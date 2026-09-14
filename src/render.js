/**
 * Conversation-log → Markdown renderer.
 *
 * The renderer walks a session's raw event log (as returned by
 * `ctx.sessionQuery.readSession()`) and emits one document. It is a pure
 * function of its inputs: no cordis context, no I/O, no clock reads beyond
 * what the caller passes in, so it can be unit-tested by feeding it a log.
 *
 * Event vocabulary consumed (see `@deepseek-ai/dsh-session`):
 * `user/message`, `assistant/message`, `system/message`, `tool/call`,
 * `tool/result`, `command/run`, `command/done`.
 *
 * @module dsh-plugin-export-md/render
 */

import { codeBlock, formatTime, inlineCode, oneLine, preview, truncate, yamlString } from './text.js';

/** Tools whose argument object carries a prominently displayable target. */
const HIGHLIGHT_FIELDS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt', 'id', 'name'];

/** One-line summaries of well-known tools, used in headings. */
const TOOL_SUMMARY_KEYS = {
  bash: ['command'],
  bash_persistent: ['command'],
  pwsh: ['command'],
  read: ['file_path', 'path'],
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  multi_edit: ['file_path', 'path'],
  glob: ['pattern'],
  grep: ['pattern'],
  web_search: ['query', 'queries'],
  web_fetch: ['url'],
  present: ['files'],
  todo_write: ['todos'],
  job_output: ['job_id'],
  job_kill: ['job_id'],
};

/**
 * Render one session log to a Markdown document.
 *
 * @param context - render inputs.
 * @param context.header - the session header (`id`, `createdAt`, `cwd`, …).
 * @param context.events - the raw event log in ascending `seq` order.
 * @param context.title - the folded session title, when one exists.
 * @param context.options - parsed `/export-md` options.
 * @param context.generatedAt - the export timestamp.
 * @param context.version - the plugin version recorded in the frontmatter.
 * @returns the complete Markdown document (frontmatter included when enabled).
 */
export function renderSessionMarkdown({ header, events, title, options, generatedAt, version }) {
  // `calls` accumulates the call ids seen so far, in log order, so an assistant
  // message's inline tool-call block is dropped exactly when the standalone
  // `tool/call` event for it has already been rendered.
  const context = { options, calls: new Map() };

  const blocks = [];
  let open = null;
  let skippedReplacements = 0;

  const ensureTurn = () => {
    if (open !== null) return open;
    open = createTurn();
    blocks.push(open);
    return open;
  };

  for (const event of events) {
    // A successful compaction replaces a range of surface nodes with one new
    // node. That replacement is model-only: the conversation the user already
    // saw stays the transcript's source material, so replacement copies are
    // skipped here and the original append-origin events are rendered instead.
    if (isSurfaceReplacement(event)) {
      skippedReplacements += 1;
      continue;
    }
    switch (event.type) {
      case 'user/message': {
        const turn = ensureTurn();
        if (isInjectedMessage(event)) {
          // Producer-injected context (workspace instructions, notices, skill
          // content) rides user-role messages; it is grouped apart from the
          // human turns so the numbering counts questions, not injections.
          turn.contextMessages.push(event);
        } else {
          turn.humanMessages.push(event);
        }
        break;
      }
      case 'assistant/message':
        eventTurn(ensureTurn(), context, event);
        break;
      case 'tool/call': {
        const turn = ensureTurn();
        turn.items.push({ kind: 'call', event });
        if (typeof event.data?.callId === 'string' && !context.calls.has(event.data.callId)) context.calls.set(event.data.callId, turn);
        break;
      }
      case 'tool/result':
        ensureTurn().toolResults.push(event);
        break;
      case 'command/run':
        ensureTurn().commands.push({ run: event, done: undefined });
        break;
      case 'command/done':
        commandGroup(ensureTurn(), event).done = event;
        break;
      default:
        break;
    }
  }

  const body = [];
  let humanTurn = 0;
  let contextGroups = 0;
  for (const turn of blocks) {
    if (turn.humanMessages.length === 0 && turn.assistantMessages.length === 0) {
      // A block holding only tool calls, command records, or injected context.
      if (turn.contextMessages.length > 0) {
        contextGroups += 1;
        if (options.mentions === true) body.push(...renderContextGroup(turn, contextGroups, options));
      } else {
        body.push(...renderTurn(turn, 0, context));
      }
      continue;
    }
    humanTurn += 1;
    body.push(...renderTurn(turn, humanTurn, context));
  }

  const document = [];
  if (options.meta !== false) document.push(renderFrontmatter({ header, title, events, generatedAt, version }));
  document.push(renderHeading({ title, header, generatedAt }));
  const summary = [`共 ${humanTurn} 轮对话`];
  if (contextGroups > 0) summary.push(`${contextGroups} 组注入上下文`);
  document.push(`> 会话 ${inlineCode(header?.id ?? '未知')} · ${summary.join(' · ')}\n`);

  if (body.length === 0) {
    document.push('_该会话还没有任何可导出的对话内容。_\n');
  } else {
    document.push(...body);
  }

  if (options.system === true) {
    document.push(...renderSystemAppendix(events, options));
  }
  if (options.usage === true) {
    document.push(...renderUsageSummary(events));
  }
  if (skippedReplacements > 0) {
    document.push(
      `<!-- 已跳过 ${skippedReplacements} 条改写型 surface 事件（上下文压缩产生的模型专用副本），本文件保留的是用户实际看到的原始对话。 -->\n`,
    );
  }

  return `${document.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd()}\n`;
}

