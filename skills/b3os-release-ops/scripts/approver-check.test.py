#!/usr/bin/env python3
"""approver-check 의 시험. ★네트워크·계정·라이브 상태를 안 탄다★ (전부 주입).

되돌렸을 때 빨개지는지(뮤턴트)는 approver-check.mutants.sh 가 확인한다.
★시험이 전부 통과하는 건 좋은 신호가 아니라 점검 신호다★ — 같은 날 죽은 시험을 두 번 짰다.
"""
import sys
from pathlib import Path

# 파일명에 하이픈이 있어 일반 import 가 안 된다 — 경로로 직접 읽는다.
import importlib.util
_spec = importlib.util.spec_from_file_location("approver_check", Path(__file__).resolve().parent / "approver-check.py")
_m = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_m)

SETTINGS = {
    "github_team_account": "gdb3rys",
    "github_approver_account": "gd452",
    "merge_approvers_normal": "bill,codex,steve",
}


def review(body, acct="gd452", state="APPROVED", at="2026-07-01T00:00:00Z"):
    return {"state": state, "user": {"login": acct}, "body": body, "submitted_at": at}


CASES = []


def case(name, expect_ok, settings, reviews, author="gdb3rys", expect_msg=None):
    CASES.append((name, expect_ok, settings, reviews, author, expect_msg))


# ── 정상 ─────────────────────────────────────────────────────────────────────
case("정상 — Approved-by 한 줄", True, SETTINGS,
     [review("확인했습니다. 테스트 통과.\n\nApproved-by: bill")])
case("정상 — 대소문자 무관", True, SETTINGS, [review("APPROVED-BY: Steve")])
# ★이 시험은 두 번 뒤집혔다 — 두 번째는 실측이 이겼다★
#   ①처음: 리터럴 \n 도 개행으로 봤다 → ②ames: "json.loads 가 복원하니 계약만 넓힌다" → 뺐다
#   → ③하네스 전수조사: ★PR#103 승인 본문이 진짜 개행 0개 · 리터럴 11개★ 였다.
#   ★우리 도구 중에 그런 본문을 만드는 게 실제로 있다.★ 안 되돌리면 그 클라이언트로는 서명이 불가능하다.
#   ★"규격상 그럴 리 없다" 를 실제 데이터가 이겼다.★
case("★리터럴 백슬래시-n 본문도 서명을 찾는다★ (PR#103 실측 형태)", True, SETTINGS,
     [review("확인했습니다.\\n\\nApproved-by: codex")])
case("정상 — 진짜 개행이면 찾는다", True, SETTINGS,
     [review("확인했습니다.\n\nApproved-by: codex")])

# ── ★산문 파싱을 그만둔 이유 — 오늘 5명이 찾은 반례가 전부 여기서 죽는다★ ────────
case("★언급만★ 'Bill 지적대로 고쳤습니다'", False, SETTINGS, [review("Bill 지적대로 고쳤습니다")])
case("★인용문★ '> Steve 승인합니다'", False, SETTINGS, [review("> Steve 승인합니다")])
case("★부정문★ 'Bill 은 승인 안 했지만'", False, SETTINGS, [review("Bill 은 승인 안 했지만 급해서")])
case("★할일★ '- Bill 승인 필요'", False, SETTINGS, [review("- Bill 승인 필요\n- 테스트")])
case("★역할어★ 'GD 승인 후 머지'", False, SETTINGS, [review("GD 승인 후 머지하겠습니다")])
case("★기술용어★ 'direct-to-gd 계약'", False, SETTINGS, [review("direct-to-gd 계약 확인했습니다")])
case("★옛 관례★ 'Bill 승인합니다' (첫 줄 이름)", False, SETTINGS, [review("Bill 승인합니다")],
     expect_msg="Approved-by")

# ── 명부·계정 ────────────────────────────────────────────────────────────────
case("★명부에 없는 사람★ dex", False, SETTINGS, [review("Approved-by: dex")],
     expect_msg="merge_approvers_normal")
case("★승인이 엉뚱한 계정에서★", False, SETTINGS, [review("Approved-by: bill", acct="someone")],
     expect_msg="approver account")
case("★작성자가 승인 계정 (#119 증상)★", False, SETTINGS, [review("Approved-by: bill")],
     author="gd452", expect_msg="team account")
