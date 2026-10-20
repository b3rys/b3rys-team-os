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

rm -f "$TMP/outbox/심볼릭.md" "$TMP/inbox/심볼릭 2.md"
# 하위 폴더: outbox/A/B/x.md → 받은 파일/A/B/x.md, 비운 outbox 폴더는 지운다.
mkdir -p "$TMP/outbox/보고서/초안"; printf r1 > "$TMP/outbox/보고서/x.md"; printf r2 > "$TMP/outbox/보고서/초안/y.md"
"$BIN" --inbox "$TMP/outbox" "$TMP/inbox"
test "$(cat "$TMP/inbox/보고서/x.md")" = r1 && test "$(cat "$TMP/inbox/보고서/초안/y.md")" = r2 && test ! -e "$TMP/outbox/보고서"
pass=$((pass + 1))
mkdir -p "$TMP/outbox/a/b/c"; printf deep > "$TMP/outbox/a/b/c/z.md"
expect_reject "$TMP/outbox" "$TMP/inbox" "third level folder"; test ! -e "$TMP/inbox/a/b/c"; rm -rf "$TMP/outbox/a" "$TMP/inbox/a"
mkdir -p "$TMP/outbox/client-secret"; printf x > "$TMP/outbox/client-secret/x.md"
expect_reject "$TMP/outbox" "$TMP/inbox" "sensitive folder"; test ! -e "$TMP/inbox/client-secret"; rm -rf "$TMP/outbox/client-secret"
mkdir -p "$TMP/elsewhere"; ln -s "$TMP/elsewhere" "$TMP/inbox/링크폴더"; mkdir "$TMP/outbox/링크폴더"; printf x > "$TMP/outbox/링크폴더/x.md"
expect_reject "$TMP/outbox" "$TMP/inbox" "destination folder symlink"; test ! -e "$TMP/elsewhere/x.md"; rm -rf "$TMP/outbox/링크폴더" "$TMP/inbox/링크폴더"

SEND_HOME="$TMP/send-home"; mkdir -p "$SEND_HOME"
printf image > "$TMP/send.png"
HOME="$SEND_HOME" "$HERE/../../skills/b3os-team-inbox/scripts/steno-send.sh" "$TMP/send.png" --to-received >/dev/null
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

HOME="$SEND_HOME" "$HERE/../../skills/b3os-team-inbox/scripts/steno-send.sh" "$TMP/send.png" --to-received --folder "발표/초안" >/dev/null
test -f "$SEND_HOME/Library/Application Support/b3os/steno-outbox/발표/초안/send.png"
pass=$((pass + 1))
for folder in ../x .숨김 a/b/c a//b /a my-token; do
  if HOME="$SEND_HOME" "$HERE/../../skills/b3os-team-inbox/scripts/steno-send.sh" "$TMP/send.png" --folder "$folder" >/dev/null 2>&1; then
    echo "FAIL: steno-send folder $folder" >&2; exit 1
  fi
  pass=$((pass + 1))
done
# 중간 폴더가 링크면 outbox 밖에 쓰지 않는다(코덱스 재현 #575).
mkdir -p "$TMP/send-outside"; rm -rf "$SEND_HOME/Library/Application Support/b3os/steno-outbox/링크"
ln -s "$TMP/send-outside" "$SEND_HOME/Library/Application Support/b3os/steno-outbox/링크"
if HOME="$SEND_HOME" "$HERE/../../skills/b3os-team-inbox/scripts/steno-send.sh" "$TMP/send.png" --to-received --folder "링크/안" >/dev/null 2>&1; then
  echo "FAIL: steno-send followed linked folder" >&2; exit 1
fi
test -z "$(ls -A "$TMP/send-outside")"
pass=$((pass + 1))
# 확인 뒤 바꿔치기 경쟁(리뷰 #575): 내려간 뒤 폴더를 밖으로 가는 링크로 바꿔도 밖에 쓰지 않는다.
RACE_BOX="$SEND_HOME/Library/Application Support/b3os/steno-outbox"
rm -rf "$RACE_BOX/경쟁" "$TMP/race-outside" "$TMP/race-moved"; mkdir -p "$TMP/race-outside" "$RACE_BOX/경쟁"
HOME="$SEND_HOME" STENO_SEND_TEST_AFTER_DESCEND="mv '$RACE_BOX/경쟁' '$TMP/race-moved' && ln -s '$TMP/race-outside' '$RACE_BOX/경쟁'" \
  "$HERE/../../skills/b3os-team-inbox/scripts/steno-send.sh" "$TMP/send.png" --to-received --folder "경쟁" >/dev/null 2>&1 || true
test -z "$(ls -A "$TMP/race-outside")" && test -f "$TMP/race-moved/send.png"   # 바꿔치기가 실제로 일어났고 파일은 처음 연 진짜 폴더로 갔다
pass=$((pass + 1))
rm -f "$RACE_BOX/경쟁"
echo "PASS: $pass 받은 파일 checks"