/**
 * Register one assistant message, keeping the turn's items in log order.
 *
 * Where the log records standalone `tool/call` events, the assistant message's
 * inline tool-call blocks are dropped so the call is not shown twice; when it
 * does not, the inline block is the call's only record. The tracked set of
 * known call ids makes that decision at the exact log position.
 *
 * @param turn - the owning turn accumulator.
 * @param context - render context (carries the known-call-id set).
 * @param event - the `assistant/message` event.
 * @returns the turn.
 */
function eventTurn(turn, context, event) {
  const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
  const calls = [];
  for (const block of blocks) {
    if (block?.type !== 'tool-call') continue;
    if (typeof block.id === 'string' && context.calls.has(block.id)) continue;
    calls.push({ type: 'tool/call', seq: event.seq, time: event.time, data: { callId: block.id, name: block.name, arguments: block.arguments } });
  }
  turn.items.push({ kind: 'assistant', event });
  for (const call of calls) turn.items.push({ kind: 'call', event: call });
  return turn;
}

/**
 * Whether an event is a surface *replacement* (a compaction rewrite) rather
 * than an append-origin record of the conversation.
 * @param event - the session event.
 * @returns true when the event must stay out of a human transcript.
 */
function isSurfaceReplacement(event) {
  const op = event?.surfaceOp;
  return op !== undefined && op !== null && op !== 'append';
}

/**
 * Create an empty accumulator for one group of log events.
 *
 * `items` preserves the exact log order of assistant messages and the tool
 * calls they made; the per-kind arrays exist only for counting.
 *
 * @returns a group accumulator.
 */
function createTurn() {
  return {
    items: [],
    humanMessages: [],
    contextMessages: [],
    assistantMessages: [],
    toolResults: [],
    commands: [],
  };
}

/**
 * Find (or create) the command group a `command/done` event settles.
 * @param turn - the owning group accumulator.
 * @param doneEvent - the `command/done` event.
 * @returns the matching group.
 */
function commandGroup(turn, doneEvent) {
  const commandId = doneEvent.data?.commandId;
  for (let index = turn.commands.length - 1; index >= 0; index -= 1) {
    const group = turn.commands[index];
    if (group.done === undefined && group.run.data?.commandId === commandId) return group;
  }
  const group = { run: { type: 'command/run', seq: doneEvent.seq, time: doneEvent.time, data: { commandId } }, done: undefined };
  turn.commands.push(group);
  return group;
}

/**
 * Render the YAML frontmatter block.
 * @param input - header, title, events, and export metadata.
 * @returns the frontmatter block text.
 */
