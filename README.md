# dsh-plugin-export-md

[![Release](https://img.shields.io/github/v/release/ErickYu-code/dsh-plugin-export-md?sort=semver)](https://github.com/ErickYu-code/dsh-plugin-export-md/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/dsh-%3E%3D0.1.5--rc.1-4f46e5.svg)](#环境要求)

把 DeepSeek Harness 的对话日志导出成 Markdown 文档的 DSH 插件。

在任意会话的输入框里敲 `/export-md`，当前会话就会渲染成一份 Markdown 文件，
默认保存到 `~/.dsh/exports/`。命令直接作用于会话日志，**不产生模型消息、不消耗 token**。

```
/export-md                      按默认级别（normal）导出
/export-md --brief              只要对话正文
/export-md --full               全量导出（含系统提示词与注入上下文）
/export-md --tools --no-tool-output   保留工具名，去掉工具输出
/export-md --tool-chars 0 --full      工具输出完整保留（文件会很大）
/export-md --help               查看全部选项
```

零运行时依赖，纯 JavaScript（ESM），无需构建步骤。

---

## 一、安装

### 环境要求

| 项目 | 要求 |
| --- | --- |
| DeepSeek Harness | `>= 0.1.5-rc.1`（在 `0.1.5-rc.2` 上开发与验证） |
| Node.js | `>= 20` |
| pnpm | 需要（`dsh plugin` 是 pnpm 的转发器，插件本身不依赖任何包） |
| Profile | `web` / `headless` / 任意含 `dsh-base` 的 profile |

### 方式 A：从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:ErickYu-code/dsh-plugin-export-md
```

想锁定版本就带上标签或提交号（`v1.0.0` 是首个公开版本，标签发布后即可用）：

```bash
dsh plugin --profile web add github:ErickYu-code/dsh-plugin-export-md#v1.0.0
dsh plugin --profile web add github:ErickYu-code/dsh-plugin-export-md#<commit-sha>
```

`dsh plugin` 会在 `~/.dsh/profiles/web/` 里执行 pnpm 安装，
然后按安装态把声明了 `dsh.bundle` 的依赖自动追加进 `dsh.profile.bundles`：

```jsonc
{
  "dependencies": { "dsh-plugin-export-md": "github:ErickYu-code/dsh-plugin-export-md", ... },
  "dsh": { "profile": { "bundles": [ ..., "dsh-plugin-export-md" ] } }
}
```

> `github:` 前缀由 pnpm 解析，会以 git 依赖方式安装。本插件**没有 `prepare` 脚本、没有原生依赖**，
> 因此不会触发 pnpm 的 `allowBuilds` 拦截 —— 这是刻意的设计，见「开发者说明」。

### 方式 B：从本地目录安装（改代码 / 离线）

```bash
git clone https://github.com/ErickYu-code/dsh-plugin-export-md.git
dsh plugin --profile web add ./dsh-plugin-export-md
```

本地路径会以 `link:` 方式装进 profile，改完源码无需重装，刷新页面即可生效。

### 装完确认

```bash
cat ~/.dsh/profiles/web/package.json     # bundles 里应有 dsh-plugin-export-md
```

本 profile 的 `patchReload` 是 `live`，配置层会热重载；如果斜杠菜单里还没出现
`/export-md`，重启一次 DSH 服务即可。

### 卸载

```bash
dsh plugin --profile web remove dsh-plugin-export-md
```

### 从本地源码安装切换到 GitHub 安装

先用 `link:` 装过本地目录的话，`dsh plugin add` 会因为同名依赖已存在而报错，
先摘掉再装：

```bash
dsh plugin --profile web remove dsh-plugin-export-md
dsh plugin --profile web add github:ErickYu-code/dsh-plugin-export-md
```

### 手动挂载（可选）

不想动 `dsh.profile.bundles` 的话，直接在 `~/.dsh/profiles/web/cordis.patch.yml`
里加一行，效果相同：

```yaml
- insert:
    - id: export-md
      name: dsh-plugin-export-md
```

---

## 二、命令参数

### 预设（决定各部分的默认开关）

| 预设 | 正文 | 思考过程 | 工具调用 | 工具输出 | 注入上下文 | 系统提示词 | 用量 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `--brief` | ✅ | — | — | — | — | — | — |
| `--normal`（默认） | ✅ | ✅ | ✅ | ✅ | — | — | ✅ |
| `--full` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

预设后面的开关可以逐项覆盖，**后写的生效**：

```
/export-md --full --no-tools --no-reasoning     # 全量，但不要工具和思考过程
/export-md --brief --tools                      # 精简，但要保留工具调用
```

### 全部开关

| 选项 | 说明 |
| --- | --- |
| `--tools` / `--no-tools` | 工具调用（名称与参数） |
| `--tool-output` / `--no-tool-output` | 工具返回结果（折叠块） |
| `--reasoning` / `--no-reasoning` | 思考过程（别名 `--thinking`） |
| `--mentions` / `--no-mentions` | 被注入的上下文消息（AGENTS.md、技能内容、目录快照等） |
| `--system` / `--no-system` | 系统提示词（作为文末附录） |
| `--meta` / `--no-meta` | 会话元信息（YAML frontmatter + 标题信息栏） |
| `--usage` / `--no-usage` | token 用量统计（文末表格） |
| `--timestamps` / `--no-timestamps` | 每轮/每条的时间戳 |
| `--max-chars <n>` | 单块最大字符数（正文/思考过程/系统提示词），`0` = 不截断（默认 20000） |
| `--tool-chars <n>` | **单条工具结果**的最大字符数，`0` = 交给 `--max-chars`（默认 2000） |
| `--out <path>` | 指定导出路径（文件或目录）；`~` 会展开 |
| `-h` / `--help` | 用法说明 |
| `-o<path>` | `--out` 的短写 |

选项中带空格的值可以加引号：`/export-md --out "~/Desktop/我的会话.md"`。

### 落盘位置

1. `--out <路径>` 指定的位置；
2. 否则 `<DSH_HOME>/exports/`（`DSH_HOME` 未设置时即 `~/.dsh/exports/`）。

文件名形如 `20260102-030405-会话标题-abcd1234.md`；同名时自动加 `-2`、`-3` 后缀。
标题里的中文会保留，只有路径非法字符会被替换。

---

## 三、导出文件长什么样

```markdown
---
title: "给导出插件加一个 --brief 级别"
session_id: "session-1f2e3d4c-5b6a-7980"
created_at: "2026-01-02T03:04:05.000Z"
exported_at: "2026-01-02T04:00:00.000Z"
cwd: "/Users/you/project"
event_count: 8
exported_by: "dsh-plugin-export-md v1.0.0"
---

# 给导出插件加一个 --brief 级别

- 创建于 2026-01-02 11:04:05
- 工作目录 `/Users/you/project`
- 导出时间 2026-01-02 12:00:00

> 会话 `session-1f2e3d4c-5b6a-7980` · 共 1 轮对话

## 第 1 轮 · 2026-01-02 11:04:07

### 🧑 用户 · 2026-01-02 11:04:07

导出的 md 里不要把工具输出全塞进来，太长了。

### 🤖 助手 · 2026-01-02 11:04:08

可以：默认把工具输出放进 `<details>` 折叠块，再加一个 `--brief` 级别只保留对话正文。

> tokens: 输入 4210 · 输出 512 · 缓存命中 3000 · 思考 128

#### 🔧 read · `src/render.js`

<details><summary>调用参数</summary>

``` json
{ "file_path": "src/render.js", "offset": 1, "limit": 40 }
```

</details>
```

设计要点：

- **轮次为 H2，用户/助手为 H3，工具调用为 H4** —— 折叠展开后层级仍然清楚。
  「轮」只数**人提出的问题**：被注入的上下文（AGENTS.md、技能内容、目标续跑通知等）
  单独折叠、单独编号，不会把 5 条注入算成 5 轮对话。
- 工具输出放 `<details>` 折叠块，文件不至于被几万行日志淹没；单条结果按
  `--tool-chars` 截断（保留头 70% + 尾 30%，中段标注省略了多少字符），
  需要完整内容用 `--tool-chars 0`。工具参数另有 4000 字符上限。
- 代码块围栏会按内容自动加长，内容里本来就有 ``` 也不会截断文档结构。
- **上下文压缩产生的「改写型」surface 事件会被跳过**：压缩摘要只是给模型看的，
  用户实际看到的原始对话才是导出的内容；跳过的条数会在文末以注释说明。
- 时间戳一律为本地时间。

### 文件有多大

取决于工具调用量。实际测量（一次 140 步、172 次工具调用的真实会话）：

| 级别 | 大小 | 说明 |
| --- | ---: | --- |
| `--brief` | 7.5 KB | 只有人机对话正文 |
| `--normal` | 673 KB | 含思考过程与工具参数/结果（每条结果截断到 2K 字符） |
| `--full` | 750 KB | 再加系统提示词与注入上下文 |

想要「能直接读的纪要」用 `--brief`；想要「完整可复盘的工作记录」用 `--normal`。

---

## 四、开发者说明

### 目录结构

仓库根目录**就是**插件包，没有 `packages/` 之类的嵌套 —— 这样
`dsh plugin add github:<user>/dsh-plugin-export-md` 能直接命中 `package.json`。

```
dsh-plugin-export-md/
├── package.json         dsh.bundle.patch 声明 + 零运行时依赖
├── cordis.patch.yml     向 profile 插入一行 host 插件
├── index.js             包入口（重导出 src/index.js）
├── src/
│   ├── index.js         cordis 插件：注册 /export-md 命令
│   ├── options.js       命令语法解析（预设 + 开关）
│   ├── render.js        会话事件日志 → Markdown（纯函数）
│   ├── text.js          围栏/YAML/文件名/截断等文本工具
│   └── export-file.js   导出目录解析与文件写入
├── examples/sample.js   用合成日志渲染一份样例，便于预览格式
└── test/run.js          24 项自检（node test/run.js）
```

### 数据来源

命令通过 `agent.id` 拿到会话 id，再经 Cordis 服务读取**完整且经过 replay 校验**的事件日志：

```js
ctx.get('sessionQuery').readSession(sessionId)
// → { session: SessionHeader, inheritedEventCount, events: SessionEvent[] }
```

标题取自 `ctx.sessionQuery.readTitle(sessionId)`，读不到就回落到日志里的
`session/title` 事件；再读不到就用文件名兜底。

### 服务依赖

插件在 `src/index.js` 里声明 `inject = ['commands', 'sessionQuery']`，两者都由
`@deepseek-ai/dsh-base` 提供（`commands` 与 `session-query-sqlite` 行），
因此 `dsh-web-app` 系 profile 开箱可用。

### 为什么写文件用 `node:fs` 而不是 `ctx.fs`

DSH 的沙箱围栏只允许写当前工作区（`workspace-write`），而导出目录
`~/.dsh/exports/` 按设计在工作区之外 —— 这也是 `--out` 可以指向任意路径的前提。
DSH 自身的状态文件（`settings.yaml`、`credentials`、agent presets）同样直接写
`$DSH_HOME`。所以这里有意绕开 `ctx.fs`；如果你希望导出受沙箱约束，
把 `src/export-file.js` 的 `writeExport` 换成 `ctx.fs.resolve` + `ctx.fs.writeText`
并显式传入 `ctx.sandboxPolicy.resolve({ session })` 即可。

### 自测

```bash
git clone https://github.com/ErickYu-code/dsh-plugin-export-md.git
cd dsh-plugin-export-md
npm test                                   # 语法检查 + 24 项断言
node examples/sample.js --full             # 打印一份全量样例
node examples/sample.js --brief /tmp/x.md  # 写一份精简样例
```

自测覆盖：命令语法（预设、开关、取值、错误路径）、渲染器（各事件类型、
截断、围栏自适应、压缩改写过滤、注入上下文分组）、落盘（唯一文件名、`--out`、
`DSH_HOME` 解析）、插件端到端（注册命令 → 读会话 → 渲染 → 写文件），
以及发版一致性（`package.json` 版本 = `VERSION` = 发布说明文件名）。

### 配置项（可选）

在 profile 的 `cordis.patch.yml` 里可以覆盖默认值：

```yaml
- id: export-md
  config:
    level: full          # 默认预设：brief | normal | full
    outputDir: ""        # 覆盖默认导出目录，留空 = <DSH_HOME>/exports
    maxChars: 20000      # 正文单块的默认字符预算，0 = 不截断
    toolChars: 2000      # 单条工具结果的默认字符预算，0 = 交给 maxChars
```

---

## 五、已知限制

- 只导出**当前会话**。跨会话或历史会话导出需要把 `agent.id` 换成目标 id，目前没做参数。
- 图片/文件附件只记录引用信息，不会把二进制内容嵌进 Markdown。
- `--max-chars` / `--tool-chars` 截断保留「头部 70% + 尾部 30%」，中段丢弃并标注省略字符数。
- 导出发生在命令触发的那一刻；之后新产生的对话不在文件里，重跑一次即可。
- 导出目录在工作区之外，因此写文件**不经过 DSH 沙箱**（见上文说明），
  在 `read-only` 权限模式下同样会写入 —— 这是有意为之，介意的话请把
  `writeExport` 换成 `ctx.fs`。

## 贡献

Issue 和 PR 都欢迎。提交前请确保 `npm test` 通过，并保持零运行时依赖这一约束。

## License

[MIT](LICENSE)
