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

up() { "$SEND" "$1" --folder "$2" --name "$3" 2>/dev/null >/dev/null; cycle; }   # 보통 올리기
rep() { "$SEND" "$1" ${2:+--folder "$2"} --name "$3" --replace 2>/dev/null >/dev/null; cycle; }

# 1. 팀원이 올린 파일을 같은 자리에서 바꾼다 — 이전 본문은 .replaced 에, 번호 사본 없음, 요청 치움
printf 'v1\n' > "$TMP/v1.md"; up "$TMP/v1.md" bill doc.md
old="$(hash "$TEAM/bill/doc.md")"
printf 'v2\n' > "$TMP/v2.md"; rep "$TMP/v2.md" bill doc.md
[ "$(cat "$TEAM/bill/doc.md")" = v2 ] || fail "replace uploaded file"; ok
[ "$(cat "$SHARED/.replaced/$old.data")" = v1 ] || fail "previous body kept"; ok
[ -z "$(ls -A "$OUT")" ] && [ ! -e "$TEAM/bill/doc 2.md" ] || fail "consumed, no numbered copy"; ok

# 2. 정책(팀장 10-24): 팀 공유 안이면 사람이 만든 노트도 바꾼다 — 이전 판은 반드시 보관
printf 'mine\n' > "$TEAM/gd/note.md"; gd_old="$(hash "$TEAM/gd/note.md")"
printf 'mine\n<!-- ✦빌 -->\n추가\n<!-- /✦빌 -->\n' > "$TMP/g.md"; B3OS_AGENT_ID=bill rep "$TMP/g.md" gd note.md
grep -q "✦빌" "$TEAM/gd/note.md" || fail "human note replaced (policy)"; ok
[ "$(cat "$SHARED/.replaced/$gd_old.data")" = mine ] || fail "human note previous body kept"; ok
printf 'root\n' > "$TEAM/root.md"; printf 'root2\n' > "$TMP/r.md"; rep "$TMP/r.md" "" root.md
[ "$(cat "$TEAM/root.md")" = root2 ] || fail "root-level file replaced"; ok
printf 'a\n' > "$TMP/a.md"; up "$TMP/a.md" bill/sub x.md; printf 'b\n' > "$TMP/b.md"; rep "$TMP/b.md" bill/sub x.md
[ "$(cat "$TEAM/bill/sub/x.md")" = b ] || fail "subfolder"; ok

# 3. 경로 탈출·점 이름·세 단계 초과는 보내는 쪽·도우미 양쪽에서 거절
"$SEND" --remove "../x.md" 2>/dev/null && fail "sender refuses dot path"; ok
python3 - "$OUT" <<'EOF2'
import json, os, sys, uuid
for meta in ({"file": "../root.md", "remove": True}, {"file": "gd/.hidden.md", "remove": True}, {"file": "a/b/c/d.md", "remove": True}):
    with open(os.path.join(sys.argv[1], f".replace-{uuid.uuid4()}.json"), "w") as f: json.dump(meta, f)
EOF2
cycle
[ -e "$TEAM/root.md" ] && grep -q "경로가 올바르지 않아 거절" "$TMP/log" && [ -z "$(ls -A "$OUT")" ] || fail "bad paths refused and dropped"; ok

# 4. 치우기 — 파일은 사라지고 본문은 .replaced 에
printf 'dup\n' > "$TMP/d.md"; up "$TMP/d.md" bill "doc 2.md"; dup="$(hash "$TEAM/bill/doc 2.md")"
"$SEND" --remove "bill/doc 2.md" 2>/dev/null >/dev/null; cycle
[ ! -e "$TEAM/bill/doc 2.md" ] && [ "$(cat "$SHARED/.replaced/$dup.data")" = dup ] || fail "remove keeps body"; ok

# 5. 미리 망가진 보관본이 있으면 진짜 본문으로 다시 쓴 뒤에만 진행 (리뷰 #612)
printf 'keep\n' > "$TMP/k.md"; up "$TMP/k.md" bill keep.md
k="$(hash "$TEAM/bill/keep.md")"; mkdir -p "$SHARED/.replaced"; printf corrupt > "$SHARED/.replaced/$k.data"
"$SEND" --remove "bill/keep.md" 2>/dev/null >/dev/null; cycle
[ "$(cat "$SHARED/.replaced/$k.data")" = keep ] && [ ! -e "$TEAM/bill/keep.md" ] || fail "corrupt backup rewritten first"; ok

# 6. 폴더를 지금 못 열면(권한) 요청을 남기고, 복구되면 적용 (리뷰 #612)
printf 'p\n' > "$TMP/p.md"; up "$TMP/p.md" bill/sub p.md
chmod 000 "$TEAM/bill/sub"; "$SEND" --remove "bill/sub/p.md" 2>/dev/null >/dev/null; cycle; chmod 755 "$TEAM/bill/sub"
[ -e "$TEAM/bill/sub/p.md" ] && ls -A "$OUT" | grep -q '^\.replace-' || fail "request kept on EACCES"; ok
cycle
[ ! -e "$TEAM/bill/sub/p.md" ] || fail "applied after access restored"; ok

# 7. 없는 파일은 새로 만들지 않고, 본문 해시가 요청과 다르면 바꾸지 않는다
rep "$TMP/b.md" bill none.md
[ ! -e "$TEAM/bill/none.md" ] && [ -z "$(ls -A "$OUT")" ] || fail "missing target not created, request dropped"; ok
"$SEND" "$TMP/b.md" --folder bill --name doc.md --replace 2>/dev/null >/dev/null
for f in "$OUT"/.replace-*.data; do printf 'tampered\n' > "$f"; done
cycle
[ "$(cat "$TEAM/bill/doc.md")" = v2 ] || fail "payload hash mismatch refused"; ok

# 8. 받은 파일도 같은 규칙 (--to-received)
RIN="$SUPPORT/steno-outbox"; RECV="$LIB/받은 파일"; mkdir -p "$RIN" "$RECV/gd"
printf 'recv1\n' > "$RECV/gd/r.md"; r_old="$(hash "$RECV/gd/r.md")"
printf 'recv2\n' > "$TMP/r2.md"; "$SEND" "$TMP/r2.md" --to-received --folder gd --name r.md --replace 2>/dev/null >/dev/null
"$BIN" --inbox "$RIN" "$RECV" 2>>"$TMP/log" || true
[ "$(cat "$RECV/gd/r.md")" = recv2 ] || fail "received file replaced"; ok
[ "$(cat "$SHARED/.replaced/$r_old.data")" = recv1 ] || fail "received previous body kept"; ok
[ -z "$(ls -A "$RIN")" ] && [ ! -e "$RECV/.replace-"* ] 2>/dev/null || fail "request consumed, not copied as file"; ok
ls "$RECV" | grep -q '^\.replace-' && fail "request json not delivered as a file"; ok
"$SEND" --to-received --remove "gd/r.md" 2>/dev/null >/dev/null; "$BIN" --inbox "$RIN" "$RECV" 2>>"$TMP/log" || true
[ ! -e "$RECV/gd/r.md" ] || fail "received file removed"; ok

echo "PASS test-replace ($pass)"
