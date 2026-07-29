#!/usr/bin/env bash
# pr-who-approved.sh — 머지하기 전에 ★누가 봤는지★ 를 눈으로 확인한다.
#
# ★왜 필요한가 (2026-07-29 실제 사고)★
#   우리 승인 계정은 여럿이 공유한다(gd452·gdb3rys). 그래서 GitHub 기록에는
#   ★계정만 남고 사람은 안 남는다.★ 그날 나는 #117 을 머지하면서
#   "★Demis 도장이 찍혀 있어서 머지했다★" 고 말했는데 ★그 도장은 내 것이었다.★
#   Demis 는 GitHub 에 리뷰를 올린 적이 없었다.
#
#   ★결과가 나쁘지 않았던 게 문제가 아니다★ — '누가 봤는지' 를 잘못 알고 머지를 판단하면
#   ★다음엔 아무도 안 본 것을 머지하게 된다.★
#
# ★★그리고 이게 이 스크립트가 '보여주기' 인 이유다★★
#   나중에 확인해보니 #117 승인 본문 첫 줄은 ★"Bill 승인합니다"★ 였다. ★이름은 있었다.★
#   즉 그날의 실패는 ★'이름을 안 썼다' 가 아니라 '머지 전에 승인을 안 읽었다' 다.★
#   ★규율을 더 요구해서는 안 고쳐진다★ — 이미 지켜져 있었는데도 틀렸기 때문이다.
#   그래서 이 도구는 ★쓰는 쪽이 아니라 읽는 쪽(머지 직전)에 붙는다.★
#
# ★쓰는 쪽도 새고 있긴 하다★: 승인 본문 ★첫 줄에 이름★ 을 쓴다
#   (skills/b3os-github-workflow/SKILL.md). 그런데 지키는 자리가 없었다.
#   ★실측(최근 PR 45건 · 승인 35건): 이름 있음 17 / ★이름 없음 18 = 51%★★
#   ★본문은 다들 충실했다.★ 리뷰를 안 한 게 아니라 ★이름만 안 적은 것★ 이다
#   → 그래서 '더 잘 기억하기' 가 아니라 ★머지 직전에 보여주는 것★ 으로 푼다.
#
# 쓰는 법:
#   bash scripts/pr-who-approved.sh 117          # 보여주기만
#   bash scripts/pr-who-approved.sh 117 --gate   # 이름 없는 승인이 있으면 exit 1 (머지 전 게이트)
#
# ★이 스크립트는 아무것도 바꾸지 않는다★ — 읽기 전용이다. 머지도 안 한다.
set -uo pipefail

PR="${1:-}"
GATE=0
[ "${2:-}" = "--gate" ] && GATE=1
if [ -z "$PR" ]; then
  echo "사용법: bash scripts/pr-who-approved.sh <PR번호> [--gate]" >&2
  exit 2
fi

REPO="${B3OS_REPO:-b3rys/b3rys-team-os}"

# 팀원 이름 사전. ★여기 없는 이름은 '이름 없음' 으로 잡힌다★ — 새 팀원이 오면 여기 추가한다.
#   (agents.json 을 읽지 않는 이유: 이 스크립트는 저장소만 있으면 어디서든 돌아야 한다.
#    라이브 상태 파일에 의존하면 클론·CI 에서 못 쓴다.)
MEMBERS="bill steve demis codex dbak lui jane dex forin ames hermes codi lisa pm brief devon gd"

# ★API 는 한 번만 부른다★ — 리뷰 목록을 받아서 그 안에서 다 판정한다.
#   B3OS_REVIEWS_JSON 은 ★시험 주입구★ 다 — 이게 있으면 네트워크를 안 탄다.
#   (테스트가 네트워크·계정 상태를 타면 그건 테스트가 아니라 점(占)이다)
if [ -n "${B3OS_REVIEWS_JSON:-}" ]; then
  JSON="$B3OS_REVIEWS_JSON"
else
  JSON="$(gh api "repos/$REPO/pulls/$PR/reviews" --paginate 2>/dev/null)" || {
    echo "✖ 리뷰를 가져오지 못했습니다 (PR#$PR · $REPO). 번호와 저장소를 확인하세요." >&2
    echo "  ★이건 '승인 없음' 이 아니라 '확인 불가' 입니다.★" >&2
    exit 2
  }
fi

printf '  PR#%s · %s\n' "$PR" "$REPO"

RESULT="$(MEMBERS="$MEMBERS" python3 - "$JSON" <<'PY'
import json, os, sys, re
try:
    reviews = json.loads(sys.argv[1] or "[]")
except Exception:
    print("PARSE_FAIL"); raise SystemExit(0)
if not isinstance(reviews, list):
    print("PARSE_FAIL"); raise SystemExit(0)

members = os.environ["MEMBERS"].split()

approvals = [r for r in reviews if isinstance(r, dict) and r.get("state") == "APPROVED"]
if not approvals:
    print("NO_APPROVAL"); raise SystemExit(0)

nameless = 0
for r in approvals:
    acct  = ((r.get("user") or {}).get("login")) or "?"
    body  = (r.get("body") or "").strip()
    first = body.split("\n")[0].strip() if body else ""
    low   = first.lower()
    hit   = next((m for m in members if re.search(rf'\b{re.escape(m)}\b', low)), None)
    if hit:
        print(f"OK\t{acct}\t{hit}\t{first[:60]}")
    else:
        nameless += 1
        print(f"NONAME\t{acct}\t-\t{(first or '(본문 없음)')[:60]}")
print(f"COUNT\t{len(approvals)}\t{nameless}")
PY
)"

case "$RESULT" in
  PARSE_FAIL)
    echo "  ✖ 응답을 해석하지 못했습니다 — ★'승인 없음' 이 아니라 '확인 불가' 입니다.★" >&2
    exit 2 ;;
  NO_APPROVAL)
    echo "  ★승인 0건★ — 아직 아무도 승인하지 않았습니다."
    [ "$GATE" = "1" ] && exit 1
    exit 0 ;;
esac

NONAME=0
while IFS=$'\t' read -r kind acct name first; do
  case "$kind" in
    OK)     printf '  ✓ %-9s ★%s★ — %s\n' "$acct" "$name" "$first" ;;
    NONAME) printf '  ⚠ %-9s ★이름 없음★ — %s\n' "$acct" "$first" ;;
    COUNT)  NONAME="$name" ;;   # COUNT 줄은 3번째 필드가 nameless 개수
  esac
done <<< "$RESULT"

if [ "${NONAME:-0}" != "0" ]; then
  echo
  echo "  ★이름 없는 승인 ${NONAME}건 — 이 PR 을 '누가' 봤는지 기록으로 알 수 없습니다.★"
  echo "  우리 계정은 공유라 계정만으로는 사람이 구분되지 않습니다."
  echo "  고치는 법: 승인 본문 첫 줄에 이름을 넣어 다시 남깁니다 —"
  echo "    gh pr review $PR --repo $REPO --approve --body-file <파일>   # 첫 줄: '<이름> 승인합니다'"
  echo "  (이미 찍은 승인은 코멘트 수정으로 이름을 넣어도 됩니다)"
  [ "$GATE" = "1" ] && exit 1
fi
exit 0
