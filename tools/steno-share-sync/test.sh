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
chmod 000 "$SRC/DDD.md"; sync; chmod 600 "$SRC/DDD.md"
[ "$(cat "$DST/DDD.md")" = d ] || fail "unreadable keeps copy"; ok

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
    if m.get("method") == "tools/call":
        with open(os.environ["FAKE_LOG"], "a") as f: f.write(json.dumps(m["params"], ensure_ascii=False) + "\n")
        print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": {"content": [{"type": "text", "text": "ok"}]}}))
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
printf '{"AAA.md":{"base":"%s","source":"%s"}}' "$(h orig)" "$(h gdnew)" > "$RS/.manifest.json"
: > "$TMP/log"; ret AAA.md --as 빌
grep -q '"name": "create_note"' "$TMP/log" && grep -q 'AAA (빌 수정).md' "$TMP/log" && ! grep -q edit_note "$TMP/log" || fail "return conflict copy"; ok
printf '{"AAA.md":{"base":"%s","source":"%s"}}' "$(h orig)" "$(h edited)" > "$RS/.manifest.json"
: > "$TMP/log"; ret AAA.md --as 빌
[ ! -s "$TMP/log" ] || fail "return no-op"; ok
printf '{}' > "$RS/.manifest.json"
: > "$TMP/log"; ret AAA.md --as 빌
grep -q create_note "$TMP/log" || fail "return unknown base makes copy"; ok
if ret ../x.md --as 빌 2>/dev/null; then fail "return bad name"; fi; ok

echo "PASS: $pass steno-share-sync checks"
