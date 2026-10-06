#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"; TMP="$(cd "$TMP" && pwd -P)"
trap 'chmod -R u+rw "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
BIN="$TMP/steno-share-sync-test"
swiftc -D STENO_SHARE_TESTING "$HERE/Sources/main.swift" -o "$BIN"
SRC="$TMP/팀 공유"; DST="$TMP/shared"
mkdir -p "$SRC" "$DST"
pass=0
ok() { pass=$((pass + 1)); }
fail() { echo "FAIL: $1" >&2; exit 1; }
sync() { "$BIN" "$SRC" "$DST" 2>/dev/null || true; }
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
if "$BIN" "$SRC" "$TMP/linked" 2>/dev/null; then fail "linked destination"; fi; ok
"$BIN" "$TMP/없음" "$DST" || fail "missing source should be ok"; ok

# 11. 되돌려 넣기: 원본 그대로면 edit_note, 바뀌었으면 create_note "(빌 수정)", 같으면 할 일 없음
RH="$TMP/home"; RS="$RH/Library/Application Support/b3os/steno-shared"; mkdir -p "$RS"
cat > "$TMP/fake-mcp" <<'STUB'
#!/usr/bin/env python3
import json, os, sys
for line in sys.stdin:
    m = json.loads(line)
    if m.get("method") == "tools/call" and m["params"]["name"] == "edit_note" and os.environ.get("FAKE_REFUSE_EDIT"):
        with open(os.environ["FAKE_LOG"], "a") as f: f.write(json.dumps(m["params"], ensure_ascii=False) + "\n")
        print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": {"isError": True, "content": [{"type": "text", "text": "stale"}]}}))
    elif m.get("method") == "tools/call":
        with open(os.environ["FAKE_LOG"], "a") as f: f.write(json.dumps(m["params"], ensure_ascii=False) + "\n")
        print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": {"content": [{"type": "text", "text": "ok"}]}}))
    elif m.get("method") == "tools/list":
        props = {"path": {}, "content": {}}
        if not os.environ.get("FAKE_NO_HASH"): props["expected_sha256"] = {}
        print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": {"tools": [{"name": "edit_note", "inputSchema": {"properties": props}}]}}))
    elif "id" in m:
        print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": {}}))
STUB
chmod +x "$TMP/fake-mcp"
h() { printf %s "$1" | shasum -a 256 | cut -d' ' -f1; }
ret() { HOME="$RH" STENO_MCP="$TMP/fake-mcp" STENO_SHARE_NO_KICK=1 FAKE_LOG="$TMP/log" "$HERE/steno-share-return.py" "$@" >/dev/null; }
printf edited > "$RS/AAA.md"
printf '{"AAA.md":{"base":"%s","source":"%s"}}' "$(h orig)" "$(h orig)" > "$RS/.manifest.json"
: > "$TMP/log"; ret AAA.md --as 빌
grep -q '"name": "edit_note"' "$TMP/log" && grep -q '"path": "팀 공유/AAA.md"' "$TMP/log" || fail "return edit"; ok
grep -q "\"expected_sha256\": \"$(h orig)\"" "$TMP/log" || fail "return expected hash"; ok
: > "$TMP/log"; FAKE_REFUSE_EDIT=1 ret AAA.md --as 빌
grep -q edit_note "$TMP/log" && grep -q '"name": "AAA (빌 수정)"' "$TMP/log" && grep -q '"format": "md"' "$TMP/log" || fail "edit refused falls back to copy"; ok
# 순서 경합: 사본 v1(=기준) 상태에서 return 시작 → 도우미가 사본·기준을 v2 로 갱신 → 옛 v1 을 보내면 안 됨
printf v1 > "$RS/RACE.md"
printf '{"RACE.md":{"base":"%s","source":"%s"}}' "$(h v1)" "$(h v1)" > "$RS/.manifest.json"
: > "$TMP/log"
STENO_SHARE_TEST_REFRESH="printf v2 > '$RS/RACE.md'; printf '{\"RACE.md\":{\"base\":\"$(h v2)\",\"source\":\"$(h v2)\"}}' > '$RS/.manifest.json'" \
  ret RACE.md --as 빌
[ ! -s "$TMP/log" ] || fail "race: stale copy sent"; ok
# 사본이 기준 판 그대로면(고친 것 없음) 아무것도 보내지 않음
printf '{"RACE.md":{"base":"%s","source":"%s"}}' "$(h v2)" "$(h v3)" > "$RS/.manifest.json"
: > "$TMP/log"; ret RACE.md --as 빌; [ ! -s "$TMP/log" ] || fail "unchanged copy sends nothing"; ok
printf '{"AAA.md":{"base":"%s","source":"%s"}}' "$(h orig)" "$(h orig)" > "$RS/.manifest.json"
# Steno 가 expected_sha256 을 모르면(스키마에 없음) edit_note 를 부르지 않고 사본
: > "$TMP/log"; FAKE_NO_HASH=1 ret AAA.md --as 빌
! grep -q edit_note "$TMP/log" && grep -q create_note "$TMP/log" || fail "no hash support makes copy"; ok
# 원본을 못 읽은 상태(source=unreadable)면 원본 자리에 쓰지 않음
printf '{"AAA.md":{"base":"%s","source":"unreadable"}}' "$(h orig)" > "$RS/.manifest.json"
: > "$TMP/log"; ret AAA.md --as 빌
! grep -q edit_note "$TMP/log" && grep -q create_note "$TMP/log" || fail "unreadable source no edit"; ok
# md·html 아닌 파일은 따로 만들기를 거절하고 아무것도 쓰지 않음, htm 은 html 형식
printf x > "$RS/BBB.txt"; printf '{"BBB.txt":{"base":"a","source":"b"}}' > "$RS/.manifest.json"
: > "$TMP/log"; if ret BBB.txt --as 빌 2>/dev/null; then fail "txt copy refused"; fi; [ ! -s "$TMP/log" ] || fail "txt no call"; ok
printf x > "$RS/CCC.htm"; printf '{"CCC.htm":{"base":"a","source":"b"}}' > "$RS/.manifest.json"
: > "$TMP/log"; ret CCC.htm --as 빌; grep -q '"format": "html"' "$TMP/log" || fail "htm format"; ok
printf '{"AAA.md":{"base":"%s","source":"%s"}}' "$(h orig)" "$(h orig)" > "$RS/.manifest.json"
printf '{"AAA.md":{"base":"%s","source":"%s"}}' "$(h orig)" "$(h gdnew)" > "$RS/.manifest.json"
: > "$TMP/log"; ret AAA.md --as 빌
grep -q '"name": "create_note"' "$TMP/log" && grep -q '"name": "AAA (빌 수정)"' "$TMP/log" && ! grep -q edit_note "$TMP/log" || fail "return conflict copy"; ok
printf '{"AAA.md":{"base":"%s","source":"%s"}}' "$(h orig)" "$(h edited)" > "$RS/.manifest.json"
: > "$TMP/log"; ret AAA.md --as 빌
[ ! -s "$TMP/log" ] || fail "return no-op"; ok
printf '{}' > "$RS/.manifest.json"
: > "$TMP/log"; ret AAA.md --as 빌
grep -q create_note "$TMP/log" || fail "return unknown base makes copy"; ok
if ret ../x.md --as 빌 2>/dev/null; then fail "return bad name"; fi; ok
for bad in "a/b" "../x" ".hidden" "$(printf 'a\nb')" "1234567890123456789012345"; do
  if ret AAA.md --as "$bad" 2>/dev/null; then fail "return bad member $bad"; fi; ok
done

echo "PASS: $pass steno-share-sync checks"
