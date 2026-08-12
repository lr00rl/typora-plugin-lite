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
--main-only           Claude 只输出主因果链，不附加 alternate/subagent 分支
--codex-home <dir>    覆盖 CODEX_HOME（也用于无真实数据的测试）
--claude-home <dir>   覆盖 CLAUDE_CONFIG_DIR
-o, --output -        输出到 stdout
-f, --force           显式允许原子替换目标文件
```

命令的普通日志和诊断写入 stderr，因此 `--output -` 可以安全地参与管道。

## Markdown 协议

笔记只依赖 Typora 能稳定渲染的 Markdown 与少量生成器自有 HTML：

- YAML frontmatter 记录 provider、session ID、导出时间、source 数与脱敏数
- 用户与 Agent 使用不同的标准 Markdown 强调行，加上 blockquote
- 工具调用与结果使用代码围栏；Session 主题会限制长输出高度并允许内部滚动
- Claude 的 alternate branch 与 subagent sidechain 放在独立附录

配套主题位于 `Typora_Claude-Like_Theme`：

- `Claude-like Session`
- `Claude-like Session Dark`

专用变体使普通笔记完全不受对话布局规则影响。

## 恢复规则

### Codex

工具根据 Codex rollout 文件名中的稳定 thread ID 在 `sessions` 与 `archived_sessions` 中查找，并按文件修改时间合并匹配的 rollout。它读取 `response_item` 中的 user/assistant message、函数/自定义工具调用及输出；旧日志没有 `response_item` 可见消息时，才回退到 `event_msg`，避免一份消息记录两次。

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
