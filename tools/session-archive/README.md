# Session Archive

`session-archive` 是一个独立于 Typora 插件运行时的本地 CLI。给它一个 Codex 或 Claude Code 的 session ID，它会找到对应 JSONL、恢复可见的主对话与工具证据，并输出适合长期保存的 Markdown 笔记。

它不会导出隐藏推理、system prompt 或 developer instructions。输出默认还会：

- 把当前用户主目录替换为 `~`
- 脱敏高置信度 API key、Bearer token、私钥和常见 secret 环境变量
- 把原始 HTML 转义为文本，禁用 `javascript:` / `file:` 等主动 URI
- 用 `0600` 权限和同目录临时文件原子发布，不会静默覆盖已有笔记

## 使用

先构建仓库：

```bash
npm run build
```

从 Codex 默认的 `$CODEX_HOME/sessions` 与 `archived_sessions` 中查找：

```bash
node dist/tools/session-archive/index.mjs codex <session-id> \
  --output ~/Notes/Agents/codex-session.md
```

长会话建议直接选择目录。文件不超过限制时输出一份 Markdown；超过限制时输出带 `index.md`、前后卷导航的目录，并保证每一卷都不超过设置值：

```bash
node dist/tools/session-archive/index.mjs codex <session-id> \
  --output-dir ~/Notes/Agents \
  --max-file-size 4MiB
```

如果只想留存自己每轮的提示词和 Agent 的最终可见回答：

```bash
node dist/tools/session-archive/index.mjs codex <session-id> \
  --output-dir ~/Notes/Agents \
  --mode answers
```

从 Claude Code 默认的 `$CLAUDE_CONFIG_DIR/projects`（未设置时为 `~/.claude/projects`）中查找：

```bash
node dist/tools/session-archive/index.mjs claude <session-id> \
  --output ~/Notes/Agents/claude-session.md
```

开发时也可以直接运行：

```bash
npm run session:archive -- codex <session-id> -o session.md
```

常用选项：

```text
--source <file>       显式读取一个 JSONL，跳过默认目录发现
--title <text>        自定义笔记标题
--output-dir <dir>    按大小输出单文件或 index + 多个分卷
--max-file-size <n>   每份 Markdown 上限，目录输出默认 4MiB（最小 64KiB）
--mode full           完整可见对话：commentary、工具调用/结果、最终回答
--mode answers        只保留每轮用户提示词和最终可见回答
--answers-only        --mode answers 的简写
--main-only           Claude 只输出主因果链，不附加 alternate/subagent 分支
--codex-home <dir>    覆盖 CODEX_HOME（也用于无真实数据的测试）
--codex-sqlite-home <dir> 覆盖 CODEX_SQLITE_HOME（只读会话标题）
--claude-home <dir>   覆盖 CLAUDE_CONFIG_DIR
-o, --output -        输出到 stdout
-f, --force           显式允许原子替换目标文件
```

命令的普通日志和诊断写入 stderr，因此 `--output -` 可以安全地参与管道。

## Markdown 协议

笔记只依赖 Typora 能稳定渲染的标准 Markdown：

- 会话标题是 H1；Codex 优先读取 `state_5.sqlite` 的显式名称/自动标题，Claude 优先使用 `custom-title`/`ai-title`，不可用时回退到首条真实提示词
- 每轮提示词是 `## YOU · 时间`；完整模式用 `## CODEX/CLAUDE Replying` 汇集该轮可见过程
- commentary/普通回复是 H3，最终回答是 `### CODEX/CLAUDE Answered · 时间`，工具调用与结果是 H4 与代码围栏
- `answers` 模式把提示词和最终回答都作为 H2，方便在 Typora 大纲中快速跳转
- Claude 的 alternate branch 与 subagent sidechain 放在更深层级的独立附录
- YAML frontmatter 记录 provider、session ID、导出模式、时间、source 数、脱敏数与分卷序号

分卷只在生成器控制的标题/事件边界发生。单个超大工具结果会先拆成多个各自闭合的代码围栏，因此不会生成跨文件断裂的 Markdown。索引和每一卷都使用私有 `0600` 权限；重新发布仍需显式 `--force`。

配套主题位于 `Typora_Claude-Like_Theme`：

- `Claude-like Session`
- `Claude-like Session Dark`

专用变体使普通笔记完全不受对话布局规则影响。

## 恢复规则

### Codex

工具根据 Codex rollout 文件名中的稳定 thread ID 在 `sessions` 与 `archived_sessions` 中查找，并按文件修改时间合并匹配的 rollout。它读取 `response_item` 中的 user/assistant message、函数/自定义工具调用及输出；旧日志没有 `response_item` 可见消息时，才回退到 `event_msg`，避免一份消息记录两次。Codex 以 user role 保存的 `AGENTS.md`、`environment_context`、hook prompt 等运行时上下文会按上游标记协议排除，不会冒充用户提示词。

### Claude Code

工具查找 `<projects>/<project>/<session-id>.jsonl`，按 `parentUuid` 从最新的非 sidechain leaf 回溯主因果链。其它 leaf 作为 alternate branch；同文件 `isSidechain` 记录和 `<session-id>/subagents/*.jsonl` 作为 subagent 附录。`thinking` 与 `redacted_thinking` 永远忽略。

## 失败语义

- `0`：成功且恢复到至少一个可见事件
- `2`：命令参数错误
- `3`：session/source 不存在
- `4`：读取、解析或发布失败
- `5`：生成了诊断性空归档，但没有可见事件

如果源文件在读取期间发生变化，导出会失败并提示 `SESSION_SOURCE_CHANGED`，避免生成看似成功但缺行的笔记。

## 当前边界

- Provider 的私有 JSONL 格式可能随版本演进；未知行会被跳过并给出诊断，而不会伪装成完整恢复。
- 默认不把本机 source path 写进 Markdown。项目内容本身仍可能包含私人业务信息；分享笔记前仍应人工复核。
- Claude 显式 `--source` 只读取这一份文件，不会猜测同目录 subagent 文件。
