#!/usr/bin/env python3
"""pr-gate 판정 시험. ★네트워크·계정·라이브 상태를 안 탄다★ (전부 주입).

되돌렸을 때 빨개지는지는 pr-gate.mutants.sh 가 확인한다.
사용: python3 skills/b3os-github-workflow/scripts/pr-gate.test.py
"""
import copy
import importlib.util
import sys
from pathlib import Path

_spec = importlib.util.spec_from_file_location("pr_gate", Path(__file__).resolve().parent / "pr-gate.py")
g = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(g)

HEAD = "a6bcb36dffb67735daad3a916853e934d2e9d1b4"
OLD = "5f447b41aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
REPO = "example/app"


def review(commit=HEAD, state="APPROVED", body="확인했습니다.\n\nApproved-by: reviewer", acct="reviewer-bot", at="2026-11-05T19:30:00Z"):
    return {"state": state, "user": {"login": acct}, "body": body, "commit_id": commit, "submitted_at": at}


def run(head=HEAD, repo=REPO, pr=372, failed=0, passed=968, exit_code=0, result="Passed",
        at="2026-11-05T19:13:27+00:00", command="scripts/dev-check.sh A B", d="run-1",
        log="units passed 948 · skipped 0 · named UI tests passed 20/20\n"):
    return {"branch": f"evidence/app-{pr}-{head[:7]}", "dir": d,
            "manifest": {"repo": repo, "pr": pr, "head_before": head, "head_after": head, "exit_code": exit_code,
                         "created_at": at, "command": command,
                         "result": result, "tests": {"passedTests": passed, "failedTests": failed, "skippedTests": 0}},
            "summary": {"devicesAndConfigurations": [{"device": {"deviceName": "sim-a"}, "passedTests": passed, "failedTests": failed}]},
            "log": log}


BASE = {
    "repo": REPO, "number": 372,
    "policy": {"base": "main", "evidence": "required", "evidence_branch_prefix": "evidence/app-",
               "required_tests": "단위 전체", "min_unit_tests": 900, "merge_method": "squash", "lead_approval": "상시",
               "approval": {"author_account": "author-bot", "approver_account": "reviewer-bot", "approvers": ["reviewer"]}},
    "pr": {"head": HEAD, "state": "OPEN", "draft": False, "base": "main", "author": "author-bot", "mergeable": "MERGEABLE"},
    "behind_by": 0,
    "reviews": [review()],
    "runs": [run()],
}

CASES = []


def case(name, expect, mutate, must_contain=None):
    CASES.append((name, expect, mutate, must_contain))


def setp(**kw):
    def f(d):
        d["pr"].update(kw)
    return f


# ── 통과 ──
case("정상 — 지금 head 승인·증거", "READY", lambda d: None)
case("이전 head 증거가 함께 있어도 지금 head 증거가 있으면 통과", "READY",
     lambda d: d["runs"].insert(0, run(head=OLD)))
# ── 승인만 대기 ──
case("리뷰가 없다(승인이 댓글뿐)", "WAITING_APPROVAL", lambda d: d.update(reviews=[]), "no standing approval")
case("승인이 이전 head 에 있다", "WAITING_APPROVAL", lambda d: d.update(reviews=[review(commit=OLD)]), "5f447b41")
case("승인 뒤 CHANGES_REQUESTED", "WAITING_APPROVAL",
     lambda d: d["reviews"].append(review(state="CHANGES_REQUESTED", body="P1", at="2026-11-05T20:00:00Z")))
case("COMMENT 리뷰만", "WAITING_APPROVAL", lambda d: d.update(reviews=[review(state="COMMENTED")]))
case("승인 본문 마지막 줄에 서명이 없다", "WAITING_APPROVAL",
     lambda d: d.update(reviews=[review(body="Approved-by: reviewer\n\n좋아요")]), "LAST line")
