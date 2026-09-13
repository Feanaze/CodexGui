# Builds CodexGui\Assets\app.ico: a multi-size icon matching the spark brand
# mark used in wwwroot (index.html, symbol #i-spark).
# Usage: powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1
# Keep this file ASCII-only: Windows PowerShell 5.1 decodes BOM-less files as
# ANSI, which corrupts non-ASCII content.
param(
    [string]$OutFile = (Join-Path $PSScriptRoot '..\Assets\app.ico'),
    [string]$PreviewFile = ''
)

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

function New-RoundedPath([System.Drawing.RectangleF]$rect, [float]$radius) {
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $d = $radius * 2
    $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
    $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

# Four point spark: tips on the axes, pinched inward between them.
function New-SparkPath([float]$cx, [float]$cy, [float]$r, [float]$k) {
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $path.StartFigure()
    $path.AddLine($cx, $cy - $r, $cx + $k, $cy - $k)
    $path.AddLine($cx + $k, $cy - $k, $cx + $r, $cy)
    $path.AddLine($cx + $r, $cy, $cx + $k, $cy + $k)
    $path.AddLine($cx + $k, $cy + $k, $cx, $cy + $r)
    $path.AddLine($cx, $cy + $r, $cx - $k, $cy + $k)
    $path.AddLine($cx - $k, $cy + $k, $cx - $r, $cy)
    $path.AddLine($cx - $r, $cy, $cx - $k, $cy - $k)
    $path.AddLine($cx - $k, $cy - $k, $cx, $cy - $r)
    $path.CloseFigure()
    return $path
}

function New-IconBitmap([int]$size) {
    $bmp = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $s = [float]$size
    $pad = [float]($s * 0.055)
    $side = [float]($s - 2 * $pad)
    $rect = [System.Drawing.RectangleF]::new($pad, $pad, $side, $side)
    $radius = [float]($s * 0.215)

    $plate = New-RoundedPath $rect $radius
    try {
        $top = [System.Drawing.Color]::FromArgb(255, 58, 61, 66)
        $bottom = [System.Drawing.Color]::FromArgb(255, 24, 25, 28)
        $grad = [System.Drawing.Drawing2D.LinearGradientBrush]::new($rect, $top, $bottom, [single]90)
        $g.FillPath($grad, $plate)
        $grad.Dispose()

        $strokeColor = [System.Drawing.Color]::FromArgb(38, 255, 255, 255)
        $strokeWidth = [single]([Math]::Max(1.0, $s / 128.0))
        $pen = [System.Drawing.Pen]::new($strokeColor, $strokeWidth)
        $g.DrawPath($pen, $plate)
        $pen.Dispose()
    }
    finally { $plate.Dispose() }

    $cx = $s / 2.0
    $cy = $s / 2.0
    # Proportions taken from the #i-spark path in wwwroot/index.html
    # (tips ~7.3/24 of the box, waist ~1.9/24). Tiny sizes get a shorter,
    # fatter waist so the mark still reads as a star after rasterizing.
    if ($size -le 32) {
        $r = [float]($s * 0.315)
        $k = [float]($s * 0.112)
    }
    else {
        $r = [float]($s * 0.300)
        $k = [float]($s * 0.078)
    }
    $spark = New-SparkPath $cx $cy $r $k
    try {
        $brushRect = [System.Drawing.RectangleF]::new(($cx - $r), ($cy - $r), (2 * $r), (2 * $r))
        $near = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
        $far = [System.Drawing.Color]::FromArgb(255, 186, 202, 255)
        $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new($brushRect, $near, $far, [single]60)
        $g.FillPath($brush, $spark)
        $brush.Dispose()
    }
    finally { $spark.Dispose() }

    $g.Dispose()
    return $bmp
}

# 32bpp bitmap -> DIB (BITMAPINFOHEADER + bottom-up pixels + AND mask).
# Small sizes use this, which is what Explorer and the taskbar read.
function ConvertTo-Dib([System.Drawing.Bitmap]$bmp) {
    $w = $bmp.Width
    $h = $bmp.Height
    $rect = [System.Drawing.Rectangle]::new(0, 0, $w, $h)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $stride = [Math]::Abs($data.Stride)
        $buf = [byte[]]::new($stride * $h)
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buf, 0, $buf.Length)

        $ms = [System.IO.MemoryStream]::new()
        $bw = [System.IO.BinaryWriter]::new($ms)
        $bw.Write([int]40); $bw.Write([int]$w); $bw.Write([int]($h * 2))
        $bw.Write([int16]1); $bw.Write([int16]32); $bw.Write([int]0)
        $bw.Write([int]($w * $h * 4)); $bw.Write([int]0); $bw.Write([int]0); $bw.Write([int]0); $bw.Write([int]0)
        for ($y = $h - 1; $y -ge 0; $y--) {
            $bw.Write($buf, $y * $stride, $w * 4)
        }
        $maskStride = [int]([Math]::Ceiling($w / 32.0) * 4)
        $bw.Write(([byte[]]::new($maskStride * $h)), 0, $maskStride * $h)
        $bw.Flush()
        return $ms.ToArray()
    }
    finally {
        $bmp.UnlockBits($data)
    }
}

