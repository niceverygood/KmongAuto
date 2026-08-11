#!/bin/bash
# 크몽 스케줄러 launchd 등록
# 발화 시각: 평일 10:30 / 16:00 / 17:00 (위시켓 09:40/14:00/15:00과 겹치지 않게 offset)
# 주말/공휴일 필터는 run-scheduler.sh 안에서 처리

set -e

WORKSPACE="$(cd "$(dirname "$0")" && pwd)"
PLIST_LABEL="com.bottlecorp.kmong-scheduler"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

mkdir -p "$HOME/Library/LaunchAgents" "$WORKSPACE/logs"
chmod +x "$WORKSPACE/run-scheduler.sh"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${WORKSPACE}/run-scheduler.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>16</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key>
  <string>${WORKSPACE}/logs/launchd-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${WORKSPACE}/logs/launchd-stderr.log</string>
  <key>WorkingDirectory</key>
  <string>${WORKSPACE}</string>
</dict>
</plist>
EOF

launchctl unload -w "$PLIST_PATH" 2>/dev/null || true
launchctl load -w "$PLIST_PATH"

echo "✅ 등록 완료: $PLIST_PATH"
echo "   발화 시각: 평일 10:30 / 16:00 / 17:00 (주말·공휴일 자동 skip)"
echo ""
echo "끄기:  launchctl unload -w $PLIST_PATH"
echo "즉시 실행 테스트:  bash $WORKSPACE/run-scheduler.sh"
