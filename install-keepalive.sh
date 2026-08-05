#!/bin/bash
# 크몽 세션 keep-alive launchd 등록 (1시간마다, 주말 포함)
#
# 사용법:
#   bash install-keepalive.sh          # 설치
#   bash install-keepalive.sh --remove # 제거

set -e

WORKSPACE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.bottlecorp.kmong-keepalive"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

if [ "$1" = "--remove" ]; then
  launchctl unload -w "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✅ keep-alive 제거 완료"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$WORKSPACE/logs"
chmod +x "$WORKSPACE/run-keepalive.sh"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${WORKSPACE}/run-keepalive.sh</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${WORKSPACE}</string>

    <!-- 1시간마다. 맥이 자다 깨면 놓친 회차를 즉시 1회 실행한다. -->
    <key>StartInterval</key>
    <integer>3600</integer>

    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${WORKSPACE}/logs/keepalive-launchd.log</string>
    <key>StandardErrorPath</key>
    <string>${WORKSPACE}/logs/keepalive-launchd.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload -w "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"

echo "✅ 크몽 세션 keep-alive 등록 완료 (1시간마다, 주말 포함)"
echo "   plist: $PLIST"
echo "   로그:  tail -f $WORKSPACE/logs/keepalive-\$(date +%Y%m).log"
echo ""
echo "즉시 1회 테스트:  node scripts/kmong-session-keepalive.js --headful"
