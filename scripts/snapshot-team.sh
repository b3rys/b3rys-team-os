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

# ★제외 목록은 구획마다 다르다★
#   하나로 합쳐 쓰면 이름이 같은 것까지 같이 걸린다. hermes 프로필의 재생성 가능한 reports·decks 를
#   지우려던 패턴이 ★멤버 워크스페이스의 reports·decks(작업물)까지★ 걸어 백업에서 빼고 있었다.
#   백업 도구가 조용히 작업물을 버리는 형태라, 구획별로 나눈다.

# 어디서나 안전한 것 — 재생성물·임시물 (.git 제외는 여기 넣지 않는다 — 아래 EX_MEMBER 주석 참조)
EX_BASE=(--exclude='node_modules' --exclude='backups' --exclude='migration-backups-*'
    --exclude='*.pre-*' --exclude='*.bak' --exclude='*.bak-*' --exclude='*.log' --exclude='.DS_Store'
    --exclude='dist' --exclude='.cache' --exclude='scratchpad' --exclude='outbox'
    --exclude='team.db.pre-*' --exclude='*.wal' --exclude='*.sqlite-*')

EX_COMMON=("${EX_BASE[@]}" --exclude='.git')

# 트리(var) 대용량 재생성물 — 모델·검색eval·벡터인덱스
EX_TREE=("${EX_COMMON[@]}" --exclude='models' --exclude='team-search-eval' --exclude='*.lancedb')

# 멤버 워크스페이스 — ★작업물을 지우지 않는다.★
#   ★.git 도 담는다★ (GD 2026-08-03). 팀원 워크스페이스는 원격이 없을 수 있어서, .git 을 빼면
#   "파일은 복구되는데 언제 왜 바꿨는지는 사라지는" 반쪽 스냅샷이 된다. 스냅샷은 그야말로 스냅샷이다.
#   비용: 실측 4MB (등록 12명 중 git repo 는 bill·lui 둘뿐) — 405MB 묶음의 1%.
EX_MEMBER=("${EX_BASE[@]}")

# hermes 프로필 — 대화state·홈·캐시·bin·모델·세션·미디어·스킬(repo서 옴)은 재생성 가능
EX_HERMES=("${EX_COMMON[@]}" --exclude='state.db' --exclude='state.db-*' --exclude='state-snapshots'
    --exclude='audio_cache' --exclude='lsp' --exclude='home' --exclude='models' --exclude='sessions'
    --exclude='media' --exclude='tmp' --exclude='reports' --exclude='images' --exclude='decks'
    --exclude='bin' --exclude='cache' --exclude='skills')

say "■ 팀 핵심 상태 수집 ($STAMP)"
# ① 트리 gitignored (team.db 는 핵심이라 통째)
cd "$LIVE_DIR"
for p in .env agents.json team.db var slack-tokens scripts rules/STATE.md rules/SHARED.md rules/TEAM-OS.md; do
  [ -e "$p" ] && { mkdir -p "$STAGE/tree/$(dirname "$p")"; rsync -a "${EX_TREE[@]}" "$p" "$STAGE/tree/$(dirname "$p")/" 2>/dev/null || true; }
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
EXPECTED=0; COPIED=0
while IFS= read -r ws; do
  [ -n "$ws" ] && EXPECTED=$((EXPECTED+1))
  [ -n "$ws" ] && [ -d "$ws" ] || continue
  rsync -a "${EX_MEMBER[@]}" "$ws" "$STAGE/home/Development/" 2>/dev/null || true
  COPIED=$((COPIED+1))
done <<EOF
$MEMBERS
EOF
# 등록부에 있는데 디스크에 없는 것은 ★아직 안 만들어진 것★ 이지 유실이 아니다(새 설치가 그렇다).
# 담을 게 없는 상태로 중단하면 백업 도구를 처음 받는 팀이 첫날부터 못 쓴다 → 여기서는 알리기만 한다.
# ★유실 판정은 래퍼가 한다★ — 실제로 있는 디렉토리 수와 묶음 안의 수를 비교한다. 판정은 한 곳에만 둔다.
if [ "$COPIED" -lt "$EXPECTED" ]; then
  warn "  ⚠ 멤버 워크스페이스 $COPIED/$EXPECTED — 등록부에 있으나 디스크에 없는 것이 있다"
  warn "     확인: agents.json 의 workspace_path (없으면 ~/Development/<id> 로 본다)"
fi
say "  ✓ 멤버 워크스페이스 $COPIED/$EXPECTED (작업물 포함)"

