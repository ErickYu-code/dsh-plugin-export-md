/**
 * Text helpers for the Markdown export: fence-safe code blocks, YAML-safe
 * scalar quoting, filename slugs, and character-budget truncation.
 *
 * @module dsh-plugin-export-md/text
 */

/**
 * Longest fence this renderer will emit. Content carrying a run at least this
 * long switches to the next fence flavour, and a document holding both falls
 * back to an indented block.
 */
const MAX_FENCE = 120;

/**
 * Pick a code fence long enough to survive the content.
 *
 * Backtick fences are preferred for rendering; when the content itself
 * contains a run of backticks at least as long as the fence, the fence grows.
 * The degenerate case (a line of {@link MAX_FENCE}+ backticks) falls back to a
 * tilde fence, and content holding both long runs is indented as a plain code
 * block — the only form that cannot be broken.
 *
 * @param content - the raw block content (no trailing newline required).
 * @param language - optional info string.
 * @returns the complete fenced block text, ending with a newline.
 */
export function codeBlock(content, language = '') {
  const text = typeof content === 'string' ? content : content === undefined || content === null ? '' : String(content);
  const backtickRun = longestRun(text, '`');
  const tildeRun = longestRun(text, '~');
  const info = language === '' || language === undefined ? '' : String(language);
  if (backtickRun < MAX_FENCE) return fence(text, '`', Math.max(3, backtickRun + 1), info);
  if (tildeRun < MAX_FENCE) return fence(text, '~', Math.max(3, tildeRun + 1), info);
  return indentBlock(text);
}

/**
 * Measure the longest consecutive run of one character.
 * @param text - text to scan.
 * @param char - single character to count.
 * @returns the longest run length, 0 when the character is absent.
 */
function longestRun(text, char) {
  let longest = 0;
  let current = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === char) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

/**
 * Render one fenced block.
 * @param text - block content.
 * @param char - fence character.
 * @param size - fence length.
 * @param info - info string placed after the opening fence.
 * @returns the fenced block text.
 */
function fence(text, char, size, info) {
  const marker = char.repeat(size);
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const separator = info === '' ? '' : ' ';
  return `${marker}${separator}${info}\n${body}\n${marker}\n`;
}

/**
 * Render an indented code block (the fence-proof fallback).
 * @param text - block content.
 * @returns the indented block text.
 */
function indentBlock(text) {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return `${body
    .split('\n')
    .map((line) => (line === '' ? '' : `    ${line}`))
    .join('\n')}\n`;
}

/**
 * Inline code span for a short value (tool names, ids, paths).
 * @param value - value to wrap.
 * @returns the inline span, using a longer delimiter when the value holds backticks.
 */
export function inlineCode(value) {
  const text = typeof value === 'string' ? value : String(value);
  if (text === '') return '``';
  const run = longestRun(text, '`');
  const marker = '`'.repeat(run + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${marker}${pad}${text}${pad}${marker}`;
}

/**
 * Quote one string as a YAML double-quoted scalar.
 * @param value - raw string.
 * @returns a value safe to place after `key: ` in the frontmatter.
 */
export function yamlString(value) {
  const text = typeof value === 'string' ? value : String(value);
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/**
 * Collapse text to a single line for headings and summaries.
 * @param value - raw text.
 * @param max - maximum characters before an ellipsis is appended.
 * @returns the collapsed single-line text.
 */
export function oneLine(value, max = 120) {
  const text = (typeof value === 'string' ? value : String(value ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Truncate content to a character budget, keeping head and tail visible.
 * @param text - raw content.
 * @param max - maximum characters to keep; 0 or negative disables truncation.
 * @param label - noun used in the omission notice.
 * @returns the possibly truncated text.
 */
export function truncate(text, max, label = '内容') {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (!Number.isFinite(max) || max <= 0 || value.length <= max) return value;
  const head = Math.max(1, Math.floor(max * 0.7));
  const tail = Math.max(0, max - head);
  const omitted = value.length - head - tail;
  const notice = `\n\n… [${label}已省略 ${omitted.toLocaleString('en-US')} 字符，完整内容见会话日志] …\n\n`;
  return `${value.slice(0, head)}${notice}${tail > 0 ? value.slice(value.length - tail) : ''}`;
}

/**
 * Show the head and the tail of long content, dropping the middle.
 *
 * Used for tool output, where both the beginning (what ran) and the end
 * (often the error or summary) carry signal that a head-only cut would lose.
 *
 * @param text - raw content.
 * @param max - maximum characters to keep; 0 or negative disables truncation.
 * @param label - noun used in the omission notice.
 * @returns the possibly shortened text.
 */
export function preview(text, max, label = '内容') {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (!Number.isFinite(max) || max <= 0 || value.length <= max) return value;
  const head = Math.max(1, Math.floor(max * 0.7));
  const tail = Math.max(0, max - head);
  const omitted = value.length - head - tail;
  const notice = `\n\n… [此处省略 ${omitted.toLocaleString('en-US')} 字符${label === '' ? '' : `（${label}）`}；用 --tool-chars 0 导出完整内容] …\n\n`;
  const tailText = tail > 0 ? value.slice(value.length - tail) : '';
  const boundary = tailText.indexOf('\n');
  const alignedTail = boundary >= 0 && boundary < tailText.length - 1 ? tailText.slice(boundary + 1) : tailText;
  return `${value.slice(0, head)}${notice}${alignedTail}`;
}

/**
 * Build a filesystem-safe, human-readable slug.
 *
 * CJK and other non-ASCII letters are preserved (they are valid in file
 * names and make the export recognizable); only path-hostile characters are
 * replaced.
 *
 * @param text - source text (usually the session title).
 * @param maxLength - maximum slug length.
 * @returns the slug, or an empty string when nothing usable remains.
 */
export function slugify(text, maxLength = 48) {
  const raw = typeof text === 'string' ? text : String(text ?? '');
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[.]+/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.\s]+|[-.\s]+$/g, '');
  if (cleaned === '') return '';
  const sliced = [...cleaned].slice(0, maxLength).join('');
  return sliced.replace(/[-.\s]+$/g, '');
}

/**
 * Format an epoch-millisecond timestamp for display.
 * @param time - Unix epoch milliseconds, or undefined.
 * @param withSeconds - include the seconds field.
 * @returns the formatted local timestamp, or an empty string when unavailable.
 */
export function formatTime(time, withSeconds = false) {
  if (typeof time !== 'number' || !Number.isFinite(time)) return '';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return withSeconds ? `${base}:${pad(date.getSeconds())}` : base;
}

/**
 * Format a compact local timestamp for file names.
 * @param date - the reference date.
 * @returns `YYYYMMDD-HHmmss`.
 */
export function fileStamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Shorten a long identifier for headings.
 * @param id - the identifier.
 * @param keep - trailing characters to keep.
 * @returns the shortened identifier.
 */
export function shortId(id, keep = 8) {
  const text = typeof id === 'string' ? id : String(id ?? '');
  if (text.length <= keep) return text;
  return text.slice(-keep);
}
