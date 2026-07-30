#!/usr/bin/env bash
# send.sh --mention 검증. ★실제 발신 안 함★ — 멘션 해석·부착 로직만 떼어 돌린다.
set -uo pipefail
SRC="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/skills/b3os-team-inbox/scripts/send.sh}"
FAIL=0
ok(){ echo "  ✓ $1"; }; bad(){ echo "  ✗ $1"; FAIL=1; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cat > "$T/members.env" <<'EOF'
# 주석은 무시된다
lisa=U0BL1UYHLV7
Jane=U0BKJR2G8MD
EOF

# resolve_mention 만 떼어낸다
LIB="$T/lib.sh"
sed -n '/^resolve_mention() {/,/^}/p' "$SRC" > "$LIB"
MEMBERS_FILE="$T/members.env"; export MEMBERS_FILE
# shellcheck disable=SC1090
. "$LIB"

echo "── T1: 이름 → ID ──"
[ "$(resolve_mention lisa)" = "U0BL1UYHLV7" ] && ok "lisa" || bad "lisa: $(resolve_mention lisa)"
[ "$(resolve_mention LISA)" = "U0BL1UYHLV7" ] && ok "대소문자 무시" || bad "대소문자"
[ "$(resolve_mention jane)" = "U0BKJR2G8MD" ] && ok "사전 키가 대문자여도 찾음" || bad "jane"

echo "── T2: 원시 ID 는 그대로 ──"
[ "$(resolve_mention U0BL1UYHLV7)" = "U0BL1UYHLV7" ] && ok "U… 통과" || bad "U…"
[ "$(resolve_mention '<@U0BL1UYHLV7>')" = "U0BL1UYHLV7" ] && ok "<@U…> 형태도 받음" || bad "<@U…>"

echo "── T3: 모르는 이름은 빈 값(→ 스크립트가 에러로 멈춘다) ──"
[ -z "$(resolve_mention nosuchperson)" ] && ok "빈 값" || bad "빈 값이 아님"

echo "── T4: 사전 파일이 없으면 이름은 못 풀고, 원시 ID 는 여전히 통과 ──"
MEMBERS_FILE="$T/none.env"
[ -z "$(resolve_mention lisa)" ] && ok "이름 → 빈 값" || bad "파일 없는데 풀렸다"
[ "$(resolve_mention U0BL1UYHLV7)" = "U0BL1UYHLV7" ] && ok "원시 ID 는 통과" || bad "원시 ID 실패"
MEMBERS_FILE="$T/members.env"

echo "── T5: 본문 부착 (중복 방지 포함) ──"
# ★부착 로직을 손으로 베끼지 않는다★ — 베끼면 그 사본이 원본과 갈라져도 시험은 통과한다
#   (#149 에서 같은 형태로 당했다: 대조 대상이 자기 복사본이었다).
#   그래서 send.sh 의 for 루프를 ★그대로 떼어★ 쓴다.
eval "prepend() {  # prepend <본문> <멘션들...>
  local BODY=\"\$1\"; shift
  local MENTIONS=\"\$*\"
$(sed -n '/^for _m in \$MENTIONS; do$/,/^done$/p' "$SRC")
  printf '%s' \"\$BODY\"
}"
r="$(prepend "본문" lisa)"
[ "$r" = "$(printf '<@U0BL1UYHLV7>\n본문')" ] && ok "맨 앞 ★자기 줄★ 에 붙음" || bad "부착: $r"
r="$(prepend "<@U0BL1UYHLV7> 이미 있음" lisa)"
[ "$r" = "<@U0BL1UYHLV7> 이미 있음" ] && ok "★중복으로 안 붙임★" || bad "중복: $r"
# ★코드블록이 깨지지 않는지★ — 여는 펜스가 줄 맨 앞에 그대로 있어야 한다
r="$(prepend '```
code
```' lisa)"
case "$r" in
  "<@U0BL1UYHLV7>"*$'\n''```'*) ok "코드블록 여는 펜스가 줄 맨 앞에 유지됨" ;;
  *) bad "★펜스가 밀렸다★: $(printf '%s' "$r" | head -2 | tr '\n' '|')" ;;
esac
r="$(prepend "본문" lisa jane)"
case "$r" in *"<@U0BL1UYHLV7>"*) case "$r" in *"<@U0BKJR2G8MD>"*) ok "여러 명 부착" ;; *) bad "두 번째 누락" ;; esac ;; *) bad "첫 번째 누락" ;; esac

echo
[ "$FAIL" -eq 0 ] && echo "ALL PASS" || echo "FAIL"
exit "$FAIL"
