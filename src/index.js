/**
 * dsh-plugin-export-md — host face.
 *
 * Registers the human slash command `/export-md`, which renders the calling
 * agent's own session log to a Markdown document under `~/.dsh/exports/`
 * (or an explicit `--out` path). The command runs directly against the agent:
 * no model message is created and no tokens are spent.
 *
 * Everything the plugin needs is reached through Cordis services, so the
 * package carries no runtime dependencies:
 *   - `ctx.commands`      — the human-command registry (`@deepseek-ai/dsh-commands`)
 *   - `ctx.sessionQuery`  — complete replay-validated session logs (`@deepseek-ai/dsh-session-query`)
 *   - `ctx.sessionTitle`  — the logged session title (`@deepseek-ai/dsh-session-title`, optional)
 *
 * @module dsh-plugin-export-md
 */

import { parseExportArgs, summarizeSections, USAGE } from './options.js';
import { renderSessionMarkdown } from './render.js';
import { displayPath, resolveTarget, writeExport } from './export-file.js';
import { formatTime } from './text.js';

/** Plugin name; matches the package name and the profile patch row. */
export const name = 'dsh-plugin-export-md';

/** Version recorded in exported documents; keep in step with package.json. */
export const VERSION = '1.0.0';

/** Services this plugin reads; the loader holds the row until they exist. */
export const inject = ['commands', 'sessionQuery'];

/** Command registered by this plugin. */
const COMMAND_NAME = 'export-md';

/** Default option values, overridable per profile through the plugin config. */
export const DEFAULT_CONFIG = {
  /** `brief` | `normal` | `full` — the preset used when the command has no preset argument. */
  level: 'normal',
  /** Directory for generated files; defaults to `<harness home>/exports` when empty. */
  outputDir: '',
  /** Per-block character budget for prose; 0 disables truncation. */
  maxChars: 20000,
  /** Per-result character budget for tool output; 0 falls back to `maxChars`. */
  toolChars: 2000,
};

/**
 * Apply the cordis plugin.
 *
 * @param ctx - the plugin's Cordis context.
 * @param config - profile-supplied configuration (all fields optional).
 * @returns the registered command's disposer.
 */
export function apply(ctx, config = {}) {
  const settings = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  const defaults = defaultsFrom(settings);
  return ctx.commands.register({
    name: COMMAND_NAME,
    description: '把当前会话导出为 Markdown 文档（默认保存到 ~/.dsh/exports/）',
    input: { hint: '--full | --brief | --tools …（--help 查看全部选项）' },
    handler: (invocation) => runExport(ctx, invocation, settings, defaults),
  });
}

/** @returns the default section switches implied by the configured preset level. */
function defaultsFrom(settings) {
  const level = typeof settings.level === 'string' ? settings.level.toLowerCase() : 'normal';
  const parsed = parseExportArgs(`--${level}`, undefined);
  const base = parsed.options ?? parseExportArgs('--normal', undefined).options;
  return {
    system: base.system,
    reasoning: base.reasoning,
    tools: base.tools,
    toolOutputs: base.toolOutputs,
    meta: base.meta,
    usage: base.usage,
    mentions: base.mentions,
    timestamps: base.timestamps,
    maxChars: Number.isInteger(settings.maxChars) && settings.maxChars >= 0 ? settings.maxChars : base.maxChars,
    toolChars: Number.isInteger(settings.toolChars) && settings.toolChars >= 0 ? settings.toolChars : base.toolChars,
  };
}

/**
 * Execute one `/export-md` invocation.
 * @param ctx - the plugin context.
 * @param invocation - the command invocation supplied by the registry.
 * @param settings - plugin configuration.
 * @param defaults - configured default section switches.
 * @returns the command result rendered by the dispatching UI.
 */
