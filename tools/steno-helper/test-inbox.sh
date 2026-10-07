#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"; TMP="$(cd "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT
BIN="${STENO_HELPER_TEST_BIN:-$TMP/steno-helper-test}"
[ -x "$BIN" ] || swiftc -D STENO_HELPER_TESTING "$HERE"/Sources/*.swift -o "$BIN"
pass=0
expect_reject() {
  if "$BIN" --inbox "$1" "$2" >/dev/null 2>&1; then echo "FAIL: $3" >&2; exit 1; fi
  pass=$((pass + 1))
}
mkdir -p "$TMP/outbox" "$TMP/inbox"

printf ok > "$TMP/outbox/정상.md"
"$BIN" --inbox "$TMP/outbox" "$TMP/inbox"
test "$(cat "$TMP/inbox/정상.md")" = ok && test ! -e "$TMP/outbox/정상.md"
pass=$((pass + 1))

printf old > "$TMP/inbox/충돌.md"; printf new > "$TMP/outbox/충돌.md"
"$BIN" --inbox "$TMP/outbox" "$TMP/inbox"
test "$(cat "$TMP/inbox/충돌.md")" = old && test "$(cat "$TMP/inbox/충돌 2.md")" = new
pass=$((pass + 1))

for ext in txt json swift svg png heic zip sh; do
  printf data > "$TMP/outbox/대표.$ext"
  "$BIN" --inbox "$TMP/outbox" "$TMP/inbox"
  test "$(cat "$TMP/inbox/대표.$ext")" = data
  pass=$((pass + 1))
done
test -f "$TMP/inbox/대표.zip" && test ! -d "$TMP/inbox/대표"
pass=$((pass + 1))
test "$(stat -f '%Lp' "$TMP/inbox/대표.sh")" = 600
pass=$((pass + 1))

printf secret > "$TMP/secret"; ln -s "$TMP/secret" "$TMP/outbox/비밀.md"
expect_reject "$TMP/outbox" "$TMP/inbox" "outbox symlink"; test ! -e "$TMP/inbox/비밀.md"; rm "$TMP/outbox/비밀.md"
ln "$TMP/secret" "$TMP/outbox/하드링크.md"
expect_reject "$TMP/outbox" "$TMP/inbox" "outbox hardlink"; test ! -e "$TMP/inbox/하드링크.md"; rm "$TMP/outbox/하드링크.md"

for ext in app command exe; do
  printf x > "$TMP/outbox/거절.$ext"
  expect_reject "$TMP/outbox" "$TMP/inbox" "extension $ext"
  rm "$TMP/outbox/거절.$ext"
done

dd if=/dev/zero of="$TMP/outbox/큼.md" bs=1048576 count=21 2>/dev/null
expect_reject "$TMP/outbox" "$TMP/inbox" "size"; rm "$TMP/outbox/큼.md"

mkdir "$TMP/real-inbox"; ln -s "$TMP/real-inbox" "$TMP/linked-inbox"
printf x > "$TMP/outbox/링크대상.md"
expect_reject "$TMP/outbox" "$TMP/linked-inbox" "destination symlink"; rm "$TMP/outbox/링크대상.md"

if "$BIN" --validate-name ../x.md; then echo "FAIL: dot-dot name" >&2; exit 1; fi; pass=$((pass + 1))
if "$BIN" --validate-name dir/x.md; then echo "FAIL: slash name" >&2; exit 1; fi; pass=$((pass + 1))

printf occupied > "$TMP/inbox/심볼릭.md"; ln -s "$TMP/secret" "$TMP/inbox/심볼릭 2.md"
printf safe > "$TMP/outbox/심볼릭.md"
expect_reject "$TMP/outbox" "$TMP/inbox" "destination filename symlink"
test "$(cat "$TMP/secret")" = secret && test ! -e "$TMP/inbox/심볼릭 3.md"

SEND_HOME="$TMP/send-home"; mkdir -p "$SEND_HOME"
printf image > "$TMP/send.png"
HOME="$SEND_HOME" "$HERE/../../skills/b3os-team-inbox/scripts/steno-send.sh" "$TMP/send.png" >/dev/null
test -f "$SEND_HOME/Library/Application Support/b3os/steno-outbox/send.png"
pass=$((pass + 1))
printf x > "$TMP/send.command"
if HOME="$SEND_HOME" "$HERE/../../skills/b3os-team-inbox/scripts/steno-send.sh" "$TMP/send.command" >/dev/null 2>&1; then
  echo "FAIL: steno-send extension" >&2; exit 1
fi
pass=$((pass + 1))
for name in .env client-secret.txt db-CREDENTIAL.md api_token.json; do
  if HOME="$SEND_HOME" "$HERE/../../skills/b3os-team-inbox/scripts/steno-send.sh" "$TMP/send.png" --name "$name" >/dev/null 2>&1; then
    echo "FAIL: steno-send sensitive name $name" >&2; exit 1
  fi
  pass=$((pass + 1))
done

mkdir -p "$TMP/new-library"
"$BIN" --inbox "$TMP/outbox" "$TMP/new-library/받은 파일"
test "$(cat "$TMP/new-library/받은 파일/.steno-folder")" = received
pass=$((pass + 1))
echo "PASS: $pass 받은 파일 checks"
