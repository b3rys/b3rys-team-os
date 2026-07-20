#!/usr/bin/env bash
# b3os 스킬 설치 — Claude Code 개인 스킬(~/.claude/skills/b3os)로 한 줄 설치.
#   curl -fsSL https://raw.githubusercontent.com/b3rys/b3rys-team-os/main/install-skill.sh | bash
# 설치 후: Claude Code 에서 /reload-skills → "b3os 설치해줘" 라고 말하면
#   스킬이 clone → 설치 → 대시보드 기동 → 첫 팀원 영입까지 대화로 안내합니다.
set -euo pipefail
BASE="${B3OS_SKILL_BASE:-https://raw.githubusercontent.com/b3rys/b3rys-team-os/main/skills/b3os}"
DEST="$HOME/.claude/skills/b3os"
say() { printf "\033[32m%s\033[0m\n" "$1"; }
# ★DEST 가 이미 clone 심링크면 curl 로 덮지 않는다★ — mkdir/curl -o 가 심링크를 따라 clone 의
#   git 추적 SKILL.md 를 직접 덮어쓰기 때문(ames 반대리뷰). 심링크면 'git pull' 로 이미 자동 최신.
if [ -L "$DEST" ]; then
  # ★유효/깨짐 판정은 '링크 해석 가능여부(-e)'로 한다★ — target 안의 SKILL.md 존재로 판정하면
  #   pull 중·SKILL.md 없는 브랜치·sparse checkout 처럼 '링크는 멀쩡한데 파일만 일시부재'인 경우를
  #   깨진 링크로 오판→curl 로 덮어써 drift 가 되살아난다(ames 반대리뷰). -e 는 링크를 따라가 대상 존재를 본다.
  if [ -e "$DEST" ]; then
    say "이미 clone 심링크로 설치됨 — 갱신은 clone 에서 'git pull' 만 하면 됩니다(curl 재설치 불필요) → $DEST"
    say "  즉시 반영: Claude Code 에서 /reload-skills."
    exit 0
  fi
  echo "깨진 스킬 심링크 감지(clone 이동/삭제 추정) — 제거 후 신규 설치: $DEST" >&2
  rm -f "$DEST"
fi
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
