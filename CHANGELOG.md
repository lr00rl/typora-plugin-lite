# Changelog

## 未发布

### Remote Control：多窗口下不再"断线即失联"

- sidecar 原本只记一个 Typora 会话（最后认证的那个窗口），它一断开就报 "Typora session is unavailable"，其他窗口明明都连着也不用。现在记住所有 Typora 窗口的会话，当前目标断开时回退到最近活跃的那个。
- 新增 `session.claimTypora`：插件在窗口获得焦点时认领，`typora.*` 调用总是落到正在使用的窗口，而不是最后打开的窗口。
- 插件侧 socket 被动断开后不再只是把状态标成 disconnected：服务处于开启状态时按 1s 起步、最长 15s 的退避自动重连（包括必要时重新拉起 sidecar）。手动停止服务时不会重连。
- `system.getInfo` 增加 `typoraSessions` 字段。

## v0.1.3 — 2026-08-11

`v0.1.2` 只修正了 macOS Quick Open 面板中 `Ctrl+Tab` 的提示；`v0.1.3` 是一次完整的插件运行时、导航、代码阅读和响应式体验升级。

### Quick Open：从文件搜索升级为工作区导航器

- 新增“文件 / 目录 / 内容”三个共享搜索核心的视图，支持目录下钻、面包屑和 ripgrep 全文搜索。
- 新增 `type:`、`scope:` 查询语法与逐级自动补全；可以直接限定子目录或跨 tab 指定搜索类型。
- 最近记录改用 frecency（新近度 + 频次）排序，并在 Typora 确认文件成功打开后记录。快速连续切换、重复打开同一路径和持久化失败重试不再漏记或重复计数。
- 索引从仅 Markdown 扩展到所有可安全打开的文本文件，并在建索引时排除已知二进制格式；大型工作区使用持久化索引和内存内重排。
- 结果面板重新设计为轻量、紧凑的命令界面：短列表自然收高，长列表最多使用动态视口高度的 75%，小窗口不再产生横向页面滚动。
- 文件名始终完整显示；路径只使用剩余空间，并按完整目录段从中间折叠，必要时依次退化为 `.../末级目录/` 或 `...`。选择态仅使用安静的整行背景，不再出现左侧黄色高亮条。
- 补齐 dialog、tablist、listbox、键盘导航、焦点圈定、状态播报和 reduced-motion 行为。

### 插件运行时与设置中心

- 新增 schema-driven 设置渲染器，覆盖布尔、文本、数字、枚举、密钥、分组、校验、保存与错误状态。
- Plugin Center 增加明确的 dialog/list/switch 语义、焦点恢复与圈定、窄屏单列布局、异步启用 busy/error 状态和主题 token 桥接。
- 插件启用状态现在可以跨重启可靠持久化；lazy event/hotkey 触发器在加载前安全解绑，避免事件回放递归和重复加载。
- 设置保存会在离开面板前刷新待写值，并串行化并发写入；旧请求不会覆盖新值或错误显示为“已保存”。

### 新增 Code Viewer 与代码块增强

- 新增只读 Code Viewer，可安全预览非 Markdown 文本和代码文件，不修改 Typora 文档模型，也不会把渲染副本写回原文件。
- 内置轻量语法高亮、语言选择器、行号、空白标记和缩进参考线；未知但可读的文本扩展名回退为纯文本。
- Fence Enhance 增加按真实行数自适应的行号槽、Tab/空格标记和缩进参考线，并在进入视口前分片预热代码块，减少滚动时的延迟与跳动。
- 构建脚本从 core 的真实导出表生成插件 shim，避免编译通过但 Typora 运行时拿到 `undefined` 的接口漂移。

### Wider 与 Sidenote 的响应式修复

- Wider 改为测量 Typora 实际编辑宿主，而不是 `window.innerWidth`。开启侧栏或缩窄窗口后，default / wide / full 都会收敛到真实可用宽度，不再制造横向滚动。
- Sidenote reserve 只在编辑宿主确实容得下正文与旁注时启用；空间不足会回到行内呈现。
- 新增从选中文本快速创建 sidenote 的菜单、命令与快捷键；修复菜单状态、选区恢复、Enter/Space、Esc 和文件切换后的生命周期清理。

### 新增本地 Remote Control

- 新增只监听 `127.0.0.1` 的 WebSocket JSON-RPC sidecar、Node 客户端和 CLI，可读取上下文、切换文件/目录、控制源码模式、调用 Typora 与插件命令。
- 所有连接必须使用随机 bearer token 认证；shell 执行和 renderer eval 分别由 `allowExec` / `allowEval` 显式开关控制，默认关闭。
- 增加方法能力发现、请求超时、文档边界标记、Typora 会话重连、父进程死亡监测和 sidecar 强制退出保护。
- Linux 插件与数据目录统一到 `~/.local/Typora/`，客户端和运行时使用同一位置。

### 升级与验证

- Quick Open 的旧 MRU 会自动迁移；文本索引 schema 已升级，首次打开可能触发一次后台重建。
- Remote Control 的高权限能力仍保持默认关闭；不使用该插件时无需额外配置。
- 发布前通过 261 项自动化测试、TypeScript typecheck、生产构建以及 macOS Typora 中的真实 Quick Open / Wider / Sidenote smoke test。
- 完整提交差异：[v0.1.2...v0.1.3](https://github.com/lr00rl/typora-plugin-lite/compare/v0.1.2...v0.1.3)

## v0.1.2

- 修正 macOS Quick Open 的 tab 切换提示：使用 `Ctrl+Tab`，避免与系统级 `Cmd+Tab` 应用切换冲突。
