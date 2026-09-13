# 更新日志

本文件格式参考 Keep a Changelog（https://keepachangelog.com/zh-CN/1.1.0/），
版本号遵循语义化版本（https://semver.org/lang/zh-CN/）。

## [Unreleased]

### 新增

- 单文件安装包（`installer/`）：自带 .NET 运行时与 Codex CLI，目标机器不用装环境；安装时可选写 PATH、建快捷方式、注册卸载信息，数据目录与默认工作目录都落在安装目录下。安装包内不含任何密钥或会话记录。
- 图形化卸载程序（`uninstall.exe`）：默认保留 `data` 目录，可勾选一并删除，同时清理 PATH 条目与注册表项。
- 设置里的 **API 配置** 面板：直接填写 API 链接、模型、密钥，写入 `codex-home`；首次启动（检测到还没配置过）会自动打开设置面板。
- 自动把工作目录标记为受信任（`[projects.'<路径>']`），避免非交互模式下反复确认。

### 变更

- 文档与示例统一改用 `wire_api = "responses"`：当前 Codex CLI 已经移除 `wire_api = "chat"`。

### 计划中

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

- 数据目录不再写死为早期开发版本的绝对路径，默认使用 `%LOCALAPPDATA%\CodexGui`，老目录存在时会继续沿用。
- 默认工作目录不再写死为某个开发路径，改为当前用户主目录（安装版由安装程序写成安装目录）。

[Unreleased]: https://github.com/Feanaze/CodexGui/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Feanaze/CodexGui/releases/tag/v1.0.0
