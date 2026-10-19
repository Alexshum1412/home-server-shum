<#
.SYNOPSIS
  Окно «Семейный сервер» для рабочего стола: состояние и три кнопки — «Включить», «Выключить», «Перезагрузить».
.DESCRIPTION
  Запускается ярлыком с рабочего стола (scripts\server-panel-shortcut.cmd создаёт его). Кнопки вызывают те же
  скрипты, что и командная строка: start.ps1, stop.ps1, restart.ps1. «Выключить» и «Перезагрузить» просят
  подтверждение: пока сервер выключен, семья не может открыть портал, смотреть кино и звонить.
  Компьютер Windows эта панель не выключает и не перезагружает — только сервер (портал, Jellyfin, торрент-клиент, модель).
  Параметры -Screenshot <файл.png> и -Check нужны для проверки окна без участия человека.
#>
[CmdletBinding()]
param([string]$Screenshot, [switch]$Check)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$cfg = Get-DashboardConfig
$publicUrl = Get-Setting 'PUBLIC_URL' ''
$iconFile = Join-Path $cfg.DataDir 'server-panel.ico'
$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$green = [Drawing.Color]::FromArgb(22, 119, 74)
$amber = [Drawing.Color]::FromArgb(168, 75, 0)
$red = [Drawing.Color]::FromArgb(180, 40, 40)
$ink = [Drawing.Color]::FromArgb(20, 32, 51)
$muted = [Drawing.Color]::FromArgb(67, 82, 104)

$form = New-Object Windows.Forms.Form
$form.Text = 'Семейный сервер'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object Drawing.Size(460, 392)
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.BackColor = [Drawing.Color]::FromArgb(247, 249, 252)
$form.Font = New-Object Drawing.Font('Segoe UI', 11)
if (Test-Path -LiteralPath $iconFile) { try { $form.Icon = New-Object Drawing.Icon($iconFile) } catch { } }

$state = New-Object Windows.Forms.Label
$state.Location = New-Object Drawing.Point(24, 20)
$state.Size = New-Object Drawing.Size(412, 44)
$state.Font = New-Object Drawing.Font('Segoe UI Semibold', 20)
$state.Text = 'Проверяю…'
$state.ForeColor = $muted
$form.Controls.Add($state)

$detail = New-Object Windows.Forms.Label
$detail.Location = New-Object Drawing.Point(26, 68)
$detail.Size = New-Object Drawing.Size(410, 64)
$detail.ForeColor = $muted
$detail.Text = ''
$form.Controls.Add($detail)

function New-PanelButton([string]$Text, [int]$Top, [bool]$Primary) {
  $b = New-Object Windows.Forms.Button
  $b.Text = $Text
  $b.Location = New-Object Drawing.Point(26, $Top)
  $b.Size = New-Object Drawing.Size(408, 52)
  $b.FlatStyle = 'Flat'
  $b.Font = New-Object Drawing.Font('Segoe UI Semibold', 13)
  $b.FlatAppearance.BorderSize = 1
  $b.Tag = if ($Primary) { 'primary' } else { 'plain' }
  if ($Primary) {
    $b.BackColor = [Drawing.Color]::FromArgb(33, 106, 202)
    $b.ForeColor = [Drawing.Color]::White
    $b.FlatAppearance.BorderColor = [Drawing.Color]::FromArgb(33, 106, 202)
  } else {
    $b.BackColor = [Drawing.Color]::White
    $b.ForeColor = $ink
    $b.FlatAppearance.BorderColor = [Drawing.Color]::FromArgb(116, 131, 154)
  }
  $form.Controls.Add($b)
  return $b
}

$buttonOn = New-PanelButton 'Включить сервер' 140 $true
$buttonOff = New-PanelButton 'Выключить сервер' 202 $false
$buttonRestart = New-PanelButton 'Перезагрузить сервер' 264 $false

$open = New-Object Windows.Forms.LinkLabel
$open.Location = New-Object Drawing.Point(26, 336)
$open.Size = New-Object Drawing.Size(408, 24)
$open.Text = 'Открыть портал в браузере'
$open.LinkColor = [Drawing.Color]::FromArgb(33, 106, 202)
$form.Controls.Add($open)

$note = New-Object Windows.Forms.Label
$note.Location = New-Object Drawing.Point(26, 362)
$note.Size = New-Object Drawing.Size(408, 22)
$note.Font = New-Object Drawing.Font('Segoe UI', 9)
$note.ForeColor = $muted
$note.Text = 'Управляет сервером, а не самим компьютером.'
$form.Controls.Add($note)

# --- state -----------------------------------------------------------------------------------------
$script:job = $null          # the running child process of an action
$script:jobName = ''
$script:jobLog = ''
$script:message = ''         # result of the last action, shown under the state

function Get-ServerState {
  if (Test-DashboardHealth $cfg.Port 1) { return 'running' }
  if (@(Get-SupervisorProcess).Count -gt 0) { return 'starting' }
  return 'stopped'
}

# An unavailable button looks unavailable (grey), whatever its normal colour is.
function Set-ButtonLook($Button) {
  if ($Button.Enabled) {
    $primary = ($Button.Tag -eq 'primary')
    $Button.BackColor = if ($primary) { [Drawing.Color]::FromArgb(33, 106, 202) } else { [Drawing.Color]::White }
    $Button.ForeColor = if ($primary) { [Drawing.Color]::White } else { $ink }
    $Button.FlatAppearance.BorderColor = if ($primary) { [Drawing.Color]::FromArgb(33, 106, 202) } else { [Drawing.Color]::FromArgb(116, 131, 154) }
  } else {
    $Button.BackColor = [Drawing.Color]::FromArgb(232, 237, 243)
    $Button.ForeColor = [Drawing.Color]::FromArgb(110, 122, 140)
    $Button.FlatAppearance.BorderColor = [Drawing.Color]::FromArgb(205, 214, 225)
  }
}