case("작성 계정으로 승인", "WAITING_APPROVAL", lambda d: d.update(reviews=[review(acct="author-bot")]))
case("명단에 없는 서명", "WAITING_APPROVAL", lambda d: d.update(reviews=[review(body="ok\n\nApproved-by: lisa")]), "lisa")
case("정책에 approval 없음 → 막힘", "WAITING_APPROVAL", lambda d: d["policy"].pop("approval"), "settings missing")
case("정책 승인자 명단 비어 있음 → 막힘", "WAITING_APPROVAL", lambda d: d["policy"]["approval"].update(approvers=[]), "merge_approvers_normal")
# ── 준비 안 됨 ──
case("behind 1", "NOT_READY", lambda d: d.update(behind_by=1), "behind")
case("draft", "NOT_READY", setp(draft=True))
case("닫힌 PR", "NOT_READY", setp(state="CLOSED"))
case("mergeable 계산 중(UNKNOWN)", "NOT_READY", setp(mergeable="UNKNOWN"))
case("충돌", "NOT_READY", setp(mergeable="CONFLICTING"))
case("다른 base", "NOT_READY", setp(base="release"))
case("증거 브랜치 없음", "NOT_READY", lambda d: d.update(runs=[]), "증거 브랜치가 없다")
case("이전 head 증거만", "NOT_READY", lambda d: d.update(runs=[run(head=OLD)]), "5f447b41")
case("다른 PR 증거", "NOT_READY", lambda d: d.update(runs=[run(pr=371)]), "#371")
case("다른 저장소 증거", "NOT_READY", lambda d: d.update(runs=[run(repo="example/other-app")]), "example/other-app#")
case("manifest 를 못 읽음", "NOT_READY", lambda d: d["runs"][0].update(manifest=None), "manifest")
case("시험 수 0", "NOT_READY", lambda d: d.update(runs=[run(passed=0)]))
case("실패 1", "NOT_READY", lambda d: d.update(runs=[run(failed=1)]))
case("시험 수가 숫자가 아님", "NOT_READY", lambda d: d["runs"][0]["manifest"]["tests"].update(failedTests=None))
case("exit 0 아님", "NOT_READY", lambda d: d.update(runs=[run(exit_code=65)]))
case("result Failed", "NOT_READY", lambda d: d.update(runs=[run(result="Failed")]))
case("head_before 만 다름(시험 중 head 바뀜)", "NOT_READY", lambda d: d["runs"][0]["manifest"].update(head_before=OLD))
case("승인 없음 + behind → 승인 대기가 아니라 준비 안 됨", "NOT_READY",
     lambda d: d.update(reviews=[], behind_by=2))
# ── 같은 head 의 run 이 여럿일 때: 명령별 최신만 본다 ──
EARLY, LATE = "2026-11-05T10:00:00+00:00", "2026-11-05T12:00:00+00:00"
case("이전 통과 + 최신 실패(통과가 앞)", "NOT_READY",
     lambda d: d.update(runs=[run(at=EARLY, d="r1"), run(at=LATE, d="r2", failed=2, exit_code=65, result="Failed")]), "r2")
case("이전 통과 + 최신 실패(실패가 앞)", "NOT_READY",
     lambda d: d.update(runs=[run(at=LATE, d="r2", failed=2, exit_code=65, result="Failed"), run(at=EARLY, d="r1")]), "r2")
case("실패 뒤 다시 돌려 통과", "READY",
     lambda d: d.update(runs=[run(at=EARLY, d="r1", failed=1, exit_code=65, result="Failed"), run(at=LATE, d="r2")]))
case("명령이 다른 묶음 하나의 최신이 실패", "NOT_READY",
     lambda d: d.update(runs=[run(at=LATE, d="unit"), run(at=EARLY, d="ui", command="scripts/dev-check.sh A B UITest",
                                                     failed=1, exit_code=65, result="Failed")]), "ui")
case("created_at 없음", "NOT_READY", lambda d: d["runs"][0]["manifest"].pop("created_at"), "created_at")
SAME = "2026-11-05T12:00:00+00:00"
FAILED = dict(failed=1, exit_code=65, result="Failed")
case("같은 시각 성공·실패(성공이 앞)", "NOT_READY",
     lambda d: d.update(runs=[run(at=SAME, d="ok"), run(at=SAME, d="bad", **FAILED)]), "bad")
case("같은 시각 성공·실패(실패가 앞)", "NOT_READY",
     lambda d: d.update(runs=[run(at=SAME, d="bad", **FAILED), run(at=SAME, d="ok")]), "bad")
case("같은 시각 둘 다 성공", "READY", lambda d: d.update(runs=[run(at=SAME, d="a"), run(at=SAME, d="b")]))
case("시간대가 다른 표기 — 실제로는 실패가 나중", "NOT_READY",
     lambda d: d.update(runs=[run(at="2026-11-05T20:00:00+09:00", d="ok"), run(at="2026-11-05T11:30:00+00:00", d="bad", **FAILED)]), "bad")
case("created_at 형식 오류", "NOT_READY", lambda d: d["runs"][0]["manifest"].update(created_at="어제"), "created_at")
# ── 단위 전체 (dev-check.sh 의 'units passed N') ──
SCOPED = "zsh artifacts/run-review-integrated.sh"
case("단위 결과 줄 없음(범위 시험만)", "NOT_READY", lambda d: d.update(runs=[run(log="Executed 23 tests, with 0 failures\n", command=SCOPED)]), "단위 전체 결과가 없다")
case("범위 단위 20", "NOT_READY", lambda d: d.update(runs=[run(log="units passed 20 · skipped 0\n", command=SCOPED)]), "20 뿐이다")
case("run.log 없음", "NOT_READY", lambda d: d["runs"][0].update(log=None), "단위 전체 결과가 없다")
case("단위 전체 run + 범위 run 둘 다 통과", "READY",
     lambda d: d.update(runs=[run(d="full"), run(d="scoped", command=SCOPED, passed=23, log="Executed 23 tests\n")]))
case("하한 정확히 900", "READY", lambda d: d.update(runs=[run(log="units passed 900 · skipped 0\n")]))
case("정책에 하한 없음이면 단위 판정 안 함", "READY",
     lambda d: (d["policy"].pop("min_unit_tests"), d.update(runs=[run(log=None)])))