case("★작성·승인 계정이 같게 설정됨★", False,
     {**SETTINGS, "github_approver_account": "gdb3rys"}, [review("Approved-by: bill", acct="gdb3rys")],
     expect_msg="same")

# ── 설정 누락 — ★기본값으로 때우지 않는다★ ──────────────────────────────────
for key in ("github_team_account", "github_approver_account", "merge_approvers_normal"):
    case(f"★설정 누락★ {key}", False, {**SETTINGS, key: ""}, [review("Approved-by: bill")],
         expect_msg="settings missing")

# ── 승인 상태 ────────────────────────────────────────────────────────────────
case("승인 0건", False, SETTINGS, [], expect_msg="no review on this PR at all")
case("반려만 있음", False, SETTINGS, [review("Approved-by: bill", state="CHANGES_REQUESTED")])
case("★승인 뒤 철회 — 나중 것이 이긴다★", False, SETTINGS,
     [review("Approved-by: bill", at="2026-07-01T00:00:00Z"),
      review("되돌립니다", state="CHANGES_REQUESTED", at="2026-07-05T00:00:00Z")],
     expect_msg="withdrawn")
# ★위 케이스만으로는 '시간순 정렬' 을 안 재고 있었다★ (뮤턴트로 발견):
#   시험 데이터가 이미 시간순이라 정렬을 지워도 결과가 같았다.
#   ★정렬이 실제로 일하는 곳은 API 가 순서를 뒤섞어 줄 때★ 다 — GitHub 은 순서를 보장하지 않는다.
case("★순서가 뒤섞여 와도 나중 철회가 이긴다★", False, SETTINGS,
     [review("되돌립니다", state="CHANGES_REQUESTED", at="2026-07-05T00:00:00Z"),
      review("Approved-by: bill", at="2026-07-01T00:00:00Z")],   # ← 승인이 배열 뒤에 있지만 ★더 이르다★
     expect_msg="withdrawn")
case("★철회 뒤 재승인 — 이번엔 통과★", True, SETTINGS,
     [review("되돌립니다", state="CHANGES_REQUESTED", at="2026-07-01T00:00:00Z"),
      review("Approved-by: bill", at="2026-07-05T00:00:00Z")])
case("코멘트는 상태를 안 바꾼다", True, SETTINGS,
     [review("Approved-by: bill", at="2026-07-01T00:00:00Z"),
      review("한마디 덧붙입니다", state="COMMENTED", at="2026-07-05T00:00:00Z")])

# ── ★모르면 막는다★ ─────────────────────────────────────────────────────────
case("★응답이 배열이 아님 → 승인없음이 아니라 확인불가★", False, SETTINGS, {"oops": 1},
     expect_msg="unknown")
case("★Approved-by 가 두 줄 — 다른 이름★", False, SETTINGS,
     [review("Approved-by: bill\nApproved-by: steve")], expect_msg="more than one")
# ★set 으로 접으면 이게 통과했다★ (ames) — 줄 수를 세야 잡힌다.
case("★Approved-by 가 두 줄 — 같은 이름★", False, SETTINGS,
     [review("Approved-by: bill\nApproved-by: bill")], expect_msg="more than one")
# ★steve 가 찾은 것 — 예시가 서명이 되던 문제★
case("★들여쓴 예시는 서명이 아니다★", False, SETTINGS, [review("   Approved-by: steve")])
case("★코드펜스 안 예시는 서명이 아니다★", False, SETTINGS,
     [review("형식은 이렇습니다:\n\n```\nApproved-by: steve\n```")])
case("★마지막 줄이 아니면 서명이 아니다★", False, SETTINGS,
     [review("Approved-by: bill\n\n덧붙임: 나중에 확인 필요")])
# ★ames BLOCKER — 작성자 조회 실패를 통과시키지 않는다★
case("★작성자 조회 실패(빈값) → 막는다★", False, SETTINGS,
     [review("Approved-by: bill")], author="", expect_msg="author unknown")

# ══ 하네스 실측 2026-07-29 — ★화면과 원문이 갈리는 자리★ ═══════════════════════
# ★이 넷은 전부 같은 부류다★: 사람이 보는 렌더 결과와 이 도구가 읽는 원문이 다르다.
#   그래서 변종마다 막지 않고 ★'갈릴 수 있는 상태' 자체를 거부★ 하게 바꿨다.
case("★안 닫힌 코드펜스 뒤 서명 → 막는다★ (열려 있으면 화면엔 예시로 보인다)", False, SETTINGS,
     [review("질문: 형식이 이거 맞나요?\n\n```\nApproved-by: steve\n")], expect_msg="UNCLOSED code fence")
