#!/usr/bin/env bash
# snapshot-team.sh — "우리 팀"을 다른 머신서 그대로 돌리기 위한 ★핵심 상태★ 스냅샷.
#   공개 repo(코드)엔 없는 팀 고유 상태만 묶는다: ①트리 gitignored(.env·agents.json·team.db·var·slack-tokens·rules상태)
#   ②멤버 워크스페이스 persona/MEMORY ③~/.claude/channels(페어링) ④~/.hermes/profiles 의 auth(대용량 state/캐시 제외) ⑤launchd.
#   ★재생성 가능한 대용량(hermes state.db·snapshots·audio_cache·backups·node_modules)은 제외★ → 스냅샷 슬림.
#   → gzip tarball → iCloud Documents/b3os-live/ (암호화 없음) + GFS 로테이션(7일/4주/3개월).
# 사용: bash scripts/snapshot-team.sh   (env: B3OS_LIVE_DIR · B3OS_SNAPSHOT_DEST)
set -euo pipefail

LIVE_DIR="${B3OS_LIVE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
DEST="${B3OS_SNAPSHOT_DEST:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/Documents/b3os-live}"
STAMP="$(date '+%Y%m%d-%H%M%S')"
STAGE="$(mktemp -d)/b3os-snapshot-$STAMP"
say(){ printf "\033[32m%s\033[0m\n" "$1"; }
warn(){ printf "\033[33m%s\033[0m\n" "$1"; }
mkdir -p "$DEST" "$STAGE"/{tree,home/Development,home/.claude,home/.hermes,launchd}

# ★재생성 가능 대용량 제외 목록★
EX=(--exclude='.git' --exclude='node_modules' --exclude='backups' --exclude='migration-backups-*'
    --exclude='*.pre-*' --exclude='*.bak' --exclude='*.bak-*' --exclude='*.log' --exclude='.DS_Store'
    --exclude='state.db' --exclude='state.db-*' --exclude='state-snapshots' --exclude='audio_cache'
    --exclude='lsp' --exclude='.cache' --exclude='dist' --exclude='decks' --exclude='team.db.pre-*'
    # hermes 프로필의 대용량 런타임(재생성 가능): 대화state·홈·캐시·bin·모델·세션·미디어·스킬(repo서 옴)
    --exclude='home' --exclude='models' --exclude='sessions' --exclude='media' --exclude='tmp'
    --exclude='*.wal' --exclude='*.sqlite-*' --exclude='reports' --exclude='images'
    --exclude='bin' --exclude='cache' --exclude='skills'
    # var 대용량 재생성물(모델·검색eval·벡터인덱스) + 멤버 전송/임시(재생성)
    --exclude='models' --exclude='team-search-eval' --exclude='*.lancedb'
    --exclude='scratchpad' --exclude='outbox')

say "■ 팀 핵심 상태 수집 ($STAMP)"
# ① 트리 gitignored (team.db 는 핵심이라 통째)
cd "$LIVE_DIR"
for p in .env agents.json team.db var slack-tokens scripts rules/STATE.md rules/SHARED.md rules/TEAM-OS.md; do
  [ -e "$p" ] && { mkdir -p "$STAGE/tree/$(dirname "$p")"; rsync -a "${EX[@]}" "$p" "$STAGE/tree/$(dirname "$p")/" 2>/dev/null || true; }
done
say "  ✓ 트리 (team.db $(du -h team.db 2>/dev/null|cut -f1))"

