<#
.SYNOPSIS
    交互式写入 Codex CLI 的 config.toml（可选 auth.json），把 GUI 接到你自己的 API 上。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/setup-provider.ps1 -BaseUrl "https://api.deepseek.com/" -Model "deepseek-chat"
    powershell -ExecutionPolicy Bypass -File scripts/setup-provider.ps1 -BaseUrl "https://api.deepseek.com/" -Model "deepseek-chat" -StoreKeyInFile
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = 'https://api.deepseek.com/',
    [string]$Model = 'deepseek-chat',
    [ValidateSet('chat', 'responses')][string]$WireApi = 'chat',
    [string]$ProviderId = 'deepseek',
    [string]$EnvKeyName = '',
    [string]$CodexHome = '',
    [string]$WorkDir = '',
    [string]$ApiKey = '',
    [switch]$StoreKeyInFile,
    [switch]$SetUserEnvVar,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

if (-not $CodexHome) { $CodexHome = Join-Path $env:LOCALAPPDATA 'CodexGui\codex-home' }
if (-not $WorkDir) { $WorkDir = $env:USERPROFILE }
if (-not $EnvKeyName) { $EnvKeyName = ($ProviderId.ToUpperInvariant() -replace '[^A-Z0-9]', '_') + '_API_KEY' }

New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
$configFile = Join-Path $CodexHome 'config.toml'
$authFile = Join-Path $CodexHome 'auth.json'

if ((Test-Path -LiteralPath $configFile) -and -not $Force) {
    Write-Warning "config.toml 已存在：$configFile"
    Write-Warning "如需覆盖请加 -Force（建议先备份）。"
    exit 1
}

if ($StoreKeyInFile -and -not $ApiKey) {
    $secure = Read-Host -AsSecureString "请输入 API Key（输入不会回显）"
    $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
if ($ApiKey -and $SetUserEnvVar) {
    [Environment]::SetEnvironmentVariable($EnvKeyName, $ApiKey, 'User')
    Write-Host "已写入用户环境变量 $EnvKeyName（新开的终端/GUI 生效）。" -ForegroundColor Green
}

$providerSection = if ($StoreKeyInFile) {
    if (-not $ApiKey) { throw "使用 -StoreKeyInFile 时必须提供 -ApiKey 或交互输入。" }
    @"
[model_providers.$ProviderId]
name = "$ProviderId"
base_url = "$BaseUrl"
wire_api = "$WireApi"
experimental_bearer_token = "$ApiKey"
"@
} else {
    @"
[model_providers.$ProviderId]
name = "$ProviderId"
base_url = "$BaseUrl"
wire_api = "$WireApi"
env_key = "$EnvKeyName"
"@
}

$toml = @"
# 由 Codex GUI 的 scripts/setup-provider.ps1 生成
model = "$Model"
model_provider = "$ProviderId"
preferred_auth_method = "apikey"
forced_login_method = "api"
model_reasoning_effort = "high"
web_search = "disabled"

[projects.'$($WorkDir.ToLowerInvariant())']
trust_level = "trusted"

$providerSection
"@

# TOML 文件按 UTF-8 无 BOM 写，避免部分解析器把 BOM 当成非法字符
[IO.File]::WriteAllText($configFile, $toml, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "已写入 $configFile（model=$Model, base_url=$BaseUrl, wire_api=$WireApi）" -ForegroundColor Green

if ($StoreKeyInFile) {
    $auth = [ordered]@{ auth_mode = 'apikey'; OPENAI_API_KEY = $ApiKey } | ConvertTo-Json
    [IO.File]::WriteAllText($authFile, $auth, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "已写入 $authFile（注意：密钥明文保存在本机文件中）" -ForegroundColor Yellow
} else {
    Write-Host "密钥没有写入文件。请自行设置环境变量后重启 GUI：" -ForegroundColor Cyan
    Write-Host "  setx $EnvKeyName `"你的密钥`"" -ForegroundColor Cyan
}

Write-Host "数据目录（GUI 使用）：$(Split-Path -Parent $CodexHome)" -ForegroundColor Cyan
