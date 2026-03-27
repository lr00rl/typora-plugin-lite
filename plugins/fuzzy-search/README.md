# Fuzzy Search / Quick Open

这个插件现在采用“两层后端”：

- UI 仍然是 Typora 内的 quick open 面板
- 索引优先走 `rg --files`
- 排序优先走 `fzf --filter`
- 如果系统里没有 `rg` / `fzf`，会自动回退到内置的 JS 索引和打分逻辑

## 现在的搜索行为

- 搜索文件名
- 搜索工作区相对路径
- 搜索“相对当前打开文件所在目录”的路径

例如当前文件在 `notes/backend/api.md`，那么输入下面这些都应该能命中：

- `auth`
- `backend/auth`
- `../auth/login`

## 依赖兼容策略

插件按下面顺序找可执行文件：

1. 系统 `PATH`
2. 插件目录内的内置二进制
3. 常见安装路径

内置二进制目录约定：

- `plugins/fuzzy-search/bin/fzf`
- `plugins/fuzzy-search/bin/rg`
- `plugins/fuzzy-search/bin/macos/fzf`
- `plugins/fuzzy-search/bin/macos/rg`
- `plugins/fuzzy-search/bin/linux/fzf`
- `plugins/fuzzy-search/bin/linux/rg`
- `plugins/fuzzy-search/bin/windows/fzf.exe`
- `plugins/fuzzy-search/bin/windows/rg.exe`

构建时 `bin/` 会被一并复制到 `dist/plugins/fuzzy-search/bin/`。

## 最佳实践

- `rg` 负责“列出候选文件”，不要把文件内容检索和 quick open 混在一起
- `fzf` 负责“排序”，UI 仍由 Typora 控制，这样兼容性最好
- 搜索键同时包含 workspace 相对路径和 current-file 相对路径，行为最接近 `fzf.vim`
- 缓存文件列表可以复用，但“相对当前文件”的路径别名要在每次打开时重算
