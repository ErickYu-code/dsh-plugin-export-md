/**
 * The `/export-md` command grammar: preset levels plus per-section switches.
 *
 * The parser is deliberately total — it never throws. Every entry in
 * {@link FLAG_SPECS} is a `--flag` or `--no-flag` boolean switch except the two
 * valued options (`--max-chars`, `--out`), and `parseExportArgs` reports the
 * first problem it meets as a user-facing message so the command can answer
 * with usage text instead of an exception.
 *
 * @module dsh-plugin-export-md/options
 */

/** Content sections that can be switched on or off. */
export const SECTION_KEYS = ['system', 'reasoning', 'tools', 'toolOutputs', 'meta', 'usage', 'mentions'];

/** Named presets, from leanest to richest. */
export const PRESETS = {
  brief: {
    system: false,
    reasoning: false,
    tools: false,
    toolOutputs: false,
    meta: false,
    usage: false,
    mentions: false,
  },
  normal: {
    system: false,
    reasoning: true,
    tools: true,
    toolOutputs: true,
    meta: true,
    usage: true,
    mentions: false,
  },
  full: {
    system: true,
    reasoning: true,
    tools: true,
    toolOutputs: true,
    meta: true,
    usage: true,
    mentions: true,
  },
};

/**
 * Boolean switches.
 *
 * `alias` names the section a switch also implies: turning that section on
 * clears the opposite alias (the last switch on the line wins), which is what
 * makes `/export-md --with-reasoning --no-reasoning` mean "off".
 */
export const FLAG_SPECS = [
  { flag: 'system', field: 'system', section: 'system', describe: '包含系统提示词' },
  { flag: 'reasoning', field: 'reasoning', section: 'reasoning', describe: '包含思考过程（reasoning）' },
  { flag: 'tools', field: 'tools', section: 'tools', describe: '包含工具调用（名称与参数）' },
  { flag: 'tool-output', field: 'toolOutputs', section: 'toolOutputs', describe: '包含工具返回结果' },
  { flag: 'meta', field: 'meta', section: 'meta', describe: '包含会话元信息（frontmatter）' },
  { flag: 'usage', field: 'usage', section: 'usage', describe: '包含 token 用量统计' },
  { flag: 'mentions', field: 'mentions', section: 'mentions', describe: '包含注入的上下文/指令消息' },
  { flag: 'thinking', field: 'reasoning', section: 'reasoning', describe: '--reasoning 的别名' },
  { flag: 'timestamps', field: 'timestamps', describe: '输出每条消息的时间戳（默认开启）' },
];

/** Valued options. */
export const VALUE_SPECS = [
  {
    flag: 'max-chars',
    field: 'maxChars',
    describe: '单个块的最大字符数（0 = 不截断）',
    example: '--max-chars 8000',
    parse(raw) {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0) return { error: `--max-chars 需要一个非负整数，收到 ${JSON.stringify(raw)}` };
      return { value };
    },
  },
  {
    flag: 'tool-chars',
    field: 'toolChars',
    describe: '单条工具结果的最大字符数（默认 2000；0 = 不截断，用 --max-chars 统一限制）',
    example: '--tool-chars 8000',
    parse(raw) {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0) return { error: `--tool-chars 需要一个非负整数，收到 ${JSON.stringify(raw)}` };
      return { value };
    },
  },
  {
    flag: 'out',
    field: 'out',
    describe: '指定导出文件的绝对/相对路径',
    example: '--out ~/Desktop/会话.md',
    parse(raw) {
      if (raw === '') return { error: '--out 需要一个文件路径' };
      return { value: raw };
    },
  },
];

/** One-letter aliases for the two most-used options. */
const SHORT_ALIASES = { h: 'help', o: 'out' };

/** Flag names that also accept a leading `--with-` / `--no-` form. */
const PREFIXED = new Set(['system', 'reasoning', 'tools', 'tool-output', 'meta', 'usage', 'mentions', 'thinking', 'timestamps']);

/**
 * Whether a token is spelled like an option rather than a value.
 *
 * A lone `-`, `--`, or a negative number are values; everything else starting
 * with `-` is an option, so `--tools --brief` never swallows the second flag
 * as the first one's value.
 *
 * @param token - one whitespace-delimited token.
 * @returns true when the token starts an option.
 */
function isOptionToken(token) {
  if (typeof token !== 'string' || !token.startsWith('-')) return false;
  if (token === '-' || token === '--') return false;
  return !/^-\d/.test(token);
}

