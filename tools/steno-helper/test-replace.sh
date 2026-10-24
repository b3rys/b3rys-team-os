#!/bin/bash
# 팀원 자기 폴더 파일 바꾸기·치우기 (steno-send.sh --replace / --remove → 도우미 --upload)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SEND="$HERE/../../skills/b3os-team-inbox/scripts/steno-send.sh"
TMP="$(mktemp -d)"; TMP="$(cd "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT
BIN="${STENO_HELPER_TEST_BIN:-$TMP/steno-helper-test}"
[ -x "$BIN" ] || swiftc -D STENO_HELPER_TESTING "$HERE"/Sources/*.swift -o "$BIN"
export HOME="$TMP/home"
SUPPORT="$HOME/Library/Application Support/b3os"
OUT="$SUPPORT/steno-share-outbox"; SHARED="$SUPPORT/steno-shared"
LIB="$TMP/lib"; TEAM="$LIB/팀 공유"
mkdir -p "$OUT" "$SHARED" "$TEAM/bill/sub" "$TEAM/gd"
printf "team\n" > "$TEAM/.steno-folder"
pass=0
ok() { pass=$((pass + 1)); }
fail() { echo "FAIL: $1" >&2; exit 1; }
cycle() { "$BIN" --upload "$OUT" "$LIB" 2>>"$TMP/log" || true; }
hash() { shasum -a 256 "$1" | cut -d' ' -f1; }

# 1. 자기 폴더 파일을 바꾼다 — 사람이 고친 판이어도 바꾸고, 이전 본문은 .replaced 에 남는다
printf 'gd edited\n' > "$TEAM/bill/doc.md"
old="$(hash "$TEAM/bill/doc.md")"
printf 'v2\n' > "$TMP/new.md"
"$SEND" "$TMP/new.md" --folder bill --name doc.md --replace 2>/dev/null >/dev/null
cycle
[ "$(cat "$TEAM/bill/doc.md")" = v2 ] || fail "replace in own folder"; ok
[ "$(cat "$SHARED/.replaced/$old.data")" = "gd edited" ] || fail "previous body kept"; ok
[ -z "$(ls -A "$OUT")" ] || fail "request consumed"; ok
[ ! -e "$TEAM/bill/doc 2.md" ] || fail "no numbered copy"; ok

# 2. 하위 폴더도 된다
printf 'a\n' > "$TEAM/bill/sub/x.md"; printf 'b\n' > "$TMP/b.md"
"$SEND" "$TMP/b.md" --folder bill/sub --name x.md --replace 2>/dev/null >/dev/null
cycle
[ "$(cat "$TEAM/bill/sub/x.md")" = b ] || fail "replace in subfolder"; ok

# 3. 팀 공유 바로 아래·남의 폴더 파일은 건드리지 않는다(요청은 남고 로그에 거절)
printf 'root\n' > "$TEAM/root.md"; printf 'mine\n' > "$TEAM/gd/note.md"
"$SEND" "$TMP/b.md" --folder bill --name doc.md --replace 2>/dev/null >/dev/null  # 정상 요청 하나 섞어 둔다
python3 - "$OUT" <<'EOF'
import json, os, sys, uuid
out = sys.argv[1]
for meta in ({"file": "root.md", "member": "root.md", "remove": True},
             {"file": "gd/note.md", "member": "bill", "remove": True}):
    with open(os.path.join(out, f".replace-{uuid.uuid4()}.json"), "w") as f: json.dump(meta, f)
EOF
cycle
[ "$(cat "$TEAM/root.md")" = root ] || fail "root file untouched"; ok
[ "$(cat "$TEAM/gd/note.md")" = mine ] || fail "other folder untouched"; ok
grep -q "자기 폴더 안의 파일만" "$TMP/log" || fail "rejection logged"; ok
[ -z "$(ls -A "$OUT")" ] || fail "rejected requests dropped"; ok
[ "$(cat "$TEAM/bill/doc.md")" = b ] || fail "valid request still applied"; ok
"$SEND" --remove "root.md" 2>/dev/null && fail "sender refuses root path"; ok

# 4. 치우기 — 파일은 사라지고 본문은 .replaced 에 남는다
printf 'dup\n' > "$TEAM/bill/doc 2.md"; dup="$(hash "$TEAM/bill/doc 2.md")"
"$SEND" --remove "bill/doc 2.md" 2>/dev/null >/dev/null
cycle
[ ! -e "$TEAM/bill/doc 2.md" ] || fail "removed"; ok
[ "$(cat "$SHARED/.replaced/$dup.data")" = dup ] || fail "removed body kept"; ok

# 5. 없는 파일 바꾸기는 새로 만들지 않는다
"$SEND" "$TMP/b.md" --folder bill --name none.md --replace 2>/dev/null >/dev/null
cycle
[ ! -e "$TEAM/bill/none.md" ] || fail "missing target not created"; ok
[ -z "$(ls -A "$OUT")" ] || fail "missing target request dropped"; ok

# 6. 본문 해시가 요청과 다르면 바꾸지 않는다
"$SEND" "$TMP/new.md" --folder bill --name doc.md --replace 2>/dev/null >/dev/null
for f in "$OUT"/.replace-*.data; do printf 'tampered\n' > "$f"; done
cycle
[ "$(cat "$TEAM/bill/doc.md")" = b ] || fail "hash mismatch refused"; ok

echo "PASS test-replace ($pass)"
