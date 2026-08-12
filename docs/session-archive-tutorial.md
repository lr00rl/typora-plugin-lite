# Session Archive 完整使用教程

`session-archive` 是一个独立的本地命令行工具。它根据 Codex 或 Claude Code 的 session ID，读取保存在本机的会话记录，整理成适合 Typora 长期阅读和留存的 Markdown。

它适合下面这些场景：

- 保存一次重要的 Agent 协作过程，保留提示词、可见回复、工具调用和结果。
- 只提取自己每轮的提示词与 Agent 最终回答，形成精简复盘笔记。
- 把几十 MB 的长会话自动拆成 Typora 可以正常打开的多个小文件。
- 使用 Claude-like Session 主题，在 Typora 大纲中按对话轮次快速跳转。

工具完全在本机运行，不会把会话上传到网络。默认还会排除隐藏推理、系统指令和运行时上下文，并对常见凭据、本机主目录与主动 HTML 做安全处理。

## 1. 开始之前

### 1.1 环境要求

- Node.js 22 或更高版本。
- 已经克隆并安装依赖的 `typora-plugin-lite` 仓库。
- 本机存在需要归档的 Codex 或 Claude Code 会话记录。
- Typora 不是生成归档的必要条件；只有阅读归档时才需要。

在仓库根目录检查 Node.js：

```bash
node --version
```

构建工具：

```bash
npm install
npm run build
```

构建完成后，CLI 位于：

```text
dist/tools/session-archive/index.mjs
```

查看命令帮助：

```bash
node dist/tools/session-archive/index.mjs --help
```

开发仓库时，也可以跳过预构建产物，直接运行 TypeScript 入口：

```bash
npm run session:archive -- codex <session-id> --output archive.md
```

## 2. 最推荐的使用方式

对于真实会话，推荐使用 `--output-dir`，而不是直接指定单个文件。这样短会话仍然只生成一份 Markdown，长会话则会自动分卷。

### 2.1 导出完整的 Codex 会话

```bash
node dist/tools/session-archive/index.mjs codex <session-id> \
  --output-dir ~/Notes/Agent-Sessions
```

完整模式会保存：

- 你的真实提示词。
- Codex 可见的 commentary。
- 工具调用及其参数。
- 工具返回结果。
- 每轮最终回答。

不会保存：

- 隐藏 reasoning 或 chain-of-thought。
- system prompt 和 developer instructions。
- Codex 注入的 `AGENTS.md instructions`、`environment_context`、hook prompt 等运行时上下文。

### 2.2 只保存提示词和最终回答

如果你的目标是快速复盘，而不是审计 Agent 的完整执行过程，使用 `answers` 模式：

```bash
node dist/tools/session-archive/index.mjs codex <session-id> \
  --output-dir ~/Notes/Agent-Sessions \
  --mode answers
```

也可以使用等价的简写：

```bash
node dist/tools/session-archive/index.mjs codex <session-id> \
  --output-dir ~/Notes/Agent-Sessions \
  --answers-only
```

该模式只保留：

```markdown
## YOU · 时间

> 你的提示词

## CODEX Answered · 时间

> Codex 这一轮的最终可见回答
```

commentary、工具调用、工具结果、附件事件与 Claude 分支不会写入精简归档。

### 2.3 导出 Claude Code 会话

```bash
node dist/tools/session-archive/index.mjs claude <session-id> \
  --output-dir ~/Notes/Agent-Sessions
```

Claude Code 完整模式还会恢复：

- 主因果链。
- alternate branches。
- 内联 sidechain。
- `subagents/*.jsonl` 中的 subagent 记录。

如果只需要主会话，不需要分支和 subagent 附录：

```bash
node dist/tools/session-archive/index.mjs claude <session-id> \
  --output-dir ~/Notes/Agent-Sessions \
  --main-only
```

## 3. 如何找到 session ID

### 3.1 Codex

Codex 默认把 rollout 放在：

```text
$CODEX_HOME/sessions/YYYY/MM/DD/
$CODEX_HOME/archived_sessions/
```

如果没有配置 `CODEX_HOME`，默认目录是：

```text
~/.codex
```

rollout 文件名通常类似：

```text
rollout-2026-08-12T00-00-00-01900000-0000-7000-8000-000000000000.jsonl
```

