#!/bin/bash
# 크몽 봇 원격 실행 진입점 (정기 Routine이 이 스크립트를 호출)
#
#   bash run-scheduler.sh            # preflight 후 스케줄러 실행
#   bash run-scheduler.sh --check    # preflight만
#
# exit 0: 정상 / 2: preflight 실패(설정 미완) / 그 외: 스케줄러 오류
#
# SKIP_SUBMIT (기본 true): true면 Phase 3에서 폼 입력까지만 하고 실제 제출 버튼은 누르지 않는다 (dry-run).
#   셀렉터 검증 후 SKIP_SUBMIT=false 로 전환할 것.

set -uo pipefail
cd "$(dirname "$0")"

export NODE_USE_ENV_PROXY=1
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
export HEADLESS="${HEADLESS:-1}"
export SKIP_SUBMIT="${SKIP_SUBMIT:-true}"

mkdir -p logs
TS=$(date +%Y%m%d-%H%M%S)
LOG="logs/run-${TS}.log"

echo "=== 크몽 봇 실행: $(date '+%F %T') (SKIP_SUBMIT=${SKIP_SUBMIT}) ===" | tee -a "$LOG"

# 0. 로그인 쿠키 복원 (새 컨테이너 대비)
#    쿠키 파일은 gitignore 대상이라 새 컨테이너엔 없음.
#    환경변수 KMONG_SESSIONID 가 있으면 그 값으로 로그인 쿠키를 재구성한다.
#    (쿠키 이름 kmong_session 확인됨 — 실제 재구성 성공 여부는 check-setup.js로 검증할 것)
COOKIE_FILE="data/kmong-cookies.local.json"
if [ ! -f "$COOKIE_FILE" ] && [ -n "${KMONG_SESSIONID:-}" ]; then
  mkdir -p data
  EXP=$(( $(date +%s) + 1209600 ))   # 2주 뒤 만료
  cat > "$COOKIE_FILE" <<EOF
[
  {
    "name": "kmong_session",
    "value": "${KMONG_SESSIONID}",
    "domain": ".kmong.com",
    "path": "/",
    "secure": true,
    "httpOnly": true,
    "sameSite": "Lax",
    "expires": ${EXP}
  }
]
EOF
  echo "[setup] KMONG_SESSIONID 로 로그인 쿠키 복원: $COOKIE_FILE" | tee -a "$LOG"
fi

# 1. 의존성 (컨테이너 재생성 대비 멱등 설치)
if [ ! -d node_modules ]; then
  echo "[setup] npm install..." | tee -a "$LOG"
  npm install --no-audit --no-fund >> "$LOG" 2>&1 || { echo "npm install 실패" | tee -a "$LOG"; exit 1; }
fi

# 2. 사전 점검
node scripts/check-setup.js 2>&1 | tee -a "$LOG"
PREFLIGHT=${PIPESTATUS[0]}
if [ "$PREFLIGHT" -ne 0 ]; then
  echo "[preflight] 미충족 — 스케줄러 실행 건너뜀 (로그: $LOG)" | tee -a "$LOG"
  exit 2
fi

[ "${1:-}" = "--check" ] && exit 0

# 3. 지난 회차에 못 보낸 슬랙 메시지 재발송 시도 (웹훅 복구 시)
node -e "require('./lib/slack').flushOutbox().then(r => console.log('[slack] 아웃박스 재발송:', JSON.stringify(r)))" 2>&1 | tee -a "$LOG"

# 4. 스케줄러 실행
node scripts/kmong-scheduler.js 2>&1 | tee -a "$LOG"
CODE=${PIPESTATUS[0]}

if [ -s data/slack-outbox.jsonl ]; then
  echo "SLACK_OUTBOX_PENDING: $(wc -l < data/slack-outbox.jsonl)건 — data/slack-outbox.jsonl" | tee -a "$LOG"
fi

# 5. seen 상태를 git으로 영속화 (컨테이너가 사라져도 상태 유지)
BRANCH="claude/kmong-automation-bot-oxidvu"
git add data/kmong-seen.json data/kmong-last-applied.json 2>/dev/null
if ! git diff --cached --quiet 2>/dev/null; then
  git commit -m "bot: seen 상태 업데이트 ($(date '+%F %T'))" >> "$LOG" 2>&1
  for i in 1 2 3 4; do
    git push -u origin "$BRANCH" >> "$LOG" 2>&1 && break
    sleep $((2 ** i))
  done
fi

echo "=== 종료 (exit $CODE): $(date '+%F %T') ===" | tee -a "$LOG"
exit $CODE
