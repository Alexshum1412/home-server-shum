# Installs one pinned third-party component into C:\FamilyServer (aria2 / llama / model).
# The owner runs this by hand: it downloads a file from the internet, so it shows the file name,
# the source and the size first and asks. Nothing is installed when the size or SHA-256 differs
# from scripts\components.json. An existing folder is renamed, never deleted.
param(
  [Parameter(Mandatory = $true)][ValidateSet('aria2', 'llama', 'model')][string]$Name,
  [switch]$Yes,
  [switch]$Reinstall
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
. (Join-Path $PSScriptRoot 'common.ps1')

$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'components.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$item = $manifest.$Name
$root = Join-Path $env:SystemDrive 'FamilyServer'
$destination = Join-Path $root $item.destination
$mainFile = Join-Path $destination $item.mainFile
$fileName = [IO.Path]::GetFileName(([Uri]$item.url).AbsolutePath)

Write-Host ''
Write-Host "Компонент: $($item.title)"
Write-Host "Файл:      $fileName"
Write-Host "Откуда:    $($item.url)"
Write-Host ("Размер:    {0:N1} МБ" -f ($item.sizeBytes / 1MB))
Write-Host "Лицензия:  $($item.licence)"
Write-Host "Куда:      $destination"

if (-not $item.sha256) {
  Write-Host ''
  Write-Host 'Контрольная сумма (SHA-256) для этого файла ещё не зафиксирована в scripts\components.json.' -ForegroundColor Yellow
  Write-Host 'Установка остановлена: файл без проверки не ставим. Закрепите сумму и запустите снова.'
  exit 2
}
if ((Test-Path -LiteralPath $mainFile) -and -not $Reinstall) {
  Write-Host ''
  Write-Host "Уже установлено: $mainFile. Ничего не делаю (для обновления добавьте -Reinstall)." -ForegroundColor Green
  exit 0
}
if (-not $Yes) {
  Write-Host ''
  $answer = Read-Host 'Скачать и установить? Введите «да»'
  if ($answer.Trim().ToLowerInvariant() -ne 'да') { Write-Host 'Отменено, ничего не скачано.'; exit 1 }
}

$work = Join-Path ([IO.Path]::GetTempPath()) ('family-download-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$file = Join-Path $work $fileName
try {
  Write-Host ''
  Write-Host 'Скачиваю…'
  & curl.exe --location --fail --silent --show-error --retry 3 --output $file $item.url
  if ($LASTEXITCODE -ne 0) { throw "Загрузка не удалась (curl, код $LASTEXITCODE)." }
  $size = (Get-Item -LiteralPath $file).Length
  if ($size -ne [int64]$item.sizeBytes) { throw "Размер файла $size байт, ожидалось $($item.sizeBytes). Установка отменена." }
  $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $item.sha256.ToLowerInvariant()) { throw "SHA-256 не совпадает: $hash. Установка отменена, файл не использован." }
  Write-Host 'Размер и SHA-256 совпали с закреплёнными.' -ForegroundColor Green

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  if ($item.kind -eq 'zip') {
    $unpacked = Join-Path $work 'unpacked'
    Expand-Archive -LiteralPath $file -DestinationPath $unpacked
    # aria2 puts everything into one nested folder; llama.cpp ships files at the top level.
    $top = @(Get-ChildItem -LiteralPath $unpacked)
    $source = if ($top.Count -eq 1 -and $top[0].PSIsContainer) { $top[0].FullName } else { $unpacked }
    if (-not (Test-Path -LiteralPath (Join-Path $source $item.mainFile))) { throw "В архиве нет $($item.mainFile). Установка отменена." }
    if (Test-Path -LiteralPath $destination) {
      $old = $destination + '.old-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
      Move-Item -LiteralPath $destination -Destination $old
      Write-Host "Прежняя папка сохранена как $old"
    }
    New-Item -ItemType Directory -Path $destination | Out-Null
    Copy-Item -Path (Join-Path $source '*') -Destination $destination -Recurse
  } else {
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    if (Test-Path -LiteralPath $mainFile) {
      $old = $mainFile + '.old-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
      Move-Item -LiteralPath $mainFile -Destination $old
      Write-Host "Прежний файл сохранён как $old"
    }
    Copy-Item -LiteralPath $file -Destination $mainFile
  }
  $record = [ordered]@{ name = $Name; title = $item.title; url = $item.url; sha256 = $hash; installedAt = (Get-Date).ToString('o') }
  $record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination ($Name + '.installed.json')) -Encoding UTF8
  Write-Host ''
  Write-Host "Готово: $mainFile" -ForegroundColor Green
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
