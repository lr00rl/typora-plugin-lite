# Sidenote Plugin

在 Typora 编辑器中为 `<span class="sidenote">` 提供 Tufte 风格的旁注体验：上标编号、右侧边栏浮动、响应式布局。

## 为什么需要这个插件？

Typora 编辑器不会将 inline HTML 的 class 渲染为真正的 DOM 属性。你写的 `<span class="sidenote">` 在编辑器的 DOM 里长这样：

```
span.md-html-inline                       ← Typora 自动生成的包裹层（没有 sidenote class）
  ├─ span.md-meta  → 文本: <span class="sidenote">   ← 只是显示文本，不是 DOM 属性
  ├─ span.md-plain → 文本: 旁注内容
  └─ span.md-meta  → 文本: </span>
```

`class="sidenote"` 只是纯文本字符串。CSS 无法根据元素文本内容做选择，所以**纯 CSS 无法在编辑器里识别旁注**。手动构造其他标签也不行——Typora 会把任何 inline HTML 的 class 都当纯文本处理。

这个插件就是解决这个问题的桥梁。

## 插件做了什么

**只做两件事，所有样式都由 CSS 完成：**

| 步骤 | 插件做的事 | 为什么 CSS 做不到 |
|------|-----------|-------------------|
| 1 | 读 `.md-meta` 的文本内容，判断是否含 `class="sidenote"`，给 `.md-html-inline` 加上 `tpl-sidenote` class | CSS 无法按元素文本内容选择 |
| 2 | 在旁注前面插入空的 `<span class="tpl-sn-num">` | 上标编号需要独立元素做 CSS counter-increment |

```
你:      写 <span class="sidenote">旁注内容</span>
插件:    识别 → 加 .tpl-sidenote class + 插入 .tpl-sn-num 编号标记
CSS:     所有视觉效果（上标编号 ¹²³、右侧浮动、响应式布局）
```

编号完全由 CSS counter 自动编排（从 1 开始），不需要 JS 计算。

## 用法

在 Markdown 中写入：

```html
正文内容<span class="sidenote">这是一条旁注。</span>正文继续。
```

插件自动处理，不需要额外操作。

## 编辑器内效果

- **宽屏 (>=1200px)**：正文中显示上标编号（¹ ² ³），旁注浮动到右侧边栏并显示匹配的编号前缀
- **窄屏 (<1200px)**：旁注以行内高亮标签呈现
- **编辑时**：光标所在段落的旁注和编号标记自动隐藏，回到行内方便编辑
- **实时监听**：MutationObserver 监听编辑，新增/修改的旁注自动处理

## 搭配 Claude-like Theme

| 配置 | Typora 编辑器 | 导出 HTML/PDF |
|------|---------------|---------------|
| 主题 + 插件 | 上标编号 + 右侧边栏浮动（完整体验） | 旁注浮在右侧 |
| 仅插件 | 上标编号 + 右侧边栏浮动（插件内置样式） | 无特殊样式 |
| 仅主题 | 无效果（CSS 无法识别编辑器内的 sidenote） | 旁注浮在右侧 |

推荐搭配 [Claude-like Theme](https://github.com/lr00rl/Typora_Claude-Like_Theme) 使用——主题 CSS 同时包含导出样式和编辑器样式规则，插件负责识别旁注并添加 CSS 可用的 class，两者互补。

## 技术细节

- **安全 DOM 操作**：插入的 `<span class="tpl-sn-num">` 不会被 Typora 序列化回 Markdown（与 fence-enhance 的 copy 按钮同理）
- **CSS counter 自动编号**：`.tpl-sn-num { counter-increment }` + `::after` 显示上标，`.tpl-sidenote::before` 读取同一 counter 显示匹配前缀
- **编辑安全**：`.md-focus > .tpl-sn-num` 隐藏编号，`.md-focus > .tpl-sidenote` 取消浮动
- **防抖**：MutationObserver 回调通过 `requestAnimationFrame` 合并
