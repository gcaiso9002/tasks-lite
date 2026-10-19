$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = 'C:\Users\gcais\.minimax\sessions\mvs_e438193d1a894ff2bb5283df48485a30\workspace\tasks-lite'
$out = Join-Path $root 'build'
New-Item -ItemType Directory -Force -Path $out | Out-Null

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

# 用 Node 把多张 PNG 合成一个多尺寸 ICO
$env:ICO_DIR = $out
node (Join-Path $root 'scripts\make-ico.js')
Write-Host "ICO 完成"
