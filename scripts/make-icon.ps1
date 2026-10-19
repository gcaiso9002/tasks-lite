$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# 从脚本自身位置推导仓库根目录。
# 以前这里写的是开发机的绝对路径，结果 Actions 上 build 目录被建到别处、
# assets 目录压根不存在，托盘图标一 Save 就报 GDI+ 错误；
# 而且绝对路径会把开发机用户名泄进公开仓库。
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'build'
$assets = Join-Path $root 'assets'
New-Item -ItemType Directory -Force -Path $out | Out-Null
New-Item -ItemType Directory -Force -Path $assets | Out-Null

function New-TaskIcon([int]$size, [string]$file) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    $bg   = [System.Drawing.Color]::FromArgb(18, 21, 28)
    $blue = [System.Drawing.Color]::FromArgb(79, 140, 255)
    $dim  = [System.Drawing.Color]::FromArgb(45, 95, 180)

    $g.Clear($bg)

    $u = $size / 256.0   # 以 256 为设计基准等比缩放

    # 圆环
    $ringPen = New-Object System.Drawing.Pen $dim, (26 * $u)
    $g.DrawEllipse($ringPen, (30 * $u), (30 * $u), (196 * $u), (196 * $u))

    # 对勾
    $tickPen = New-Object System.Drawing.Pen $blue, (24 * $u)
    $tickPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $tickPen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $tickPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $pts = @(
        (New-Object System.Drawing.PointF (80 * $u),  (129 * $u)),
        (New-Object System.Drawing.PointF (110 * $u), (161 * $u)),
        (New-Object System.Drawing.PointF (178 * $u), (95 * $u))
    )
    $g.DrawLines($tickPen, [System.Drawing.PointF[]]$pts)

    $g.Dispose()
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

foreach ($s in @(16, 24, 32, 48, 64, 128, 256)) {
    New-TaskIcon $s (Join-Path $out "icon-$s.png")
}
Write-Host "PNG 已生成：16/24/32/48/64/128/256"

# --- 托盘图标 -------------------------------------------------------------
# 透明背景 + 纯蓝对勾：Windows 任务栏深浅主题下都看得清，
# 深色圆环在浅色任务栏上会糊成一个方块，所以托盘版去掉。
function New-TrayIcon([int]$size, [string]$file) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)   # 透明底
    $u = $size / 32.0
    $blue = [System.Drawing.Color]::FromArgb(79, 140, 255)
    $pen = New-Object System.Drawing.Pen $blue, (3.6 * $u)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $pts = @(
        (New-Object System.Drawing.PointF (8 * $u),  (16.5 * $u)),
        (New-Object System.Drawing.PointF (13.5 * $u), (22 * $u)),
        (New-Object System.Drawing.PointF (24 * $u), (10 * $u))
    )
    $g.DrawLines($pen, [System.Drawing.PointF[]]$pts)
    $g.Dispose()
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

New-TrayIcon 32 (Join-Path $root 'assets\tray-icon.png')
Write-Host "托盘图标已生成: assets\tray-icon.png"

# 用 Node 把多张 PNG 合成一个多尺寸 ICO
$env:ICO_DIR = $out
node (Join-Path $root 'scripts\make-ico.js')
Write-Host "ICO 完成"
