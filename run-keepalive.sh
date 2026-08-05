#!/bin/bash
# launchd가 1시간마다 실행하는 크몽 세션 keep-alive 래퍼
#
# run-scheduler.sh 와 달리 주말/공휴일에도 실행한다 —
# 세션이 죽는 구간이 바로 그 무접속 구간(금 17:00 → 월 10:30)이기 때문.

export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

WORKSPACE="$(cd "$(dirname "$0")" && pwd)"
cd "$WORKSPACE" || exit 1

mkdir -p logs
LOG_FILE="logs/keepalive-$(date +%Y%m).log"

node scripts/kmong-session-keepalive.js >> "$LOG_FILE" 2>&1
exit 0
