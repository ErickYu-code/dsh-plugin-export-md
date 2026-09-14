/**
 * Self-contained checks for the renderer, the option parser, and the export
 * target resolution. Run with `node test/run.js` — no test framework needed.
 *
 * @module dsh-plugin-export-md/test
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseExportArgs, summarizeSections, USAGE } from '../src/options.js';
import { renderSessionMarkdown } from '../src/render.js';
import { displayPath, resolveTarget, writeExport, defaultExportDir } from '../src/export-file.js';
import { codeBlock, fileStamp, slugify, truncate, yamlString, oneLine, inlineCode } from '../src/text.js';

const checks = [];
const check = (label, fn) => checks.push({ label, fn });

/** Build one synthetic session log covering every supported event type. */
function fixtureEvents() {
  const base = Date.UTC(2026, 0, 2, 3, 4, 5);
  const at = (offset) => base + offset * 1000;
  return [
    { type: 'session/title', seq: 0, time: at(0), data: { title: '导出插件冒烟测试' } },
    { type: 'turn/start', seq: 1, time: at(1), data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: at(2), data: { turn: 1, step: 1, message: { role: 'user', id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我看看这个插件怎么写。' }] } } },
    { type: 'step/start', seq: 3, time: at(3), data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      seq: 4,
      time: at(4),
      data: {
        turn: 1,
        step: 1,
        interrupted: true,
        usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 800, reasoningTokens: 90 },
        message: {
          role: 'assistant',
          id: 'm2',
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
          content: [
            { type: 'reasoning', text: '先看一眼目录结构。' },
            { type: 'text', text: '我先读一下目录。' },
            { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls -la"}' },
          ],
        },
        stream: [],
      },
    },
    { type: 'tool/call', seq: 5, time: at(5), data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls -la","description":"列出目录"}' } },
    {
      type: 'tool/result',
      seq: 6,
      time: at(6),
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'user',
          id: 'm3',
          source: { kind: 'tool', callId: 'c1' },
          content: [{ type: 'tool-result', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'total 8\ndrwxr-xr-x  3 user  staff   96 Jan  2 03:04 .' }] }],
        },
      },
    },
    { type: 'tool/call', seq: 7, time: at(7), data: { turn: 1, step: 1, callId: 'c2', name: 'read', arguments: '{"file_path":"/tmp/缺失.md"}' } },
    {
      type: 'tool/result',
      seq: 8,
      time: at(8),
      data: {
        turn: 1,
        step: 1,
        error: { name: 'FsError', code: 'ENOENT' },
        message: {
          role: 'user',
          id: 'm4',
          source: { kind: 'tool', callId: 'c2' },
          content: [{ type: 'tool-result', toolCallId: 'c2', isError: true, content: [{ type: 'text', text: 'ENOENT: no such file or directory' }] }],
        },
      },
    },
    { type: 'assistant/message', seq: 9, time: at(9), data: { turn: 1, step: 1, message: { role: 'assistant', id: 'm5', source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' }, content: [{ type: 'text', text: '目录是空的。' }] }, stream: [] } },
    { type: 'step/end', seq: 10, time: at(10), data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 11, time: at(11), data: { turn: 1 } },
    { type: 'turn/start', seq: 12, time: at(12), data: { turn: 2 } },
    { type: 'user/message', seq: 13, time: at(13), data: { turn: 2, step: 1, message: { role: 'user', id: 'm6', source: { kind: 'plugin', plugin: 'dsh-agent-instructions', form: 'instructions' }, content: [{ type: 'text', text: '# AGENTS.md\n\n请用中文回答。' }] } } },
    { type: 'user/message', seq: 14, time: at(14), data: { turn: 2, step: 1, message: { role: 'user', id: 'm7', source: { kind: 'user' }, content: [{ type: 'text', text: '继续。' }] } } },
    { type: 'command/run', seq: 15, time: at(15), data: { commandId: 'cmd1', name: 'export-md', args: ' --brief', source: { kind: 'user' } } },
    { type: 'command/done', seq: 16, time: at(16), data: { commandId: 'cmd1', kind: 'success', text: '已导出 → ~/.dsh/exports/x.md' } },
    { type: 'system/message', seq: 17, time: at(17), data: { turn: 2, step: 1, message: { role: 'system', id: 'm8', source: { kind: 'plugin', plugin: 'dsh-system-prompt' }, content: [{ type: 'text', text: 'You are a coding agent.' }] } } },
    { type: 'assistant/attempt', seq: 18, time: at(18), data: { turn: 2, step: 1, stream: [] } },
    { type: 'assistant/message', seq: 19, time: at(19), data: { turn: 2, step: 1, message: { role: 'assistant', id: 'm9', source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' }, content: [{ type: 'text', text: '好的。' }] }, stream: [] } },
    { type: 'turn/end', seq: 20, time: at(20), data: { turn: 2 } },
  ];
}

const render = (options) =>
  renderSessionMarkdown({
    header: { version: 3, id: 'session-1234abcd-0000', createdAt: Date.UTC(2026, 0, 2, 3, 4, 5), cwd: '/tmp/示例', isSeeded: false },
    events: fixtureEvents(),
    title: '导出插件冒烟测试',
    options,
    generatedAt: Date.UTC(2026, 0, 2, 4, 0, 0),
    version: '1.0.0',
  });

const optionsFor = (line) => {
  const parsed = parseExportArgs(line, undefined);
  assert.equal(parsed.error, undefined, `parse failed for ${JSON.stringify(line)}: ${parsed.error}`);
  return parsed.options;
};

check('text: fences grow past embedded backticks', () => {
  const block = codeBlock('a ``` b', 'json');
  assert.ok(block.startsWith('```` json'), block);
  assert.ok(block.trimEnd().endsWith('````'));
  assert.ok(codeBlock('plain').startsWith('```\n'));

  // A long backtick run alone steps up to a tilde fence…
  const tildes = codeBlock(`${'`'.repeat(200)}\nbody`);
  assert.ok(tildes.startsWith('~~~\n'), tildes.slice(0, 12));

  // …while content holding both long runs falls back to an indented block,
  // the only form that cannot be broken.
  const indented = codeBlock(`${'`'.repeat(200)}\n${'~'.repeat(200)}`);
  assert.ok(indented.startsWith('    '), 'degenerate content falls back to an indented block');
});

check('text: yaml quoting escapes quotes and newlines', () => {
  assert.equal(yamlString('a"b\nc'), '"a\\"b\\nc"');
});

check('text: slugify keeps CJK and strips path characters', () => {
  assert.equal(slugify('导出/插件: 测试?'), '导出-插件-测试');
  assert.equal(slugify('   '), '');
  assert.ok(slugify('长'.repeat(80)).length <= 48);
});

check('text: truncate reports the omitted count', () => {
  const out = truncate('x'.repeat(1000), 100, '输出');
  assert.ok(out.includes('已省略 900 字符'), out.slice(0, 80));
  assert.equal(truncate('short', 100), 'short');
  assert.equal(truncate('x'.repeat(1000), 0), 'x'.repeat(1000));
});

check('text: oneLine and inlineCode stay on one line', () => {
  assert.equal(oneLine('a\n\nb   c'), 'a b c');
  assert.equal(inlineCode('a`b'), '``a`b``');
});

check('options: presets and switches resolve as documented', () => {
  const brief = optionsFor(' --brief');
  assert.deepEqual([brief.reasoning, brief.tools, brief.toolOutputs, brief.system], [false, false, false, false]);
  const full = optionsFor(' --full');
  assert.deepEqual([full.reasoning, full.tools, full.toolOutputs, full.system, full.mentions], [true, true, true, true, true]);
  const mixed = optionsFor(' --full --no-tools --no-tool-output');
  assert.deepEqual([mixed.tools, mixed.toolOutputs, mixed.reasoning], [false, false, true]);
  assert.equal(optionsFor(' --thinking').reasoning, true);
  assert.equal(optionsFor(' --with-reasoning').reasoning, true);
});

check('options: valued forms and errors', () => {
  assert.equal(optionsFor(' --max-chars 500').maxChars, 500);
  assert.equal(optionsFor(' --max-chars=0').maxChars, 0);
  assert.equal(optionsFor(' --out "/tmp/a b.md"').out, '/tmp/a b.md');
  assert.equal(optionsFor(' -o/tmp/c.md').out, '/tmp/c.md');
  assert.equal(optionsFor(' --brief --tools').tools, true);
  assert.equal(optionsFor(' --help').help, true);
  assert.ok(parseExportArgs(' --nope', undefined).error.includes('未知选项'));
  assert.ok(parseExportArgs(' --max-chars abc', undefined).error.includes('非负整数'));
  assert.ok(parseExportArgs(' --max-chars', undefined).error.includes('需要一个取值'));
  assert.ok(parseExportArgs(' wat', undefined).error.includes('无法识别的参数'));
  assert.ok(USAGE.includes('/export-md'));
  assert.ok(summarizeSections(optionsFor(' --brief')).includes('仅正文'));
});

check('render: normal level carries every section', () => {
  const md = render(optionsFor(' --normal'));
  assert.ok(md.startsWith('---\n'), 'frontmatter first');
  assert.ok(md.includes('# 导出插件冒烟测试'));
  assert.ok(md.includes('## 第 1 轮'));
  assert.ok(md.includes('### 🧑 用户'));
  assert.ok(md.includes('帮我看看这个插件怎么写。'));
  assert.ok(md.includes('### 🤖 助手'));
  assert.ok(md.includes('我先读一下目录。'));
  assert.ok(md.includes('💭 思考过程'));
  assert.ok(md.includes('#### 🔧 bash · `ls -la`'));
  assert.ok(md.includes('📄 工具结果'));
  assert.ok(md.includes('❌ 工具结果（失败）'));
  assert.ok(md.includes('被中断'));
  assert.ok(md.includes('tokens: 输入 1200'));
  assert.ok(md.includes('## Token 用量'));
  assert.ok(md.includes('⌘ /export-md'));
  assert.ok(!md.includes('You are a coding agent.'), 'system prompt hidden at normal level');
  assert.ok(md.includes('条注入的上下文消息'), 'injected context is counted in one notice per group');
});

check('render: brief level is text only', () => {
  const md = render(optionsFor(' --brief'));
  assert.ok(md.includes('帮我看看这个插件怎么写。'));
  assert.ok(!md.includes('#### 🔧'));
  assert.ok(!md.includes('💭 思考过程'));
  assert.ok(!md.includes('## Token 用量'));
  assert.ok(!md.startsWith('---\n'), 'brief drops frontmatter');
});

check('render: full level adds system prompt, mentions, and usage', () => {
  const md = render(optionsFor(' --full'));
  assert.ok(md.includes('## 系统提示词'));
  assert.ok(md.includes('You are a coding agent.'));
  assert.ok(md.includes('dsh-agent-instructions'), 'each injected message is labelled by producer');
  assert.ok(md.includes('请用中文回答。'));
  assert.ok(md.includes('dsh-agent-instructions'));
  assert.ok(md.includes('## Token 用量'));
});

check('render: a group holding only injected context is not a turn', () => {
  const events = [
    { type: 'user/message', seq: 0, time: 0, data: { turn: 1, step: 1, message: { role: 'user', id: 'c1', source: { kind: 'plugin', plugin: 'dsh-goal', form: 'notice' }, content: [{ type: 'text', text: '目标轮次继续。' }] } } },
    { type: 'user/message', seq: 1, time: 1000, data: { turn: 1, step: 1, message: { role: 'user', id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '真正的问题' }] } } },
  ];
  const elided = renderSessionMarkdown({ header: { version: 3, id: 's', createdAt: 0, isSeeded: false }, events, title: 't', options: optionsFor(' --normal'), generatedAt: 0, version: '1.0.0' });
  assert.ok(elided.includes('## 第 1 轮'), 'the human message is turn 1');
  assert.ok(!elided.includes('## 第 2 轮'), 'injected context does not open a turn');
  assert.ok(elided.includes('1 条注入的上下文消息'), elided.slice(0, 400));

  const shown = renderSessionMarkdown({ header: { version: 3, id: 's', createdAt: 0, isSeeded: false }, events, title: 't', options: optionsFor(' --mentions'), generatedAt: 0, version: '1.0.0' });
  assert.ok(shown.includes('目标轮次继续。'), '--mentions includes the body');
  assert.ok(shown.includes('dsh-goal'), 'the producer is named');
});

check('render: tool calls without outputs keep the call row', () => {
  const md = render(optionsFor(' --tools --no-tool-output'));
  assert.ok(md.includes('#### 🔧 bash'));
  assert.ok(md.includes('工具结果已省略'));
  assert.ok(!md.includes('total 8'));
});

check('render: tool output obeys its own budget, separately from prose', () => {
  const events = fixtureEvents();
  const result = events.find((event) => event.type === 'tool/result');
  result.data.message.content[0].content = [{ type: 'text', text: `${'y'.repeat(500)}\nTAIL-MARKER` }];
  const parsed = parseExportArgs(' --tool-chars 200', undefined);
  const md = renderSessionMarkdown({
    header: { version: 3, id: 'session-1', createdAt: 0, isSeeded: false },
    events,
    title: 't',
    options: parsed.options,
    generatedAt: 0,
    version: '1.0.0',
  });
  assert.ok(md.includes('已截断'), 'the summary flags truncation');
  assert.ok(md.includes('此处省略'), 'the omission notice is present');
  assert.ok(md.includes('--tool-chars 0'), 'the notice names the escape hatch');
  assert.ok(md.includes('TAIL-MARKER'), 'the tail is kept');

  // A zero tool budget hands the block back to the general bound.
  const wide = parseExportArgs(' --tool-chars 0 --max-chars 100', undefined);
  const wideMd = renderSessionMarkdown({
    header: { version: 3, id: 'session-1', createdAt: 0, isSeeded: false },
    events,
    title: 't',
    options: wide.options,
    generatedAt: 0,
    version: '1.0.0',
  });
  assert.ok(wideMd.includes('此处省略'), 'falls back to --max-chars');
  assert.ok(wideMd.includes('（工具输出）'), 'the omission notice is labelled');
});

check('render: content with an embedded fence survives', () => {
  const events = fixtureEvents();
  const result = events.find((event) => event.type === 'tool/result');
  result.data.message.content[0].content = [{ type: 'text', text: '```\ncode\n```' }];
  const md = renderSessionMarkdown({
    header: { version: 3, id: 'session-1', createdAt: 0, isSeeded: false },
    events,
    title: 't',
    options: optionsFor(' --normal'),
    generatedAt: 0,
    version: '1.0.0',
  });
  assert.ok(md.includes('````'), 'fence grew to four backticks');
});

check('render: compaction replacement copies stay out of the transcript', () => {
  const events = fixtureEvents();
  // A landed compaction: one summary node replacing an earlier surface range.
  events.push({
    type: 'assistant/message',
    seq: 21,
    time: Date.UTC(2026, 0, 2, 3, 4, 25),
    surfaceOp: { op: 'replace', startSeq: 2, endSeq: 9 },
    sourceEventSeqs: [2, 4, 6, 8, 9],
    data: { turn: 2, step: 1, message: { role: 'assistant', id: 'm10', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: '【压缩摘要】此前讨论了插件写法。' }] }, stream: [] },
  });
  const md = renderSessionMarkdown({
    header: { version: 3, id: 'session-1', createdAt: 0, isSeeded: false },
    events,
    title: 't',
    options: optionsFor(' --normal'),
    generatedAt: 0,
    version: '1.0.0',
  });
  assert.ok(!md.includes('【压缩摘要】'), 'replacement copy is not rendered');
  assert.ok(md.includes('帮我看看这个插件怎么写。'), 'original conversation is retained');
  assert.ok(md.includes('已跳过 1 条改写型 surface 事件'), 'the skip is disclosed');
});

check('render: an empty log still produces a document', () => {
  const md = renderSessionMarkdown({
    header: { version: 3, id: 'session-empty', createdAt: 0, isSeeded: false },
    events: [],
    title: '',
    options: optionsFor(' --normal'),
    generatedAt: 0,
    version: '1.0.0',
  });
  assert.ok(md.includes('# 会话导出'));
  assert.ok(md.includes('还没有任何可导出的对话内容'));
});

check('render: a log with only tool events still renders a section', () => {
  const md = renderSessionMarkdown({
    header: { version: 3, id: 'session-tools', createdAt: 0, isSeeded: false },
    events: [{ type: 'tool/call', seq: 0, time: 0, data: { turn: 1, step: 1, callId: 'c9', name: 'grep', arguments: '{"pattern":"todo"}' } }],
    title: '',
    options: optionsFor(' --normal'),
    generatedAt: 0,
    version: '1.0.0',
  });
  assert.ok(md.includes('#### 🔧 grep · `todo`'));
  assert.ok(md.includes('## 会话事件'), 'a group with no human message is not numbered as a turn');
});

check('export-file: default directory follows DSH_HOME', () => {
  assert.equal(defaultExportDir({ DSH_HOME: '/tmp/dsh-home' }), '/tmp/dsh-home/exports');
  assert.equal(displayPath('/tmp/dsh-home/exports/a.md', { DSH_HOME: '/tmp/dsh-home' }), '~/.dsh/exports/a.md');
  assert.equal(displayPath('/elsewhere/a.md', { DSH_HOME: '/tmp/dsh-home' }), '/elsewhere/a.md');
});

check('export-file: writes a unique file and honours --out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'export-md-test-'));
  const now = new Date(2026, 0, 2, 3, 4, 5);
  const stamp = fileStamp(now);
  try {
    const first = await resolveTarget({ title: '会话/标题', sessionId: 'session-abcd1234-9999', now, env: { DSH_HOME: dir } });
    assert.equal(first.path, join(dir, 'exports', `${stamp}-会话-标题-abcd1234.md`), first.path);
    const bytes = await writeExport(first.path, 'hello');
    assert.equal(bytes, 5);

    const again = await resolveTarget({ title: '会话/标题', sessionId: 'session-abcd1234-9999', now, env: { DSH_HOME: dir } });
    assert.ok(again.path.endsWith('-2.md'), again.path);
    await writeExport(again.path, 'hello again');

    const named = await resolveTarget({ out: join(dir, 'custom.md'), title: 'x', sessionId: 'session-1', now, env: { DSH_HOME: dir } });
    assert.equal(named.path, join(dir, 'custom.md'));

    const inDirectory = await resolveTarget({ out: dir, title: 'y', sessionId: 'session-2', now, env: { DSH_HOME: dir } });
    assert.ok(inDirectory.path.startsWith(`${dir}/`), inDirectory.path);

    const written = await readFile(first.path, 'utf8');
    assert.equal(written, 'hello');
    const listing = await readdir(join(dir, 'exports'));
    assert.deepEqual(listing.sort(), [`${stamp}-会话-标题-abcd1234-2.md`, `${stamp}-会话-标题-abcd1234.md`]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

check('plugin: /export-md registers and writes a real file', async () => {
  const { apply, name, inject } = await import('../src/index.js');
  assert.equal(name, 'dsh-plugin-export-md');
  assert.deepEqual(inject, ['commands', 'sessionQuery']);

  const dir = await mkdtemp(join(tmpdir(), 'export-md-plugin-'));
  const registered = [];
  const ctx = {
    get: (key) => (key === 'sessionQuery' ? sessionQuery : undefined),
    commands: {
      register: (definition) => {
        registered.push(definition);
        return () => {};
      },
    },
  };
  const sessionQuery = {
    readSession: async () => ({ session: { version: 3, id: 'session-abc12345-0000', createdAt: Date.UTC(2026, 0, 2, 3, 4, 5), cwd: '/tmp/示例', isSeeded: false }, inheritedEventCount: 0, events: fixtureEvents() }),
    readTitle: async () => ({ title: '导出插件冒烟测试' }),
  };

  const dispose = apply(ctx, { outputDir: dir });
  assert.equal(typeof dispose, 'function');
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'export-md');

  const result = await registered[0].handler({ agent: { id: 'session-abc12345-0000' }, rawInput: ' --brief', attachments: [], signal: new AbortController().signal });
  assert.equal(result.kind, 'success', result.text);
  assert.ok(result.text.includes('.md'), result.text);

  const files = await readdir(dir);
  assert.equal(files.length, 1, files.join(','));
  const written = await readFile(join(dir, files[0]), 'utf8');
  assert.ok(written.includes('帮我看看这个插件怎么写。'));
  assert.ok(!written.includes('#### 🔧'), '--brief is honoured through the whole pipeline');

  const bad = await registered[0].handler({ agent: { id: 'session-abc12345-0000' }, rawInput: ' --nope', attachments: [], signal: new AbortController().signal });
  assert.equal(bad.kind, 'error');
  assert.ok(bad.text.includes('未知选项'));

  const help = await registered[0].handler({ agent: { id: 'session-abc12345-0000' }, rawInput: ' --help', attachments: [], signal: new AbortController().signal });
  assert.equal(help.kind, 'success');
  assert.ok(help.text.includes('用法'));

  await rm(dir, { recursive: true, force: true });
});

check('plugin: a missing sessionQuery service fails soft', async () => {
  const { apply } = await import('../src/index.js');
  let definition;
  const ctx = { get: () => undefined, commands: { register: (value) => { definition = value; } } };
  apply(ctx, {});
  const result = await definition.handler({ agent: { id: 'session-x' }, rawInput: '', attachments: [], signal: new AbortController().signal });
  assert.equal(result.kind, 'error');
  assert.ok(result.text.includes('sessionQuery'), result.text);

  const noAgent = await definition.handler({ agent: undefined, rawInput: '', attachments: [], signal: new AbortController().signal });
  assert.equal(noAgent.kind, 'error');
  assert.ok(noAgent.text.includes('无法确定当前会话'));
});

check('release: package.json, VERSION, and the release notes stay in step', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const { VERSION } = await import('../src/index.js');
  assert.equal(VERSION, manifest.version, 'exports stamp the released version');

  // A published tag must have a matching notes file, otherwise the workflow
  // falls back to auto-generated notes that omit the install line.
  const notes = new URL(`../RELEASE_NOTES/v${manifest.version}.md`, import.meta.url);
  const body = await readFile(notes, 'utf8');
  assert.ok(body.startsWith(`# v${manifest.version}`), 'notes are titled with the version');
  assert.ok(body.includes('dsh plugin --profile web add github:'), 'notes carry an install line');
});

check('privacy: no personal identity leaks into tracked files', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('..', import.meta.url));
  // Tracked files only, so local scratch dirs never trip this.
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  // Split on purpose: a literal here would make this very file trip the check.
  const personalName = new RegExp(`${'yuzhi'}${'min'}`, 'i');
  // Any author-style email is a leak unless it is GitHub's own noreply alias,
  // which is safe to publish. (The git-identity runbook that carries that alias
  // now sits in docs/RELEASING.md, which is untracked and therefore unscanned.)
  const anyEmail = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi;
  const hits = [];
  for (const file of tracked) {
    const body = await readFile(new URL(`../${file}`, import.meta.url), 'utf8').catch(() => '');
    if (personalName.test(body)) hits.push(`${file}: 出现个人名 ${personalName.source}`);
    for (const email of body.match(anyEmail) ?? []) {
      if (!email.endsWith('@users.noreply.github.com')) hits.push(`${file}: 出现个人邮箱 ${email}`);
    }
  }
  assert.deepEqual(hits, [], `仓库文件里不应出现个人身份信息：\n${hits.join('\n')}`);
});

check('release: the workflow makes re-releasing a tag idempotent', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  // Re-pushing a tag must not fail with "release already exists".
  assert.ok(/gh release delete "\$\{TAG\}" --yes/.test(workflow), 'workflow deletes an existing release before creating');
  // --cleanup-tag would delete the git tag and break the later --verify-tag.
  // Only executable lines count: the step's own comment names the flag to
  // explain why it is left off.
  const commands = workflow
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  assert.ok(!/--cleanup-tag/.test(commands), 'workflow must keep the git tag when recreating a release');
  assert.ok(workflow.includes('--verify-tag'), 'release creation verifies the tag exists');
  assert.ok(workflow.includes('tools/release.yml') === false);
  // The tag under release must be the one that triggered the run.
  assert.ok(workflow.includes('github.event.inputs.tag || github.ref_name'), 'tag comes from the push or the manual input');

  // This one bites: a tag-triggered run executes the workflow file from the
  // TAG'S commit, so the maintainer runbook must tell you to move an old tag
  // onto the commit carrying the fix.
  //
  // That runbook now lives in docs/RELEASING.md, which is deliberately NOT
  // tracked (see .gitignore) because it is written for this machine only. So
  // this half of the check runs where the file exists and is skipped in a
  // clean clone / CI, rather than failing there for a missing local note.
  const releaseDoc = await readFile(new URL('../docs/RELEASING.md', import.meta.url), 'utf8').catch(() => null);
  if (releaseDoc === null) {
    process.stdout.write('       note: docs/RELEASING.md is absent (local-only file) — skipping runbook assertions\n');
  } else {
    // Match the intent, not one exact wording: the section may be rephrased
    // (it already was once) but it must keep explaining the tag-commit rule.
    // The recipes are deliberately tag-agnostic (<tag>), since hard-coded tag
    // names went stale the moment this repo's history and tags were reset.
    const explainsRule = /标签指向的那个提交|标签所指提交/.test(releaseDoc);
    assert.ok(explainsRule, 'docs/RELEASING.md explains which workflow version runs for a tag');
    assert.ok(/git tag -f\s+\S+/.test(releaseDoc), 'docs/RELEASING.md shows how to move a tag onto the fixed commit');
    assert.ok(/git show\s+\S+:.github\/workflows\/release\.yml/.test(releaseDoc), 'docs/RELEASING.md shows how to inspect the workflow a tag carries');
    // Pin the worked example: the section once lost it and nothing failed.
    assert.ok(/\|\s*`T1`\s*\|/.test(releaseDoc) && /\|\s*`T2`\s*\|/.test(releaseDoc), 'docs/RELEASING.md keeps the worked example for the tag-commit rule');
    // ...but it has to stay generic. Real values rot: this repo reset its history
    // and cleared its tags once already, which silently falsified the old example.
    // (Note the identity section carries an 8-digit account id, so only a full
    // 40-char hash counts as a real commit reference here.)
    assert.ok(!/\b[0-9a-f]{40}\b/.test(releaseDoc), 'docs/RELEASING.md uses placeholder commits, not real 40-char hashes');
    assert.ok(!/\b\d{1,2}:\d{2}\b/.test(releaseDoc), 'docs/RELEASING.md uses placeholder times, not real clock times');
  }

  // The stated check count stays in the README (still developer-facing) even
  // though the release runbook moved out. It drifted twice while this suite
  // grew, so derive it from the same array the runner uses instead of trusting
  // a hand-edited number.
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const declared = [...readme.matchAll(/(\d+) 项(?:自检|断言)/g)].map((m) => Number(m[1]));
  assert.ok(declared.length > 0, 'README states how many checks the suite has');
  for (const value of declared) assert.equal(value, checks.length, `README claims ${value} checks, the suite defines ${checks.length}`);
});

let failed = 0;
for (const { label, fn } of checks) {
  try {
    await fn();
    process.stdout.write(`  ok   ${label}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  FAIL ${label}\n       ${error?.message ?? error}\n`);
  }
}

process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`);
if (failed > 0) process.exitCode = 1;
