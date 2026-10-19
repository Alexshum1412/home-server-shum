<#
.SYNOPSIS
  Кладёт на рабочий стол ярлык «Семейный сервер» — окно с кнопками «Включить / Выключить / Перезагрузить».
.DESCRIPTION
  Создаёт значок (из картинки приложения) в каталоге данных и ярлык на рабочем столе текущего пользователя.
  Больше ничего в системе не меняется. Убрать ярлык: scripts\server-panel-shortcut.cmd -Off
#>
[CmdletBinding()]
param([switch]$Off)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Add-Type -AssemblyName System.Drawing
$cfg = Get-DashboardConfig
$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop 'Семейный сервер.lnk'

if ($Off) {
  if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link; Write-Host 'Ярлык с рабочего стола убран.' -ForegroundColor Green }
  else { Write-Host 'Ярлыка на рабочем столе не было.' }
  exit 0
}

# An .ico may hold a PNG: 256 x 256 picture drawn from the application's own icon.
$source = Join-Path $cfg.RepoRoot 'web\public\icons\icon-512.png'
$iconFile = Join-Path $cfg.DataDir 'server-panel.ico'
New-Item -ItemType Directory -Force -Path $cfg.DataDir | Out-Null
$original = [Drawing.Image]::FromFile($source)
try {
  $bitmap = New-Object Drawing.Bitmap(256, 256)
  $canvas = [Drawing.Graphics]::FromImage($bitmap)
  $canvas.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $canvas.DrawImage($original, 0, 0, 256, 256)
  $canvas.Dispose()
  $png = New-Object IO.MemoryStream
  $bitmap.Save($png, [Drawing.Imaging.ImageFormat]::Png)
  $bytes = $png.ToArray()
  $bitmap.Dispose()
} finally {
  $original.Dispose()
}
$stream = New-Object IO.MemoryStream
$writer = New-Object IO.BinaryWriter($stream)
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)          # ICONDIR: one image
$writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)   # 256 x 256 (0 = 256), no palette
$writer.Write([uint16]1); $writer.Write([uint16]32)                                    # planes, bits per pixel
$writer.Write([uint32]$bytes.Length); $writer.Write([uint32]22)                         # size, offset
$writer.Write($bytes)
$writer.Flush()
[IO.File]::WriteAllBytes($iconFile, $stream.ToArray())

$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$panel = Join-Path $PSScriptRoot 'server-panel.ps1'
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($link)
$shortcut.TargetPath = $shell
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$panel`""
$shortcut.WorkingDirectory = $cfg.RepoRoot
$shortcut.IconLocation = $iconFile
$shortcut.Description = 'Включить, выключить или перезагрузить семейный сервер'
$shortcut.WindowStyle = 7   # minimised console: only the panel window is seen
$shortcut.Save()
Write-Host "Ярлык создан: $link" -ForegroundColor Green
Write-Host 'Двойной щелчок открывает окно с кнопками «Включить», «Выключить», «Перезагрузить».'
