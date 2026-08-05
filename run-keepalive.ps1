# 크몽 세션 keep-alive — Windows 작업 스케줄러가 1시간마다 실행하는 래퍼
#
# run-scheduler 와 달리 주말/공휴일에도 실행한다 —
# 세션이 죽는 구간이 바로 그 무접속 구간(금 17:00 → 월 10:30)이기 때문.

$ErrorActionPreference = 'Continue'

$Workspace = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
Set-Location $Workspace

$LogDir = Join-Path $Workspace 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir ("keepalive-{0}.log" -f (Get-Date -Format 'yyyyMM'))

# 작업 스케줄러는 사용자 셸 PATH 를 그대로 물려주지 않는 경우가 있어 node 경로를 직접 해석
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    foreach ($candidate in @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )) {
        if (Test-Path $candidate) { $node = $candidate; break }
    }
}
if (-not $node) {
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] node 를 찾을 수 없음 — keep-alive skip" |
        Out-File -FilePath $LogFile -Append -Encoding utf8
    exit 0
}

& $node (Join-Path $Workspace 'scripts\kmong-session-keepalive.js') @args *>&1 |
    Out-File -FilePath $LogFile -Append -Encoding utf8

# 세션 복구 실패(exit 1)여도 작업 스케줄러에 오류로 남기지 않는다 — 슬랙 알림으로 이미 통지됨
exit 0
