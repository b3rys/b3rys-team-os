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

echo "── T5: ★본문을 오염시키지 않는다★ (broadcast 는 텔레그램 그룹방으로도 나간다) ──"
# ★이 시험이 존재하는 이유★: 처음엔 send.sh 가 본문 맨 앞에 <@U…> 를 박았다.
#   그 결과 ★텔레그램 단체방에 <@U0BL1UYHLV7> 이 그대로 찍혔다★(2026-07-30, 팀장님 발견).
#   슬랙 문법은 슬랙에서만 뜻이 있다 — 그래서 지금은 ID 만 풀어 meta 로 넘기고,
#   실제 부착은 슬랙으로 릴레이하는 서버가 한다.
grep -q 'BODY="<@' "$SRC" && bad "★본문에 멘션을 박는 코드가 남아 있다★" || ok "본문 부착 코드 없음"
grep -q "meta\['slack_mentions'\]" "$SRC" && ok "meta.slack_mentions 로 넘긴다" || bad "meta 전달 코드가 없다"
grep -q 'MENTION_IDS="\$MENTION_IDS \$_id"' "$SRC" && ok "ID 로 풀어 모은다" || bad "ID 수집 코드가 없다"

echo "── T6: 서버가 슬랙 릴레이에서만 붙이나 (소스 확인) ──"
SRV="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src/server/routes/inbox.ts"
if [ -f "$SRV" ]; then
  grep -q 'slack_mentions' "$SRV" && ok "릴레이가 meta 를 읽는다" || bad "서버가 meta 를 안 읽는다"
  # 부착이 슬랙 send 블록 안에 있는지 — text: slackText 로 넘어가야 한다
  grep -q 'text: slackText' "$SRV" && ok "슬랙 발신 text 에만 적용" || bad "슬랙 발신에 안 걸려 있다"
  # 형식 검증: U/W 로 시작하는 것만 받아야 한다(임의 문자열 주입 방지)
  grep -q 'UW\]\[A-Z0-9\]' "$SRV" && ok "ID 형식 검증 있음" || bad "★형식 검증 없음 — 임의 문자열이 붙는다★"
else
  bad "서버 소스를 못 찾음: $SRV"
fi

echo
[ "$FAIL" -eq 0 ] && echo "ALL PASS" || echo "FAIL"
exit "$FAIL"
