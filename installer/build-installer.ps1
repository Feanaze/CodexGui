<#
.SYNOPSIS
    构建 Codex GUI 单文件安装包（自包含运行时 + 可选 Codex CLI，全部打进一个 exe）。

.EXAMPLE
    .\installer\build-installer.ps1
    .\installer\build-installer.ps1 -OutputExe D:\CodexGui-Setup-1.0.0.exe
    .\installer\build-installer.ps1 -SkipCodexCli -KeepPayload
#>
[CmdletBinding()]
param(
    [string]$Configuration = 'Release',
    # 与目标框架匹配的 .NET 运行时版本；留空表示自动取本机最高版本
    [string]$RuntimeVersion = '7.0.20',
    # Codex CLI 的原生包目录（npm 里 codex-win32-x64\vendor\x86_64-pc-windows-msvc）；留空自动查找
    [string]$CodexVendorDir = '',
    [switch]$SkipCodexCli,
    # 最终安装包的输出路径；留空输出到 <仓库>\artifacts\CodexGui-Setup-1.0.0.exe
    [string]$OutputExe = '',
    # 中间产物目录
    [string]$WorkDir = '',
    # gcc / windres 所在目录（MinGW-w64）；留空从 PATH 里找
    [string]$GccDir = '',
    [switch]$KeepPayload
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host "    $text" -ForegroundColor Green }

# MinGW 的 ld 会把内置的默认清单（default-manifest.o）和我们自己的清单一起合并，
# 合并失败时会往 stderr 打一条 .rsrc merge failure；实际采用的就是我们自己那份（RT_MANIFEST id=1），
# 所以这里把这行噪音过滤掉，只保留真正的报错。
function Invoke-Gcc([string[]]$gccArgs) {
    # 捕获原生 stderr 会被 PowerShell 当成错误记录，这里临时放宽错误策略
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $gcc @gccArgs 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    $output | Where-Object { $_ -notmatch '\.rsrc merge failure' } | ForEach-Object { Write-Host $_ }
    return $code
}

$installerDir = $PSScriptRoot
$repoRoot = Split-Path -Parent $installerDir
$project = Join-Path $repoRoot 'CodexGui.csproj'
if (-not (Test-Path -LiteralPath $project)) { throw "找不到项目文件：$project" }

if (-not $WorkDir) { $WorkDir = Join-Path $repoRoot 'artifacts\installer' }
$payloadDir = Join-Path $WorkDir 'payload'
$appDir = Join-Path $payloadDir 'app'
$zipPath = Join-Path $WorkDir 'payload.zip'
$setupExe = Join-Path $WorkDir 'CodexGui-Setup.exe'
if (-not $OutputExe) { $OutputExe = Join-Path $repoRoot 'artifacts\CodexGui-Setup-1.0.0.exe' }

# ---------------------------------------------------------------- 工具检查
function Resolve-Tool([string]$name, [string]$explicitDir) {
    if ($explicitDir) {
        $candidate = Join-Path $explicitDir "$name.exe"
        if (Test-Path -LiteralPath $candidate) { return $candidate }
        throw "在 $explicitDir 里找不到 $name.exe"
    }
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw "找不到 $name。请安装 MinGW-w64（或用 -GccDir 指定 gcc/windres 所在目录）。"
}

$gcc = Resolve-Tool 'gcc' $GccDir
$windres = Resolve-Tool 'windres' $GccDir
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw '找不到 node（make-selfcontained.js 需要 Node.js）。' }
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path -LiteralPath $tar)) { $tar = (Get-Command tar -ErrorAction SilentlyContinue).Source }
if (-not $tar) { throw '找不到 tar.exe（Windows 10 1803 及以上自带）。' }

Write-Step "准备工作目录 $WorkDir"
if (Test-Path -LiteralPath $payloadDir) { Remove-Item -LiteralPath $payloadDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputExe) | Out-Null

# ------------------------------------------------------- 1. 发布 GUI 本体
Write-Step '发布 CodexGui（framework-dependent，多文件）'
& dotnet publish $project -c $Configuration -r win-x64 --self-contained false `
    -p:PublishSingleFile=false -p:DebugType=none --nologo -v minimal -o $appDir
if ($LASTEXITCODE -ne 0) { throw "dotnet publish 失败（退出码 $LASTEXITCODE）" }

Get-ChildItem -Path $appDir -Include '*.pdb' -File -Recurse | Remove-Item -Force
Get-ChildItem -Path $appDir -Filter 'Microsoft.Web.WebView2.*.xml' -File | Remove-Item -Force
Write-Ok "已发布到 $appDir"

# --------------------------------------------- 2. 转成自包含（离线可用）
Write-Step '把发布产物转成自包含（复制本机运行时 + 改写 runtimeconfig/deps）'
$scArgs = @(
    (Join-Path $installerDir 'make-selfcontained.js'),
    '--publish-dir', $appDir,
    '--framework', 'Microsoft.NETCore.App',
    '--framework', 'Microsoft.WindowsDesktop.App'
)
if ($RuntimeVersion) { $scArgs += @('--version', $RuntimeVersion, '--version', $RuntimeVersion) }
& node @scArgs
if ($LASTEXITCODE -ne 0) { throw "make-selfcontained 失败（退出码 $LASTEXITCODE）" }

# ------------------------------------------------------- 3. Codex CLI
if (-not $SkipCodexCli) {
    Write-Step '打包 Codex CLI'
    if (-not $CodexVendorDir) {
        $candidates = @(
            (Join-Path $env:APPDATA 'npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc'),
            (Join-Path $env:LOCALAPPDATA 'npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc'),
            'D:\Codex\npm-global\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc'
        )
        # 注意：管道只返回一个对象时结果会退化成字符串，必须用 @() 兜住
        $candidates = @($candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
        if ($candidates.Count -gt 0) { $CodexVendorDir = $candidates[0] }
    }
    if (-not $CodexVendorDir -or -not (Test-Path -LiteralPath $CodexVendorDir)) {
        throw "找不到 Codex CLI 的原生包目录。请用 -CodexVendorDir 指定，或加 -SkipCodexCli 跳过。`n" +
              "提示：npm i -g @openai/codex 之后，它位于 %APPDATA%\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc"
    }

    $codexTarget = Join-Path $payloadDir 'codex'
    New-Item -ItemType Directory -Force -Path $codexTarget | Out-Null
    foreach ($item in 'bin', 'codex-path', 'codex-resources', 'codex-package.json') {
        $source = Join-Path $CodexVendorDir $item
        if (Test-Path -LiteralPath $source) {
            Copy-Item -LiteralPath $source -Destination $codexTarget -Recurse -Force
        } else {
            Write-Warning "缺少 $item（来自 $CodexVendorDir）"
        }
    }
    $cliSize = [math]::Round(((Get-ChildItem $codexTarget -Recurse -File | Measure-Object -Sum Length).Sum / 1MB), 1)
    Write-Ok "已加入 Codex CLI（$cliSize MB，来自 $CodexVendorDir）"
}

