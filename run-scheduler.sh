#!/bin/bash
# launchd가 실행하는 크몽 스케줄러 래퍼
# - launchd는 사용자 셸 환경을 상속하지 않으므로 PATH 명시
# - 주말/공휴일 skip, 중복 실행 방지 lock, caffeinate로 sleep 방지

export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

WORKSPACE="$(cd "$(dirname "$0")" && pwd)"
cd "$WORKSPACE" || exit 1

mkdir -p logs

TODAY=$(date +%Y-%m-%d)
LOG_FILE="logs/scheduler-$(date +%Y%m%d).log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"; }

# 주말 skip
DOW=$(date +%u)
if [ "$DOW" -ge 6 ]; then
  log "주말 — skip"
  exit 0
fi

# 공휴일 skip (data/korean-holidays-*.json)
YEAR=$(date +%Y)
HOLIDAY_FILE="data/korean-holidays-${YEAR}.json"
if [ -f "$HOLIDAY_FILE" ] && grep -q "\"$TODAY\"" "$HOLIDAY_FILE"; then
  log "공휴일($TODAY) — skip"
  exit 0
fi

# 중복 실행 방지
LOCK_FILE="/tmp/kmong-scheduler.lock"
if [ -f "$LOCK_FILE" ]; then
  OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    log "이전 회차 실행 중 (pid $OLD_PID) — skip"
    exit 0
  fi
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

log "크몽 스케줄러 시작"
caffeinate -i node scripts/kmong-scheduler.js >> "$LOG_FILE" 2>&1
RC=$?
log "크몽 스케줄러 종료 (exit $RC)"
exit $RC
