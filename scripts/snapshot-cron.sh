#!/opt/homebrew/bin/bash
# snapshot-cron.sh — snapshot-team.sh 를 예약 실행용으로 감싼다.
#   ① 로컬을 정본으로 뜬다  ② 되읽어 검증한다  ③ iCloud 로는 best-effort 복사하고 성패를 남긴다.
#
# 왜 로컬이 정본인가: 예약 실행에서 iCloud 쓰기가 실패하는 것이 실측됐다("Operation not permitted").
#   목적지를 iCloud 하나로 두면 그 실패가 조용히 지나간다. 백업이 안 된 것을 모르는 상태가 제일 나쁘다.
# 왜 bash 경로를 박는가: snapshot-team.sh 는 mapfile·declare -A 를 쓴다(bash 4+).
#   launchd 는 최소 PATH 라 `env bash` 가 /bin/bash 3.2 로 잡히고, 그러면 로테이션이 깨진다.
set -euo pipefail

# launchd 는 최소 PATH(/usr/bin:/bin:/usr/sbin:/sbin)로 돈다. snapshot-team.sh 는 멤버 워크스페이스 목록을
# node 로 읽고 실패를 삼킨다 — PATH 에 node 가 없으면 ★목록이 비고 워크스페이스가 통째로 빠진 채 성공한다.★
export PATH="/opt/homebrew/bin:$PATH"

HERE="$(cd "$(dirname "$0")" && pwd)"
LOCAL="${B3OS_SNAPSHOT_LOCAL:-$HOME/.b3os-backups}"
CLOUD="${B3OS_SNAPSHOT_CLOUD:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/Documents/b3os-live}"
LOG="${B3OS_SNAPSHOT_LOG:-$LOCAL/snapshot.log}"
mkdir -p "$LOCAL"
log(){ printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" | tee -a "$LOG"; }

log "=== 시작 ==="

# ① 로컬 정본
# ★`bash` 라고 쓰면 안 된다★ — launchd 의 최소 PATH 에서는 /bin/bash 3.2 로 잡힌다.
# 지금 이 스크립트를 돌리는 그 인터프리터($BASH)를 그대로 넘긴다.
B3OS_SNAPSHOT_DEST="$LOCAL" "$BASH" "$HERE/snapshot-team.sh" >>"$LOG" 2>&1 \
  || { log "✗ 스냅샷 실패 — 여기서 멈춘다"; exit 1; }

NEW="$(ls -1t "$LOCAL"/b3os-snapshot-*.tar.gz 2>/dev/null | head -1)"
[ -n "$NEW" ] || { log "✗ 산출물을 찾지 못했다"; exit 1; }
log "떴다: $(basename "$NEW") ($(du -h "$NEW" | cut -f1))"

# ② 되읽어 검증 — 뜨고 끝내면 깨진 파일도 성공으로 보인다.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
DB="$(tar -tzf "$NEW" | grep -m1 'tree/team\.db$' || true)"
[ -n "$DB" ] || { log "✗ 검증 실패 — 묶음 안에 team.db 가 없다"; exit 1; }
tar -xzf "$NEW" -C "$TMP" "$DB"
INTEG="$(sqlite3 "$TMP/$DB" 'PRAGMA integrity_check;' 2>&1 | head -1)"
[ "$INTEG" = "ok" ] || { log "✗ 검증 실패 — integrity_check=$INTEG"; exit 1; }
# team.db 만 보면 부족하다. 도구가 PATH 에 없어 한 구획이 통째로 빠져도 그건 멀쩡하다.
for part in tree/team.db tree/agents.json home/.claude/channels; do
  n="$(tar -tzf "$NEW" | grep -c "/$part" || true)"
  [ "$n" -gt 0 ] || { log "✗ 검증 실패 — 묶음에 $part 가 0건이다"; exit 1; }
done

# 멤버 워크스페이스는 "있나" 로 세면 안 된다 — 빈 디렉토리도 1건으로 잡혀 통과한다.
# ★몇 명 것이 들어갔나★ 를 세서 등록부의 기대값과 맞춘다.
LIVE_DIR="$(cd "$HERE/.." && pwd)"
EXPECT="$(python3 -c 'import json,os,sys
a=json.load(open(sys.argv[1]))
print(sum(1 for x in a if os.path.isdir(x.get("workspace_path") or os.path.expanduser("~/Development/"+x["id"]))))' "$LIVE_DIR/agents.json" 2>/dev/null || echo 0)"
GOT="$(tar -tzf "$NEW" | grep -oE 'home/Development/[^/]+/' | sort -u | wc -l | tr -d ' ')"
[ "$EXPECT" -gt 0 ] || { log "✗ 검증 실패 — 기대 워크스페이스 수를 못 구했다(agents.json 확인)"; exit 1; }
[ "$GOT" -ge "$EXPECT" ] || { log "✗ 검증 실패 — 워크스페이스 $GOT/$EXPECT 만 들어갔다"; exit 1; }
log "검증 ok — agent=$(sqlite3 "$TMP/$DB" 'SELECT COUNT(*) FROM agent;') message=$(sqlite3 "$TMP/$DB" 'SELECT COUNT(*) FROM message;') 워크스페이스=$(tar -tzf "$NEW" | grep -c '/home/Development' || true)건"

# ③ iCloud 는 best-effort. 실패해도 로컬 정본은 이미 있다 — 다만 조용히 지나가지 않게 남긴다.
#    목적지 폴더 목록 조회는 응답이 없을 수 있어 하지 않는다. 파일 하나만 직접 쓴다.
if mkdir -p "$CLOUD" 2>/dev/null && cp "$NEW" "$CLOUD/$(basename "$NEW")" 2>>"$LOG"; then
  log "기기밖=ok ($(basename "$NEW"))"
else
  log "기기밖=실패 — 로컬에는 있다. iCloud 쓰기를 확인하라"
fi

log "=== 끝 ==="