末尾的 UUID 就是 session ID。

列出一批 Codex 会话文件：

```bash
find "${CODEX_HOME:-$HOME/.codex}/sessions" \
  "${CODEX_HOME:-$HOME/.codex}/archived_sessions" \
  -type f -name 'rollout-*.jsonl' -print 2>/dev/null \
  | tail -n 20
```

如果已经知道 session ID 的一部分，可以查找对应文件：

```bash
find "${CODEX_HOME:-$HOME/.codex}" \
  -type f -name '*<session-id-or-prefix>*.jsonl' -print
```

### 3.2 Claude Code

Claude Code 默认把会话放在：

```text
~/.claude/projects/<encoded-project>/<session-id>.jsonl
```

如果设置了 `CLAUDE_CONFIG_DIR`，则从该目录的 `projects` 下查找。

列出一批 Claude Code 主会话：

```bash
find "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects" \
  -type f -name '*.jsonl' \
  ! -path '*/subagents/*' -print 2>/dev/null \
  | tail -n 20
```

文件名去掉 `.jsonl` 后就是 session ID。

## 4. 单文件输出与目录输出

### 4.1 明确输出为一个文件

```bash
node dist/tools/session-archive/index.mjs codex <session-id> \
  --output ~/Notes/Agent-Sessions/my-session.md
```

`--output` 保持输出为一个 Markdown 文件，不执行自动分卷。它适合确认体积较小的会话。

也可以使用短参数：

```bash
node dist/tools/session-archive/index.mjs codex <session-id> \
  -o ~/Notes/Agent-Sessions/my-session.md
```

### 4.2 自动选择单文件或分卷

```bash
node dist/tools/session-archive/index.mjs codex <session-id> \
  --output-dir ~/Notes/Agent-Sessions \
  --max-file-size 4MiB
```

当最终 Markdown 不超过限制时，输出：

```text
Agent-Sessions/
└── codex-session-<session-id>.md
```

超过限制时，输出：

```text
Agent-Sessions/
└── codex-session-<session-id>/
    ├── index.md
    ├── part-01.md
    ├── part-02.md
    └── ...
```

其中：

- `index.md` 列出全部分卷及每卷起始内容。
- 每个分卷顶部都有返回索引、上一卷和下一卷链接。
- 每个 Markdown 文件都不会超过 `--max-file-size`。
- 分卷只在生成器控制的事件块之间进行。
- 单个超大工具输出会变成多个各自闭合的代码围栏，不会跨文件截断 Markdown fence。

### 4.3 大小建议

默认值是 `4MiB`，最小允许值是 `64KiB`。

| 使用场景 | 建议值 |
| --- | --- |
| 老机器、包含大量代码块 | `2MiB` |
| 普通 Typora 长期阅读 | `4MiB` |
| 机器性能较好、希望减少分卷 | `8MiB` |
| 专门测试分卷行为 | `64KiB`–`256KiB` |

支持的单位包括：

```text
B, KB, KiB, MB, MiB, GB, GiB
```

对于已经达到二三十 MB、Typora 拒绝打开的会话，建议从 `2MiB` 或 `4MiB` 开始。

## 5. 生成后的 Markdown 结构

### 5.1 完整模式

完整归档的大纲大致如下：

```markdown
# Session title

## YOU · 2026-08-10 02:58:45.925Z

## CODEX Replying

### *CODEX · commentary · 2026-08-10 02:58:53.623Z*

#### TOOL · exec_command · CALL · 2026-08-10 02:59:01.000Z

#### TOOL · exec_command · RESULT · 2026-08-10 02:59:02.000Z

### CODEX Answered · 2026-08-10 03:00:00.000Z
```

这样设计有两个目的：

1. 在正文中清楚区分问题、进行中的回复、证据和最终结论。
2. 在 Typora 大纲中直接跳到任意一轮或任意工具证据。

Claude Code 会使用 `CLAUDE Replying` 和 `CLAUDE Answered`。alternate branch 和 subagent 会放在 `Recovered branches` 下的更深标题层级。

### 5.2 标题来源

Codex 标题优先级：

1. Codex thread 的显式 name。
2. `state_5.sqlite` 中的自动 title。
3. 第一条真实用户提示词的前 72 个字符。
4. `Codex session`。

