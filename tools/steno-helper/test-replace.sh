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

up() { "$SEND" "$1" --folder "$2" --name "$3" 2>/dev/null >/dev/null; cycle; }  # 보통 올리기(도우미가 목록에 적는다)

# 1. 도우미가 올린 자기 폴더 파일을 바꾼다 — 사람이 고친 판이어도 바꾸고, 이전 본문은 .replaced 에 남는다
printf 'v1\n' > "$TMP/v1.md"; up "$TMP/v1.md" bill doc.md
grep -q '"bill/doc.md"' "$TEAM/.b3os-sent.json" || fail "upload recorded"; ok
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
printf 'a\n' > "$TMP/a.md"; up "$TMP/a.md" bill/sub x.md
printf 'b\n' > "$TMP/b.md"
"$SEND" "$TMP/b.md" --folder bill/sub --name x.md --replace 2>/dev/null >/dev/null
cycle
[ "$(cat "$TEAM/bill/sub/x.md")" = b ] || fail "replace in subfolder"; ok

# 3. 도우미가 올리지 않은 파일(사람이 만든 노트)은 경로·member 를 맞춰도 안 바뀐다 (리뷰 #612 P1 재현)
printf 'root\n' > "$TEAM/root.md"; printf 'mine\n' > "$TEAM/gd/note.md"; printf 'hand\n' > "$TEAM/bill/hand.md"
"$SEND" "$TMP/b.md" --folder gd --name note.md --replace 2>/dev/null >/dev/null
python3 - "$OUT" <<'EOF2'
import json, os, sys, uuid
out = sys.argv[1]
for meta in ({"file": "root.md", "member": "root.md", "remove": True},
             {"file": "gd/note.md", "member": "gd", "remove": True},
             {"file": "gd/note.md", "member": "bill", "remove": True},
             {"file": "bill/hand.md", "member": "bill", "remove": True}):
    with open(os.path.join(out, f".replace-{uuid.uuid4()}.json"), "w") as f: json.dump(meta, f)
EOF2
"$SEND" "$TMP/new.md" --folder bill --name doc.md --replace 2>/dev/null >/dev/null  # 정상 요청 하나 섞어 둔다
cycle
[ "$(cat "$TEAM/root.md")" = root ] || fail "root file untouched"; ok
[ "$(cat "$TEAM/gd/note.md")" = mine ] || fail "human note in other folder untouched"; ok
[ "$(cat "$TEAM/bill/hand.md")" = hand ] || fail "human note in own folder untouched"; ok
grep -q "도우미가 올린 파일이 아니라" "$TMP/log" || fail "not-uploaded rejection logged"; ok
[ -z "$(ls -A "$OUT")" ] || fail "rejected requests dropped"; ok
[ "$(cat "$TEAM/bill/doc.md")" = v2 ] || fail "valid request still applied"; ok
"$SEND" --remove "../x.md" 2>/dev/null && fail "sender refuses dot path"; ok
printf '{}' > "$OUT/.b3os-sent.json" 2>/dev/null; cycle   # outbox 쪽 가짜 목록은 쓰이지 않는다
rm -f "$OUT/.b3os-sent.json"

# 3b. 정책: 팀원끼리는 구분하지 않는다 — 다른 팀원이 올린 파일도 바뀐다(같은 사용자라 요청자 증명 불가)
printf 'codex\n' > "$TMP/c.md"; up "$TMP/c.md" codex note.md
B3OS_AGENT_ID=bill "$SEND" "$TMP/b.md" --folder codex --name note.md --replace 2>/dev/null >/dev/null
cycle
[ "$(cat "$TEAM/codex/note.md")" = b ] || fail "uploaded file replaceable by any teammate (policy)"; ok

# 3c. 올린 목록을 지금 못 읽으면 요청을 남기고, 새 업로드도 목록을 덮지 않는다 (리뷰 #612 P2-2)
chmod 000 "$TEAM/.b3os-sent.json"
"$SEND" --remove "codex/note.md" 2>/dev/null >/dev/null
printf 'n\n' > "$TMP/n.md"; "$SEND" "$TMP/n.md" --folder bill --name newone.md 2>/dev/null >/dev/null
cycle
chmod 600 "$TEAM/.b3os-sent.json"
[ -e "$TEAM/codex/note.md" ] || fail "kept while ledger unreadable"; ok
ls -A "$OUT" | grep -q '^\.replace-' || fail "request kept while ledger unreadable"; ok
grep -q '"bill/doc.md"' "$TEAM/.b3os-sent.json" || fail "ledger not overwritten by upload"; ok
cycle
[ ! -e "$TEAM/codex/note.md" ] || fail "applied after ledger readable"; ok

# 4. 치우기 — 파일은 사라지고 본문은 .replaced 에 남고, 목록에서도 빠진다
printf 'dup\n' > "$TMP/dup.md"; up "$TMP/dup.md" bill "doc 2.md"
dup="$(hash "$TEAM/bill/doc 2.md")"
"$SEND" --remove "bill/doc 2.md" 2>/dev/null >/dev/null
cycle
[ ! -e "$TEAM/bill/doc 2.md" ] || fail "removed"; ok
[ "$(cat "$SHARED/.replaced/$dup.data")" = dup ] || fail "removed body kept"; ok
grep -q '"bill/doc 2.md"' "$TEAM/.b3os-sent.json" && fail "ledger entry removed"; ok

# 5. 미리 망가진 백업 파일이 있어도 진짜 본문으로 다시 쓴 뒤에만 치운다 (리뷰 #612 P1-2)
printf 'keep\n' > "$TMP/keep.md"; up "$TMP/keep.md" bill keep.md
k="$(hash "$TEAM/bill/keep.md")"; mkdir -p "$SHARED/.replaced"; printf corrupt > "$SHARED/.replaced/$k.data"
"$SEND" --remove "bill/keep.md" 2>/dev/null >/dev/null
cycle
[ "$(cat "$SHARED/.replaced/$k.data")" = keep ] || fail "corrupt backup rewritten"; ok
[ ! -e "$TEAM/bill/keep.md" ] || fail "removed after verified backup"; ok

# 6. 폴더를 지금 못 열면(권한) 요청을 남긴다 (리뷰 #612 P2)
printf 'p\n' > "$TMP/p.md"; up "$TMP/p.md" bill/sub p.md
chmod 000 "$TEAM/bill/sub"
"$SEND" --remove "bill/sub/p.md" 2>/dev/null >/dev/null
cycle
chmod 755 "$TEAM/bill/sub"
[ -n "$(ls -A "$OUT")" ] || fail "request kept on EACCES"; ok
cycle
[ ! -e "$TEAM/bill/sub/p.md" ] || fail "applied after access restored"; ok

# 7. 없는 파일 바꾸기는 새로 만들지 않는다
"$SEND" "$TMP/b.md" --folder bill --name none.md --replace 2>/dev/null >/dev/null
cycle
[ ! -e "$TEAM/bill/none.md" ] || fail "missing target not created"; ok
[ -z "$(ls -A "$OUT")" ] || fail "missing target request dropped"; ok

# 8. 본문 해시가 요청과 다르면 바꾸지 않는다
"$SEND" "$TMP/b.md" --folder bill --name doc.md --replace 2>/dev/null >/dev/null
for f in "$OUT"/.replace-*.data; do printf 'tampered\n' > "$f"; done
cycle
[ "$(cat "$TEAM/bill/doc.md")" = v2 ] || fail "hash mismatch refused"; ok

echo "PASS test-replace ($pass)"