# ② 멤버 워크스페이스 (persona·MEMORY, 대용량 제외)
# ★python3 로 읽는다★ — 예전에는 node 였는데 launchd 의 최소 PATH 에는 node 가 없다.
#   그때 실패를 삼키고 있어서 ★워크스페이스가 통째로 빠진 채 스냅샷이 성공으로 끝났다.★
#   python3 는 macOS 에 기본으로 있다. 그리고 실패하면 여기서 멈춘다 — 조용히 넘기지 않는다.
MEMBERS="$(python3 -c 'import json,os,sys
a=json.load(open(sys.argv[1]))
print("\n".join(x.get("workspace_path") or os.path.join(os.path.expanduser("~/Development"), x["id"]) for x in a))' "$LIVE_DIR/agents.json")" \
  || { printf '\033[31m✗ agents.json 에서 멤버 워크스페이스를 읽지 못했다 — 스냅샷을 중단한다\033[0m\n' >&2; exit 1; }
COPIED=0
while IFS= read -r ws; do
  [ -n "$ws" ] && [ -d "$ws" ] || continue
  rsync -a "${EX[@]}" "$ws" "$STAGE/home/Development/" 2>/dev/null || true
  COPIED=$((COPIED+1))
done <<EOF
$MEMBERS
EOF
[ "$COPIED" -gt 0 ] || { printf '\033[31m✗ 멤버 워크스페이스가 0건이다 — 백업이 반쪽이므로 중단한다\033[0m\n' >&2; exit 1; }
say "  ✓ 멤버 워크스페이스 $COPIED개 (대용량 제외)"

# ③ 페어링 ④ hermes auth (대용량 state 제외)
[ -d "$HOME/.claude/channels" ] && rsync -a "${EX[@]}" "$HOME/.claude/channels" "$STAGE/home/.claude/" 2>/dev/null||true
[ -d "$HOME/.hermes/profiles" ] && rsync -a "${EX[@]}" "$HOME/.hermes/profiles" "$STAGE/home/.hermes/" 2>/dev/null||true
say "  ✓ .claude/channels + .hermes/profiles(auth만)"
# ⑤ launchd
cp "$HOME/Library/LaunchAgents/com.$(id -un)."*.plist "$STAGE/launchd/" 2>/dev/null||true
say "  ✓ launchd ($(ls "$STAGE/launchd/" 2>/dev/null|wc -l|tr -d ' ')개)"

{ echo "b3os team snapshot $STAMP"; echo "source: $LIVE_DIR (public $(git -C "$LIVE_DIR" rev-parse --short HEAD 2>/dev/null))";
  echo "restore: scripts/restore-team.sh <tarball>"; echo "제외: hermes state/캐시·backups·node_modules(재생성 가능)"; } > "$STAGE/MANIFEST.txt"

OUT="$DEST/b3os-snapshot-$STAMP.tar.gz"
say "■ 압축 → $(basename "$OUT")"
tar -czf "$OUT" -C "$(dirname "$STAGE")" "b3os-snapshot-$STAMP"
rm -rf "$(dirname "$STAGE")"
say "  ✓ $(du -h "$OUT"|cut -f1)"

# GFS 로테이션 (7일/4주/3개월)
# ★bash 3.2 에서도 돌아야 한다★ — macOS 기본 셸이 3.2 이고, launchd 는 최소 PATH 라
#   `env bash` 가 그쪽으로 잡힌다. mapfile·declare -A(bash 4)를 쓰면 그 자리에서 깨진다.
cd "$DEST"
ALL="$(ls -1 b3os-snapshot-*.tar.gz 2>/dev/null | sort -r || true)"
KEEP=""
keep(){ case " $KEEP " in *" $1 "*) ;; *) KEEP="$KEEP $1" ;; esac; }
i=0; for f in $ALL; do [ $i -lt 7 ] && keep "$f"; i=$((i+1)); done
seen=""; n=0
for f in $ALL; do
  d="$(echo "$f" | grep -oE '[0-9]{8}' | head -1)"; [ -z "$d" ] && continue
  k="w$(date -j -f '%Y%m%d' "$d" '+%Y-W%V' 2>/dev/null || echo "$d")"
  case " $seen " in *" $k "*) ;; *) seen="$seen $k"; keep "$f"; n=$((n+1)); [ $n -ge 4 ] && break ;; esac
done
seen=""; n=0
for f in $ALL; do
  d="$(echo "$f" | grep -oE '[0-9]{8}' | head -1)"; [ -z "$d" ] && continue
  k="m$(echo "$d" | cut -c1-6)"
  case " $seen " in *" $k "*) ;; *) seen="$seen $k"; keep "$f"; n=$((n+1)); [ $n -ge 3 ] && break ;; esac
done
for f in $ALL; do
  case " $KEEP " in *" $f "*) ;; *) rm -f "$f"; warn "  삭제(로테이션): $f" ;; esac
done
say "✓ 완료 — 보관 $(ls -1 b3os-snapshot-*.tar.gz 2>/dev/null|wc -l|tr -d ' ')개 · 총 $(du -sh "$DEST" 2>/dev/null|cut -f1)"
