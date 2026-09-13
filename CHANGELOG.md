# 更新日志

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中

- 安装包（一键安装 + 首次运行引导填写 API 地址与密钥）
- 会话导出（Markdown / JSON）

## [1.0.0] - 2026-09-13

首个公开版本。

### 新增

- 多会话：新建、切换、搜索、删除，每个会话独立工作目录，可并发运行。
- 实时流式输出：解析 `codex exec --json` 事件流，边跑边渲染。
- 工具调用卡片：命令、退出码、输出，自动折叠与一键复制。
- 文件改动、任务清单、思考过程卡片，思考过程可开关。
- Markdown 渲染与代码高亮（离线内嵌渲染器）。
- 图片附件（粘贴 / 选择，经 `-i` 传给 Codex）。
- 顶栏切换模型、推理强度、沙箱权限；设置里切换主题、字号、Enter 发送等。
- 无边框窗口，WebView2 原生拖拽标题栏与系统菜单；启动时恢复窗口位置。
- 单实例运行；数据目录可通过 `CODEXGUI_DATA_DIR` 或 `portable.marker` 自定义。
- 命令行自检：`--selftest`、`--autorun`。

### 说明

- 数据目录不再写死为 `D:\Codex\CodexGuiData`，默认使用 `%LOCALAPPDATA%\CodexGui`，老目录存在时会继续沿用。
- 默认工作目录不再写死为 `D:\cpp`，改为当前用户主目录。

[Unreleased]: https://github.com/OWNER/REPO/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/OWNER/REPO/releases/tag/v1.0.0
