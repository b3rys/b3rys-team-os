#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"; TMP="$(cd "$TMP" && pwd -P)"
trap 'chmod -R u+rw "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
BIN="${STENO_HELPER_TEST_BIN:-$TMP/steno-helper-test}"
[ -x "$BIN" ] || swiftc -D STENO_HELPER_TESTING "$HERE"/Sources/*.swift -o "$BIN"
SRC="$TMP/팀 공유"; DST="$TMP/shared"
mkdir -p "$SRC" "$DST"
printf " team\n" > "$SRC/.steno-folder"
pass=0
ok() { pass=$((pass + 1)); }
fail() { echo "FAIL: $1" >&2; exit 1; }
sync() { "$BIN" --share "$SRC" "$DST" 2>/dev/null || true; }
srcsum() { find "$SRC" -type f -exec shasum {} + | sort; }

# 1. 처음 복사 + manifest 기록, 원본 무수정
printf v1 > "$SRC/AAA.md"
before="$(srcsum)"
sync
[ "$(cat "$DST/AAA.md")" = v1 ] || fail "first copy"; ok
grep -q '"AAA.md"' "$DST/.manifest.json" || fail "manifest entry"; ok
[ "$(srcsum)" = "$before" ] || fail "source changed"; ok

# 2. 원본만 바뀜 → 사본 갱신
printf v2 > "$SRC/AAA.md"; sync
[ "$(cat "$DST/AAA.md")" = v2 ] || fail "source update"; ok

# 3. 팀원이 사본을 고침 → 원본이 그대로면 사본 유지
printf team > "$DST/AAA.md"; sync
[ "$(cat "$DST/AAA.md")" = team ] || fail "team edit kept"; ok

# 4. 원본도 바뀜 → 사본은 여전히 유지, manifest source 는 새 원본 해시
printf gd > "$SRC/AAA.md"; sync
[ "$(cat "$DST/AAA.md")" = team ] || fail "both changed keeps copy"; ok
gdhash="$(printf gd | shasum -a 256 | cut -d' ' -f1)"
grep -q "$gdhash" "$DST/.manifest.json" || fail "manifest source hash"; ok

# 5. 되돌려 넣은 뒤(원본 = 사본) → 새 기준으로 맞춤
printf team > "$SRC/AAA.md"; sync
teamhash="$(printf team | shasum -a 256 | cut -d' ' -f1)"
[ "$(grep -c "$teamhash" "$DST/.manifest.json")" = 2 ] || fail "rebase after return"; ok

# 6. 건너뛰기: 숨김, .steno 사이드카, 비밀 이름, 링크, 폴더, 실행 확장자, 20MB 초과
printf x > "$SRC/.hidden.md"; mkdir -p "$SRC/.steno"; printf x > "$SRC/.steno/ai-edits.json"
printf x > "$SRC/api-token.md"; printf x > "$SRC/run.command"; mkdir "$SRC/하위"; printf x > "$SRC/하위/in.md"
printf secret > "$TMP/outside.md"; ln -s "$TMP/outside.md" "$SRC/링크.md"
dd if=/dev/zero of="$SRC/큼.md" bs=1048576 count=21 2>/dev/null
sync
for n in .hidden.md .steno api-token.md run.command 하위 링크.md 큼.md; do
  [ ! -e "$DST/$n" ] || fail "skip $n"; ok
done

# 7. 팀 공유에서 빠짐: 안 고친 사본은 지우고, 고친 사본은 남김
printf b > "$SRC/BBB.md"; printf c > "$SRC/CCC.md"; sync
printf edited > "$DST/CCC.md"
rm "$SRC/BBB.md" "$SRC/CCC.md"; sync
[ ! -e "$DST/BBB.md" ] || fail "removed untouched copy"; ok
[ "$(cat "$DST/CCC.md")" = edited ] || fail "edited copy kept"; ok

# 8. 목록엔 있지만 못 읽는 파일(iCloud 미다운로드 대역) → 사본 안 지움
printf d > "$SRC/DDD.md"; sync
chmod 000 "$SRC/DDD.md"; sync
grep -A3 '"DDD.md"' "$DST/.manifest.json" | grep -q '"source" : "unreadable"' || fail "unreadable marks source"; ok
chmod 600 "$SRC/DDD.md"
[ "$(cat "$DST/DDD.md")" = d ] || fail "unreadable keeps copy"; ok

# 8a. 사본을 못 읽으면(권한) 원본이 바뀌어도 덮지 않음
printf f1 > "$SRC/FFF.md"; sync; chmod 000 "$DST/FFF.md"
printf f2 > "$SRC/FFF.md"; sync; chmod 600 "$DST/FFF.md"
[ "$(cat "$DST/FFF.md")" = f1 ] || fail "unreadable copy untouched"; ok

# 8c. NFD 이름: manifest 키는 NFC, file 칸은 디스크 이름
nfd="$(python3 -c 'import unicodedata;print(unicodedata.normalize("NFD","한글.md"))')"
printf k > "$SRC/$nfd"; sync
python3 - "$DST/.manifest.json" <<'PY' || fail "nfc key"
import json, sys, unicodedata
m = json.load(open(sys.argv[1])); e = m[unicodedata.normalize("NFC", "한글.md")]
assert e["file"] == unicodedata.normalize("NFD", "한글.md")
PY
ok

# 8b. 팀 공유 폴더를 못 읽으면(권한·iCloud 오류) 사본을 하나도 지우지 않음
chmod 300 "$SRC"; sync; chmod 700 "$SRC"
[ "$(cat "$DST/DDD.md")" = d ] && [ -e "$DST/AAA.md" ] || fail "unreadable folder keeps copies"; ok

# 9. 팀 폴더 안 같은 이름 링크 → 링크 대상은 안 바뀌고 링크만 교체
printf target > "$TMP/victim.txt"
printf e > "$SRC/EEE.md"; ln -s "$TMP/victim.txt" "$DST/EEE.md"; sync
[ "$(cat "$TMP/victim.txt")" = target ] || fail "symlink target untouched"; ok

# 10. 팀 폴더가 링크면 거절, 팀 공유가 없으면 조용히 끝
ln -s "$DST" "$TMP/linked"
if "$BIN" --share "$SRC" "$TMP/linked" 2>/dev/null; then fail "linked destination"; fi; ok
"$BIN" --share "$TMP/없음" "$DST" || fail "missing source should be ok"; ok

# New upload: bytes/SHA, collision suffix and stripped execute bits.
LIB="$TMP/library"; OUT="$TMP/share-outbox"
mkdir -p "$LIB/팀 공유" "$OUT"; printf team > "$LIB/팀 공유/.steno-folder"
printf upload > "$OUT/new.md"; chmod 700 "$OUT/new.md"
"$BIN" --upload "$OUT" "$LIB"
[ "$(shasum -a 256 "$LIB/팀 공유/new.md" | cut -d' ' -f1)" = "$(printf upload | shasum -a 256 | cut -d' ' -f1)" ] || fail "new upload SHA"; ok
[ "$(stat -f %Lp "$LIB/팀 공유/new.md")" = 600 ] || fail "upload mode"; ok
[ ! -e "$OUT/new.md" ] || fail "upload consumes source"; ok
printf second > "$OUT/new.md"; "$BIN" --upload "$OUT" "$LIB"
[ "$(cat "$LIB/팀 공유/new.md")" = upload ] && [ "$(cat "$LIB/팀 공유/new 2.md")" = second ] || fail "upload collision"; ok
ln -s "$TMP/outside.md" "$OUT/link.md"; mkdir "$OUT/folder.md"
dd if=/dev/zero of="$OUT/big.md" bs=1048576 count=21 2>/dev/null
if "$BIN" --upload "$OUT" "$LIB" 2>/dev/null; then fail "unsafe upload accepted"; fi
for n in link.md folder.md big.md; do [ ! -e "$LIB/팀 공유/$n" ] || fail "unsafe upload $n"; ok; done
rm "$OUT/link.md" "$OUT/big.md"; rmdir "$OUT/folder.md"
SEND_HOME="$TMP/send-home"; mkdir -p "$SEND_HOME"
printf send > "$TMP/send.md"
HOME="$SEND_HOME" "$HERE/../../skills/b3os-team-inbox/scripts/steno-send.sh" "$TMP/send.md" >/dev/null
[ -f "$SEND_HOME/Library/Application Support/b3os/steno-share-outbox/send.md" ] || fail "send defaults to team"; ok

python3 "$HERE/test-return.py" "$BIN" "$HERE/steno-share-return.py"


# Same-named user folders must not be shared.
rm "$SRC/.steno-folder"
printf private > "$SRC/Private.md"
sync
[ ! -e "$DST/Private.md" ] || fail "unmarked user folder shared"; ok
# An iCloud marker placeholder identifies the folder while its contents are pending.
: > "$SRC/.steno-folder.icloud"
sync
[ "$(cat "$DST/Private.md")" = private ] || fail "cloud marker placeholder"; ok
rm "$SRC/.steno-folder.icloud"
printf team > "$SRC/.steno-folder"

# An unreadable cloud source requests downloading once across helper invocations.
printf pending > "$SRC/Cloud.md"
chmod 000 "$SRC/Cloud.md"
sync
python3 - "$DST/.manifest.json" <<'CHECK'
import json,sys
assert json.load(open(sys.argv[1]))['Cloud.md']['downloadRequested'] == '1'
CHECK
ok
sync
python3 - "$DST/.manifest.json" <<'CHECK'
import json,sys
assert json.load(open(sys.argv[1]))['Cloud.md']['downloadRequested'] == '1'
CHECK
ok
chmod 600 "$SRC/Cloud.md"
sync
[ "$(cat "$DST/Cloud.md")" = pending ] || fail "cloud source copied on next readable cycle"; ok
chmod 000 "$SRC/Cloud.md"
sync
python3 - "$DST/.manifest.json" <<'CHECK'
import json,sys
assert json.load(open(sys.argv[1]))['Cloud.md']['downloadRequested'] == '1'
CHECK
ok
chmod 600 "$SRC/Cloud.md"

echo "PASS: $pass 팀 공유 checks"
