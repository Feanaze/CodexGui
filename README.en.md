# Codex GUI

A native Windows GUI for the [Codex CLI](https://github.com/openai/codex): sessions, Markdown rendering, tool-call cards, reasoning traces and image attachments, in a regular desktop window.

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4)
![.NET](https://img.shields.io/badge/.NET-7.0--windows-512BD4)
![License](https://img.shields.io/badge/license-MIT-green)

English | [简体中文](README.md)

> Unofficial third-party UI. Not affiliated with OpenAI or DeepSeek. It only drives the Codex CLI that is already installed on your machine; API traffic goes straight from the CLI to the provider you configure.

## Features

- **Multiple sessions** with search, per-session working directory, and concurrent runs (one turn per session at a time).
- **Live streaming output** parsed from the `codex exec --json` event stream.
- **Tool-call cards** for commands, exit codes and stdout/stderr, with auto-collapse and copy.
- **File-change, todo and reasoning cards**; reasoning display can be toggled.
- **Markdown + syntax highlighting** rendered offline by a bundled renderer.
- **Image attachments** passed to Codex via `-i`.
- **Model / reasoning effort / sandbox mode** switchers in the title bar.
- **Themes and UI preferences**: dark, light, follow system, font size, Enter-to-send.
- **Native window chrome**: frameless window with WebView2 native drag region, double-click maximize and system menu.
- **Local-only**: no account, no telemetry, everything stays on your machine.

## Requirements

| Component | Notes |
| --- | --- |
| OS | Windows 10 1809+ / Windows 11 (x64) |
| Runtime | [.NET 7 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/7.0) (not needed for self-contained builds) |
| WebView2 | [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (bundled with Windows 11) |
| Codex CLI | `@openai/codex` (Node.js 18+), or any copy of `codex.exe` |

## Quick start

```powershell
# 1. install the CLI
npm install -g @openai/codex

# 2. clone the repository
git clone https://github.com/Feanaze/CodexGui.git
cd CodexGui

# 3. run the GUI from source
dotnet run
```

Then configure your provider in Codex's own config file, e.g.
`%LOCALAPPDATA%\CodexGui\codex-home\config.toml`:

```toml
model = "deepseek-chat"
model_provider = "deepseek"
preferred_auth_method = "apikey"
forced_login_method = "api"

[model_providers.deepseek]
name = "deepseek"
base_url = "https://api.deepseek.com/"
wire_api = "chat"
env_key = "DEEPSEEK_API_KEY"
```

See [`samples/`](samples/) for ready-to-copy examples, and [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for every application setting.

## Privacy

No telemetry, no auto-update, no account. Sessions, configuration and `codex-home` (including `auth.json`) live in a local data directory:
`%LOCALAPPDATA%\CodexGui`, or `<program dir>\data` in portable mode (a `portable.marker` file next to the executable), or whatever `CODEXGUI_DATA_DIR` points to.

## Build

```powershell
dotnet build CodexGui.csproj -c Release
dotnet publish CodexGui.csproj -c Release -r win-x64 `
  -p:PublishSingleFile=true -p:SelfContained=false -o dist
```

Add `-p:SelfContained=true` for a build that needs no pre-installed runtime. See [docs/BUILD.md](docs/BUILD.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Build & packaging](docs/BUILD.md)
- [Configuration](docs/CONFIGURATION.md)
- [FAQ](docs/FAQ.md)
- [Contributing](CONTRIBUTING.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Security](SECURITY.md)

## License

[MIT](LICENSE) © 2026 Feanaze. Third-party notices: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