# ------------------------------------------------------- 4. 卸载程序
Write-Step '编译卸载程序'
$uninstallObj = Join-Path $WorkDir 'uninstall-resource.o'
Push-Location $installerDir
try {
    & $windres 'resource-uninstall.rc' -O coff -o $uninstallObj
    if ($LASTEXITCODE -ne 0) { throw 'windres 编译卸载程序资源失败' }
    $code = Invoke-Gcc @('-O2', '-s', '-mwindows', '-municode',
        '-o', (Join-Path $payloadDir 'uninstall.exe'), 'uninstall.c', $uninstallObj,
        '-lcomctl32', '-lshell32', '-lshlwapi', '-lole32', '-loleaut32', '-luuid',
        '-luser32', '-lgdi32', '-ladvapi32', '-static-libgcc')
    if ($code -ne 0) { throw "gcc 编译卸载程序失败（退出码 $code）" }
} finally { Pop-Location }
Write-Ok '卸载程序已生成'

# ------------------------------------------------------- 5. 打包载荷 zip
Write-Step '压缩载荷（zip）'
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
$zipEntries = @('app')
if (Test-Path -LiteralPath (Join-Path $payloadDir 'codex')) { $zipEntries += 'codex' }
if (Test-Path -LiteralPath (Join-Path $payloadDir 'uninstall.exe')) { $zipEntries += 'uninstall.exe' }

Push-Location $payloadDir
try {
    & $tar -a -c -f $zipPath @zipEntries
    if ($LASTEXITCODE -ne 0) { throw "tar 打包失败（退出码 $LASTEXITCODE）" }
} finally { Pop-Location }
$zipSize = [math]::Round(((Get-Item -LiteralPath $zipPath).Length / 1MB), 1)
Write-Ok "载荷 $zipSize MB"

# ------------------------------------------------------- 6. 编译安装程序
Write-Step '编译安装程序'
$setupObj = Join-Path $WorkDir 'setup-resource.o'
Push-Location $installerDir
try {
    & $windres 'resource-setup.rc' -O coff -o $setupObj
    if ($LASTEXITCODE -ne 0) { throw 'windres 编译安装程序资源失败' }
    $code = Invoke-Gcc @('-O2', '-s', '-mwindows', '-municode',
        '-o', $setupExe, 'setup.c', $setupObj,
        '-lcomctl32', '-lshell32', '-lshlwapi', '-lole32', '-loleaut32', '-luuid',
        '-luser32', '-lgdi32', '-ladvapi32', '-static-libgcc')
    if ($code -ne 0) { throw "gcc 编译安装程序失败（退出码 $code）" }
} finally { Pop-Location }

# ------------------------------------------------------- 7. 追加载荷
Write-Step '把载荷追加到安装程序尾部'
Copy-Item -LiteralPath $setupExe -Destination $OutputExe -Force

$magic = [System.Text.Encoding]::ASCII.GetBytes('CGXGUIPL')
$stream = [System.IO.File]::Open($OutputExe, 'Append', 'Write')
try {
    $payloadStream = [System.IO.File]::OpenRead($zipPath)
    try { $payloadStream.CopyTo($stream) } finally { $payloadStream.Dispose() }
    $lengthBytes = [BitConverter]::GetBytes([int64](Get-Item -LiteralPath $zipPath).Length)
    $stream.Write($lengthBytes, 0, 8)
    $stream.Write($magic, 0, 8)
} finally { $stream.Dispose() }

if (-not $KeepPayload) {
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $setupExe -Force -ErrorAction SilentlyContinue
}

$finalSize = [math]::Round(((Get-Item -LiteralPath $OutputExe).Length / 1MB), 1)
Write-Host ''
Write-Host "安装包已生成：$OutputExe（$finalSize MB）" -ForegroundColor Green
Write-Host "安装目录布局：<安装目录>\app（程序+运行时）、codex\（CLI）、data\（运行后生成）" -ForegroundColor DarkGray
