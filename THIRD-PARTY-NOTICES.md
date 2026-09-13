# 第三方组件说明

本仓库自身以 [MIT](LICENSE) 发布。运行时依赖以下第三方组件，它们的许可与版权归各自所有者。

## Microsoft.Web.WebView2

- 用途：在 WPF 中承载界面（`WebView2` 控件）。
- 形式：通过 NuGet 包 `Microsoft.Web.WebView2` 引用，构建时还原。
- 许可：随包附带的许可条款（详见 NuGet 包内的 `LICENSE.txt` 与 <https://www.nuget.org/packages/Microsoft.Web.WebView2/>）。
- 运行时还需要机器上安装 **Microsoft Edge WebView2 Runtime**，它由 Microsoft 分发和维护。

## .NET / Windows Desktop Runtime

- 用途：应用运行时的基础框架（WPF、System.Text.Json 等）。
- 许可：MIT（<https://github.com/dotnet/runtime>）。

## Codex CLI（`@openai/codex`）

- 用途：真正执行任务的 Agent 进程，由本界面通过子进程调用。
- 分发方式：**本仓库不包含、也不重新分发其二进制**。请自行通过 npm 安装，或使用官方发布的版本。
- 许可与使用条款以其官方仓库为准：<https://github.com/openai/codex>。

## 图标

`Assets/app.ico` 由本仓库的 `tools/make-icon.ps1` 生成，不包含第三方素材。

## 前端

`wwwroot/` 下的 HTML / CSS / JS 全部为本项目自写，运行时不加载任何 CDN、外部字体或统计脚本。
