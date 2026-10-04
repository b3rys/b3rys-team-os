#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
TMP="$(cd "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/steno-inbox-writer-test"
swiftc -D STENO_WRITER_TESTING "$HERE/Sources/main.swift" -o "$BIN"

pass=0
expect_reject() {
  if "$BIN" "$1" "$2" >/dev/null 2>&1; then echo "FAIL: $3" >&2; exit 1; fi
  pass=$((pass + 1))
}

mkdir -p "$TMP/outbox" "$TMP/inbox"
printf ok > "$TMP/outbox/정상.md"
"$BIN" "$TMP/outbox" "$TMP/inbox"
test "$(cat "$TMP/inbox/정상.md")" = ok && test ! -e "$TMP/outbox/정상.md"
pass=$((pass + 1))

printf old > "$TMP/inbox/충돌.md"
printf new > "$TMP/outbox/충돌.md"
"$BIN" "$TMP/outbox" "$TMP/inbox"
test "$(cat "$TMP/inbox/충돌.md")" = old && test "$(cat "$TMP/inbox/충돌 2.md")" = new
pass=$((pass + 1))

printf secret > "$TMP/secret"
ln -s "$TMP/secret" "$TMP/outbox/비밀.md"
expect_reject "$TMP/outbox" "$TMP/inbox" "outbox symlink"
test ! -e "$TMP/inbox/비밀.md"
rm "$TMP/outbox/비밀.md"

ln "$TMP/secret" "$TMP/outbox/하드링크.md"
expect_reject "$TMP/outbox" "$TMP/inbox" "outbox hardlink"
test ! -e "$TMP/inbox/하드링크.md"
rm "$TMP/outbox/하드링크.md"

printf x > "$TMP/outbox/거절.txt"
expect_reject "$TMP/outbox" "$TMP/inbox" "extension"
rm "$TMP/outbox/거절.txt"

dd if=/dev/zero of="$TMP/outbox/큼.md" bs=1048577 count=1 2>/dev/null
expect_reject "$TMP/outbox" "$TMP/inbox" "size"
rm "$TMP/outbox/큼.md"

mkdir "$TMP/real-inbox"
ln -s "$TMP/real-inbox" "$TMP/linked-inbox"
printf x > "$TMP/outbox/링크대상.md"
expect_reject "$TMP/outbox" "$TMP/linked-inbox" "destination symlink"
rm "$TMP/outbox/링크대상.md"

# 경로 구분자와 .. 는 실제 디렉터리 엔트리로 만들 수 없어 이름 검사기를 직접 검증한다.
if "$BIN" --validate-name ../x.md; then echo "FAIL: dot-dot name" >&2; exit 1; fi
pass=$((pass + 1))
if "$BIN" --validate-name dir/x.md; then echo "FAIL: slash name" >&2; exit 1; fi
pass=$((pass + 1))

printf occupied > "$TMP/inbox/심볼릭.md"
ln -s "$TMP/secret" "$TMP/inbox/심볼릭 2.md"
printf safe > "$TMP/outbox/심볼릭.md"
expect_reject "$TMP/outbox" "$TMP/inbox" "destination filename symlink"
test "$(cat "$TMP/secret")" = secret && test ! -e "$TMP/inbox/심볼릭 3.md"
rm "$TMP/outbox/심볼릭.md"

echo "PASS: $pass steno-inbox-writer checks"