/** Usage text shown by `/export-md --help` and on a parse error. */
export const USAGE = `用法：/export-md [预设] [选项]

预设（决定各部分的默认开关，后面的选项可覆盖它）
  --brief          最精简：只导出用户与助手的对话正文
  --normal         标准（默认）：正文 + 思考过程 + 工具调用 + 用量
  --full           全部：在标准之上再加系统提示词与注入的上下文消息

选项
  --tools / --no-tools                 工具调用（名称与参数）
  --tool-output / --no-tool-output     工具返回结果
  --reasoning / --no-reasoning         思考过程（别名 --thinking）
  --mentions / --no-mentions           注入的上下文消息（AGENTS.md、技能等）
  --system / --no-system               系统提示词（追加在文末）
  --meta / --no-meta                   会话元信息（frontmatter）
  --usage / --no-usage                 token 用量统计
  --timestamps / --no-timestamps       每轮时间戳
  --max-chars <n>                      单个块最大字符数，0 = 不截断（默认 20000）
  --tool-chars <n>                     单条工具结果最大字符数，0 = 不截断（默认 2000）
  --out <path>                         指定导出路径（默认 ~/.dsh/exports/）

示例
  /export-md                          按默认标准级别导出本会话
  /export-md --brief                  只要对话正文
  /export-md --full                   全量导出
  /export-md --tools --no-tool-output 保留工具名，去掉工具输出
  /export-md --tool-chars 0 --full    工具输出完整保留（文件会很大）
  /export-md --max-chars 0 --full     全量且不做任何截断`;

/**
 * Parse the raw command input that follows `/export-md`.
 *
 * @param input - verbatim text after the command name.
 * @param defaults - the configured default section switches.
 * @returns `{ options }` on success or `{ error }` with a user-facing message.
 */
export function parseExportArgs(input, defaults) {
  const base = { ...PRESETS.normal, ...(defaults ?? {}) };
  const options = {
    ...base,
    timestamps: defaults?.timestamps ?? true,
    maxChars: defaults?.maxChars ?? 20000,
    toolChars: defaults?.toolChars ?? 2000,
    out: undefined,
    help: false,
    preset: undefined,
  };
  let sawPreset = false;

  const tokens = tokenize(input);
  for (const token of tokens) {
    if (token.kind === 'positional') {
      const preset = token.value.toLowerCase();
      if (Object.hasOwn(PRESETS, preset)) {
        Object.assign(options, PRESETS[preset]);
        sawPreset = true;
        options.preset = preset;
        continue;
      }
      return {
        error: `无法识别的参数 ${JSON.stringify(token.value)}。可用的预设是 --brief、--normal、--full；输入 /export-md --help 查看全部选项。`,
      };
    }

    const { negated, hasValue } = token;
    const value = token.value;
    const name = SHORT_ALIASES[token.name] ?? token.name;

    if (name === 'help') {
      options.help = true;
      continue;
    }

    if (name === 'preset') {
      if (!hasValue) return { error: '--preset 需要一个值：brief / normal / full' };
      const preset = String(value).toLowerCase();
      if (!Object.hasOwn(PRESETS, preset)) return { error: `未知预设 ${JSON.stringify(value)}，可用：brief、normal、full` };
      Object.assign(options, PRESETS[preset]);
      sawPreset = true;
      options.preset = preset;
      continue;
    }

    if (!negated && Object.hasOwn(PRESETS, name)) {
      if (hasValue && !isOptionToken(String(value))) return { error: `预设 --${name} 不接受取值（收到 ${JSON.stringify(value)}）` };
      Object.assign(options, PRESETS[name]);
      sawPreset = true;
      options.preset = name;
      continue;
    }

    const boolSpec = FLAG_SPECS.find((spec) => spec.flag === name);
    if (boolSpec !== undefined) {
      if (hasValue && !isOptionToken(String(value))) return { error: `选项 --${name} 不接受取值（收到 ${JSON.stringify(value)}）` };
      options[boolSpec.field] = !negated;
      continue;
    }

    const valueSpec = VALUE_SPECS.find((spec) => spec.flag === name);
    if (valueSpec !== undefined) {
      if (negated) return { error: `选项 --${name} 不能被 --no- 取反` };
      if (!hasValue) return { error: `选项 --${name} 需要一个取值，例如 ${valueSpec.example}` };
      const parsed = valueSpec.parse(String(value));
      if (parsed.error !== undefined) return { error: parsed.error };
      options[valueSpec.field] = parsed.value;
      continue;
    }

    return {
      error: `未知选项 ${negated ? '--no-' : '--'}${name}。输入 /export-md --help 查看全部选项。`,
    };
  }

  if (!sawPreset) options.preset = 'normal';
  return { options };
}