function renderFrontmatter({ header, title, events, generatedAt, version }) {
  const lines = ['---'];
  if (typeof title === 'string' && title !== '') lines.push(`title: ${yamlString(title)}`);
  lines.push(`session_id: ${yamlString(header?.id ?? '')}`);
  if (header?.createdAt !== undefined) {
    lines.push(`created_at: ${yamlString(new Date(header.createdAt).toISOString())}`);
  }
  lines.push(`exported_at: ${yamlString(new Date(generatedAt).toISOString())}`);
  if (typeof header?.cwd === 'string' && header.cwd !== '') lines.push(`cwd: ${yamlString(header.cwd)}`);
  if (typeof header?.agentPreset === 'string' && header.agentPreset !== '') lines.push(`agent_preset: ${yamlString(header.agentPreset)}`);
  if (typeof header?.parentSession === 'string' && header.parentSession !== '') lines.push(`parent_session: ${yamlString(header.parentSession)}`);
  lines.push(`event_count: ${events.length}`);
  lines.push(`exported_by: ${yamlString(`dsh-plugin-export-md v${version}`)}`);
  lines.push('---');
  return `${lines.join('\n')}\n`;
}

/**
 * Render the document title and its metadata bullet list.
 * @param input - title, header, and generation time.
 * @returns the heading block text.
 */
function renderHeading({ title, header, generatedAt }) {
  const heading = typeof title === 'string' && title.trim() !== '' ? title.trim() : '会话导出';
  const facts = [];
  if (header?.createdAt !== undefined) facts.push(`创建于 ${formatTime(header.createdAt, true)}`);
  if (typeof header?.cwd === 'string' && header.cwd !== '') facts.push(`工作目录 ${inlineCode(header.cwd)}`);
  if (typeof header?.parentSession === 'string' && header.parentSession !== '') facts.push(`派生自 ${inlineCode(header.parentSession)}`);
  facts.push(`导出时间 ${formatTime(generatedAt, true)}`);
  const detail = facts.length > 0 ? `\n\n${facts.map((fact) => `- ${fact}`).join('\n')}` : '';
  const notice = '\n\n<!-- 由 dsh-plugin-export-md 生成；时间戳均为本地时间。 -->';
  return `# ${heading}${detail}${notice}\n`;
}

/**
 * Render one turn.
 * @param turn - the group accumulator.
 * @param index - the 1-based display index; 0 renders a group with no human turn.
 * @param context - render context (carries the effective options).
 * @returns the group's Markdown lines.
 */
function renderTurn(turn, index, context) {
  const { options } = context;
  const lines = [];
  const startedAt = firstEventTime(turn);
  const stamp = options.timestamps === false ? '' : timestampSuffix(startedAt);
  lines.push(`## ${index > 0 ? `第 ${index} 轮` : '会话事件'}${stamp}\n`);

  for (const command of turn.commands) {
    lines.push(...renderCommand(command));
  }

  for (const event of turn.humanMessages) {
    lines.push(`### 🧑 用户${timestampSuffix(options.timestamps === false ? undefined : event.time)}\n`);
    lines.push(`${textOfMessage(event)}\n`);
  }

  // Injected context stays out of the numbered turns; when elided, one notice
  // per group replaces the per-message notices it would otherwise repeat.
  if (turn.contextMessages.length > 0) {
    if (options.mentions === true) {
      lines.push(...renderContextMessages(turn, context));
    } else {
      lines.push(`> _（本组还有 ${turn.contextMessages.length} 条注入的上下文消息，使用 \`--mentions\` 可包含）_\n`);
    }
  }

  const byCallId = new Map();
  for (const event of turn.toolResults) {
    const callId = event.data?.message?.source?.callId ?? event.data?.message?.content?.[0]?.toolCallId;
    if (typeof callId === 'string') byCallId.set(callId, event);
  }

  for (const item of turn.items) {
    if (item.kind === 'assistant') lines.push(...renderAssistant(item.event, context, byCallId));
    else lines.push(...renderToolCall(item.event, context, byCallId.get(item.event.data?.callId)));
  }

  return lines;
}

/**
 * Render one group holding only injected context messages.
 * @param turn - the group accumulator.
 * @param index - the 1-based context-group index.
 * @param options - effective options.
 * @returns Markdown lines.
 */
