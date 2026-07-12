# Fuzzy Search / Quick Open

这个插件现在采用“最近打开 + 持久化索引”的模型。

目标很明确：

- 空输入时秒开，只显示最近打开的文件
- 有输入时只查索引，不再全量扫目录
- 大目录下避免把大量文件路径通过 Typora bridge 一次性回传给前端

## 现在的行为

### 1. 默认态（最近 + 浏览，用来替代侧边栏文件树）

当输入框为空时，面板显示两部分：

- **最近打开** —— 按 **frecency**（新近度 + 频次）排序，不再是纯时间顺序。
  一个你每天开十次的文件，会排在一个昨晚只碰过一次的文件前面。
  - 权重以新近度为主、频次为辅（频次有上限，避免某个文件永远霸榜）
  - 当前激活文件会定期同步进记录；通过 quick open 打开的文件立即写入
  - 存储从旧的 `mru` 数组自动迁移到 frecency，升级不丢历史
- **浏览** —— 工作区根目录的直接子文件夹和文件，可直接下钻，像文件树一样。

### 浏览 / 目录下钻（文件树替代）

浏览态完全从扁平索引推导，不额外维护树结构：

- 在文件夹上按 `Enter` 或 `→` 进入该目录，只显示它的直接子项
- 顶部有面包屑和 `..` 上级项；`←`、或空输入时按 `Backspace` 返回上级
- 面包屑每一段都可点击跳转；目录会显示其下文件总数
- 任何输入都会离开浏览态、对整个工作区做模糊搜索；清空输入会回到刚才的浏览位置

目标是：日常导航不再需要侧边栏的 tree 视图。

### 2. 搜索态

当输入框非空时，插件会查工作区索引。

- 每次输入会做防抖；输入值没变化不会重复触发
- 每次查询最多返回 100 条结果
- **索引在面板打开期间只解析一次、常驻内存**。旧实现每次按键都重新读盘并重新
  规整整份索引，这是大仓库下打字卡顿的主因；现在按 (根目录, 当前文件目录) 缓存，
  逐键只做内存过滤
- 打分叠加 **frecency 加成**（有上限）：常开的文件在同等匹配下排得更靠前
- 如果系统可用 `fzf`，优先用 `fzf --filter`
- 否则回退到 JS 打分（现在是内存 + frecency，通常已经够快）
- 若无 `fzf`，插件会尝试识别系统包管理器，并在底部提供“安装 fzf”入口

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
