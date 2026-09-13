<#
.SYNOPSIS
    一键发布：编译 → 可选自包含/便携 → 可选带上 Codex CLI → 可选打 zip。

.EXAMPLE
    # 在 PowerShell 会话里直接跑（推荐）
    .\scripts\publish.ps1 -Portable -Zip
    .\scripts\publish.ps1 -SelfContained -CodexVendorDir "$env:APPDATA\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc"

    # 执行策略受限时（-File 会把 -Switch 当字符串，所以这里用 -Command）
    powershell -ExecutionPolicy Bypass -Command "& .\scripts\publish.ps1 -Portable -Zip"
#>
[CmdletBinding()]
param(
    [string]$Configuration = 'Release',
    [string]$OutputDir = 'artifacts\CodexGui',
    [switch]$SelfContained,
    [switch]$Portable,
    [string]$CodexVendorDir = '',
    [switch]$Zip
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$project = Join-Path $repoRoot 'CodexGui.csproj'
if (-not (Test-Path -LiteralPath $project)) { throw "找不到项目文件：$project" }

if (Test-Path -LiteralPath $OutputDir) { Remove-Item -LiteralPath $OutputDir -Recurse -Force }

$publishArgs = @(
    'publish', $project,
    '-c', $Configuration,
    '-r', 'win-x64',
    '-p:PublishSingleFile=true',
    '-p:DebugType=none',
    '-o', $OutputDir
)
if ($SelfContained) {
    $publishArgs += @('-p:SelfContained=true', '-p:IncludeNativeLibrariesForSelfExtract=true')
} else {
    $publishArgs += '-p:SelfContained=false'
}

Write-Host "dotnet $($publishArgs -join ' ')" -ForegroundColor Cyan
& dotnet @publishArgs
if ($LASTEXITCODE -ne 0) { throw "dotnet publish 失败（退出码 $LASTEXITCODE）" }

if ($Portable) {
    New-Item -ItemType File -Force -Path (Join-Path $OutputDir 'portable.marker') | Out-Null
    Write-Host '已开启便携模式（portable.marker），数据目录为 <程序目录>\data' -ForegroundColor Green
}

if ($CodexVendorDir) {
    $vendor = (Resolve-Path -LiteralPath $CodexVendorDir).Path
    $target = Join-Path $OutputDir 'codex'
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    foreach ($sub in 'bin', 'codex-path', 'codex-resources', 'codex-package.json') {
        $src = Join-Path $vendor $sub
        if (Test-Path -LiteralPath $src) {
            Copy-Item -LiteralPath $src -Destination $target -Recurse -Force
        } else {
            Write-Warning "缺少 $sub（来自 $vendor）"
        }
    }
    Write-Host "已把 Codex CLI 复制到 $target（用户无需安装 Node.js）" -ForegroundColor Green
}

& (Join-Path $PSScriptRoot 'check-secrets.ps1') -Path $OutputDir

if ($Zip) {
    $zipPath = Join-Path (Split-Path -Parent $OutputDir) ("CodexGui-{0}-win-x64.zip" -f $Configuration.ToLowerInvariant())
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    Compress-Archive -Path (Join-Path $OutputDir '*') -DestinationPath $zipPath
    Write-Host "已生成 $zipPath" -ForegroundColor Green
}

Write-Host "发布完成：$OutputDir" -ForegroundColor Green
