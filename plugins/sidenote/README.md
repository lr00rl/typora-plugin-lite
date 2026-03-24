# Sidenote Plugin

在 Typora 编辑器中为 `<span class="sidenote">` 提供 Tufte 风格的旁注体验：自动编号、右侧边栏浮动。

## 原理

Typora 编辑器不会将 inline HTML 渲染为真正的 DOM 元素，而是包裹在 `.md-html-inline` 结构中。因此插件**不插入任何 DOM 节点**（避免破坏 Markdown 序列化），而是：

1. 识别 `.md-html-inline` 中包含 `class="sidenote"` 的元素
2. 添加 `tpl-sidenote` CSS class
3. 注入编辑器 CSS：CSS counter 自动编号 + `::before` 显示 + 浮动布局

## 用法

在 Markdown 中写入：

```html
正文内容<span class="sidenote">这是一条旁注。</span>正文继续。
```

插件自动处理，不需要额外操作。

## 编辑器内效果

- **宽屏 (>=1200px)**：旁注浮动到右侧边栏，带自动编号前缀（`1.`、`2.`）
- **窄屏 (<1200px)**：旁注以行内高亮标签呈现
- **编辑时**：光标所在段落的旁注回到行内，方便修改内容
- **MutationObserver** 监听实时编辑，新增/修改的旁注自动处理

## 搭配 Claude-like Theme

| 配置 | Typora 编辑器 | 导出 HTML/PDF |
|------|---------------|---------------|
| 主题 + 插件 | 自动编号 + 右侧边栏浮动 | 旁注浮在右侧 |
| 仅插件 | 自动编号 + 右侧边栏浮动（内置样式） | 无特殊样式 |
| 仅主题 | 无效果 | 旁注浮在右侧 |

推荐搭配 [Claude-like Theme](https://github.com/lr00rl/Typora_Claude-Like_Theme) 使用——主题负责导出样式，插件负责编辑器体验。

## 技术细节

- **零 DOM 插入**：只添加 CSS class，不修改 Typora 的 DOM 结构
- **CSS counter**：通过 `.tpl-sidenote { counter-increment }` + `::before` 实现自动编号
- **编辑安全**：`.md-focus > .tpl-sidenote` 时取消浮动，确保编辑体验
- **防抖**：MutationObserver 回调通过 `requestAnimationFrame` 防抖
