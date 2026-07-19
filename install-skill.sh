#!/usr/bin/env bash
# b3os 스킬 설치 — Claude Code 개인 스킬(~/.claude/skills/b3os)로 한 줄 설치.
#   curl -fsSL https://raw.githubusercontent.com/b3rys/b3rys-team-os/main/install-skill.sh | bash
# 설치 후: Claude Code 에서 /reload-skills → "b3os 설치해줘" 라고 말하면
#   스킬이 clone → 설치 → 대시보드 기동 → 첫 팀원 영입까지 대화로 안내합니다.
set -euo pipefail
BASE="${B3OS_SKILL_BASE:-https://raw.githubusercontent.com/b3rys/b3rys-team-os/main/skills/b3os}"
DEST="$HOME/.claude/skills/b3os"
say() { printf "\033[32m%s\033[0m\n" "$1"; }
mkdir -p "$DEST/references"
for f in SKILL.md references/recruit.md references/troubleshooting.md references/runtime-setup.md references/b3os-ops-primer.md references/system-jobs.md; do
  curl -fsSL "$BASE/$f" -o "$DEST/$f"
  [ -s "$DEST/$f" ] || { echo "다운로드 실패: $f" >&2; exit 1; }
done
say "b3os 스킬 설치 완료 → $DEST"
say ""
say "다음 단계 (Claude Code 안에서):"
say "  /reload-skills        # 스킬 로드 (설치 직후 1회)"
say "  \"b3os 설치해줘\"        # 실행 — clone → 설치 → 대시보드 → 첫 팀원 영입까지 대화로 안내"