# ③ 페어링 ④ hermes auth (대용량 state 제외)
[ -d "$HOME/.claude/channels" ] && rsync -a "${EX_COMMON[@]}" "$HOME/.claude/channels" "$STAGE/home/.claude/" 2>/dev/null||true
[ -d "$HOME/.hermes/profiles" ] && rsync -a "${EX_HERMES[@]}" "$HOME/.hermes/profiles" "$STAGE/home/.hermes/" 2>/dev/null||true
say "  ✓ .claude/channels + .hermes/profiles(auth만)"
# ★클로드 팀원의 장기기억★ — 코드로 다시 만들 수 없는 유일본이다. 이게 빠지면 팀원이 배운 것이 사라진다.
#   projects 전체는 대화 기록까지 있어 크다 → memory 디렉토리만 담는다.
MEM=0
for d in "$HOME"/.claude/projects/*/memory; do
  [ -d "$d" ] || continue
  t="$STAGE/home/.claude/projects/$(basename "$(dirname "$d")")"
  mkdir -p "$t"; rsync -a "${EX_COMMON[@]}" "$d" "$t/" 2>/dev/null || true
  MEM=$((MEM+1))
done
say "  ✓ 팀원 장기기억 ${MEM}개 디렉토리"
# openclaw · codex 런타임 인증 — 없으면 그 런타임 팀원이 인증을 못 한다.
#   두 홈 모두 대용량 캐시가 있으므로 ★설정·인증 파일만★ 담는다.
[ -f "$HOME/.openclaw/openclaw.json" ] && { mkdir -p "$STAGE/home/.openclaw"; cp "$HOME/.openclaw/openclaw.json" "$STAGE/home/.openclaw/"; }
# ★파일을 이름으로 집는다.★ rsync 의 --include 는 --exclude='*' 가 뒤에 없으면 아무것도 안 걸러서,
#   플러그인·세션·캐시까지 통째로 딸려온다(여기서 760MB 중 대부분이 재생성 가능한 것들이다).
#   이름을 하나씩 박으면 이름이 바뀔 때 조용히 빠진다(이 디렉토리는 이미 auth.json.<런타임>-backup-<날짜>
#   같은 이름이 늘어난 적이 있다). ★최상위 파일만★ 을 무늬로 집는다 — 하위 디렉토리는 안 따라온다.
if [ -d "$HOME/.codex" ]; then
  mkdir -p "$STAGE/home/.codex"
  for f in "$HOME"/.codex/auth* "$HOME"/.codex/*.toml "$HOME"/.codex/*.json; do
    [ -f "$f" ] && cp "$f" "$STAGE/home/.codex/"
  done
fi
say "  ✓ openclaw·codex 인증 설정"
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

# GFS 로테이션 — 최근 7개 · 주 4개 · 월 3개 (하루 한 번 돌면 '7일' 과 같다)
# ★bash 3.2 에서도 돌아야 한다★ — macOS 기본 셸이 3.2 이고, launchd 는 최소 PATH 라
#   `env bash` 가 그쪽으로 잡힌다. mapfile·declare -A(bash 4)를 쓰면 그 자리에서 깨진다.
cd "$DEST"
ALL="$(ls -1 b3os-snapshot-*.tar.gz 2>/dev/null | sort -r || true)"
KEEP=""
keep(){ case " $KEEP " in *" $1 "*) ;; *) KEEP="$KEEP $1" ;; esac; }
i=0; for f in $ALL; do [ $i -lt 7 ] && keep "$f"; i=$((i+1)); done
seen=""; n=0
for f in $ALL; do
  d="$(echo "$f" | grep -oE '[0-9]{8}' | head -1 || true)"; [ -z "$d" ] && continue
  k="w$(date -j -f '%Y%m%d' "$d" '+%G-W%V' 2>/dev/null || echo "$d")"
  case " $seen " in *" $k "*) ;; *) seen="$seen $k"; keep "$f"; n=$((n+1)); [ $n -ge 4 ] && break ;; esac
done
seen=""; n=0
for f in $ALL; do
  d="$(echo "$f" | grep -oE '[0-9]{8}' | head -1 || true)"; [ -z "$d" ] && continue
  k="m$(echo "$d" | cut -c1-6)"
  case " $seen " in *" $k "*) ;; *) seen="$seen $k"; keep "$f"; n=$((n+1)); [ $n -ge 3 ] && break ;; esac
done
for f in $ALL; do
  case " $KEEP " in *" $f "*) ;; *) rm -f "$f"; warn "  삭제(로테이션): $f" ;; esac
done
say "✓ 완료 — 보관 $(ls -1 b3os-snapshot-*.tar.gz 2>/dev/null|wc -l|tr -d ' ')개 · 총 $(du -sh "$DEST" 2>/dev/null|cut -f1)"
