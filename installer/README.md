# 安装包构建（Windows）

`build-installer.ps1` 会把这些东西打成一个单文件安装程序：

```
CodexGui-Setup-1.0.0.exe
├─（本体）原生 Win32 安装程序，见 setup.c / uninstall.c
└─（尾部追加）payload.zip
   ├─ app\            CodexGui 本体 + 自包含 .NET 运行时
   ├─ codex\          可选的 Codex CLI（免装 Node.js）
   └─ uninstall.exe   卸载程序
```

安装后目录结构：

```
<安装目录>\
├─ app\            CodexGui.exe 及运行时（portable.marker 指向下面的 data）
├─ codex\bin\      codex.exe（如果打包时带上了 CLI）
├─ data\           配置、会话、codex-home（安装后生成，安装包里不含）
└─ uninstall.exe
```

## 依赖

- .NET SDK（编译 GUI）与 Node.js（`make-selfcontained.js` 需要）
- MinGW-w64 的 `gcc` / `windres`（编译原生安装程序），例如 <https://winlibs.com/>
- 系统自带 `tar.exe`（Windows 10 1803+，安装时用来解压）

## 用法

```powershell
# 最简：自动找 npm 全局里的 Codex CLI，打包成单文件安装程序
.\installer\build-installer.ps1

# 指定 CLI 位置、输出路径、运行时版本
.\installer\build-installer.ps1 `
    -CodexVendorDir "$env:APPDATA\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc" `
    -OutputExe "$PWD\artifacts\CodexGui-Setup-1.0.0.exe"

# 不带 CLI（用户自己 npm 安装 codex）
.\installer\build-installer.ps1 -SkipCodexCli
```

## 安装程序支持的开关

```powershell
CodexGui-Setup-1.0.0.exe                          # 图形界面
CodexGui-Setup-1.0.0.exe /silent                 # 静默安装到 %LOCALAPPDATA%\Programs\CodexGui
CodexGui-Setup-1.0.0.exe /silent /dir=D:\CodexGui  # 指定目录
CodexGui-Setup-1.0.0.exe /nopath /noshortcut /nolaunch
```

`/nopath` 不写 PATH，`/noshortcut` 不建快捷方式，`/nolaunch` 装完不启动。

## 卸载

`<安装目录>\uninstall.exe`，或「设置 → 应用 → 已安装的应用」里的 Codex GUI。
卸载默认保留 `data` 目录，勾选「同时删除 data 目录」才会连同会话记录和密钥一起删除。

## 关于 `make-selfcontained.js`

标准做法是 `dotnet publish --self-contained`，但那需要联网下载 runtime pack。为了在离线环境里
也能产出「目标机器不用装 .NET」的安装包，脚本把本机 `%ProgramFiles%\dotnet\shared\` 里的框架文件
展平复制到发布目录，并按 SDK 的格式改写 `runtimeconfig.json`（`includedFrameworks`）与
`deps.json`（把框架文件登记为 `runtimepack` 资产）。产物用 `COREHOST_TRACE=1` 验证过：
`hostfxr`、`hostpolicy`、`coreclr`、`System.Private.CoreLib` 全部来自程序目录。
