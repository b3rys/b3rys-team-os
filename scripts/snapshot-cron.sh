#!/usr/bin/env bash
# snapshot-cron.sh — snapshot-team.sh 를 예약 실행용으로 감싼다.
#   ① 로컬을 정본으로 뜬다  ② 되읽어 검증한다  ③ iCloud 로는 best-effort 복사하고 성패를 남긴다.
#
# 왜 로컬이 정본인가: 예약 실행에서 iCloud 쓰기가 실패하는 것이 실측됐다("Operation not permitted").
#   목적지를 iCloud 하나로 두면 그 실패가 조용히 지나간다. 백업이 안 된 것을 모르는 상태가 제일 나쁘다.
#   둘 다 bash 3.2 에서 돈다 — launchd 의 최소 PATH 에서 `env bash` 가 /bin/bash 로 잡히기 때문이다.
set -euo pipefail

# launchd 는 최소 PATH(/usr/bin:/bin:/usr/sbin:/sbin)로 돈다. 쓰는 도구(python3·sqlite3·tar·rsync)는
# 전부 /usr/bin 에 있지만, 홈브루로 덮어 쓴 기계도 있으므로 있으면 앞에 둔다(없으면 무해).
for d in /opt/homebrew/bin /usr/local/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
export PATH

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

# ls 는 무늬에 맞는 것이 없으면 실패한다. 파이프의 종료코드는 마지막 명령(head)이라 0 인데,
# ★pipefail★ 이 그 실패를 밖으로 내보내고 set -e 가 대입문에서 끝낸다(8행에 pipefail 이 있다).
# 그러면 ★바로 아래 안내가 실행되지 않는다.★ 안내를 살리려면 이 줄이 실패하지 않아야 한다.
NEW="$(ls -1t "$LOCAL"/b3os-snapshot-*.tar.gz 2>/dev/null | head -1 || true)"
[ -n "$NEW" ] || { log "✗ 산출물을 찾지 못했다"; exit 1; }
log "떴다: $(basename "$NEW") ($(du -h "$NEW" | cut -f1))"

# ② 되읽어 검증 — 뜨고 끝내면 깨진 파일도 성공으로 보인다.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
DB="$(tar -tzf "$NEW" | grep -m1 'tree/team\.db$' || true)"
[ -n "$DB" ] || { log "✗ 검증 실패 — 묶음 안에 team.db 가 없다"; exit 1; }
tar -xzf "$NEW" -C "$TMP" "$DB"
# 손상된 db 면 sqlite3 가 실패한다(rc 26). pipefail 이 그 실패를 파이프 밖으로 내보내고
# set -e 가 대입문에서 끝낸다 — ★손상을 알리라고 둔 검사가, 손상됐을 때만 침묵한다.★
INTEG="$(sqlite3 "$TMP/$DB" 'PRAGMA integrity_check;' 2>&1 | head -1 || true)"
[ "$INTEG" = "ok" ] || { log "✗ 검증 실패 — integrity_check=$INTEG"; exit 1; }
# team.db 만 보면 부족하다. 도구가 PATH 에 없어 한 구획이 통째로 빠져도 그건 멀쩡하다.
# 그리고 수집 쪽 rsync 는 실패를 삼키므로(|| true) ★이 목록이 유일한 방어다.★
#   .env — 없으면 복원해도 서버가 안 뜬다(토큰·바인드·신뢰 주소가 여기 있다)
#   rules/SHARED.md — 추적도 이력도 없는 단일 사본
#   .claude/projects — 팀원 장기기억. 코드로 다시 만들 수 없다
#   .codex — 인증. 이름이 바뀌어도 줄어든 것을 알아채게 ★건수 하한★ 으로 본다
for part in tree/team.db tree/agents.json tree/.env tree/rules/SHARED.md \
            home/.claude/channels home/.claude/projects; do
  n="$(tar -tzf "$NEW" | grep -c "/$part" || true)"
  [ "$n" -gt 0 ] || { log "✗ 검증 실패 — 묶음에 $part 가 0건이다"; exit 1; }
done
# 인증 파일은 "있나" 가 아니라 "몇 개인가" 로 본다. 최소 auth 와 설정 두 개는 있어야 한다.
if [ -d "$HOME/.codex" ]; then
  n="$(tar -tzf "$NEW" | grep -c 'home/\.codex/[^/]\+$' || true)"
  [ "$n" -ge 2 ] || { log "✗ 검증 실패 — .codex 인증 파일이 ${n}개다(2개 미만). 이름 규칙이 바뀌었는지 보라"; exit 1; }
fi

# 멤버 워크스페이스는 "있나" 로 세면 안 된다 — 빈 디렉토리도 1건으로 잡혀 통과한다.
# ★몇 명 것이 들어갔나★ 를 세서 등록부의 기대값과 맞춘다.
LIVE_DIR="${B3OS_LIVE_DIR:-$(cd "$HERE/.." && pwd)}"
EXPECT="$(python3 -c 'import json,os,sys
a=json.load(open(sys.argv[1]))
print(sum(1 for x in a if os.path.isdir(x.get("workspace_path") or os.path.expanduser("~/Development/"+x["id"]))))' "$LIVE_DIR/agents.json" 2>/dev/null || echo 0)"
# ★|| true 를 떼지 마라★ — grep 이 0건이면 pipefail 로 파이프가 실패하고, set -e 가 ★이 대입문에서★
# 스크립트를 끝낸다. 아래 판정은 실행되지 않고 아무 표시도 남지 않는다(워크스페이스 0인 새 설치가 그 경우다).
GOT="$(tar -tzf "$NEW" | grep -oE 'home/Development/[^/]+/' | sort -u | wc -l | tr -d ' ' || true)"
GOT="${GOT:-0}"
# ★기대 0 은 실패가 아니다★ — 워크스페이스가 아직 없는 새 설치본이다. snapshot-team.sh 도 같은 판정으로 넘어간다.
#   두 곳이 반대로 말하면, 백업 도구를 처음 받는 팀이 첫날부터 빨간 로그를 본다.
if [ "$EXPECT" -eq 0 ]; then
  log "워크스페이스 기대 0 — 아직 만들어진 것이 없다(새 설치). 이 검사는 건너뛴다"
else
  [ "$GOT" -ge "$EXPECT" ] || { log "✗ 검증 실패 — 워크스페이스 $GOT/$EXPECT 만 들어갔다"; exit 1; }
fi
log "검증 ok — agent=$(sqlite3 "$TMP/$DB" 'SELECT COUNT(*) FROM agent;') message=$(sqlite3 "$TMP/$DB" 'SELECT COUNT(*) FROM message;') 워크스페이스=$(tar -tzf "$NEW" | grep -c '/home/Development' || true)건"

# ③ iCloud 는 best-effort. 실패해도 로컬 정본은 이미 있다 — 다만 조용히 지나가지 않게 남긴다.
#    목적지 폴더 목록 조회는 응답이 없을 수 있어 하지 않는다. 파일 하나만 직접 쓴다.
if mkdir -p "$CLOUD" 2>/dev/null && cp "$NEW" "$CLOUD/$(basename "$NEW")" 2>>"$LOG"; then
  log "기기밖=ok ($(basename "$NEW"))"
else
  log "기기밖=실패 — 로컬에는 있다. iCloud 쓰기를 확인하라"
fi

log "=== 끝 ==="
