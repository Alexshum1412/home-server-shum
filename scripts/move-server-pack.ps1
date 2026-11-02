<#
.SYNOPSIS
  Шаг 1 переезда на другое устройство: собирает пакет с настройками, учётными записями и секретами этого сервера.
.DESCRIPTION
  Запускать на СТАРОМ сервере:  scripts\move-server-pack.cmd [-To D:\Переезд]
  В пакет попадает: данные портала (учётные записи, чаты, настройки, заметки, архив), секреты (токен бота, ключ
  бесплатных моделей), файл .env и список установленных программ. Фильмы, фото, файлы и офлайн-библиотека в пакет
  НЕ входят (они большие): скрипт покажет их папки и размер, их копируют на новое устройство отдельно (диск, флешка).
  ВАЖНО: пакет содержит секреты. Храните его как пароль, никуда не выкладывайте и не отправляйте.
#>
[CmdletBinding()]
param([string]$To = '')

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$repo = Split-Path -Parent $PSScriptRoot
$root = Join-Path $env:SystemDrive 'FamilyServer'
if ($To -eq '') { $To = [Environment]::GetFolderPath('Desktop') }
New-Item -ItemType Directory -Force -Path $To | Out-Null

$stamp = Get-Date -Format 'yyyy-MM-dd-HHmm'
$stage = Join-Path ([IO.Path]::GetTempPath()) ("family-move-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  Write-Host 'Собираю пакет переезда…'
  # 1. Данные портала (без журналов: они велики и не нужны).
  $data = Join-Path $root 'data\dashboard'
  if (Test-Path -LiteralPath $data) {
    $target = Join-Path $stage 'data\dashboard'
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    robocopy $data $target /E /XD logs print-spool /XF *.tmp /NFL /NDL /NJH /NJS /NP | Out-Null
    Write-Host "  данные портала: $data"
  } else { Write-Host "  данных портала не найдено ($data)" -ForegroundColor Yellow }

  # 2. Секреты (токен бота, ключ бесплатных моделей, ключи копий).
  $secrets = Join-Path $root 'secrets'
  if (Test-Path -LiteralPath $secrets) {
    Copy-Item -LiteralPath $secrets -Destination (Join-Path $stage 'secrets') -Recurse
    Write-Host "  секреты: $secrets"
  }

  # 3. Настройки .env.
  $envFile = Join-Path $repo '.env'
  if (Test-Path -LiteralPath $envFile) { Copy-Item -LiteralPath $envFile -Destination (Join-Path $stage 'env.txt'); Write-Host '  файл .env' }

  # 4. Список установленных программ и больших папок (чтобы ничего не забыть).
  $apps = @()
  $appsDir = Join-Path $root 'apps'
  if (Test-Path -LiteralPath $appsDir) { $apps = @(Get-ChildItem -LiteralPath $appsDir -Directory | ForEach-Object { $_.Name }) }
  $big = @()
  foreach ($letter in 'C', 'D', 'E') {
    $folder = "${letter}:\FamilyData"
    if (Test-Path -LiteralPath $folder) {
      foreach ($child in Get-ChildItem -LiteralPath $folder -Directory) {
        $sum = (Get-ChildItem -LiteralPath $child.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
        $big += [pscustomobject]@{ path = $child.FullName; gigabytes = [math]::Round(([double]$sum) / 1GB, 2) }
      }
    }
  }
  $remote = ''
  try { $remote = (& git -C $repo remote get-url origin 2>$null) } catch { $remote = '' }
  $manifest = [pscustomobject]@{
    made = (Get-Date).ToString('s')
    computer = $env:COMPUTERNAME
    repository = $remote
    programs = $apps
    bigFolders = $big
  }
  $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $stage 'manifest.json') -Encoding UTF8

  $zip = Join-Path $To "FamilyServer-move-$stamp.zip"
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
  $size = (Get-Item -LiteralPath $zip).Length / 1MB
  Write-Host ''
  Write-Host ("Готово: {0} ({1:N1} МБ)" -f $zip, $size) -ForegroundColor Green
  Write-Host 'ВНИМАНИЕ: в пакете секреты. Перенесите его на новое устройство флешкой и после переезда удалите.' -ForegroundColor Yellow
  if ($big.Count -gt 0) {
    Write-Host ''
    Write-Host 'Большие папки, которые в пакет не входят (скопируйте их на новое устройство сами):'
    $big | ForEach-Object { Write-Host ("  {0}  {1} ГБ" -f $_.path, $_.gigabytes) }
  }
  Write-Host ''
  Write-Host 'Дальше на новом устройстве: scripts\move-server-setup.cmd -Package <путь к этому zip>'
} finally {
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
