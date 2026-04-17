# Fuzzy Search / Quick Open

这个插件现在采用“最近打开 + 持久化索引”的模型。

目标很明确：

- 空输入时秒开，只显示最近打开的文件
- 有输入时只查索引，不再全量扫目录
- 大目录下避免把大量文件路径通过 Typora bridge 一次性回传给前端

## 现在的行为

### 1. 默认态

当输入框为空时，面板只显示“最近打开”。

- 最近打开上限是 30 条
- 当前激活文件会定期同步进最近记录
- 通过 quick open 打开的文件也会立即写入最近记录

这样做的原因是默认态最重要的是快，而不是把整个工作区塞进列表。

### 2. 搜索态

当输入框非空时，插件会查工作区索引。

- 每次输入会做防抖
- 如果输入值没有变化，不会重复触发查询
- 每次查询最多返回 100 条结果
- 如果系统可用 `fzf`，优先用 `fzf --filter`
- 如果没有 `fzf`，回退到 JS 打分
- 如果没有 `fzf`，插件会尝试识别系统包管理器，并在 quick open 底部提供“安装 fzf”入口

搜索键覆盖三种视角：

- 文件名
- 相对工作区路径
- 相对当前文件目录的路径

例如当前文件在 `notes/backend/api.md`，那么下面这些都应该能命中：

- `auth`
- `backend/auth`
- `../auth/login`

## 索引设计

### 为什么要改成落盘索引

原来的 quick open 在大目录下容易卡，核心问题不是匹配逻辑，而是“候选列表怎么拿”。

如果直接通过 bridge 执行：

- `rg --files`
- `find`
- 或其他会产生大量 stdout 的命令

那么在 macOS 下很容易撞上 bridge / IPC payload 限制，或者 Typora 内部命令执行层的缓冲限制。

所以现在改成：

1. 后台构建索引文件
2. 结果直接写入缓存目录
3. bridge / shell 只返回很小的状态信息，比如文件数
4. 搜索时直接针对索引文件执行 `fzf --filter`

这样大数据不再走前端 IPC。

### 索引文件位置

索引写在插件数据目录下：

- `<dataDir>/cache/fuzzy-search/index-<hash>.paths.txt`
- `<dataDir>/cache/fuzzy-search/index-<hash>.meta.json`

在 Linux 上，`dataDir` 默认是 `~/.local/Typora/data`。

其中：

- `paths.txt` 存 root 相对路径，一行一个文件
- `meta.json` 记录根目录、schema 版本、文件数和更新时间

### 索引构建策略

按下面顺序选择构建器：

1. `rg --files`
2. `find`

并且只收录 Markdown 文件：

- `.md`
- `.markdown`

默认会忽略这些目录：

- `.git`
- `node_modules`
- `.obsidian`
- `.trash`
- `.Trash`
- `_archive`

## 可执行文件探测

插件按下面顺序找 `rg` / `fzf`：

1. 系统 `PATH`
2. 插件目录内的内置二进制
3. 常见安装路径

如果没有找到 `fzf`：

- quick open 底部会显示“安装 fzf”或“安装说明”
- 能无交互执行的包管理器（例如部分 `brew` / `mise` / `scoop` 场景）可直接由插件尝试执行
- 需要 `sudo` 或终端交互的包管理器，插件只提供准确命令复制，不会静默后台安装

内置二进制目录约定：

- `plugins/fuzzy-search/bin/fzf`
- `plugins/fuzzy-search/bin/rg`
- `plugins/fuzzy-search/bin/macos/fzf`
- `plugins/fuzzy-search/bin/macos/rg`
- `plugins/fuzzy-search/bin/linux/fzf`
- `plugins/fuzzy-search/bin/linux/rg`
- `plugins/fuzzy-search/bin/windows/fzf.exe`
- `plugins/fuzzy-search/bin/windows/rg.exe`

## 为什么不做查询缓存

现在没有做“查询结果缓存”。

原因是这版的假设是：

- 真正慢的是“扫描整个目录”
- 不是 `fzf --filter` 本身

所以优化重点放在：

- 持久化索引
- 空输入只看最近打开
- 非空输入只查索引
- 每次查询限制返回数量

这比做一层额外的 query cache 更直接，也更稳定。

## 已知边界

- 当前索引构建和 `fzf` 查询命令主要按 POSIX shell 设计，macOS / Linux 这条链路最稳
- Windows 如需完全等价支持，建议后续单独补一层命令适配
- 目前“最近打开”主要来自插件自己的 MRU 记录和当前活动文件同步，不依赖 Typora 的私有 recent 缓存结构
