<#
.SYNOPSIS
  Шаг 2 переезда: создаёт такой же сервер на другом устройстве с Windows.
.DESCRIPTION
  Запускать на НОВОМ устройстве от имени администратора:
    scripts\move-server-setup.cmd -Package D:\FamilyServer-move-....zip
  Без пакета (чистая установка) создаётся пустой сервер, первого администратора нужно будет добавить вручную.
  Что делает: ставит Node.js и Git (через winget), скачивает код, собирает портал, готовит папки, возвращает данные и
  секреты из пакета, ставит торрент-клиент и языковую модель (с вашим подтверждением), включает автозапуск.
  Что остаётся вручную: Kiwix, SearXNG, Kavita, Jellyfin, Plex, Tailscale (см. docs/FAMILY_USER_GUIDE.md и «Сервер»),
  а также большие папки с фильмами, фото и офлайн-библиотекой.
  -DryRun только показывает, что будет сделано.
#>
[CmdletBinding()]
param(
  [string]$Package = '',
  [string]$Repository = 'https://github.com/Alexshum1412/home-server-shum.git',
  [string]$Folder = '',
  [switch]$Yes,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Join-Path $env:SystemDrive 'FamilyServer'
if ($Folder -eq '') { $Folder = Join-Path $root 'app' }
$steps = New-Object System.Collections.Generic.List[string]

function Step([string]$text, [scriptblock]$action) {
  Write-Host ''
  Write-Host "== $text" -ForegroundColor Cyan
  $steps.Add($text)
  if ($DryRun) { Write-Host '   (пробный запуск: пропущено)'; return }
  & $action
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrator')
if (-not $admin -and -not $DryRun) {
  Write-Host 'Запустите PowerShell от имени администратора и повторите (нужно для автозапуска и установки программ).' -ForegroundColor Yellow
  exit 1
}
if ($Package -ne '' -and -not (Test-Path -LiteralPath $Package)) { Write-Host "Пакет не найден: $Package" -ForegroundColor Yellow; exit 1 }

Step 'Node.js и Git' {
  foreach ($tool in @(@('node', 'OpenJS.NodeJS'), @('git', 'Git.Git'))) {
    if (Get-Command $tool[0] -ErrorAction SilentlyContinue) { Write-Host "   $($tool[0]) уже есть"; continue }
    winget install -e --id $tool[1] --accept-package-agreements --accept-source-agreements
  }
  # Свежеустановленные программы видны только в новом окне: подхватываем путь вручную.
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

Step "Код сервера в $Folder" {
  if (Test-Path -LiteralPath (Join-Path $Folder '.git')) { git -C $Folder pull --ff-only }
  else { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Folder) | Out-Null; git clone $Repository $Folder }
}

Step 'Сборка портала (npm ci, npm run build)' {
  Push-Location $Folder
  try { npm.cmd ci; if ($LASTEXITCODE -ne 0) { throw 'npm ci не удался' }; npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw 'сборка не удалась' } }
  finally { Pop-Location }
}

Step 'Папки данных' {
  foreach ($path in @('data\dashboard', 'secrets', 'apps', 'tools', 'backups')) { New-Item -ItemType Directory -Force -Path (Join-Path $root $path) | Out-Null }
  $drive = if (Test-Path 'D:\') { 'D:' } else { $env:SystemDrive }
  foreach ($name in @('Files', 'Photos', 'Media', 'Chat')) { New-Item -ItemType Directory -Force -Path (Join-Path "$drive\FamilyData" $name) | Out-Null }
  Write-Host "   семейные папки: $drive\FamilyData"
}

if ($Package -ne '') {
  Step "Возврат данных и секретов из пакета $Package" {
    $work = Join-Path ([IO.Path]::GetTempPath()) ('family-restore-' + [Guid]::NewGuid().ToString('N'))
    Expand-Archive -LiteralPath $Package -DestinationPath $work
    try {
      if (Test-Path (Join-Path $work 'data\dashboard')) { robocopy (Join-Path $work 'data\dashboard') (Join-Path $root 'data\dashboard') /E /NFL /NDL /NJH /NJS /NP | Out-Null }
      if (Test-Path (Join-Path $work 'secrets')) { robocopy (Join-Path $work 'secrets') (Join-Path $root 'secrets') /E /NFL /NDL /NJH /NJS /NP | Out-Null }
      if ((Test-Path (Join-Path $work 'env.txt')) -and -not (Test-Path (Join-Path $Folder '.env'))) {
        Copy-Item (Join-Path $work 'env.txt') (Join-Path $Folder '.env')
        Write-Host '   .env перенесён: проверьте в нём диски и адреса (VOLUMES, PUBLIC_URL, LAN_URL) под новое устройство.'
      }
      if (Test-Path (Join-Path $work 'manifest.json')) {
        $manifest = Get-Content (Join-Path $work 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        Write-Host ("   на старом сервере были программы: {0}" -f ($manifest.programs -join ', '))
      }
    } finally { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
  }
} else {
  if (-not (Test-Path (Join-Path $Folder '.env')) -and -not $DryRun) { Copy-Item (Join-Path $Folder '.env.example') (Join-Path $Folder '.env') -ErrorAction SilentlyContinue }
  Write-Host ''
  Write-Host 'Чистая установка: добавьте первого администратора командой' -ForegroundColor Yellow
  Write-Host '  scripts\user.cmd add <логин> --name "Имя" --role admin'
}

Step 'Торрент-клиент и языковая модель (с вашим подтверждением)' {
  $flag = @(); if ($Yes) { $flag = @('-Yes') }
  foreach ($name in 'aria2', 'llama', 'model') {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Folder 'scripts\install-component.ps1') -Name $name @flag
  }
}

Step 'Автозапуск сервера' {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Folder 'scripts\autostart.ps1')
}

Write-Host ''
Write-Host 'Готово. Шаги:' -ForegroundColor Green
$steps | ForEach-Object { Write-Host "  - $_" }
Write-Host ''
Write-Host 'Вручную: Tailscale (вход в ту же сеть), Jellyfin (scripts\jellyfin-setup.cmd), при необходимости Kiwix, SearXNG, Kavita;'
Write-Host 'скопируйте большие папки (фильмы, фото, офлайн-библиотека). Затем: scripts\start.cmd и откройте http://127.0.0.1:8070'
