#!/bin/bash
# Steno 도우미 하나(받은 파일 넣기 + 팀 공유 복사)를 설치한다. 파일만 설치하고 LaunchAgent 를 등록하거나 실행하지 않는다.
# Steno 라이브러리를 옮겨 쓰면 STENO_LIBRARY=/경로 를 붙여 실행한다(기본 ~/Documents/Steno, 팀 공유에만 쓴다).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SUPPORT="$HOME/Library/Application Support/b3os"
BIN_DIR="$SUPPORT/bin"
PLIST="$HOME/Library/LaunchAgents/com.b3os.steno-helper.plist"
LIBRARY="${STENO_LIBRARY:-$HOME/Documents/Steno}"
case "$LIBRARY" in /*) ;; *) echo "STENO_LIBRARY 는 절대 경로여야 합니다" >&2; exit 1 ;; esac

install -d -m 700 "$BIN_DIR" "$SUPPORT/steno-outbox" "$SUPPORT/steno-shared" "$HOME/Library/LaunchAgents"
swiftc -O "$HERE"/Sources/*.swift -o "$BIN_DIR/steno-helper"
chmod 700 "$BIN_DIR/steno-helper"
# plist(XML) 용으로 & < 를 먼저 바꾸고, 그다음 sed 치환 문자열용으로 & | \ 를 이스케이프한다.
esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/[&|\\]/\\&/g'; }
sed -e "s|__B3OS_HOME__|$(esc "$HOME")|g" -e "s|__STENO_LIBRARY__|$(esc "$LIBRARY")|g" \
  "$HERE/com.b3os.steno-helper.plist.template" > "$PLIST"
chmod 600 "$PLIST"
echo "설치됨(아직 등록되지 않음): $BIN_DIR/steno-helper"
echo "LaunchAgent 템플릿: $PLIST"
