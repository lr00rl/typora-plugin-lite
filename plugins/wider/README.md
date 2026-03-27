# Wider Plugin

为 Typora 编辑器提供类似飞书文档的三档书写宽度切换：

- `default`
- `wide`
- `full`

插件只保留快捷键和命令入口，不再在编辑区右下角显示常驻控件。

## 功能

- **三档宽度切换**：正文宽度可在 `default / wide / full` 之间切换
- **持久化模式**：关闭再打开 Typora 后，保持上一次选择
- **快捷键切换**：
  - `Mod+[`：向窄调整
  - `Mod+]`：向宽调整
- **命令入口**：
  - `Editor Width: Narrower`
  - `Editor Width: Wider`
  - `Editor Width: Default / Wide / Full`

## 与 Sidenote 的兼容

如果同时启用了 `sidenote` 插件：

- `wider` 会自动检测右侧边注预留宽度
- `wide` / `full` 模式下正文放宽时，不会把边注挤回正文区域
- 在窄窗口下，仍然会退回更紧凑的正文宽度，避免布局溢出

## 交互说明

- `Mod+[`：向窄调整一档
- `Mod+]`：向宽调整一档
- 切换时会在底部显示简短提示，例如 `Editor width: Wide`

## 设计目标

这个插件不是单纯把 `#write` 拉满，而是优先保证：

1. 阅读区比默认 Typora 更宽
2. 宽屏下有明确的三档切换
3. 与 `sidenote` 共存时布局稳定
4. 不额外占用或遮挡正文界面
