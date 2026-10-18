<#
.SYNOPSIS
  Показывает, с какими правами работают процессы сервера, и что мешает разделить их по правам. Только чтение.
.DESCRIPTION
  Ничего не меняет: ни UAC, ни права на папки, ни задачи планировщика. Результат помогает выполнить план
  из docs/runbooks/least-privilege.md.
#>
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'common.ps1')

Write-Host ''
Write-Host '== Контроль учётных записей (UAC) =='
$lua = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction SilentlyContinue).EnableLUA
if ($lua -eq 1) { Write-Host '  включён' -ForegroundColor Green } else { Write-Host '  ВЫКЛЮЧЕН: все программы администратора работают с полными правами без запроса.' -ForegroundColor Yellow }

Write-Host ''
Write-Host '== Кто запустил программы сервера =='
$names = 'node.exe', 'jellyfin.exe', 'aria2c.exe', 'llama-server.exe'
$rows = foreach ($name in $names) {
  Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction SilentlyContinue | ForEach-Object {
    $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwner
    $role = if ($_.CommandLine -match 'supervisor') { 'супервизор' } elseif ($_.CommandLine -match 'server.src.index') { 'портал' } elseif ($name -eq 'node.exe') { 'другой node' } else { $name -replace '\.exe$', '' }
    [pscustomobject]@{ Программа = $role; PID = $_.ProcessId; Пользователь = "$($owner.Domain)\$($owner.User)" }
  }
}
if ($rows) { $rows | Format-Table -AutoSize | Out-String | Write-Host } else { Write-Host '  не запущены' }

Write-Host '== Состоят ли они в группе администраторов =='
# By SID (S-1-5-32-544): the group is called «Администраторы» on a Russian Windows.
$admins = @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
$users = @($rows | ForEach-Object { $_.Пользователь } | Sort-Object -Unique)
foreach ($u in $users) {
  $isAdmin = [bool]($admins | Where-Object { $_ -ieq $u })
  Write-Host ("  {0}: {1}" -f $u, $(if ($isAdmin) { 'администратор' } else { 'обычный пользователь' }))
}

Write-Host ''
Write-Host '== Задачи планировщика =='
Get-ScheduledTask -TaskName 'FamilyServer', 'FamilyServerBackup' -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host ("  {0}: пользователь {1}, вход {2}, уровень {3}" -f $_.TaskName, $_.Principal.UserId, $_.Principal.LogonType, $_.Principal.RunLevel)
}

Write-Host ''
Write-Host '== Кто может писать в папки сервера =='
foreach ($dir in 'C:\FamilyServer\data\dashboard', 'C:\FamilyServer\apps', 'C:\FamilyData\Files', 'C:\FamilyData\Photos', 'C:\FamilyData\Media', 'C:\FamilyServer\secrets') {
  if (-not (Test-Path -LiteralPath $dir)) { Write-Host "  $dir : нет папки"; continue }
  $acl = Get-Acl -LiteralPath $dir
  $who = ($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -match 'Write|Modify|FullControl') } | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique) -join ', '
  Write-Host "  $dir"
  Write-Host "      запись: $who"
}

Write-Host ''
Write-Host 'Что делать дальше — docs/runbooks/least-privilege.md. Скрипт ничего не менял.'
