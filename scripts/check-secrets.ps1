<#
.SYNOPSIS
    开源/打包前的敏感信息自查：找密钥、找会话记录、找个人绝对路径。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/check-secrets.ps1
    powershell -ExecutionPolicy Bypass -File scripts/check-secrets.ps1 -Path dist,CodexGui
#>
[CmdletBinding()]
param(
    [string[]]$Path = @('.'),
    [switch]$IncludeDependencies
)

$ErrorActionPreference = 'Stop'

# 二进制/大型目录直接跳过，省时间也避免误报
$skipDirs = @('\.git\', '\bin\', '\obj\', '\node_modules\')
$skipExt = @('.exe', '.dll', '.pdb', '.ico', '.png', '.jpg', '.zip', '.7z', '.woff', '.woff2', '.sqlite', '.sqlite-wal', '.sqlite-shm')
if (-not $IncludeDependencies) { $skipDirs += @('\.nuget\') }

# 允许出现的“像密钥但不是密钥”的占位符
$allowWords = @('你的密钥', 'YOUR_KEY', 'YOUR-KEY', 'your-key', 'PUT-YOUR', 'placeholder', 'example', 'xxx', '***', 'REDACTED', '$env:', '%', '$(')

$patterns = [ordered]@{
    'API 密钥（sk-…）'      = 'sk-[A-Za-z0-9_\-]{16,}'
    'Bearer Token'          = '(?i)bearer\s+[A-Za-z0-9\-_\.]{24,}'
    '疑似密钥赋值'          = '(?i)(api[_\-]?key|apikey|secret|token|password)\s*[:=]\s*"([^"]{16,})"'
    '个人用户目录（C:\Users\xxx）' = '(?i)[A-Z]:\\Users\\[A-Za-z0-9._\-]+'
}

# 这些文件名出现在仓库里基本就是误提交：运行时会话/凭据
$dangerFiles = @('auth.json', 'credentials.json', 'log.txt')
$dangerDirs = @('\codex-home', '\sessions', '\attachments', '\WebView2')

$problems = New-Object System.Collections.Generic.List[string]
$scanned = 0

function Test-SkipPath([string]$full) {
    foreach ($d in $skipDirs) { if ($full -like "*$d*") { return $true } }
    $ext = [IO.Path]::GetExtension($full)
    return $skipExt -contains $ext
}

foreach ($root in $Path) {
    if (-not (Test-Path -LiteralPath $root)) { Write-Warning "路径不存在：$root"; continue }

    $files = if (Test-Path -LiteralPath $root -PathType Container) {
        Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue
    } else { Get-Item -LiteralPath $root }

    foreach ($f in $files) {
        if (Test-SkipPath $f.FullName) { continue }
        if ($dangerFiles -contains $f.Name) {
            $problems.Add("运行时会话/凭据文件被纳入范围：$($f.FullName)")
            continue
        }
        if ($f.Extension -eq '.json' -and $f.FullName -like '*\sessions\*') {
            $problems.Add("会话文件被纳入范围：$($f.FullName)")
            continue
        }

        $scanned++
        $lineNo = 0
        foreach ($line in (Get-Content -LiteralPath $f.FullName -ErrorAction SilentlyContinue)) {
            $lineNo++
            $isAllowed = $false
            foreach ($w in $allowWords) { if ($line.Contains($w)) { $isAllowed = $true; break } }

            foreach ($name in $patterns.Keys) {
                $m = [regex]::Match($line, $patterns[$name])
                if (-not $m.Success) { continue }
                if ($isAllowed) { continue }
                $problems.Add("[$name] $($f.FullName):$lineNo -> $($m.Value)")
            }
        }
    }

    foreach ($dir in $dangerDirs) {
        Get-ChildItem -LiteralPath $root -Recurse -Directory -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -like "*$dir" } |
            ForEach-Object { $problems.Add("运行时会话/凭据目录被纳入范围：$($_.FullName)") }
    }
}

Write-Host "已扫描 $scanned 个文本文件。" -ForegroundColor Cyan
if ($problems.Count -eq 0) {
    Write-Host "没有发现密钥、会话记录或个人路径，可以提交/打包。" -ForegroundColor Green
    exit 0
}

Write-Host "发现 $($problems.Count) 处需要人工确认的内容：" -ForegroundColor Yellow
$problems | Sort-Object -Unique | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
exit 1