/**
 * Split one command line into option tokens.
 *
 * Supports `--flag`, `--no-flag`, `--flag=value`, `--flag value`,
 * short `-h`/`-o`, `--` as an end-of-options marker, and single/double quoted
 * values containing spaces.
 *
 * @param input - raw command input.
 * @returns token descriptors in source order.
 */
function tokenize(input) {
  const text = typeof input === 'string' ? input : '';
  const tokens = [];
  let index = 0;
  let optionsEnded = false;

  const readValue = (inline) => {
    if (inline !== undefined) return { value: inline, hasValue: true };
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (index >= text.length) return { value: undefined, hasValue: false };
    const quote = text[index] === '"' || text[index] === "'" ? text[index] : undefined;
    if (quote === undefined) {
      const start = index;
      while (index < text.length && !/\s/.test(text[index])) index += 1;
      return { value: text.slice(start, index), hasValue: true };
    }
    index += 1;
    const start = index;
    while (index < text.length && text[index] !== quote) index += 1;
    const value = text.slice(start, index);
    if (index < text.length) index += 1;
    return { value, hasValue: true };
  };

  /**
   * Whether the next token is an option rather than a value.
   *
   * A lone `-` and `--` are values/terminators, not options; anything else
   * starting with `-` is treated as an option so `--tools --brief` never
   * swallows the second flag as the first one's value.
   * @returns true when the next non-space character starts an option token.
   */
  const peekOption = () => {
    let lookahead = index;
    while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1;
    return isOptionToken(text.slice(lookahead));
  };

  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (optionsEnded) {
      const start = index;
      while (index < text.length && !/\s/.test(text[index])) index += 1;
      tokens.push({ kind: 'positional', value: text.slice(start, index) });
      continue;
    }
    if (char === '-' && text[index + 1] === '-') {
      if (text[index + 2] === undefined || /\s/.test(text[index + 2])) {
        optionsEnded = true;
        index += 2;
        continue;
      }
      index += 2;
      const start = index;
      while (index < text.length && !/[\s=]/.test(text[index])) index += 1;
      let name = text.slice(start, index);
      let negated = false;
      if (name.startsWith('no-')) {
        negated = true;
        name = name.slice(3);
      } else if (name.startsWith('with-') && PREFIXED.has(name.slice(5))) {
        name = name.slice(5);
      }
      if (text[index] === '=') {
        index += 1;
        const inline = readValue(undefined);
        tokens.push({ kind: 'option', name, negated, value: inline.value ?? '', hasValue: true });
        continue;
      }
      // A value is only claimed when the next token cannot itself be an
      // option; `--tools --brief` must stay two flags.
      const looked = peekOption() ? { value: undefined, hasValue: false } : readValue(undefined);
      tokens.push({ kind: 'option', name, negated, value: looked.value, hasValue: looked.hasValue });
      continue;
    }
    if (char === '-') {
      // Short form: `-h` is a bare flag, `-o<path>` / `-o <path>` take a value.
      const name = text[index + 1];
      if (name === undefined || /\s/.test(name)) {
        const start = index;
        while (index < text.length && !/\s/.test(text[index])) index += 1;
        tokens.push({ kind: 'positional', value: text.slice(start, index) });
        continue;
      }
      index += 2;
      if (name === 'h') {
        tokens.push({ kind: 'option', name, negated: false, value: undefined, hasValue: false });
        continue;
      }
      const shortValue = text[index] !== undefined && !/\s/.test(text[index]) ? readValue(undefined).value : peekOption() ? undefined : readValue(undefined).value;
      tokens.push({ kind: 'option', name, negated: false, value: shortValue, hasValue: shortValue !== undefined });
      continue;
    }
    const start = index;
    while (index < text.length && !/\s/.test(text[index])) index += 1;
    tokens.push({ kind: 'positional', value: text.slice(start, index) });
  }

  return tokens;
}

/**
 * Describe the effective sections for the command's answer line.
 * @param options - parsed options.
 * @returns a short Chinese summary.
 */
export function summarizeSections(options) {
  const on = [];
  const off = [];
  const labels = {
    system: '系统提示词',
    reasoning: '思考过程',
    tools: '工具调用',
    toolOutputs: '工具输出',
    meta: '元信息',
    usage: '用量',
    mentions: '注入上下文',
  };
  for (const key of SECTION_KEYS) {
    (options[key] ? on : off).push(labels[key]);
  }
  const level = options.preset === undefined ? '自定义' : options.preset;
  return `级别 ${level}；包含：${on.join('、') || '（仅正文）'}${off.length > 0 ? `；不含：${off.join('、')}` : ''}`;
}
