# 常见问题

## 启动与界面

**Q：双击 exe 弹 UAC，能不能不要？**

`app.manifest` 里是 `requireAdministrator`——Codex 的 Windows 沙箱需要管理员权限。不想要的话把 `requestedExecutionLevel` 改成 `asInvoker` 再重新编译；代价是部分沙箱能力受限。

**Q：窗口打开了但一片空白，或者提示「WebView2 运行时初始化失败」。**

装一下 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（Win11 自带，Win10 部分机器没装）。另外确认 `WebView2Loader.dll` 与 `CodexGui.exe` 在同一目录，且 `runtimes\win-x64\native\WebView2Loader.dll` 存在。

**Q：提示「Codex GUI 已经在运行了」。**

程序是单实例的，去任务栏或托盘把已有的窗口找出来即可。要用两个互不干扰的实例，请用不同的 `CODEXGUI_DATA_DIR`（单实例互斥量是全局的，所以更推荐只开一个）。

**Q：界面能打开，但发消息提示「没有找到 codex 命令」。**

依次检查：

1. `codex --version` 在终端里能不能跑；
2. npm 全局目录是否在 `PATH`（`npm config get prefix`，常见是 `%APPDATA%\npm`）；
3. 在设置里手动填 `codex.exe` 的完整路径；
4. 便携包用户确认 `codex\bin\codex.exe` 与 `CodexGui.exe` 的相对位置正确（见 [BUILD.md](BUILD.md#把-codex-cli-一起打包可选)）。

## 模型与 API

**Q：怎么换成 DeepSeek / 中转服务？**

改 `<数据目录>\codex-home\config.toml`：设置 `model`、`model_provider`，并在 `[model_providers.<id>]` 里写 `base_url`、`wire_api`、`env_key`（或 `experimental_bearer_token`）。完整示例见 [CONFIGURATION.md](CONFIGURATION.md#codex-cli-配置)。

**Q：顶栏模型菜单是空的。**

菜单读 `<数据目录>\codex-home\models.json`；没有这个文件时显示「默认模型」，实际模型取 `config.toml` 的 `model` 字段，功能不受影响。

**Q：报 `401` / `invalid api key`。**

1. 密钥是否写在环境变量里而**没有重启** GUI（`setx` 只对新进程生效，重启 GUI 或注销一次）；
2. `base_url` 末尾斜杠、`wire_api`（`chat` vs `responses`）是否和服务商匹配；
3. 第三方中转是否允许 Codex CLI 的请求格式。

**Q：`web_search` 报错或模型说不能联网。**

在 `config.toml` 里加 `web_search = "disabled"`。

## 使用

**Q：快捷键有哪些？**

| 快捷键 | 作用 |
| --- | --- |
| `Enter` / `Shift+Enter` | 发送 / 换行（设置里关掉「Enter 发送」后变成 `Ctrl+Enter` 发送） |
| `Ctrl+N` | 新建对话 |
| `Ctrl+K` | 聚焦搜索框 |
| `Ctrl+B` | 折叠 / 展开侧栏 |
| `Ctrl+,` | 打开设置 |
| `Esc` | 关闭弹层 |

**Q：能同时跑多个会话吗？**

可以，不同会话互不干扰；同一个会话同一时刻只允许一轮，避免同一个 CLI 线程被并发续接。

**Q：命令输出乱码。**

子进程按 UTF-8 读取输出。如果是你自己的程序在被 Agent 调用时输出乱码，请在程序里显式用 UTF-8 输出，或在命令前加 `chcp 65001 >nul &`。

**Q：怎么停止正在跑的一轮？**

输入框右侧的停止按钮，或按会话切换走再回来，状态会从 CLI 事件流恢复；停止会结束整棵进程树。

## 数据与隐私

**Q：会话保存在哪？删掉会怎样？**

`<数据目录>\sessions\<id>.json`。删除某个文件即从 GUI 列表里消失；CLI 侧的历史在 `codex-home`（`sessions\`、`*.sqlite*`、`history.jsonl`），需要一起删才彻底清空。

**Q：数据目录到底在哪？**

默认 `%LOCALAPPDATA%\CodexGui`；如果程序目录有 `portable.marker` 就是 `<程序目录>\data`；如果 `D:\Codex\CodexGuiData` 还在（早期版本路径）会继续沿用；也可以用 `CODEXGUI_DATA_DIR` 指定。界面「设置」里会显示当前数据目录。

**Q：会上传我的数据吗？**

不会。程序没有遥测和自动更新，所有请求都由 Codex CLI 直接发往你自己在 `config.toml` 里配置的 `base_url`。

**Q：密钥存在哪？安全吗？**

`<数据目录>\codex-home\auth.json` 或 `config.toml` 里，**明文**。这是 Codex CLI 的既有设计。想降低风险就用 `env_key` + 系统环境变量，或者只给密钥最小额度。

## 故障排查

**Q：日志在哪？**

`<数据目录>\log.txt`（未处理异常、配置读写失败等），界面右下角的提示气泡只显示当前这一轮的错误。

**Q：想验证 GUI ↔ CLI 链路是否通？**

```powershell
CodexGui.exe --selftest "只回复：pong"
```

它会打印找到的 codex 路径、收到的事件和退出码，不开窗口。

**Q：升级后会话不见了。**

大概率是数据目录换了（比如原来在 `D:\Codex\CodexGuiData`，现在解析到了 `%LOCALAPPDATA%\CodexGui`）。用 `CODEXGUI_DATA_DIR` 指回原来的目录即可。
