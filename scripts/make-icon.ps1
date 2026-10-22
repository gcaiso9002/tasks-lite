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

# ---------------------------------------------------------------------------
# 设计：圆角方块 + 蓝紫渐变 + 白色对勾，四角透明。
#
# 换掉旧设计的理由：旧版是「不透明近黑方块 + 暗蓝圆环 + 蓝对勾」，
# 在 Windows 深色任务栏/开始菜单里整块糊成一个黑方块，圆环几乎看不见，
# 而且方形底在圆角图标居多的任务栏里显得很生硬。现在：
#   - 四角透明 + 圆角，跟系统里其它应用图标同一套视觉语言；
#   - 内部渐变（浅蓝 → 深蓝），小尺寸下也能看出体积感；
#   - 纯白对勾，对比度最高，16px 仍然认得出是「勾」。
# ---------------------------------------------------------------------------

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
    $p = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $d = [single]($r * 2)
    $p.AddArc($x, $y, $d, $d, [single]180, [single]90)
    $p.AddArc([single]($x + $w - $d), $y, $d, $d, [single]270, [single]90)
    $p.AddArc([single]($x + $w - $d), [single]($y + $h - $d), $d, $d, [single]0, [single]90)
    $p.AddArc($x, [single]($y + $h - $d), $d, $d, [single]90, [single]90)
    $p.CloseFigure()
    return $p
}

function New-AppIcon([int]$size, [string]$file) {
    $bmp = [System.Drawing.Bitmap]::new($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)

    $u = $size / 256.0                       # 以 256 为设计基准等比缩放
    $pad = [single]([Math]::Max(0.0, 8 * $u))   # 四周留一点透明边，任务栏里不贴边显胖
    $side = [single]($size - 2 * $pad)
    $r = [single]([Math]::Max(1.5, 54 * $u))

    # 底色：圆角方块 + 对角渐变
    $path = New-RoundedPath $pad $pad $side $side $r
    $rect = [System.Drawing.RectangleF]::new($pad, $pad, $side, $side)
    $c1 = [System.Drawing.Color]::FromArgb(255, 98, 152, 255)
    $c2 = [System.Drawing.Color]::FromArgb(255, 34, 70, 196)
    $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new($rect, $c1, $c2, [single]60)
    $g.FillPath($brush, $path)

    # 上半部一层很淡的高光：让方块有玻璃质感。16px 不画，否则糊成一片。
    if ($size -ge 32) {
        $glossH = [single]($side * 0.48)
        $gloss = New-RoundedPath $pad $pad $side $glossH ([single]($r * 0.8))
        $glossRect = [System.Drawing.RectangleF]::new($pad, $pad, $side, $glossH)
        $glossBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
            $glossRect,
            [System.Drawing.Color]::FromArgb(44, 255, 255, 255),
            [System.Drawing.Color]::FromArgb(0, 255, 255, 255),
            [single]90)
        $g.FillPath($glossBrush, $gloss)
        $glossBrush.Dispose()
        $gloss.Dispose()
    }

    # 白色对勾：起笔短、收笔长，重心略偏右上，视觉最稳
    $penW = [single]([Math]::Max(1.5, 29 * $u))
    $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, $penW)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $pts = @(
        [System.Drawing.PointF]::new([single]($pad + $side * 0.265), [single]($pad + $side * 0.520)),
        [System.Drawing.PointF]::new([single]($pad + $side * 0.435), [single]($pad + $side * 0.680)),
        [System.Drawing.PointF]::new([single]($pad + $side * 0.760), [single]($pad + $side * 0.330))
    )
    $g.DrawLines($pen, [System.Drawing.PointF[]]$pts)

    $pen.Dispose()
    $brush.Dispose()
    $path.Dispose()
    $g.Dispose()
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

foreach ($s in @(16, 24, 32, 48, 64, 128, 256)) {
    New-AppIcon $s (Join-Path $out "icon-$s.png")
}
Write-Host "PNG 已生成：16/24/32/48/64/128/256"

# --- 托盘图标 -------------------------------------------------------------
# 用同一套圆角渐变方块：它自带底色，深色任务栏和浅色任务栏上都立得住。
# （旧版是透明底 + 纯蓝细对勾，浅色任务栏上几乎看不见。）
New-AppIcon 32 (Join-Path $assets 'tray-icon.png')
Write-Host "托盘图标已生成: assets\tray-icon.png"

# --- 通知图标 -------------------------------------------------------------
# src/main/index.js 的 Windows 通知要读 assets\icon-256.png。
# 这个文件以前**从来没被生成过**，于是 Toast 只能退回 Electron 默认图标
# —— 这就是通知里看到的那个丑图标。这里补上，以后不会再缺。
Copy-Item (Join-Path $out 'icon-256.png') (Join-Path $assets 'icon-256.png') -Force
Write-Host "通知图标已生成: assets\icon-256.png"

# 用 Node 把多张 PNG 合成一个多尺寸 ICO
$env:ICO_DIR = $out
node (Join-Path $root 'scripts\make-ico.js')

# --- 窗口图标 -------------------------------------------------------------
# BrowserWindow 的 icon 要读 assets\icon.ico（build/ 不进安装包，assets/ 才进）。
# 不给窗口设图标时它的图标句柄是 0，任务栏会退回按 exe 路径查系统图标缓存，
# 于是旧图标可能一直挂着 —— 这条路径必须显式给死。
Copy-Item (Join-Path $out 'icon.ico') (Join-Path $assets 'icon.ico') -Force
Write-Host "窗口图标已生成: assets\icon.ico"

Write-Host "ICO 完成"