function renderContextGroup(turn, index, options) {
  const first = turn.contextMessages[0];
  const stamp = options.timestamps === false ? '' : timestampSuffix(first?.time);
  return [`## 🧩 注入上下文（第 ${index} 组）${stamp}\n`, ...renderContextMessages(turn, { options })];
}

/**
 * Render every injected context message in a group, each collapsed.
 * @param turn - the group accumulator.
 * @param context - render context.
 * @returns Markdown lines.
 */
function renderContextMessages(turn, context) {
  const lines = [];
  for (const event of turn.contextMessages) {
    const message = event.data?.message ?? event.data;
    lines.push(`<details><summary>🧩 ${inlineCode(sourceLabel(message))}${context.options.timestamps === false ? '' : timestampSuffix(event.time)}</summary>\n`);
    lines.push(`${textOfMessage(event)}\n`);
    lines.push('</details>\n');
  }
  return lines;
}

/**
 * The earliest recorded timestamp in a group.
 * @param turn - the group accumulator.
 * @returns epoch milliseconds, or undefined when the group holds no event.
 */
function firstEventTime(turn) {
  let earliest;
  const candidates = [
    ...turn.commands.flatMap((group) => [group.run, group.done]),
    ...turn.humanMessages,
    ...turn.contextMessages,
    ...turn.items.map((item) => item.event),
    ...turn.toolResults,
  ];
  for (const event of candidates) {
    if (typeof event?.time !== 'number') continue;
    if (earliest === undefined || event.time < earliest) earliest = event.time;
  }
  return earliest;
}

/**
 * Render the numbering-suffix used in headings.
 * @param time - epoch milliseconds, or undefined.
 * @returns ` · HH:MM:SS` or an empty string.
 */
function timestampSuffix(time) {
  const formatted = formatTime(time, true);
  return formatted === '' ? '' : ` · ${formatted}`;
}

/**
 * Render one assistant message: visible text, reasoning, and any tool calls the
 * log did not record as standalone `tool/call` events.
 * @param event - the `assistant/message` event.
 * @param context - render context.
 * @param byCallId - tool results indexed by call id.
 * @returns Markdown lines.
 */