Claude Code 标题优先级：

1. `custom-title`。
2. `ai-title`。
3. 第一条真实用户提示词。
4. `Claude Code session`。

可以随时使用 `--title` 覆盖：

```bash
node dist/tools/session-archive/index.mjs codex <session-id> \
  --output-dir ~/Notes/Agent-Sessions \
  --title "插件系统架构审计与修复"
```

Codex 标题数据库读取属于尽力而为的增强。数据库缺失、正在迁移或当前 Node.js 不支持 SQLite 时，归档不会失败，而是自动回退到第一条真实提示词。

## 6. 安装配套 Typora 主题

主题位于独立仓库 `Typora_Claude-Like_Theme`，提供：

- `Claude-like Session`
- `Claude-like Session Dark`

Session 变体只影响明确选择该主题的对话归档，不会改变普通 `Claude Like` 笔记。

### 6.1 macOS

Typora 主题目录通常是：

```text
~/Library/Application Support/abnerworks.Typora/themes
```

将主题仓库中的以下内容复制到该目录：

```text
claude-like.css
claude-like-dark.css
claude-like-session.css
claude-like-session-dark.css
session/agent-session.css
```

示例：

```bash
theme_repo=/absolute/path/to/Typora_Claude-Like_Theme
theme_dir="$HOME/Library/Application Support/abnerworks.Typora/themes"

mkdir -p "$theme_dir/session"
cp "$theme_repo/claude-like.css" "$theme_dir/"
cp "$theme_repo/claude-like-dark.css" "$theme_dir/"
cp "$theme_repo/claude-like-session.css" "$theme_dir/"
cp "$theme_repo/claude-like-session-dark.css" "$theme_dir/"
cp "$theme_repo/session/agent-session.css" "$theme_dir/session/"
```

然后在 Typora 中选择：

```text
Themes → Claude-like Session
```

或：

```text
Themes → Claude-like Session Dark
```

如果菜单中没有出现，重启 Typora 或使用主题菜单重新加载。

### 6.2 主题带来的效果

- 会话 H1 保持文档标题感，而不是聊天窗口标题。
- H2–H6 对话层级在正文和大纲中保持一致。
- 用户与 Agent 内容使用很浅的背景区分，不使用厚重气泡。
- 工具输出最大高度约为视口的 48%，内部可滚动。
- 打印时移除工具区高度限制，并尽量避免标题和内容分页断开。
- 小屏幕下缩小页边距，不引入额外横向滚动。

## 7. 完整命令参数

```text
session-archive <codex|claude> <session-id> [options]

-o, --output <file>          输出为一个 Markdown 文件；- 表示 stdout
    --output-dir <dir>       自动选择单文件或索引分卷目录
    --max-file-size <size>   目录输出的单文件大小上限，默认 4MiB
    --mode <full|answers>    完整可见记录或提示词/最终回答
    --answers-only           --mode answers 的简写
    --source <jsonl>         显式使用一份 transcript，跳过自动发现
    --title <text>           覆盖归档标题
    --codex-home <dir>       覆盖 CODEX_HOME
    --codex-sqlite-home <dir>
                             覆盖 CODEX_SQLITE_HOME，只用于读取标题
    --claude-home <dir>      覆盖 CLAUDE_CONFIG_DIR
    --main-only              Claude 不恢复 alternate/subagent 分支
-f, --force                  安全替换已有输出目标
-h, --help                   显示帮助
```

`--output` 和 `--output-dir` 不能同时使用。`--max-file-size` 只对 `--output-dir` 有意义。

## 8. 进阶用法

### 8.1 显式指定 transcript

当自动发现遇到同 ID 多份 Claude 主记录，或者需要分析复制出来的测试文件时：

```bash
node dist/tools/session-archive/index.mjs codex <session-id> \
  --source /absolute/path/to/rollout.jsonl \
  --output-dir ~/Notes/Agent-Sessions
```

Claude 显式 `--source` 只读取这一份文件，不会自动猜测同目录中的 subagent 文件。

### 8.2 使用自定义 Codex 目录

```bash
node dist/tools/session-archive/index.mjs codex <session-id> \
  --codex-home /path/to/codex-home \
  --output-dir ~/Notes/Agent-Sessions
```

