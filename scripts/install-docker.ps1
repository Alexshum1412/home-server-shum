# Docker for the family server (WSL2 + Docker Desktop). Run it ONCE, from PowerShell "as administrator".
# It enables the Windows parts (WSL, virtual machine platform), installs WSL2 and Docker Desktop through winget,
# and asks for a restart. It changes nothing else (no firewall, Defender, UAC or network settings).
$ErrorActionPreference = 'Stop'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrator')
if (-not $admin) { Write-Host 'Запустите PowerShell от имени администратора и повторите.'; exit 1 }

Write-Host '1/3 Включаю компоненты Windows: WSL и платформа виртуальных машин...'
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart | Out-Null
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart | Out-Null

Write-Host '2/3 Устанавливаю WSL2...'
wsl.exe --install --no-distribution
wsl.exe --set-default-version 2

Write-Host '3/3 Устанавливаю Docker Desktop...'
winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements

Write-Host ''
Write-Host 'Готово. ПЕРЕЗАГРУЗИТЕ компьютер, затем один раз запустите Docker Desktop и примите условия.'
Write-Host 'Дальше: docker compose -f deploy\docker\compose.yml --profile archivebox up -d'