async function runExport(ctx, invocation, settings, defaults) {
  const parsed = parseExportArgs(invocation.rawInput ?? '', defaults);
  if (parsed.error !== undefined) {
    return { kind: 'error', text: `${parsed.error}\n\n${USAGE}` };
  }

  const options = parsed.options;
  if (options.help === true) return { kind: 'success', text: USAGE };

  const sessionId = invocation.agent?.id;
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { kind: 'error', text: '无法确定当前会话：命令没有携带 agent 身份。' };
  }

  const sessionQuery = lookupService(ctx, 'sessionQuery');
  if (sessionQuery === undefined || typeof sessionQuery.readSession !== 'function') {
    return { kind: 'error', text: '会话查询服务（ctx.sessionQuery）不可用，无法读取会话日志。请确认 profile 中已挂载 @deepseek-ai/dsh-session-query-sqlite。' };
  }

  let snapshot;
  try {
    snapshot = await sessionQuery.readSession(sessionId);
  } catch (error) {
    return { kind: 'error', text: `读取会话日志失败：${messageOf(error)}` };
  }

  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  if (events.length === 0) {
    return { kind: 'error', text: '当前会话的日志为空，没有可导出的内容。' };
  }

  const title = await readTitle(sessionQuery, sessionId, events);
  const now = new Date();

  let content;
  try {
    content = renderSessionMarkdown({
      header: snapshot.session,
      events,
      title,
      options,
      generatedAt: now.getTime(),
      version: VERSION,
    });
  } catch (error) {
    return { kind: 'error', text: `渲染 Markdown 失败：${messageOf(error)}` };
  }

  let target;
  try {
    target = await resolveTarget({
      out: options.out ?? (typeof settings.outputDir === 'string' && settings.outputDir.trim() !== '' ? settings.outputDir : undefined),
      title,
      sessionId,
      now,
    });
    await writeExport(target.path, content);
  } catch (error) {
    return { kind: 'error', text: `写入导出文件失败：${messageOf(error)}` };
  }

  const stats = countContent(events, options);
  const lines = [
    `✅ 已导出本会话 → ${displayPath(target.path)}`,
    '',
    `- 轮次：${stats.turns} · 模型回复：${stats.assistant} · 工具调用：${stats.toolCalls}${stats.toolErrors > 0 ? `（失败 ${stats.toolErrors}）` : ''} · 注入上下文：${stats.contextMessages}`,
    `- 文件大小：${formatBytes(Buffer.byteLength(content, 'utf8'))} · 日志事件：${events.length} 条`,
    `- ${summarizeSections(options)}`,
  ];
  if (options.toolChars > 0 && stats.truncatedSuspected) {
    lines.push(`- ⚠️ 存在超长的工具输出，已按 --tool-chars ${options.toolChars} 截断；需要完整内容请加 \`--tool-chars 0\``);
  }
  lines.push('', '提示：`/export-md --help` 查看全部选项，`--full` 导出全部内容。');
  return { kind: 'success', text: lines.join('\n') };
}

/**
 * Fold the session title, tolerating an absent title service.
 * @param sessionQuery - the session-query service.
 * @param sessionId - the session id.
 * @param events - the raw event log (fallback title source).
 * @returns the title, or an empty string.
 */
async function readTitle(sessionQuery, sessionId, events) {
  if (typeof sessionQuery.readTitle === 'function') {
    try {
      const snapshot = await sessionQuery.readTitle(sessionId);
      if (typeof snapshot?.title === 'string' && snapshot.title.trim() !== '') return snapshot.title.trim();
    } catch {
      // Fall through to the log fold: a title is presentation, never fatal.
    }
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== 'session/title') continue;
    const title = event.data?.title;
    if (typeof title === 'string' && title.trim() !== '') return title.trim();
  }
  return '';
}

/**
 * Resolve one Cordis service without depending on the proxy's failure mode.
 * @param ctx - the plugin context.
 * @param key - the service name.
 * @returns the service, or undefined when it is not mounted.
 */
function lookupService(ctx, key) {
  try {
    const service = ctx.get?.(key);
    if (service !== undefined && service !== null) return service;
  } catch {
    // A required-service lookup may throw; the direct read below is the fallback.
  }
  try {
    return ctx[key];
  } catch {
    return undefined;
  }
}

/**
 * Count the conversation facts reported in the answer line.
 * @param events - the event log.
 * @param options - effective options.
 * @returns the counts.
 */
function countContent(events, options) {
  let turns = 0;
  let assistant = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let contextMessages = 0;
  let truncatedSuspected = false;
  const budget = options.toolChars > 0 ? options.toolChars : options.maxChars;
  for (const event of events) {
    if (event.type === 'turn/start') turns += 1;
    else if (event.type === 'assistant/message') assistant += 1;
    else if (event.type === 'tool/call') toolCalls += 1;
    else if (event.type === 'user/message') {
      const source = (event.data?.message ?? event.data)?.source;
      if (source !== undefined && source !== null && source.kind !== 'user') contextMessages += 1;
    } else if (event.type === 'tool/result') {
      if (event.data?.message?.content?.[0]?.isError === true) toolErrors += 1;
      if (budget > 0 && options.toolOutputs === true && textLengthOf(event) > budget) truncatedSuspected = true;
    }
  }
  if (turns === 0) {
    let started = false;
    for (const event of events) {
      if (event.type === 'user/message') {
        const source = (event.data?.message ?? event.data)?.source;
        if (source?.kind === 'user' && !started) {
          turns += 1;
          started = true;
        }
      } else if (event.type === 'command/run') {
        started = false;
      }
    }
  }
  return { turns, assistant, toolCalls, toolErrors, contextMessages, truncatedSuspected };
}

/**
 * Total visible text length of one tool-result event.
 * @param event - the `tool/result` event.
 * @returns the character count.
 */
function textLengthOf(event) {
  const content = event.data?.message?.content?.[0]?.content;
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, block) => total + (block?.type === 'text' && typeof block.text === 'string' ? block.text.length : 0), 0);
}

/**
 * Render an error for a user-facing answer line.
 * @param error - the thrown value.
 * @returns the message text.
 */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Format a byte count.
 * @param bytes - the size in bytes.
 * @returns a human-readable size.
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export { formatTime };
export default {
  name,
  VERSION,
  DEFAULT_CONFIG,
  inject,
  apply,
};