case("★안 닫힌 HTML 주석 뒤 서명 → 막는다★ (화면에서는 통째로 사라진다)", False, SETTINGS,
     [review("리뷰 안 했습니다.\n<!-- 메모\nApproved-by: bill")], expect_msg="UNBALANCED HTML comment")
case("★닫힌 주석은 정상 통과★ (막는 건 '안 닫힌 것' 이지 주석 자체가 아니다)", True, SETTINGS,
     [review("<!-- 메모 -->\n확인했습니다.\n\nApproved-by: bill")])
case("★줄 끝 백슬래시로 중복서명 가드를 우회하지 못한다★", False, SETTINGS,
     [review("Approved-by: dex\\\nApproved-by: bill")], expect_msg="more than one")

# ★규약을 알려주는 문서를 인용해도 막히지 않는다★ — 규칙을 지키려는 사람이 막히던 자리
case("★SKILL.md 형식 예시(닫힌 펜스)를 인용하고 진짜 서명 → 통과★", True, SETTINGS,
     [review("형식이 이건가요?\n\n```\nApproved-by: bill\n```\n\n확인했습니다.\n\nApproved-by: codex")])

# ★남의 승인이 있어도 내 승인을 막지 않는다★ — public repo 라 아무나 APPROVED 를 남길 수 있다
case("★제3자 APPROVED 가 있어도 승인계정 서명이 있으면 통과★", True, SETTINGS,
     [review("looks fine", acct="randomdev", at="2026-07-01T00:00:00Z"),
      review("Approved-by: bill", at="2026-07-02T00:00:00Z")], expect_msg="ignored approvals from")
case("★제3자 승인만 있으면 통과 못 한다★ (자격은 승인계정에만 있다)", False, SETTINGS,
     [review("looks fine", acct="randomdev")], expect_msg="do not count")

# ★계정 대소문자★ — GitHub 로그인은 대소문자 무관인데 설정 표기가 갈리면 영구 차단됐다
case("★승인계정 표기가 대문자여도 통과★", True, SETTINGS, [review("Approved-by: bill", acct="GD452")])
case("★작성자 표기가 대문자여도 통과★", True, SETTINGS, [review("Approved-by: bill")], author="GDB3rys")

# ★'승인 없음' 의 원인을 갈라 말한다★ — 셋이 같은 문장을 내면서 원인을 단언했다
case("원인구분: 리뷰가 아예 없음", False, SETTINGS, [], expect_msg="no review on this PR at all")
case("원인구분: ★push 로 폐기됨(dismiss_stale_reviews)★", False, SETTINGS,
     [review("Approved-by: bill", state="DISMISSED")], expect_msg="DISMISSED")
case("원인구분: 실제 철회", False, SETTINGS,
     [review("Approved-by: bill", at="2026-07-01T00:00:00Z"),
      review("되돌립니다", state="CHANGES_REQUESTED", at="2026-07-05T00:00:00Z")], expect_msg="withdrawn")

# ★'모양은 맞는데 안 맞다' 를 구분해 말한다★ — 사용자 눈에는 정확히 그 줄이라 원인을 못 찾았다
for _tag, _body in [("@멘션", "Approved-by: @bill"), ("기호", "Approved-by: bill ✦"),
                    ("NBSP", "Approved-by: bill\xa0"), ("볼드", "**Approved-by: bill**"),
                    ("리스트", "- Approved-by: bill")]:
    case(f"★{_tag} → 막되 이유를 말한다★", False, SETTINGS, [review(_body)],
         expect_msg="looks like a signature but does not match exactly")


def main():
    npass = nfail = 0
    for name, expect_ok, settings, reviews, author, expect_msg in CASES:
        ok, msg = _m.check(settings, reviews, author)
        bad = []
        if ok != expect_ok:
            bad.append(f"ok={ok} (기대 {expect_ok})")
        if expect_msg and expect_msg not in msg:
            bad.append(f"메시지에 {expect_msg!r} 없음")
        if bad:
            nfail += 1
            print(f"  ✖ {name}\n     {' · '.join(bad)}\n     실제: {msg}")
        else:
            npass += 1
    print(f"  통과 {npass} · 실패 {nfail}")
    return 1 if nfail else 0


if __name__ == "__main__":
    sys.exit(main())