function Update-Panel {
  Update-PanelText
  foreach ($b in $buttonOn, $buttonOff, $buttonRestart) { Set-ButtonLook $b }
}

function Update-PanelText {
  if ($script:job) {
    foreach ($b in $buttonOn, $buttonOff, $buttonRestart) { $b.Enabled = $false }
    $state.ForeColor = $amber
    $state.Text = $script:jobName
    $detail.Text = 'Это займёт до минуты. Окно можно не закрывать.'
    return
  }
  $now = Get-ServerState
  $buttonOn.Enabled = ($now -ne 'running')
  $buttonOff.Enabled = ($now -ne 'stopped')
  $buttonRestart.Enabled = ($now -eq 'running')
  switch ($now) {
    'running' {
      $state.ForeColor = $green; $state.Text = 'Сервер работает'
      $where = if ($publicUrl) { "Для семьи: $publicUrl" } else { "На этом компьютере: http://127.0.0.1:$($cfg.Port)" }
      $detail.Text = $where
    }
    'starting' {
      $state.ForeColor = $amber; $state.Text = 'Сервер запускается…'
      $detail.Text = 'Если так долго, нажмите «Перезагрузить сервер».'
    }
    default {
      $state.ForeColor = $red; $state.Text = 'Сервер выключен'
      $detail.Text = 'Портал, кино, чат и звонки сейчас не работают.'
    }
  }
  if ($script:message) { $detail.Text = $script:message + "`n" + $detail.Text }
}

function Start-Action([string]$Name, [string]$Script) {
  $script:jobLog = Join-Path ([IO.Path]::GetTempPath()) ('server-panel-' + [Guid]::NewGuid().ToString('N') + '.log')
  $script:jobName = $Name
  $script:message = ''
  $file = Join-Path $PSScriptRoot $Script
  # Output goes to a file: the window is hidden, and the last lines are shown if something fails.
  $arguments = "-NoProfile -ExecutionPolicy Bypass -Command `"& '$file' *>&1 | Out-File -LiteralPath '$($script:jobLog)' -Encoding utf8; exit `$LASTEXITCODE`""
  $script:job = Start-Process -FilePath $shell -ArgumentList $arguments -WindowStyle Hidden -PassThru
  Update-Panel
}

function Confirm-Action([string]$Question) {
  $answer = [Windows.Forms.MessageBox]::Show($Question, 'Семейный сервер', 'YesNo', 'Question', 'Button2')
  return ($answer -eq 'Yes')
}

$buttonOn.Add_Click({ Start-Action 'Включаю сервер…' 'start.ps1' })
$buttonOff.Add_Click({
  if (Confirm-Action "Выключить сервер?`n`nПока он выключен, семья не сможет открыть портал, смотреть кино, писать в чат и звонить. Включить снова можно этой же кнопкой.") {
    Start-Action 'Выключаю сервер…' 'stop.ps1'
  }
})
$buttonRestart.Add_Click({
  if (Confirm-Action "Перезагрузить сервер?`n`nОн будет недоступен примерно полминуты, идущие звонки оборвутся.") {
    Start-Action 'Перезагружаю сервер…' 'restart.ps1'
  }
})
$open.Add_LinkClicked({
  $address = if ($publicUrl) { $publicUrl } else { "http://127.0.0.1:$($cfg.Port)" }
  Start-Process $address
})

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({
  if ($script:job -and $script:job.HasExited) {
    $code = $script:job.ExitCode
    $script:job = $null
    $tail = ''
    if (Test-Path -LiteralPath $script:jobLog) {
      $tail = (Get-Content -LiteralPath $script:jobLog -Tail 8 -Encoding UTF8 -ErrorAction SilentlyContinue) -join "`n"
      Remove-Item -LiteralPath $script:jobLog -ErrorAction SilentlyContinue
    }
    if ($code -eq 0) {
      $script:message = ''
    } else {
      $script:message = 'Не получилось. Подробности — в журнале.'
      [Windows.Forms.MessageBox]::Show("Действие не выполнено (код $code).`n`n$tail`n`nЖурналы: $($cfg.LogDir)", 'Семейный сервер', 'OK', 'Warning') | Out-Null
    }
  }
  Update-Panel
})

if ($Check) {
  # Used by the checks: builds everything above and reports what the window would show.
  Update-Panel
  [pscustomobject]@{ state = $state.Text; detail = $detail.Text; on = $buttonOn.Enabled; off = $buttonOff.Enabled; restart = $buttonRestart.Enabled } | ConvertTo-Json
  exit 0
}

Update-Panel
if ($Screenshot) {
  $form.Show()
  [Windows.Forms.Application]::DoEvents()
  $bitmap = New-Object Drawing.Bitmap($form.Width, $form.Height)
  $form.DrawToBitmap($bitmap, (New-Object Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
  $bitmap.Save($Screenshot, [Drawing.Imaging.ImageFormat]::Png)
  $form.Close()
  exit 0
}

$timer.Start()
[void]$form.ShowDialog()
$timer.Stop()
