/**
 * Render a sample document from a synthetic session log, so the export format
 * can be reviewed without installing the plugin. Optionally writes the result
 * to a file.
 *
 * @example node examples/sample.js --full /tmp/sample.md
 */

import { writeFile } from 'node:fs/promises';
import { parseExportArgs } from '../src/options.js';
import { renderSessionMarkdown } from '../src/render.js';

const [, , ...args] = process.argv;
const target = args.find((arg) => !arg.startsWith('-'));
const line = args.filter((arg) => arg.startsWith('-')).join(' ');

const parsed = parseExportArgs(line, undefined);
if (parsed.error !== undefined) {
  process.stderr.write(`${parsed.error}\n`);
  process.exit(2);
}

const base = Date.UTC(2026, 0, 2, 3, 4, 5);
const at = (offset) => base + offset * 1000;
const events = [
  { type: 'session/title', seq: 0, time: at(0), data: { title: '示例：给导出插件加一个 --brief 级别' } },
  { type: 'turn/start', seq: 1, time: at(1), data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: at(2), data: { turn: 1, step: 1, message: { role: 'user', id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '导出的 md 里不要把工具输出全塞进来，太长了。' }] } } },
  { type: 'assistant/message', seq: 3, time: at(3), data: { turn: 1, step: 1, usage: { inputTokens: 4210, outputTokens: 512, cacheReadTokens: 3000, reasoningTokens: 128 }, message: { role: 'assistant', id: 'm2', source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' }, content: [{ type: 'reasoning', text: '用户要的是可读性。把工具输出放进折叠块，再加一个 --brief 级别。' }, { type: 'text', text: '可以：默认把工具输出放进 `<details>` 折叠块，再加一个 `--brief` 级别只保留对话正文。' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"src/render.js","offset":1,"limit":40}' }] }, stream: [] } },
  { type: 'tool/call', seq: 4, time: at(4), data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"src/render.js","offset":1,"limit":40}' } },
  { type: 'tool/result', seq: 5, time: at(5), data: { turn: 1, step: 1, message: { role: 'user', id: 'm3', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'export function renderSessionMarkdown({ header, events, title, options }) {\n  // …\n}' }] }] } } },
  { type: 'assistant/message', seq: 6, time: at(6), data: { turn: 1, step: 1, message: { role: 'assistant', id: 'm4', source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' }, content: [{ type: 'text', text: '已经按这个思路实现了，`--brief` 会跳过工具、思考过程和用量统计。' }] }, stream: [] } },
  { type: 'turn/end', seq: 7, time: at(7), data: { turn: 1 } },
];

const markdown = renderSessionMarkdown({
  header: { version: 3, id: 'session-1f2e3d4c-5b6a-7980', createdAt: base, cwd: '/Users/you/project', isSeeded: false },
  events,
  title: '示例：给导出插件加一个 --brief 级别',
  options: parsed.options,
  generatedAt: Date.UTC(2026, 0, 2, 4, 0, 0),
  version: '1.0.0',
});

if (target === undefined) process.stdout.write(markdown);
else {
  await writeFile(target, markdown, 'utf8');
  process.stdout.write(`wrote ${target}\n`);
}