function ConvertTo-PngBytes([System.Drawing.Bitmap]$bmp) {
    $ms = [System.IO.MemoryStream]::new()
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    return $ms.ToArray()
}

$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
$images = @()
$rendered = @()
foreach ($size in $sizes) {
    $bmp = New-IconBitmap $size
    $rendered += , @{ Size = $size; Bmp = $bmp }
    if ($size -le 48) {
        $images += , @{ Size = $size; Bytes = (ConvertTo-Dib $bmp); Png = $false }
    }
    else {
        $images += , @{ Size = $size; Bytes = (ConvertTo-PngBytes $bmp); Png = $true }
    }
}

# Optional verification strip: every size drawn 4x on a mid gray background.
if ($PreviewFile) {
    $zoom = 4
    $gap = 8 * $zoom
    $w = $gap
    $hMax = 0
    foreach ($item in $rendered) {
        $w += $item.Size * $zoom + $gap
        $hMax = [Math]::Max($hMax, $item.Size)
    }
    $strip = [System.Drawing.Bitmap]::new($w, ($hMax * $zoom + 2 * $gap), [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stripG = [System.Drawing.Graphics]::FromImage($strip)
    try {
        $stripG.Clear([System.Drawing.Color]::FromArgb(255, 130, 130, 138))
        $stripG.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $stripG.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
        $x = $gap
        foreach ($item in $rendered) {
            $stripG.DrawImage($item.Bmp, $x, $gap, $item.Size * $zoom, $item.Size * $zoom)
            $x += $item.Size * $zoom + $gap
        }
    }
    finally { $stripG.Dispose() }
    $strip.Save($PreviewFile, [System.Drawing.Imaging.ImageFormat]::Png)
    $strip.Dispose()
}

foreach ($item in $rendered) { $item.Bmp.Dispose() }

if (-not (Test-Path (Split-Path -Parent $OutFile))) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $OutFile) -Force | Out-Null
}
$target = Join-Path (Resolve-Path -LiteralPath (Split-Path -Parent $OutFile)).Path (Split-Path -Leaf $OutFile)

$ms = [System.IO.MemoryStream]::new()
$bw = [System.IO.BinaryWriter]::new($ms)
$bw.Write([int16]0); $bw.Write([int16]1); $bw.Write([int16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($img in $images) {
    $dim = if ($img.Size -ge 256) { 0 } else { $img.Size }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([int16]1); $bw.Write([int16]32)
    $bw.Write([int]$img.Bytes.Length); $bw.Write([int]$offset)
    $offset += $img.Bytes.Length
}
foreach ($img in $images) { $bw.Write([byte[]]$img.Bytes, 0, $img.Bytes.Length) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($target, $ms.ToArray())
$bw.Dispose()

Write-Host ("wrote {0} ({1} bytes, {2} sizes)" -f $target, (Get-Item $target).Length, $images.Count)