如果 rollout 和 SQLite 状态库不在同一个目录：

```bash
node dist/tools/session-archive/index.mjs codex <session-id> \
  --codex-home /path/to/codex-home \
  --codex-sqlite-home /path/to/codex-state \
  --output-dir ~/Notes/Agent-Sessions
```

也可以使用环境变量：

```bash
export CODEX_HOME=/path/to/codex-home
export CODEX_SQLITE_HOME=/path/to/codex-state
```

### 8.3 使用自定义 Claude Code 目录

```bash
node dist/tools/session-archive/index.mjs claude <session-id> \
  --claude-home /path/to/claude-config \
  --output-dir ~/Notes/Agent-Sessions
```

或：

```bash
export CLAUDE_CONFIG_DIR=/path/to/claude-config
```

### 8.4 输出到管道

```bash
node dist/tools/session-archive/index.mjs codex <session-id> --output - \
  | less
```

普通诊断和成功摘要写入 stderr，因此 stdout 只包含 Markdown。

### 8.5 重新生成已有归档

默认不会覆盖已有文件或目录：

```text
OUTPUT_EXISTS: ...
```

确认目标就是旧归档后，显式使用：

```bash
node dist/tools/session-archive/index.mjs codex <session-id> \
  --output-dir ~/Notes/Agent-Sessions \
  --force
```

如果旧结果是分卷、新结果变成单文件，或者反过来，`--force` 会发布新结果后清理旧形态，避免同一个 session 留下两套互相冲突的归档。

## 9. 隐私与安全边界

### 9.1 默认会处理的内容

- 将当前用户主目录替换为 `~`。
- 脱敏高置信度 OpenAI、Anthropic、GitHub、GitLab、Slack 和 AWS 凭据。
- 脱敏常见 `API_KEY`、`TOKEN`、`SECRET`、`PASSWORD` 等赋值。
- 脱敏私钥块。
- 转义原始 HTML。
- 禁用 `javascript:`、`vbscript:`、`data:` 和 `file:` 主动 URI。
- 阻止 Markdown 图片在打开笔记时自动请求远端资源。
- 使用 `0600` 创建归档文件；分卷目录使用 `0700`。

### 9.2 始终排除的内容

- Codex reasoning item。
- Claude `thinking` 和 `redacted_thinking`。
- system prompt 与 developer instructions。
- Codex 的 AGENTS、environment、skill、hook 等上下文信封。

你可能在旧版归档开头见过一大段类似 system prompt 的内容。它通常不是你真正发送的提示词，而是 Codex 以 user role 持久化的运行时上下文。当前版本会把它排除，避免污染 `YOU` 对话轮次。

真正的底层 system prompt 也不保证被 provider 完整持久化，因此工具不能可靠恢复一个不存在于本机会话文件中的提示词。

### 9.3 分享之前仍要人工复核

自动脱敏只针对高置信度模式。业务名称、客户数据、数据库内容、内部域名和模型输出中的隐私信息仍可能保留。

对外分享之前建议检查：

```bash
rg -n '/Users/|/home/|Authorization:|Bearer |API_KEY|TOKEN|SECRET|PASSWORD' \
  /path/to/exported/archive
```

还应人工阅读与业务数据相关的工具输出。

## 10. 失败语义和退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功，并生成至少一个可见归档块 |
| `2` | 参数错误 |
| `3` | 找不到 session 或显式 source |
| `4` | 读取、解析、渲染或发布失败 |
| `5` | 没有恢复到当前模式可导出的可见内容 |

工具会在读取 JSONL 前后校验文件稳定性。如果会话仍在高速写入并且读取期间发生变化，会返回：

```text
SESSION_SOURCE_CHANGED
```

这比生成一份看似成功、实际缺行的笔记更安全。稍后重新运行即可。

## 11. 常见问题

### 11.1 `SESSION_NOT_FOUND`

检查：

1. provider 是否正确，是 `codex` 还是 `claude`。
2. session ID 是否完整。
3. `CODEX_HOME`、`CODEX_SQLITE_HOME` 或 `CLAUDE_CONFIG_DIR` 是否使用了自定义路径。
4. 会话是否已进入 Codex 的 `archived_sessions`；工具会自动搜索该目录，但自定义 home 必须正确。

