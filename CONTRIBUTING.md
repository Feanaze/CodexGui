# 贡献指南

感谢你愿意花时间改进 Codex GUI。下面是最短的路径，照着走就能跑起来。

## 环境准备

- Windows 10 1809+ / Windows 11
- [.NET SDK 7.0 或更高](https://dotnet.microsoft.com/download)（仓库目标框架是 `net7.0-windows`，用 8.0 SDK 也能编译）
- [Node.js 18+](https://nodejs.org/)：可选，只有 `tools/` 下的前端冒烟测试需要
- [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)：Win11 自带
- 一份可用的 Codex CLI：`npm install -g @openai/codex`

## 本地运行

```powershell
dotnet build CodexGui.csproj -c Release
dotnet run
```

只想验证「GUI ↔ CLI」链路是否通（不开窗口、不需要点鼠标）：

```powershell
dotnet run -- --selftest "只回复：pong"
```

只想调前端样式，可以绕过 WPF：`wwwroot/index.html` 支持用浏览器打开（`?theme=light&view=settings` 可以直接进设置页），此时 `app.js` 会退回到内置的 demo bridge。

## 目录速查

- `MainWindow.xaml.cs`：窗口、WebView2 宿主、前后端消息桥、会话与子进程调度。
- `Services/`：配置、数据目录、codex 定位与启动、会话存储、内嵌资源。
- `wwwroot/`：前端界面，构建时会被嵌进 exe（`EmbeddedResource`）。
- `tools/`：Node 写的 DOM 桩与冒烟测试。

更完整的说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 代码风格

- C#：遵循 `.editorconfig`，4 空格缩进，启用可空引用类型；异步方法用 `Async` 结尾。
- 前端：原生 JS，不引第三方运行时；不要从 CDN 加载任何资源（界面必须离线可用）。
- 注释与界面文案用中文，标识符与提交信息用英文。
- 面向 `Services/` 的改动尽量保持 `MainWindow.xaml.cs` 只做「转发 + 渲染」。
- 不要为了小功能引入新的 NuGet 依赖；确有必要请在 PR 描述里说明理由。

## 测试

```powershell
dotnet build CodexGui.csproj -c Release                 # 必须 0 警告 0 错误
node tools/concurrency-test.js                          # 并发调度
node tools/session-ui-test.js                           # 会话 UI
node tools/window-chrome-test.js                        # 窗口标题栏
```

改动涉及进程调度、事件解析或会话读写时，请补一个能复现问题的用例，或在 PR 里写清手工验证步骤（截图/日志都可以）。

## 提交 PR

1. Fork 并从 `main` 切一个分支，例如 `fix/session-list-scroll`。
2. 保持提交粒度清晰，提交信息用祈使句：`fix: 修复会话列表滚动抖动`、`feat: 支持自定义字体`。
3. 确保构建通过、相关测试通过，并在 PR 描述里写：动机、改动点、验证方式、影响范围。
4. 界面改动请附截图（前后对比更好）。

## 提交前请自查

- [ ] 没有提交任何密钥、token、`auth.json`、`config.toml`、会话记录或日志。
- [ ] 没有引入个人绝对路径（例如某个人的 `D:\cpp`），路径一律走配置或环境变量。
- [ ] 没有把大文件（>`dist/`、模型、二进制）带进仓库。
- [ ] 界面文案与 README 保持同步。

提交前可以本地跑一次敏感信息扫描：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-secrets.ps1
```

## 报告问题

- Bug / 功能建议：用仓库的 Issue 模板，尽量带上版本号、Windows 版本、`codex --version`、复现步骤和日志（**记得先删掉里面的密钥**）。
- 安全问题：见 [SECURITY.md](SECURITY.md)，不要开公开 Issue。

## 许可证

提交代码即表示你同意以本仓库的 [MIT](LICENSE) 许可证发布你的贡献。
