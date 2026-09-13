# 构建与打包

## 前置条件

- Windows 10 1809+ / Windows 11
- [.NET SDK 7.0 或更高](https://dotnet.microsoft.com/download)（项目目标框架为 `net7.0-windows`；用 8.0 SDK 编译同样可行）
- 可选：Node.js 18+（只用于 `tools/` 下的前端冒烟测试）
- 可选：一份 Codex CLI（`npm install -g @openai/codex`），用于本地真实联调

## 编译

```powershell
dotnet build CodexGui.csproj -c Release
```

期望输出：**0 警告 0 错误**，产物在 `CodexGui/bin/Release/net7.0-windows/win-x64/`。

## 运行

```powershell
dotnet run                                     # 正常启动
dotnet run -- --selftest "只回复：pong"         # 无界面链路自检
```

> 注意：`app.manifest` 里声明了 `requireAdministrator`（Windows 沙箱要提权），所以本地也是以管理员身份启动，会出现 UAC 提示。如果不想要，把 `requestedExecutionLevel` 改成 `asInvoker`。

## 发布

### 1. 单文件（推荐，目标机器需装 .NET 7 Desktop Runtime）

```powershell
dotnet publish CodexGui.csproj -c Release -r win-x64 `
  -p:PublishSingleFile=true -p:SelfContained=false -p:DebugType=none -o dist
```

产物：`dist\CodexGui.exe` 以及 `WebView2Loader.dll`、`runtimes\win-x64\native\WebView2Loader.dll`（WebView2 的原生加载器必须跟 exe 放在一起）。

### 2. 自包含（目标机器什么都不用装）

```powershell
dotnet publish CodexGui.csproj -c Release -r win-x64 `
  -p:PublishSingleFile=true -p:SelfContained=true -p:IncludeNativeLibrariesForSelfExtract=true -o dist
```

体积会明显变大（要带上运行时），但用户不需要预装 .NET。

### 3. 打成 zip

```powershell
Compress-Archive dist\* artifacts\CodexGui-1.0.0-win-x64.zip
```

## 便携模式

在程序目录放一个空的 `portable.marker` 文件，数据目录就固定为 `<程序目录>\data`（配置、会话、`codex-home` 全部跟着程序走），卸载时删目录即可：

```powershell
New-Item -ItemType File dist\portable.marker
```

## 打成单文件安装包

想让用户「下载一个 exe、双击、填个 API 地址就能用」，用仓库里的安装器构建脚本：

```powershell
.\installer\build-installer.ps1 -OutputExe D:\CodexGui-Setup-1.0.0.exe
```

它会自动完成：发布 GUI → 转成自包含（离线可用）→ 打包 Codex CLI → 编译原生安装/卸载程序 →
合成一个自解压安装包。完整说明见 [../installer/README.md](../installer/README.md)。

## 把 Codex CLI 一起打包（可选）

如果想让用户连 `npm install -g @openai/codex` 都不用做，可以把 npm 全局安装目录里的原生 CLI 复制进来，保持 npm 的相对布局：

```
dist\
├─ CodexGui.exe
├─ codex\bin\codex.exe
├─ codex\codex-path\rg.exe
├─ codex\codex-resources\codex-command-runner.exe
├─ codex\codex-resources\codex-windows-sandbox-setup.exe
└─ portable.marker
```

这些文件来自 `node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\`（`bin\`、`codex-path\`、`codex-resources\` 三个目录原样搬）。`CodexLocator` 会优先使用它，用户不需要装 Node.js。

> 分发前请确认你遵守 OpenAI 对 Codex CLI 的许可与使用条款；不想承担这部分责任的话，就让用户自己 `npm install -g @openai/codex`，本项目的界面代码不依赖任何一份具体的 CLI 二进制。

## 敏感信息自查

打包前（尤其是把产物压缩进「安装包/便携包」之前）务必确认没有把数据目录带进去：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-secrets.ps1 -Path dist
```

需要重点排除的目录：`codex-home\`（含 `auth.json`、`config.toml`、CLI 会话历史）、`sessions\`、`WebView2\`、`*.sqlite*`、`log.txt`。

## CI / Release

- `.github/workflows/build.yml`：push / PR 时在 Windows 上编译并跑构建产物上传。
- `.github/workflows/release.yml`：打 `v*` 标签时发布单文件版本并创建 GitHub Release。

## 常见构建问题

| 现象 | 处理 |
| --- | --- |
| `NETSDK1045 / 找不到 net7.0 目标包` | 安装 .NET 7 SDK，或用 8.0 SDK（会自动下载 7.0 的引用包） |
| NuGet 还原失败（公司网络/代理） | 配置 `nuget.config` 源或设置代理；离线环境可用内网源 |
| 启动时提示缺少 WebView2 | 安装 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) |
| 界面空白且无报错 | 打开 `<数据目录>\log.txt`，并确认 `runtimes\win-x64\native\WebView2Loader.dll` 在 exe 旁边 |
