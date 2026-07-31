#!/usr/bin/env bash
# restore-team.sh — snapshot-team.sh 로 뜬 스냅샷을 새 머신에 풀어 "우리 팀" 복원.
#   전제: 이 repo(공개 코드)는 이미 clone/build 돼 있다. 스냅샷은 코드엔 없는 ★팀 고유 상태★만 복원한다.
#   ①트리 gitignored(.env·agents.json·team.db·var·slack-tokens·rules상태) ②멤버 워크스페이스 ③~/.claude/channels ④~/.hermes/profiles auth ⑤launchd plist.
#   ★안전★: 기존 파일은 덮기 전 .pre-restore-<STAMP> 로 백업. --dry-run 으로 미리 확인.
# 사용: bash scripts/restore-team.sh <snapshot.tar.gz> [--dry-run]
#   env override: B3OS_LIVE_DIR(복원 대상 repo, 기본 이 스크립트 repo)
set -euo pipefail

TARBALL="${1:-}"; DRY=0; [ "${2:-}" = "--dry-run" ] && DRY=1
[ "${1:-}" = "--dry-run" ] && { DRY=1; TARBALL="${2:-}"; }
LIVE_DIR="${B3OS_LIVE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
STAMP="$(date '+%Y%m%d-%H%M%S')"
say(){ printf "\033[32m%s\033[0m\n" "$1"; }
warn(){ printf "\033[33m%s\033[0m\n" "$1"; }
die(){ printf "\033[31m✗ %s\033[0m\n" "$1"; exit 1; }

[ -n "$TARBALL" ] && [ -f "$TARBALL" ] || die "사용: bash scripts/restore-team.sh <snapshot.tar.gz> [--dry-run]"
gzip -t "$TARBALL" 2>/dev/null || die "손상된 tarball: $TARBALL"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
tar -xzf "$TARBALL" -C "$WORK"
SNAP="$(find "$WORK" -maxdepth 1 -type d -name 'b3os-snapshot-*' | head -1)"
[ -n "$SNAP" ] || die "스냅샷 구조 아님(b3os-snapshot-* 없음)"
say "■ 복원 소스: $(basename "$TARBALL")  → 대상 repo: $LIVE_DIR"
[ -f "$SNAP/MANIFEST.txt" ] && sed 's/^/    /' "$SNAP/MANIFEST.txt"
[ "$DRY" = 1 ] && warn "■ DRY-RUN — 실제로 쓰지 않음. 아래는 복원 예정 항목:"

# 덮기 전 백업 후 복사 (dry-run 이면 계획만 출력)
place(){ # $1=src(스냅샷 내) $2=dst(실제)
  [ -e "$1" ] || return 0
  if [ "$DRY" = 1 ]; then echo "    복원: $2 $([ -e "$2" ] && echo '(기존→.pre-restore-'"$STAMP"' 백업)')"; return 0; fi
  mkdir -p "$(dirname "$2")"
  [ -e "$2" ] && mv "$2" "$2.pre-restore-$STAMP"
  cp -R "$1" "$2"
}

# ① 트리 gitignored (repo 안으로)
if [ -d "$SNAP/tree" ]; then
  for p in .env agents.json team.db var slack-tokens; do place "$SNAP/tree/$p" "$LIVE_DIR/$p"; done
  for r in STATE.md SHARED.md TEAM-OS.md; do place "$SNAP/tree/rules/$r" "$LIVE_DIR/rules/$r"; done
  say "  ✓ 트리 gitignored"
fi
# ② 멤버 워크스페이스
if [ -d "$SNAP/home/Development" ]; then
  for d in "$SNAP/home/Development/"*/; do [ -d "$d" ] && place "$d" "$HOME/Development/$(basename "$d")"; done
  say "  ✓ 멤버 워크스페이스"
fi
# ③ 페어링 ④ hermes auth
place "$SNAP/home/.claude/channels" "$HOME/.claude/channels"
place "$SNAP/home/.hermes/profiles" "$HOME/.hermes/profiles"
say "  ✓ .claude/channels + .hermes/profiles"
# ⑤ launchd plist (라벨의 user 부분은 새 머신 user 로 치환 필요 — 경고만)
if [ -d "$SNAP/launchd" ] && [ "$DRY" = 0 ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  for pl in "$SNAP/launchd/"*.plist; do [ -e "$pl" ] && cp "$pl" "$HOME/Library/LaunchAgents/"; done
  warn "  ⚠ launchd plist 복사됨 — 라벨/경로의 user·홈이 새 머신과 다르면 수정 후 load 필요"
fi

[ "$DRY" = 1 ] && { say "■ DRY-RUN 종료"; exit 0; }
say "✓ 복원 완료. 다음: (1) launchd plist 경로/user 점검 → launchctl load  (2) bun run build  (3) /team 200 확인"