case("줄 머리가 아닌 units passed 는 안 셈", "NOT_READY", lambda d: d.update(runs=[run(log="echo units passed 948\n")]))
case("created_at 시간대 없음", "NOT_READY", lambda d: d["runs"][0]["manifest"].update(created_at="2026-11-05T12:00:00"), "created_at")


def main():
    bad = 0
    for name, expect, mutate, must in CASES:
        d = copy.deepcopy(BASE)
        mutate(d)
        status, lines = g.judge(d)
        text = "\n".join(lines)
        ok = status == expect and (must is None or must in text)
        if not ok:
            bad += 1
            print(f"✗ {name}: got {status} (expect {expect}){' — missing ' + repr(must) if must and must not in text else ''}\n{text}\n")
        else:
            print(f"✓ {name}")

    # 조회 실패 = UNKNOWN(exit 3), 정책 없는 저장소 = NOT_READY(exit 1). main() 의 분기를 그대로 탄다.
    orig = g.fetch

    def boom(repo, number):
        raise g.Unknown("gh api 실패")
    g.fetch = boom
    rc = g.main(["pr-gate", REPO, "372"])
    bad += rc != 3
    print(("✓" if rc == 3 else "✗") + f" 조회 실패 → exit {rc} (expect 3)")

    def nopolicy(repo, number):
        raise LookupError("no policy")
    g.fetch = nopolicy
    rc = g.main(["pr-gate", "example/unlisted", "1"])
    bad += rc != 1
    print(("✓" if rc == 1 else "✗") + f" 정책 없는 저장소 → exit {rc} (expect 1)")
    g.fetch = orig

    # 실제 fetch→judge→main 경로: manifest 하나가 HTTP 503 이면 UNKNOWN(3), 404 면 '못 읽음'(1).
    import json as _json
    pr_json = {"head": {"sha": HEAD}, "state": "open", "draft": False, "base": {"ref": "main"}, "user": {"login": "author-bot"}}
    tree = {"tree": [{"path": "r1/manifest.json"}, {"path": "r2/manifest.json"}]}
    good = run(d="r1")["manifest"]

    def fake_gh(fail_with, target="r2/manifest.json"):
        def gh(*args):
            path = args[-1]
            if args[:2] == ("pr", "view"):
                return _json.dumps({"mergeable": "MERGEABLE"})
            if path.endswith("/pulls/372"):
                return _json.dumps(pr_json)
            if "/compare/" in path:
                return _json.dumps({"behind_by": 0})
            if path.endswith("/reviews"):
                return _json.dumps([[review()]])
            if "matching-refs" in path:
                return _json.dumps([{"ref": "refs/heads/evidence/app-372-a6bcb36", "object": {"sha": "e" * 40}}])
            if "/git/trees/" in path:
                return _json.dumps(tree)
            if target in path:
                raise fail_with("gh api 실패: HTTP " + ("503" if fail_with is g.Unknown else "404"))
            if "r2/manifest.json" in path:
                return _json.dumps(run(d="r2")["manifest"])
            if "r1/manifest.json" in path:
                return _json.dumps(good)
            if "xcresult-summary.json" in path:
                raise g.NotFound("HTTP 404")
            if "/run.log" in path:
                return "units passed 948 · skipped 0\n"
            raise AssertionError(path)
        return gh

    orig_gh = g.gh
    for fail_with, target, expect, label in ((g.Unknown, "r2/manifest.json", 3, "manifest 503"),
                                             (g.NotFound, "r2/manifest.json", 1, "manifest 404"),
                                             (g.Unknown, "r2/run.log", 3, "run.log 503"),
                                             (g.NotFound, "r2/run.log", 0, "run.log 404 (다른 run 이 단위 전체)")):
        g.gh = fake_gh(fail_with, target)
        rc = g.main(["pr-gate", REPO, "372"])
        bad += rc != expect
        print(("✓" if rc == expect else "✗") + f" {label} → exit {rc} (expect {expect})")
    g.gh = orig_gh
    extra = 4

    # gh() 가 404 와 그 밖의 실패를 가르는지 — gh 를 실제로 부르지 않고 subprocess 결과만 주입한다.
    import subprocess as _sp
    orig_run = g.subprocess.run
    for stderr, want in (("gh: Not Found (HTTP 404)", g.NotFound), ("gh: Service Unavailable (HTTP 503)", g.Unknown)):
        g.subprocess.run = lambda *a, **k: _sp.CompletedProcess(a, 1, "", stderr)
        try:
            g.gh("api", "x")
            got = None
        except g.Unknown as e:
            got = type(e)
        ok = got is want
        bad += not ok
        extra += 1
        print(("✓" if ok else "✗") + f" gh() {stderr[-10:]} → {getattr(got, '__name__', got)} (expect {want.__name__})")
    g.subprocess.run = orig_run

    print(f"\n  통과 {len(CASES) + 2 + extra - bad} · 실패 {bad}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
