#!/usr/bin/env bash
# rules-drift-check.sh — 팀 규칙 정본이 공개 템플릿과 벌어졌는지 본다.
#
# 왜 필요한가: 정본 `rules/TEAM-OS.md` 는 추적 대상이 아니다(.gitignore).
#   공개본으로는 `rules/TEAM-OS.template.md` 만 간다. 그래서 규칙을 고쳐도
#   ★다른 기계는 pull 해도 모른다.★ 알려주는 것도 없어서, 벌어진 채로 계속 돈다.
#   이 검사는 그 침묵을 없앤다 — 고치지는 않는다. 무엇이 다른지 보여주고 사람이 정한다.
#
# 종료코드: 0 같음 · 1 다름(사람 판단 필요) · 2 파일 없음
set -euo pipefail

ROOT="${B3OS_LIVE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
LIVE="$ROOT/rules/TEAM-OS.md"
TMPL="$ROOT/rules/TEAM-OS.template.md"
say(){ printf "\033[32m%s\033[0m\n" "$1"; }
warn(){ printf "\033[33m%s\033[0m\n" "$1"; }

for f in "$LIVE" "$TMPL"; do
  [ -f "$f" ] || { warn "⚠ 없음: $f"; exit 2; }
done

# diff 는 같으면 0, 다르면 1 로 끝난다. set -e 아래에서 그대로 쓰면 여기서 스크립트가 죽어
# 아래 안내가 실행되지 않는다 — 다를 때만 죽으므로 ★필요한 순간에만 침묵하게 된다.★
D="$(diff -u "$TMPL" "$LIVE" || true)"

if [ -z "$D" ]; then
  say "✓ 규칙 정본 = 공개 템플릿 (차이 없음)"
  exit 0
fi

# 규칙은 `- ` 로 시작하는 목록이라 diff 에서 `-- `·`+- ` 가 된다. 두 번째 글자로 거르면 0 이 나온다.
N="$(printf '%s\n' "$D" | grep -cE '^[+-]' || true)"
N=$(( N - 2 ))   # +++ / --- 머리 두 줄 제외
warn "⚠ 규칙 정본이 공개 템플릿과 다르다 — ${N}줄"
printf '%s\n' "$D" | sed -n '3,40p'
warn "  정본: $LIVE  (추적 안 됨 — pull 로 갱신되지 않는다)"
warn "  템플릿: $TMPL  (공개본과 함께 온다)"
warn "  팀 사정에 맞춘 차이면 그대로 두고, 공개본의 새 규칙이면 그 줄만 정본에 옮겨라."
exit 1
