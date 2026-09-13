# 配置说明

配置分两层，互不重叠：

- **应用配置**：窗口、主题、工作目录、模型名等 → `<数据目录>\config.json`（本文件重点）。
- **Codex CLI 配置**：服务商、`base_url`、密钥、沙箱 → `<数据目录>\codex-home\config.toml` 与 `auth.json`。

## 数据目录

解析顺序（`Services/StoragePaths.cs`）：

1. 环境变量 `CODEXGUI_DATA_DIR`（绝对路径）；
2. 程序目录下存在 `portable.marker`：
   - 文件为空 → `<程序目录>\data`（绿色便携版）；
   - 文件里写了一行路径 → 用这个路径当数据目录（安装包把它写成 `<安装目录>\data`）；
3. 已经存在 `config.json` 的 `%LOCALAPPDATA%\CodexGui`；
4. `D:\Codex\CodexGuiData`（最早版本写死的路径，只要目录还在就继续沿用，避免老用户会话「消失」）；
5. 默认 `%LOCALAPPDATA%\CodexGui`。

目录内结构：

```
config.json      应用配置
log.txt          运行日志（出错时看这里）
sessions\        会话 JSON
attachments\     附件副本
WebView2\        WebView2 用户数据
codex-home\      Codex CLI 的 CODEX_HOME
```

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `CODEXGUI_DATA_DIR` | 覆盖数据目录（最高优先级） |
| `CODEXGUI_CODEX_HOME` | 覆盖 `CODEX_HOME`，默认 `<数据目录>\codex-home` |
| `CODEX_HOME` | GUI 启动 CLI 时会设置成上面的值；手动跑 `codex` 时也可以自己设 |
| `HOME` | 子进程缺少时由 GUI 补上 |
| `DEEPSEEK_API_KEY` 等 | 推荐做法：把密钥放在环境变量里，`config.toml` 用 `env_key` 引用，避免密钥落盘 |

## 应用配置（config.json）

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `WorkDir` | string | 用户主目录 | 默认工作目录；也是 Codex 沙箱的根目录 |
| `CodexPath` | string? | `null` | 手动指定 `codex.exe`；`null` 表示自动检测 |
| `Model` | string | `""` | 传给 `codex -m`；留空用 CLI 的默认模型 |
| `ReasoningEffort` | string | `""` | `low` / `medium` / `high` / `max`；留空用默认 |
| `Sandbox` | string | `workspace-write` | `read-only` / `workspace-write` / `danger-full-access` |
| `Approval` | string | `never` | 预留字段（当前版本不参与命令行拼装） |
| `Theme` | string | `dark` | `dark` / `light` / `system` |
| `FontSize` | number | `15` | 聊天区字号，有效范围 11–24 |
| `ShowReasoning` | bool | `true` | 是否显示思考过程 |
| `AutoCollapseTools` | bool | `true` | 长命令输出默认折叠 |
| `SendOnEnter` | bool | `true` | `false` 时改为 `Ctrl+Enter` 发送 |
| `RecentDirs` | string[] | `[]` | 最近使用的工作目录（最多 10 个） |
| `WindowWidth` / `WindowHeight` | number | 1360 / 860 | 窗口尺寸 |
| `WindowLeft` / `WindowTop` | number | `NaN` | 窗口位置；`NaN` 表示居中 |
| `WindowMaximized` | bool | `false` | 上次是否为最大化 |
| `SidebarWidth` | number | `272` | 侧栏宽度，范围 200–520 |
| `LastSessionId` | string? | `null` | 上次打开的会话 |

整个文件可以直接手工编辑（程序退出后改），也可以在界面里改——界面的每次修改都会立刻回写。字段非法时会自动纠正到默认值（`AppConfig.Normalize`）。

## Codex CLI 配置

### 示例 A：DeepSeek（密钥放环境变量，推荐）

`<数据目录>\codex-home\config.toml`：

```toml
model = "deepseek-chat"          # 换成服务商实际支持的模型名
model_provider = "deepseek"
preferred_auth_method = "apikey"
forced_login_method = "api"
model_reasoning_effort = "high"
web_search = "disabled"          # 该服务商不支持联网搜索时保持关闭

[projects.'d:\work']
trust_level = "trusted"          # 免去首次进入目录的信任确认

[model_providers.deepseek]
name = "deepseek"
base_url = "https://api.deepseek.com/"
wire_api = "responses"           # 当前 Codex CLI 只认 Responses 协议（"chat" 已被移除）
env_key = "DEEPSEEK_API_KEY"
```

```powershell
setx DEEPSEEK_API_KEY "sk-你的密钥"
```

### 示例 B：OpenAI 官方

```toml
model = "gpt-5.1-codex"
model_provider = "openai"

[model_providers.openai]
name = "openai"
base_url = "https://api.openai.com/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
```

### 示例 C：把密钥写在文件里

部分用户（或第三方中转服务）只提供长期 token，可以直接写进 `config.toml`：

```toml
[model_providers.deepseek]
base_url = "https://api.deepseek.com/"
wire_api = "responses"
experimental_bearer_token = "sk-你的密钥"
```

或者按 Codex CLI 的登录态保存到 `auth.json`：

```json
{ "auth_mode": "apikey", "OPENAI_API_KEY": "sk-你的密钥" }
```

这两种方式密钥都是**明文落盘**，只适合自己用的机器；能改用 `env_key` 就尽量改用 `env_key`。

### 模型清单（可选）

界面顶栏的模型菜单读的是 `<数据目录>\codex-home\models.json` 里的 `models[]`，用得上的字段：

```json
{
  "models": [
    {
      "slug": "deepseek-chat",
      "display_name": "DeepSeek Chat",
      "description": "通用对话模型",
      "default_reasoning_level": "high",
      "supported_reasoning_levels": [
        { "effort": "low", "description": "快速回答" },
        { "effort": "high", "description": "更深入推理" }
      ]
    }
  ]
}
```

没有这个文件也能用：菜单会显示「默认模型」，实际模型取 `config.toml` 的 `model`。

## 沙箱与权限

- GUI 通过 `codex exec -s <模式>` 指定沙箱：`read-only` 只看不动，`workspace-write` 可改工作目录，`danger-full-access` 不限制。
- 本程序在 `app.manifest` 里声明了 `requireAdministrator`：Windows 上的沙箱与提权行为需要管理员权限，所以启动会弹 UAC。想要免 UAC 就把 `requestedExecutionLevel` 改成 `asInvoker`（代价是部分沙箱能力受限）。
- 工作目录本身也要存在：目录不存在时 GUI 会提示「工作目录不存在」，不会静默失败。

## 重置 / 迁移

- **重置全部设置**：退出程序，删除 `<数据目录>\config.json`。
- **清空对话**：删除 `<数据目录>\sessions\*.json`（GUI 侧记录）与 `<数据目录>\codex-home\sessions\`、`*.sqlite*`（CLI 侧历史）。
- **换机器**：整个数据目录拷走即可（里面含密钥，注意安全）。
- **多套环境共存**：用 `CODEXGUI_DATA_DIR` 指向不同目录，例如 `D:\CodexGui-work`、`D:\CodexGui-personal`。
