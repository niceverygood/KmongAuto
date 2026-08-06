# 크몽 세션 keep-alive — Windows 작업 스케줄러 등록 (1시간마다, 주말 포함)
#
# 사용법:
#   powershell -ExecutionPolicy Bypass -File install-keepalive.ps1
#   powershell -ExecutionPolicy Bypass -File install-keepalive.ps1 -Remove
#
# 관리자 권한 불필요 — 현재 사용자로 로그온 중일 때 실행되는 작업으로 등록한다.
# (Playwright 가 사용자 프로필의 브라우저 세션을 열어야 하므로 이 방식이 맞다)

param([switch]$Remove)

$ErrorActionPreference = 'Stop'

$TaskName  = 'KmongSessionKeepAlive'
$Workspace = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
$Runner    = Join-Path $Workspace 'run-keepalive.ps1'

if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "✅ keep-alive 작업 제거 완료 ($TaskName)"
    exit 0
}

if (-not (Test-Path $Runner)) {
    Write-Error "run-keepalive.ps1 을 찾을 수 없습니다: $Runner"
    exit 1
}

New-Item -ItemType Directory -Force -Path (Join-Path $Workspace 'logs') | Out-Null

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Runner`"" `
    -WorkingDirectory $Workspace

# 1시간마다 무기한 반복.
# PowerShell 5.1 은 [TimeSpan]::MaxValue 를 거부하는 경우가 있어 10년(3650일)으로 지정한다.
$trigger = New-ScheduledTaskTrigger `
    -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Hours 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description '크몽 로그인 세션 keep-alive (1시간마다 users/me ping, 만료 시 자동 재로그인)' `
    -Force | Out-Null

Write-Host "✅ 크몽 세션 keep-alive 등록 완료 (1시간마다, 주말 포함)"
Write-Host "   작업 이름: $TaskName"
Write-Host "   로그:      $Workspace\logs\keepalive-$(Get-Date -Format 'yyyyMM').log"
Write-Host ""
Write-Host "즉시 1회 실행:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "상태 확인:      Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo"
Write-Host "창 띄워 테스트: node scripts\kmong-session-keepalive.js --headful"
