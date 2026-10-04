#!/bin/bash
# 파일을 설치할 뿐 LaunchAgent를 등록하거나 실행하지 않는다.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SUPPORT="$HOME/Library/Application Support/b3os"
BIN_DIR="$SUPPORT/bin"
OUTBOX="$SUPPORT/steno-outbox"
PLIST="$HOME/Library/LaunchAgents/com.b3os.steno-inbox-writer.plist"

install -d -m 700 "$BIN_DIR" "$OUTBOX" "$HOME/Library/LaunchAgents"
swiftc -O "$HERE/Sources/main.swift" -o "$BIN_DIR/steno-inbox-writer"
chmod 700 "$BIN_DIR/steno-inbox-writer"
sed "s|__B3OS_HOME__|$HOME|g" "$HERE/com.b3os.steno-inbox-writer.plist.template" > "$PLIST"
chmod 600 "$PLIST"
echo "설치됨(아직 등록되지 않음): $BIN_DIR/steno-inbox-writer"
echo "LaunchAgent 템플릿: $PLIST"
