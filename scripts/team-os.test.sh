#!/usr/bin/env bash
# team-os.test.sh — team-os 진입 동작 인수 테스트.
#
# ★왜 이 시험이 있나★ (2026-07-30, 팀장님 지적)
#   `team-os` 를 인자 없이 치면 ★곧바로 up 이 실행됐다.★ 기본값이 up 이었다.
#   처음 쓰는 사람이 이름만 쳐보는 건 가장 흔한 첫 동작인데, 그 자리에서 설명 대신
#   서비스 기동이 시작되고 20초를 기다린다. 공개 사용자에게는 그게 첫인상이다.
#
# ★이 시험은 부작용이 없어야 한다★ — 진짜 up 을 돌리면 시험이 팀을 건드린다.
#   그래서 launchctl·curl·tmux 를 stub 으로 가리고 PATH 앞에 둔다. 하나라도 불리면
#   그 사실 자체를 기록해 실패시킨다 — "안 불렸겠지" 를 짐작하지 않는다.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HERE/team-os"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

STUB="$TMP/bin"; mkdir -p "$STUB"
CALLS="$TMP/calls.log"; : > "$CALLS"
for cmd in launchctl curl tmux; do
  cat > "$STUB/$cmd" <<EOF
#!/bin/sh
echo "$cmd \$*" >> "$CALLS"
exit 0
EOF
  chmod +x "$STUB/$cmd"
done

FAILED=0
ok()   { echo "  ✓ $1"; }
bad()  { echo "  ✗ $1"; FAILED=1; }

run() { # run <인자...> → stdout+stderr, 종료코드는 RC 에
  : > "$CALLS"
  OUT="$(PATH="$STUB:$PATH" bash "$TARGET" "$@" 2>&1)"; RC=$?
}

echo "── T1: 인자 없이 치면 설명이 나오고 ★아무것도 안 건드린다★ ──"
run
[ "$RC" -eq 0 ] && ok "종료코드 0 (설명을 본 것은 잘못이 아니다)" || bad "종료코드 $RC (0이어야 한다)"
case "$OUT" in *"사용법: team-os"*) ok "설명 출력됨" ;; *) bad "설명이 안 나왔다" ;; esac
case "$OUT" in *"■ 올립니다"*) bad "★up 이 실행됐다★ — 이 시험이 존재하는 이유" ;; *) ok "up 이 실행되지 않았다" ;; esac
if [ -s "$CALLS" ]; then
  bad "★부작용 발생★ — 외부 명령이 불렸다: $(tr '\n' ';' < "$CALLS")"
else
  ok "launchctl·curl·tmux 를 하나도 부르지 않았다"
fi

echo "── T2: help · -h · --help 전부 같은 설명 ──"
for a in help -h --help; do
  run "$a"
  [ "$RC" -eq 0 ] || bad "$a: 종료코드 $RC"
  case "$OUT" in *"사용법: team-os"*) ok "$a → 설명" ;; *) bad "$a → 설명이 안 나왔다" ;; esac
  [ -s "$CALLS" ] && bad "$a: 부작용 발생"
done

echo "── T3: 모르는 명령은 실패로 끝난다 (조용히 넘어가지 않는다) ──"
run wat
[ "$RC" -eq 1 ] && ok "종료코드 1" || bad "종료코드 $RC (1이어야 한다)"
case "$OUT" in *"모르는 명령입니다: wat"*) ok "무엇이 잘못됐는지 말한다" ;; *) bad "친 명령을 안 알려준다" ;; esac
case "$OUT" in *"사용법: team-os"*) ok "설명도 같이 나온다" ;; *) bad "설명이 없다" ;; esac
[ -s "$CALLS" ] && bad "부작용 발생"

echo "── T4: 설명은 ★한 곳에서만★ 나온다 (두 벌이면 한쪽만 고쳐진다) ──"
n="$(grep -c 'usage()' "$TARGET")"
[ "$n" -eq 1 ] && ok "usage 정의 1개" || bad "usage 정의가 $n 개"
if grep -q 'echo "사용법: team-os up | team-os doctor | team-os down"' "$TARGET"; then
  bad "옛 인라인 설명이 남아 있다 — usage 와 갈라진다"
else
  ok "인라인 중복 설명 없음"
fi

echo
if [ "$FAILED" -eq 0 ]; then echo "ALL PASS — team-os 진입 동작"; else echo "FAIL — team-os 진입 동작"; fi
exit "$FAILED"
