#!/usr/bin/env bash
# team-os 의 두 가드(root 거부 · off 명단 존중)를 검증한다. ★서버 미기동·라이브 무접촉★
set -uo pipefail
SRC="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../bin/team-os}"
FAIL=0
ok(){ echo "  ✓ $1"; }; bad(){ echo "  ✗ $1"; FAIL=1; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

echo "── T1: root 거부 ──"
# ★PATH 로 `id` 를 가리는 방식은 더 이상 안 통한다★ — 가드가 bash 내장 EUID 를 쓴다(hermes 지적).
#   그게 이 가드의 요점이라, ①PATH shadow 로는 판정이 안 바뀌는지 확인하고
#   ②거부 경로 자체는 명시적 시임(TEAMOS_FAKE_UID)으로 확인한다.
mkdir -p "$T/bin"
printf '#!/bin/sh\n[ "$1" = "-u" ] && echo 0 || exec /usr/bin/id "$@"\n' > "$T/bin/id"
chmod +x "$T/bin/id"
SHADOW="$(PATH="$T/bin:$PATH" bash "$SRC" 2>&1)"
case "$SHADOW" in
  *"root 로 실행하지 않습니다"*) bad "★PATH 로 id 를 가려 판정을 바꿀 수 있다 = 방어가 우회 가능★" ;;
  *) ok "PATH shadow 로는 판정이 안 바뀐다 (EUID 사용)" ;;
esac
OUT="$(TEAMOS_FAKE_UID=0 bash "$SRC" doctor 2>&1)"; RC=$?
[ "$RC" -eq 1 ] && ok "종료코드 1" || bad "종료코드 $RC (1이어야 한다)"
case "$OUT" in *"root 로 실행하지 않습니다"*) ok "거부 메시지" ;; *) bad "거부 메시지 없음: $OUT" ;; esac
case "$OUT" in *"■ 점검"*|*"정상"*) bad "★거부했는데 판정이 돌았다★" ;; *) ok "판정 자체를 시작하지 않음" ;; esac

echo "── T2: 일반 사용자면 그대로 동작 ──"
OUT2="$(bash "$SRC" 2>&1)"; RC2=$?
[ "$RC2" -eq 0 ] && ok "인자 없이 → 설명, 종료코드 0" || bad "종료코드 $RC2"
case "$OUT2" in *"사용법: team-os"*) ok "설명 정상 출력" ;; *) bad "설명이 안 나옴" ;; esac

echo "── T3: off 명단 판정 ──"
# member_off 만 떼어 검증 (REPO 변수를 임시로 잡는다)
LIB="$T/lib.sh"
sed -n '/^member_off() {/,/^}/p' "$SRC" > "$LIB"
mkdir -p "$T/repo/var"
REPO="$T/repo"; export REPO
# shellcheck disable=SC1090
. "$LIB"
printf 'steve, demis\n' > "$T/repo/var/agent-off.txt"
member_off steve  && ok "steve 정지됨으로 인식" || bad "steve 를 못 읽음"
member_off demis  && ok "demis 정지됨으로 인식(콤마 구분)" || bad "콤마 구분 실패"
member_off bill   && bad "★bill 은 명단에 없는데 정지로 봤다★" || ok "bill 은 정상(명단 밖)"
member_off stev   && bad "★부분 문자열로 매칭됐다★" || ok "부분 문자열 매칭 안 함"
: > "$T/repo/var/agent-off.txt"
member_off steve  && bad "★빈 명단인데 정지로 봤다★" || ok "빈 명단 = 아무도 정지 아님"
rm -f "$T/repo/var/agent-off.txt"
member_off steve  && bad "★파일이 없는데 정지로 봤다★" || ok "파일 없음 = 아무도 정지 아님"

echo
[ "$FAIL" -eq 0 ] && echo "ALL PASS" || echo "FAIL"
exit "$FAIL"
