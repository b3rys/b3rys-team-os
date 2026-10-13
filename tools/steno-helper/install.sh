#!/bin/bash
# Steno 도우미 하나(받은 파일 넣기 + 팀 공유 복사)를 설치한다. 파일만 설치하고 LaunchAgent 를 등록하거나 실행하지 않는다.
# 매 주기 라이브러리: Steno/library-location.json의 path → 명시한 STENO_LIBRARY → iCloud Steno Documents → ~/Documents/Steno.
# STENO_LIBRARY=/경로 를 명시한 경우에만 plist에 기록한다. 사라지거나 무효면 다음 후보로 넘어간다.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SUPPORT="$HOME/Library/Application Support/b3os"
BIN_DIR="$SUPPORT/bin"
PLIST="$HOME/Library/LaunchAgents/com.b3os.steno-helper.plist"
if [ "${STENO_LIBRARY+x}" = x ]; then
  case "$STENO_LIBRARY" in /*) ;; *) echo "STENO_LIBRARY 는 절대 경로여야 합니다" >&2; exit 1 ;; esac
fi

install -d -m 700 "$BIN_DIR" "$SUPPORT/steno-outbox" "$SUPPORT/steno-share-outbox" "$SUPPORT/steno-shared" "$HOME/Library/LaunchAgents"
swiftc -O "$HERE"/Sources/*.swift -o "$BIN_DIR/steno-helper"
SIGN_ID='Developer ID Application: GUE DON JUNG (7NTC94U74E)'
if ! security find-identity -v -p codesigning | grep -Fq "\"$SIGN_ID\""; then
  SIGN_ID='-'
fi
codesign --force --sign "$SIGN_ID" --identifier com.b3os.steno-helper "$BIN_DIR/steno-helper"
chmod 700 "$BIN_DIR/steno-helper"
# plist(XML) 용으로 & < 를 먼저 바꾸고, 그다음 sed 치환 문자열용으로 & | \ 를 이스케이프한다.
esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/[&|\\]/\\&/g'; }
LIBRARY_ENV=''
if [ "${STENO_LIBRARY+x}" = x ]; then
  LIBRARY_ENV="<key>EnvironmentVariables</key><dict><key>STENO_LIBRARY</key><string>$(esc "$STENO_LIBRARY")</string></dict>"
fi
sed -e "s|__B3OS_HOME__|$(esc "$HOME")|g" -e "s|__STENO_LIBRARY_ENV__|$LIBRARY_ENV|g" \
  "$HERE/com.b3os.steno-helper.plist.template" > "$PLIST"
chmod 600 "$PLIST"
echo "설치됨(아직 등록되지 않음): $BIN_DIR/steno-helper"
echo "LaunchAgent 템플릿: $PLIST"
