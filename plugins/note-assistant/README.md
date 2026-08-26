# Note Assistant

`Cmd/Ctrl+;` 唤出相关笔记面板。数据来自 vault 侧的 `.note-assistant/graph.json`
（由 `tools/note-assistant/build-graph.mjs` 生成），插件只做三件事：发现、打开、
把 wiki-link 插进正文。

## 面板

三个范围页签，`Tab` / `Shift+Tab` / `Cmd+←→` 循环切换：

- **相关**：图谱决策阶段挑出的精选相关笔记，按分数排序，每行带一个理由徽标
  （链接 / 反链 / 同目录 / 同分区 / 共词·某词）。决策为空时打开会自动落到
  第一个非空的范围，不会面对空列表发愣。
- **链接**：确定性的出链（explicitLinks）与入链（backlinks），去重后按先出后入排列。
- **候选**：图谱的宽池候选（TF-IDF 共词 + 目录邻近加权），找冷门关联用。
  已被精选进「相关」的条目会从这里排除，两个范围读作「精选」与「池子的其余部分」。

输入即过滤（对标题 / 路径 / 标签做子序列匹配，CJK 安全，保持图谱原序不重排），
命中字符用下划线淡标。键盘模型与 Quick Open 一致：`↑↓` 移动，`Enter` 打开并关闭，
`Esc` 关闭并把焦点还给编辑器。

**`⌥Enter`（macOS）/ `Alt+Enter`：把 `[[相对路径|标题]]` 插入正文光标处。**
这是唯一写文档的动作，也是整个设计里最关键的一个：块内容会被 apply-graph
重新生成，只有正文里的 wiki-link 会被 build-graph 吸收进图谱，让下次的「相关」
更准。插入后 toast 会提醒「保存并重建索引后生效」。源代码模式下走
CodeMirror 的 `replaceSelection`，两种模式都进各自的撤销栈。

footer 一行状态：未建索引 / 本篇未索引 / 共 N 篇 · 生成于日期；索引超过 7 天
未更新时会安静地出现「重建索引」按钮（键盘路径是 `Cmd/Ctrl+R`）。

## 内联 wiki-link

正文里任何位置的 `[[路径|标题]]` 都会渲染成可点的链接：只显示标题，点击打开
目标笔记，索引里查不到的目标显示成虚线并在 tooltip 里说明。

关键约束是**一个字符都不改文档**。渲染不是替换文本，而是把原文本切成几段
span，把 `[[`、`路径|`、`]]` 三段用 CSS 隐藏，只留标题可见；拼回来的
textContent 和原文逐字节相同，所以写盘内容不受影响。没写标题的
`[[a/b/c]]` 同理，只隐藏目录前缀显示 `c`，不会凭空造出文档里没有的字。

光标进入某个块时该块整体还原成原始 markdown，和 Typora 处理自家行内语法
的方式一致，编辑体验不变。`Alt+点击` 是逃生口：不跳转，把光标放进链接文本里。

重渲染只针对 mutation 真正触及的块，加上刚得到或失去焦点的那一个，所以在
几百条链接的索引页里打字也不会卡。代码块、行内代码、公式、已有的 `<a>` 和
生成块内部一律跳过。

## 内联块

文档里 `<!-- note-assistant:index:start/end -->`（以及旧的
`<!-- note-assistant:start/end -->`）区域是 vault 流水线的生成物
（`tools/vault.mjs index` 重写，build-graph 分析前会剔除），所以渲染是只读的：
一行小标题加条数，下面按小节分组的链接列表，点击直接打开；「面板」按钮
唤出面板。

两套标记都认，因为生成器换过一次名字：只认旧的那次，全库 250 个索引块一个
都没渲染出来。小节和嵌套都保留，`### 子目录` / `### 笔记` 各自成段，
`- firewall（2 篇）` 这种没有链接的行作为标签留在原位，它下面的子链接缩进
挂在它下面。链接后面跟的 `（6 篇）` 会当作附注显示，不会被误当成路径。

块内容要改就直接改 markdown，MutationObserver 会实时重渲染。observer 只响应
「注释节点增删」和「块区域内编辑」两类 mutation，在文档别处打字不会触发任何
重处理。

## 命令

- `笔记助手: 打开相关笔记`（`note-assistant:open`，同 `Cmd/Ctrl+;`，切换式）
- 全局 `Cmd/Ctrl+Shift+R`：面板关着也能触发重建（面板内的 `Cmd/Ctrl+R` 只在开着时有效）
- `笔记助手: 重建索引`（`note-assistant:rebuild-graph`，运行
  `node tools/note-assistant/build-graph.mjs --root <vault> --allow-heuristic-blocks`）
- `笔记助手: 状态`（`note-assistant:state`）：返回 JSON 状态快照
  （图谱路径、索引规模、当前篇收录情况、面板开关、内联块渲染计数、
  内联 wiki-link 的处理次数与当前链接数 `wikiLinks`、buildMarker），
  供 remote-control 调用做自动化验证。

## 数据文件

插件从当前文件向上查找 `.note-assistant/graph.json`，路径计算一律使用
「找到的那个根目录」，不信任文件内嵌的 `root` 字段（跨机器同步的 vault
里它是上一台机器的绝对路径）。vault 侧流水线见 `tools/note-assistant/README.md`。
