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
case("정상 — 이스케이프 개행으로 와도 찾는다", True, SETTINGS,
     [review("확인했습니다.\\n\\nApproved-by: codex")])

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
case("승인 0건", False, SETTINGS, [], expect_msg="no standing approval")
case("반려만 있음", False, SETTINGS, [review("Approved-by: bill", state="CHANGES_REQUESTED")])
case("★승인 뒤 철회 — 나중 것이 이긴다★", False, SETTINGS,
     [review("Approved-by: bill", at="2026-07-01T00:00:00Z"),
      review("되돌립니다", state="CHANGES_REQUESTED", at="2026-07-05T00:00:00Z")],
     expect_msg="no standing approval")
# ★위 케이스만으로는 '시간순 정렬' 을 안 재고 있었다★ (뮤턴트로 발견):
#   시험 데이터가 이미 시간순이라 정렬을 지워도 결과가 같았다.
#   ★정렬이 실제로 일하는 곳은 API 가 순서를 뒤섞어 줄 때★ 다 — GitHub 은 순서를 보장하지 않는다.
case("★순서가 뒤섞여 와도 나중 철회가 이긴다★", False, SETTINGS,
     [review("되돌립니다", state="CHANGES_REQUESTED", at="2026-07-05T00:00:00Z"),
      review("Approved-by: bill", at="2026-07-01T00:00:00Z")],   # ← 승인이 배열 뒤에 있지만 ★더 이르다★
     expect_msg="no standing approval")
case("★철회 뒤 재승인 — 이번엔 통과★", True, SETTINGS,
     [review("되돌립니다", state="CHANGES_REQUESTED", at="2026-07-01T00:00:00Z"),
      review("Approved-by: bill", at="2026-07-05T00:00:00Z")])
case("코멘트는 상태를 안 바꾼다", True, SETTINGS,
     [review("Approved-by: bill", at="2026-07-01T00:00:00Z"),
      review("한마디 덧붙입니다", state="COMMENTED", at="2026-07-05T00:00:00Z")])

# ── ★모르면 막는다★ ─────────────────────────────────────────────────────────
case("★응답이 배열이 아님 → 승인없음이 아니라 확인불가★", False, SETTINGS, {"oops": 1},
     expect_msg="unknown")
case("★Approved-by 가 두 줄★", False, SETTINGS,
     [review("Approved-by: bill\nApproved-by: steve")], expect_msg="more than one")


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