必要时使用 `--source` 直接指定 JSONL。

### 11.2 `AMBIGUOUS_SESSION`

Claude 自动发现找到了多份可能的主 transcript。使用：

```bash
--source /absolute/path/to/correct-session.jsonl
```

### 11.3 `OUTPUT_EXISTS`

工具默认禁止覆盖。确认目标无误后添加 `--force`，或者选择一个新目录。

### 11.4 `MAX_FILE_SIZE_TOO_SMALL`

最小上限是 `64KiB`：

```bash
--max-file-size 64KiB
```

实际阅读建议使用 `2MiB`–`4MiB`。

### 11.5 没有读取到 Codex session title

标题数据库是可选增强。确认：

- Node.js 至少为 22。
- `state_5.sqlite` 位于 `$CODEX_SQLITE_HOME` 或 `$CODEX_HOME`。
- 使用自定义状态目录时传入了 `--codex-sqlite-home`。

即使标题读取失败，对话恢复和输出仍会正常完成。

### 11.6 Typora 仍然打开很慢

降低分卷大小：

```bash
--max-file-size 2MiB
```

如果只关心结论，改用：

```bash
--mode answers
```

后者通常会显著减少代码块、工具日志和整体体积。

### 11.7 为什么没有最开始的 system prompt

因为它被有意排除了。

Codex 会把 AGENTS、环境信息和其它运行时上下文以 user role 放入 rollout，但它们不是你手动发送的提示词。工具按上游标记将其排除，避免错误生成一个巨大的 `## YOU`。

真正的 system/developer prompt 可能未被完整持久化，也属于默认隐私边界，因此当前版本不导出。工具目前没有 `--include-context` 参数；不要依赖一个尚未实现的选项。

## 12. 推荐工作流

### 12.1 保留完整工程过程

```bash
npm run build

node dist/tools/session-archive/index.mjs codex <session-id> \
  --output-dir ~/Notes/Agent-Sessions \
  --max-file-size 4MiB
```

然后使用 `Claude-like Session` 主题打开生成的单文件或 `index.md`。

### 12.2 形成轻量复盘笔记

```bash
node dist/tools/session-archive/index.mjs codex <session-id> \
  --output-dir ~/Notes/Agent-Sessions \
  --mode answers \
  --title "本次协作的主题"
```

### 12.3 同时保留完整版和精简版

不要把两种模式输出到同一个 `--output-dir`，因为它们使用同一个稳定目标名。分别选择目录：

```bash
node dist/tools/session-archive/index.mjs codex <session-id> \
  --output-dir ~/Notes/Agent-Sessions/full

node dist/tools/session-archive/index.mjs codex <session-id> \
  --output-dir ~/Notes/Agent-Sessions/answers \
  --mode answers
```

这样可以用完整版审计过程，用精简版日常阅读。

## 13. 快速命令表

```bash
# 构建
npm run build

# Codex 完整归档，自动分卷
node dist/tools/session-archive/index.mjs codex <id> --output-dir ~/Notes/Agents

# Codex 提示词 + 最终回答
node dist/tools/session-archive/index.mjs codex <id> --output-dir ~/Notes/Agents --mode answers

# Claude Code 完整归档
node dist/tools/session-archive/index.mjs claude <id> --output-dir ~/Notes/Agents

# Claude Code 只保留主链
node dist/tools/session-archive/index.mjs claude <id> --output-dir ~/Notes/Agents --main-only

# 固定为单文件
node dist/tools/session-archive/index.mjs codex <id> -o ~/Notes/Agents/session.md

# 自定义标题
node dist/tools/session-archive/index.mjs codex <id> --output-dir ~/Notes/Agents --title "标题"

# 更小的 Typora 分卷
node dist/tools/session-archive/index.mjs codex <id> --output-dir ~/Notes/Agents --max-file-size 2MiB

# 安全替换旧结果
node dist/tools/session-archive/index.mjs codex <id> --output-dir ~/Notes/Agents --force
```

如果只是第一次试用，建议从下面这一条开始：

```bash
node dist/tools/session-archive/index.mjs codex <session-id> \
  --output-dir ~/Notes/Agent-Sessions \
  --max-file-size 4MiB
```