function renderAssistant(event, context, byCallId) {
  const { options } = context;
  const lines = [];
  const message = event.data?.message;
  const interrupted = event.data?.interrupted === true;
  lines.push(`### 🤖 助手${timestampSuffix(options.timestamps === false ? undefined : event.time)}${interrupted ? '（被中断）' : ''}\n`);

  const blocks = Array.isArray(message?.content) ? message.content : [];
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n')
    .trim();
  if (text !== '') lines.push(`${truncate(text, options.maxChars, '回复内容')}\n`);

  if (options.reasoning === true) {
    const reasoning = blocks
      .filter((block) => block?.type === 'reasoning' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n\n')
      .trim();
    if (reasoning !== '') {
      lines.push('<details><summary>💭 思考过程</summary>\n');
      lines.push(`${truncate(reasoning, options.maxChars, '思考过程')}\n`);
      lines.push('</details>\n');
    }
  }

  const usage = event.data?.usage;
  if (options.usage === true && usage !== undefined && usage !== null) {
    lines.push(`> tokens: 输入 ${usage.inputTokens ?? 0} · 输出 ${usage.outputTokens ?? 0}${usage.cacheReadTokens !== undefined ? ` · 缓存命中 ${usage.cacheReadTokens}` : ''}${usage.reasoningTokens !== undefined ? ` · 思考 ${usage.reasoningTokens}` : ''}\n`);
  }

  return lines;
}

/**
 * Render one tool invocation, with its result inlined when available.
 * @param event - a `tool/call`-shaped record (`data.name`, `data.arguments`, `data.callId`).
 * @param context - render context.
 * @param resultEvent - the paired `tool/result` event, when it exists.
 * @returns Markdown lines.
 */
function renderToolCall(event, context, resultEvent) {
  const { options } = context;
  if (options.tools !== true) {
    return options.toolOutputs === true && resultEvent !== undefined ? renderResultBody(resultEvent, options) : [];
  }

  const name = typeof event.data?.name === 'string' && event.data.name !== '' ? event.data.name : '未知工具';
  const summary = summarizeArguments(name, event.data?.arguments);
  const lines = [`#### 🔧 ${name}${summary === '' ? '' : ` · ${summary}`}\n`];

  const args = prettyArguments(event.data?.arguments);
  if (args !== '') {
    // The heading already carries the salient argument, so a huge payload
    // (a 20 KB file body, say) is previewed rather than pasted whole.
    lines.push('<details><summary>调用参数</summary>\n');
    lines.push(codeBlock(preview(args, argsBudget(options), '参数')));
    lines.push('</details>\n');
  }

  if (options.toolOutputs === true) {
    if (resultEvent !== undefined) lines.push(...renderResultBody(resultEvent, options));
  } else {
    lines.push('> _（工具结果已省略，使用 `--tool-output` 可包含）_\n');
  }
  return lines;
}

/** Character budget for one tool-call argument payload. */
const ARGUMENT_BUDGET = 4000;

/**
 * The per-payload argument budget, bounded by the general `--max-chars` bound.
 * @param options - effective options.
 * @returns the character budget for one argument block, 0 meaning unlimited.
 */
function argsBudget(options) {
  if (!(options.maxChars > 0)) return ARGUMENT_BUDGET;
  return Math.min(ARGUMENT_BUDGET, options.maxChars);
}

/**
 * Render the result of one tool call.
 * @param resultEvent - the `tool/result` event.
 * @param options - effective options.
 * @returns Markdown lines.
 */
function renderResultBody(resultEvent, options) {
  const block = resultEvent?.data?.message?.content?.[0];
  const text = textOfContent(block?.content);
  const isError = block?.isError === true || resultEvent?.data?.error !== undefined;
  // Tool output has its own budget: a single verbose result must not dominate
  // the document. `0` hands the block back to the general `--max-chars` bound.
  const budget = options.toolChars > 0 ? options.toolChars : options.maxChars;
  const truncated = budget > 0 && text.length > budget;
  const lines = [];
  const size = text.length.toLocaleString('en-US');
  lines.push(`<details><summary>${isError ? '❌ 工具结果（失败）' : '📄 工具结果'} · ${size} 字符${truncated ? '（已截断）' : ''}</summary>\n`);
  if (text.trim() === '') {
    lines.push('_（空结果）_\n');
  } else {
    lines.push(codeBlock(preview(text, budget, '工具输出')));
  }
  lines.push('</details>\n');
  return lines;
}

/**
 * Render a `/command` invocation and its outcome.
 * @param group - the `command/run` event plus its optional `command/done`.
 * @returns Markdown lines.
 */
function renderCommand(group) {
  const name = typeof group.run?.data?.name === 'string' ? group.run.data.name : '命令';
  const args = typeof group.run?.data?.args === 'string' ? group.run.data.args.trim() : '';
  const outcome = group.done?.data;
  const lines = [`> **⌘ /${name}**${args === '' ? '' : ` ${inlineCode(oneLine(args, 80))}`}`];
  if (outcome === undefined) {
    lines.push('> _（未记录结果）_');
  } else if (outcome.kind === 'error') {
    lines.push(`> ❌ ${oneLine(outcome.text ?? '执行失败', 400)}`);
  } else if (typeof outcome.text === 'string' && outcome.text.trim() !== '') {
    lines.push(`> ${outcome.text.trim().split('\n').join('\n> ')}`);
  }
  lines.push('');
  return lines;
}

/**
 * Render the appendix holding the system prompt.
 * @param events - the event log.
 * @param options - effective options.
 * @returns Markdown lines.
 */
function renderSystemAppendix(events, options) {
  const systems = events.filter((event) => event.type === 'system/message');
  if (systems.length === 0) return [];
  const lines = ['---\n', '## 系统提示词\n'];
  const latest = systems[systems.length - 1];
  const text = typeof latest.data?.message?.content !== 'undefined' ? textOfContent(latest.data.message.content) : '';
  if (text.trim() === '') {
    lines.push('_（该会话没有系统提示词）_\n');
  } else {
    lines.push(codeBlock(truncate(text, options.maxChars, '系统提示词'), 'markdown'));
  }
  if (systems.length > 1) lines.push(`_（会话期间共记录 ${systems.length} 个系统提示词快照，此处为最后一个。）_\n`);
  return lines;
}

/**
 * Render the token-usage summary appendix.
 * @param events - the event log.
 * @returns Markdown lines.
 */
function renderUsageSummary(events) {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  let steps = 0;
  for (const event of events) {
    if (event.type !== 'assistant/message') continue;
    const usage = event.data?.usage;
    if (usage === undefined || usage === null) continue;
    steps += 1;
    input += usage.inputTokens ?? 0;
    output += usage.outputTokens ?? 0;
    cacheRead += usage.cacheReadTokens ?? 0;
    cacheWrite += usage.cacheWriteTokens ?? 0;
    reasoning += usage.reasoningTokens ?? 0;
  }
  if (steps === 0) return [];
  const rows = [
    ['输入 tokens', input],
    ['输出 tokens', output],
    ['缓存读取', cacheRead],
    ['缓存写入', cacheWrite],
    ['思考 tokens', reasoning],
    ['合计', input + output],
  ];
  const lines = ['---\n', '## Token 用量\n', '| 项目 | 数量 |', '| --- | ---: |'];
  for (const [label, value] of rows) lines.push(`| ${label} | ${value.toLocaleString('en-US')} |`);
  lines.push(`\n_（统计自 ${steps} 次模型回复；缓存与思考 token 为其中已上报的部分。）_\n`);
  return lines;
}

/**
 * Whether a user-role message event was produced by a plugin rather than typed
 * by the human.
 * @param event - the `user/message` event.
 * @returns true for producer-injected context.
 */
function isInjectedMessage(event) {
  const message = event?.data?.message ?? event?.data;
  const source = message?.source;
  if (source === undefined || source === null) return false;
  return source.kind !== 'user';
}

/**
 * Label one injected message by its producer and declared form.
 * @param message - the message.
 * @returns a short Chinese label.
 */
function sourceLabel(message) {
  const source = message?.source ?? {};
  const producer = typeof source.plugin === 'string' && source.plugin !== '' ? source.plugin : source.kind === 'model' ? '模型' : source.kind === 'tool' ? '工具' : '插件';
  const forms = {
    instructions: '工作区指令',
    catalog: '目录快照',
    snapshot: '状态快照',
    notice: '事件通知',
    relay: '代理转达',
    recall: '历史召回',
  };
  const form = forms[source.form];
  return form === undefined ? producer : `${producer} / ${form}`;
}

/**
 * Extract the plain text of one message event.
 * @param event - a session event carrying a message.
 * @returns the concatenated visible text.
 */
function textOfMessage(event) {
  const message = event?.data?.message ?? event?.data;
  return textOfContent(message?.content);
}

/**
 * Concatenate the text blocks of a content array.
 * @param content - a content-block array.
 * @returns the joined text.
 */
function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n');
}

/**
 * Build the one-line argument summary shown in a tool heading.
 * @param name - the tool name.
 * @param raw - the raw JSON argument string.
 * @returns a short summary, or an empty string.
 */
function summarizeArguments(name, raw) {
  const parsed = parseArguments(raw);
  if (parsed === undefined) return '';
  const keys = TOOL_SUMMARY_KEYS[name] ?? HIGHLIGHT_FIELDS;
  for (const key of keys) {
    const value = parsed?.[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() !== '') return inlineCode(oneLine(value, 70));
    if (Array.isArray(value) && value.length > 0) return inlineCode(oneLine(value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(', '), 70));
    if (typeof value === 'number' || typeof value === 'boolean') return inlineCode(String(value));
  }
  return '';
}

/**
 * Parse a tool-call argument string.
 * @param raw - the raw JSON string produced by the model.
 * @returns the parsed object, or undefined when it is not a JSON object.
 */
function parseArguments(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pretty-print a tool-call argument string.
 * @param raw - the raw JSON string produced by the model.
 * @returns the pretty-printed JSON, or the original text when it is not JSON.
 */
function prettyArguments(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  const parsed = parseArguments(raw);
  if (parsed === undefined) return raw.trim();
  return JSON.stringify(parsed, undefined, 2);
}
