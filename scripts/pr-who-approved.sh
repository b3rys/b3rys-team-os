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

# 팀원 이름 사전(한글 별칭 포함). ★여기 없는 이름은 '확인 불가' 로 잡힌다★ — 새 팀원이 오면 추가한다.
#   (agents.json 을 읽지 않는 이유: 이 스크립트는 저장소만 있으면 어디서든 돌아야 한다.
#    라이브 상태 파일에 의존하면 클론·CI 에서 못 쓴다. 대신 드리프트는 테스트가 경고한다.)
#
# ★pm·gd 는 일부러 뺐다★ — 역할어라 "GD 승인 후 머지하겠습니다" 같은 ★언급★ 이 승인자로 잡힌다.
MEMBERS="bill:빌 steve:스티브 demis:데미스 codex:코덱스 dbak:디백 lui:루이 jane:제인 dex:덱스 forin:포린 ames:에임스 hermes:헤르메스,헤름 codi:코디 lisa:리사 brief:브리프 devon:데본"

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

# "bill:빌" · "hermes:헤르메스,헤름" → {정식이름: [별칭들]}
MEMBERS = {}
for tok in os.environ["MEMBERS"].split():
    canon, _, aka = tok.partition(":")
    MEMBERS[canon] = [canon] + [a for a in aka.split(",") if a]

# ★승인 동사★ — 우리 관례가 "<이름> 승인합니다" 라 그 모양만 신뢰한다.
VERB = r'(승인|approve[sd]?|lgtm)'

def first_line(body: str) -> str:
    """첫 줄을 뽑는다.

    ★이스케이프된 개행을 먼저 되돌린다★ (steve, 2026-07-29 · #103 실측):
      어떤 응답은 본문에 진짜 개행 대신 `\\n` 두 글자가 들어온다. 그러면 split("\\n") 이
      ★아무것도 안 쪼개서 first = 본문 전체★ 가 되고, ★본문 어디에 있는 이름이든 잡힌다.★
      실제로 #103(승인자=hermes) 이 본문 속 'Bill' 때문에 ★bill 로 표시★ 됐다.
    """
    s = body.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\r\n", "\n")
    for line in s.split("\n"):
        # 마크다운 장식은 벗긴다 — `**Bill 승인합니다**`, `> Bill 승인`, `## Bill 승인`
        t = re.sub(r'^[\s>#*_`\-]+', '', line)
        t = re.sub(r'[\s*_`]+$', '', t)
        if t.strip():
            return t.strip()
    return ""

def who_approved(first: str):
    """(정식이름 | None, 사유) — ★확실할 때만 이름을 말한다.★

    ★추측해서 하나 고르는 게 제일 나쁘다★ (steve): 틀린 이름을 자신 있게 보여주면
    '누가 봤는지 잘못 알고 머지한다' 는 원래 사고를 ★자동화★ 한다.
    이전 판은 `members` 목록 순서로 first-match 를 골라서, 목록 첫 항목인 bill 이
    ★'Bill 지적대로 반영했습니다. Steve 승인합니다.' 를 bill 로★ 판정했다.
    """
    low = first.lower()
    # ★서명 문법 2가지만 신뢰한다★ — 실제로 쓰이는 형식만(steve·ames 실측):
    #   A) `<이름> 승인합니다` — 줄 ★앞★ 에 이름, 그 직후에 승인 동사
    #   B) `리뷰어: <이름>`    — Demis 가 #116 에서 쓴 형식
    # ★그 밖은 전부 '모름' 이다.★ 넓히면 언급이 서명으로 새고, 그게 이 도구를 쓸모없게 만든다.
    def anchored_hit(a: str) -> bool:
        a = re.escape(a.lower())
        return bool(re.match(rf'^{a}\b[^\n]{{0,12}}?{VERB}', low)          # A
                    or re.match(rf'^리뷰어\s*[:：]\s*{a}\b', low))          # B
    # ★앵커가 둘 이상일 수는 없다★ — A·B 둘 다 ★줄 맨 앞★ 을 요구하므로 한 줄에 하나뿐이다.
    #   처음엔 '이름 여럿 → 모름' 분기를 뒀는데, 뮤턴트로 확인해보니 ★도달 불가능한 죽은 분기★ 였다
    #   (되돌려도 아무 시험이 안 빨개졌다 = 그 분기를 타는 입력이 존재하지 않는다).
    #   ★실패할 수 있는 입력이 없는 검사는 검사가 아니라 장식이다★ — 그래서 지웠다.
    #   앵커 규칙을 넓혀 줄 앞이 아닌 곳도 받게 되면 ★이 분기를 다시 넣어야 한다.★
    anchored = [c for c, aliases in MEMBERS.items() if any(anchored_hit(a) for a in aliases)]
    if anchored:
        return anchored[0], ""
    # ② 앵커가 없다 — 이름이 보여도 ★그게 서명인지 언급인지 알 수 없다.★
    mentioned = [c for c, aliases in MEMBERS.items()
                 if any(re.search(rf'(?<![0-9a-z]){re.escape(a.lower())}(?![0-9a-z])', low) for a in aliases)]
    if mentioned:
        return None, f"이름이 보이지만 서명 형태가 아님({'·'.join(mentioned)})"
    return None, "이름 없음"

approvals = [r for r in reviews if isinstance(r, dict) and r.get("state") == "APPROVED"]
if not approvals:
    print("NO_APPROVAL"); raise SystemExit(0)

unknown = 0
for r in approvals:
    acct  = ((r.get("user") or {}).get("login")) or "?"
    first = first_line((r.get("body") or "").strip())
    name, why = who_approved(first)
    if name:
        print(f"OK\t{acct}\t{name}\t{first[:60]}")
    else:
        unknown += 1
        print(f"UNKNOWN\t{acct}\t{why}\t{(first or '(본문 없음)')[:60]}")
print(f"COUNT\t{len(approvals)}\t{unknown}")
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

UNKNOWN=0
while IFS=$'\t' read -r kind acct why first; do
  case "$kind" in
    OK)      printf '  ✓ %-9s ★%s★ — %s\n' "$acct" "$why" "$first" ;;
    UNKNOWN) printf '  ⚠ %-9s ★모름★ (%s) — %s\n' "$acct" "$why" "$first" ;;
    COUNT)   UNKNOWN="$why" ;;   # COUNT 줄은 3번째 필드가 unknown 개수
  esac
done <<< "$RESULT"

if [ "${UNKNOWN:-0}" != "0" ]; then
  echo
  echo "  ★승인 ${UNKNOWN}건은 '누가' 했는지 알 수 없습니다.★ 우리 계정은 공유라 계정만으로 사람이 안 갈립니다."
  echo "  ★이 도구는 확실할 때만 이름을 말합니다★ — 추측해서 지목하면, 틀린 이름을 자신 있게"
  echo "  보여주게 되고 그건 '누가 봤는지 잘못 알고 머지' 하는 원래 사고를 자동화합니다."
  echo
  echo "  신뢰하는 서명 형식은 둘뿐입니다 (승인 본문 ★첫 줄★):"
  echo "    · '<이름> 승인합니다'        예) Bill 승인합니다"
  echo "    · '리뷰어: <이름>'           예) 리뷰어: Demis"
  echo "  고치는 법: gh pr review $PR --repo $REPO --approve --body-file <파일>"
  echo "  (이미 찍은 승인은 본문을 수정해 첫 줄에 이름을 넣어도 됩니다)"
  [ "$GATE" = "1" ] && exit 1
fi
exit 0
