# 架构说明

## 三层结构

```
┌───────────────────────── WPF 外壳进程（CodexGui.exe）─────────────────────────┐
│                                                                              │
│  MainWindow (WPF)                                                            │
│   ├─ WebView2 控件 ── 界面（wwwroot，构建时嵌入 exe 作为资源）                 │
│   ├─ 消息桥：OnWebMessage / Post（JSON，{ "t": "..." }）                       │
│   ├─ 会话与进程调度：Dictionary<sessionId, Turn>                              │
│   └─ Services/：配置、数据目录、codex 定位、日志                               │
│                          │                                                    │
└──────────────────────────┼────────────────────────────────────────────────────┘
                           │ 子进程：codex exec --json ...
                           ▼
                 Codex CLI（codex.exe，独立进程，每个会话每轮一个）
```

- **没有本地 HTTP 服务**：前端不是从 `http://127.0.0.1:xxxx` 加载的，而是注册了 WebView2 虚拟主机 `codexgui.local`，由 `WebResourceRequested` 从内嵌资源（`EmbeddedResource`）返回字节流。既省掉端口占用和防火墙弹窗，也不会把界面文件暴露给其它进程。
- **前后端只通过 JSON 消息通信**（`postMessage` / `PostWebMessageAsJson`），前端不直接碰文件系统。

## 启动流程

1. `App.OnStartup`：`StoragePaths.Initialize()` 建数据目录 → `CodexEnvironment.EnsureHome()` 准备 `codex-home`（必要时从用户原有的 `~\.codex` 复制 `auth.json` 等）→ 单实例互斥量。
2. 命令行参数：`--selftest`（无界面自检）、`--autorun "提示词"`（自动发一条消息，给自动化测试用）。
3. `MainWindow` 构造：读 `config.json`、恢复窗口位置、扫描 `codex-home\models.json` 生成模型列表、`codex --version` 探测版本。
4. `InitWebAsync`：创建 WebView2 环境（用户数据目录为 `<数据目录>\WebView2`），注册事件，注入 `window.__CODEX_BOOT__`（配置 / 模型 / 版本 / 主题 / 是否支持原生拖动），然后导航到 `https://codexgui.local/index.html`。

## 消息协议

前端 → 后端（`MainWindow.OnWebMessage` 里的 `switch`）：

| `t` | 作用 |
| --- | --- |
| `init` | 页面就绪，索取初始状态（配置、会话列表、模型、codex 状态） |
| `send` | 发送一轮提示词（可带图片、sessionId） |
| `stop` | 停止某个会话正在跑的一轮 |
| `turn.snapshot` | 重新打开界面/切换会话时拉取正在跑的轮次快照 |
| `session.new` / `session.load` / `session.delete` / `session.rename` / `session.draft` | 会话管理 |
| `config.patch` | 修改配置（工作目录、模型、沙箱、主题、字号……） |
| `dialog.workdir` | 弹出系统文件夹选择框 |
| `codex.refresh` | 重新探测 codex 可执行文件与版本 |
| `shell.open` / `link.open` | 用资源管理器打开路径 / 用浏览器打开链接 |
| `clipboard.write` | 写系统剪贴板 |
| `image.read` | 读取图片文件（附件预览） |
| `window` | 窗口控制：`minimize` / `maximize` / `close` / `drag` / `resize` |

后端 → 前端（`MainWindow.Post`）：

| `t` | 作用 |
| --- | --- |
| `state` / `config` / `codex` | 初始与增量状态 |
| `sessions` / `session` | 会话列表与当前会话内容 |
| `turn.user` / `turn.status` / `turn.log` / `turn.event` / `turn.snapshot` | 一轮对话的用户消息、状态、CLI 日志、事件流、快照 |
| `toast` | 右下角提示 |
| `image.data` / `window` | 图片数据与窗口状态 |

## 一轮对话是怎么跑的

`CodexRunner.StartNew()`（`Services/CodexRunner.cs`）拼出的命令行等价于：

```text
codex exec --json --skip-git-repo-check -C <工作目录> -s <沙箱模式> \
      [-m <模型>] [-c model_reasoning_effort="<强度>"] [-i <图片>]... -
```

- 提示词通过 **stdin** 送进去（末尾的 `-` 表示从标准输入读），避免超长参数和引号转义问题。
- 续接同一会话时用 `codex exec resume <threadId> --json -c sandbox_mode="..." ...`，`threadId` 存在会话文件里。
- 子进程统一补 `HOME` / `CODEX_HOME`（`CodexEnvironment.Apply`），保证 CLI 一定能找到自己的配置目录。
- stdout 按行解析：JSON 行作为事件回调给界面，非 JSON 行当普通日志；stderr 过滤掉噪音后同样当日志。
- 事件类型：`thread.started`、`item.started` / `item.updated` / `item.completed`、`turn.completed`、`turn.failed`、`error`，分别映射成消息、工具卡片、思考过程、用量统计与错误提示。

**并发模型**：`_turns` 按会话 id 索引，每个会话同时只允许一轮（避免同一个 `threadId` 被并发续接），不同会话可以同时在跑。界面上的「正在处理/运行中」状态就是这份字典的投影。

## 会话与数据

```
<数据目录>\
├─ config.json              应用配置（含窗口位置、最近工作目录）
├─ log.txt                  出错时的日志
├─ sessions\<id>.json       会话：id / title / workDir / threadId / model / sandbox / messages[]
├─ attachments\             图片附件副本
├─ WebView2\                WebView2 用户数据
└─ codex-home\              Codex CLI 自己的配置目录
   ├─ config.toml           模型、服务商、base_url、沙箱等
   ├─ auth.json             API 密钥（明文，注意保管）
   ├─ models.json           可选：模型清单，界面用它渲染模型菜单
   └─ sessions\ · state*.sqlite · history.jsonl   CLI 自己的会话数据
```

会话文件里的 `threadId` 是和 CLI 会话（`codex-home` 里的 sqlite/JSONL）关联的主键：删掉 `sessions\<id>.json` 只是让 GUI 不再显示这条会话，CLI 侧的历史仍在 `codex-home` 里。

## codex 与数据目录是怎么定位的

`CodexLocator.Resolve()` 的顺序：

1. `config.json` 里手动指定的 `CodexPath`；
2. 便携目录：`<程序目录>\codex\bin\codex.exe` 或 `<程序目录>\codex\codex.exe`（安装包把 CLI 一起带上时走这里，不依赖 PATH）；
3. `PATH` 里的 `codex.exe`；
4. `PATH` 里的 `codex.cmd` / `codex.bat`（npm 全局的 shim，会用 `cmd /c` 包装）；
5. `%APPDATA%\npm`、`%LOCALAPPDATA%\npm`。

如果是 npm 的 shim，会再尝试直接定位 `node_modules\@openai\codex\...\bin\codex.exe`，跳过 `cmd` 包装，启动更快。

`StoragePaths.ResolveRoot()` 的优先级见 [CONFIGURATION.md](CONFIGURATION.md#数据目录)。

## 前端约定

- 纯原生 HTML/CSS/JS，无构建步骤；`dotnet build` 时 `wwwroot\**\*` 作为 `EmbeddedResource` 打进 exe，运行时经 `WebAssets` 提供。
- 浏览器直接打开 `wwwroot/index.html`（`?view=settings`、`?theme=light`）会走内置 demo bridge，方便调样式。
- 主题用 `data-theme` 属性 + CSS 变量；字号用 `--font-size`。
- 无边框窗口的标题栏靠 CSS `app-region: drag`（WebView2 的 `IsNonClientRegionSupportEnabled`）+ 少量消息桥兜底。
