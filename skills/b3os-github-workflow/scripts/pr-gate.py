#!/usr/bin/env python3
"""PR 머지 준비 확인 — ★읽기 전용★. 머지·브랜치 변경·시험 실행을 하지 않는다.

사용: pr-gate.sh <owner/repo> <pr>   (또는 python3 pr-gate.py <owner/repo> <pr>)

━━ 무엇을 보나 ━━
  ① PR 이 열려 있고 draft 가 아니며 GitHub 이 MERGEABLE 이라고 답한다
  ② base(정책의 base) 대비 behind 0
  ③ 시험 증거: 정책의 증거 브랜치 manifest 가 ★이 repo·이 PR·지금 head★ 이고, 실패 0·통과 > 0
  ④ 승인: approver-check.py(release-preflight 와 같은 판정부)가 OK 이고, 그 승인이 ★지금 head★ 에 달렸다.
     작성 계정·승인 계정·승인자 명단은 ★정책 파일의 approval★ 에서 읽는다 — 기계마다 다른 팀 설정에서 읽으면
     같은 PR 을 두 기계가 다르게 판정한다.

━━ 결과 ━━
  READY            (exit 0) 위 네 가지 통과. ★검사 결과일 뿐 머지 허가가 아니다★ — 팀장 승인 필요 여부는 정책 줄을 본다.
  WAITING_APPROVAL (exit 2) 승인만 빠졌다. 이 출력을 붙여 리뷰어에게 승인을 요청하면 된다.
  NOT_READY        (exit 1) 승인 말고도 빠진 것이 있다.
  UNKNOWN          (exit 3) GitHub·설정 조회가 실패했다. ★모르는 것은 통과가 아니다.★

판정(judge)은 네트워크 없이 시험할 수 있게 조회(fetch)와 나눴다 — pr-gate.test.py.
"""
import importlib.util
import json
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
POLICY_PATH = HERE / "pr-gate-policy.json"

# 승인 판정은 release-preflight 의 부품을 그대로 쓴다 — 두 도구의 판정이 갈리지 않게.
_spec = importlib.util.spec_from_file_location(
    "approver_check", HERE.parent.parent / "b3os-release-ops" / "scripts" / "approver-check.py")
approver = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(approver)


class Unknown(Exception):
    """조회 실패 — 판정할 수 없다."""


# ── 판정 (순수 함수) ─────────────────────────────────────────────────────────

def run_failure(m):
    """통과한 run 이면 None, 아니면 이유."""
    tests = m.get("tests") if isinstance(m.get("tests"), dict) else {}
    failed, passed = tests.get("failedTests"), tests.get("passedTests")
    if m.get("exit_code") != 0 or m.get("result") != "Passed":
        return f'결과가 통과가 아니다 (exit {m.get("exit_code")}, {m.get("result")})'
    if not isinstance(failed, int) or not isinstance(passed, int) or failed != 0 or passed <= 0:
        return f"시험 수가 비었거나 실패가 있다 (통과 {passed} · 실패 {failed})"
    return None


UNITS_LINE = re.compile(r"^units passed (\d+)\b", re.M)


def units_passed(log):
    """dev-check.sh 의 판정 줄(`units passed N · …`)에서 N. 없으면 None — 단위 전체를 돌리지 않은 run 이다."""
    hits = UNITS_LINE.findall(log) if isinstance(log, str) else []
    return int(hits[-1]) if hits else None


def judge_evidence(repo, pr, head, runs, min_units=None):
    """runs = [{"branch", "dir", "manifest": dict|None, "summary": dict|None, "log": str|None}]. (ok, 줄들).

    min_units 가 있으면 통과한 최신 run 중 하나는 dev-check.sh 의 `units passed N` 이 N ≥ min_units 여야 한다.
    manifest 의 통과 수는 붙인 결과 묶음만 세서(UI 만일 수 있다) 단위 전체를 돌렸는지 알려 주지 않는다.

    지금 head 의 run 을 같은 명령(시험 범위)끼리 묶고 ★묶음마다 가장 늦은 run 만★ 본다.
    이전에 통과하고 나중에 실패했으면 실패다 — 첫 통과를 고르면 최신 실패가 가려진다.
    실패 뒤 다시 돌려 통과했으면 통과다. 묶음 하나라도 최신이 실패면 증거 전체가 실패다.
    """
    if not runs:
        return False, ["증거 브랜치가 없다"]
    lines, other_heads, groups, unreadable = [], set(), {}, []
    for run in runs:
        m = run.get("manifest")
        where = f'{run.get("branch")}:{run.get("dir")}'
        if not isinstance(m, dict):
            # 못 읽은 run 이 최신 실패일 수 있다 — 건너뛰지 않고 막는다.
            unreadable.append(f"{where} manifest 를 읽지 못했다")
            continue
        if m.get("repo") != repo or str(m.get("pr")) != str(pr):
            lines.append(f'{where} 는 {m.get("repo")}#{m.get("pr")} 의 증거다')
            continue
        before, after = m.get("head_before"), m.get("head_after")
        if before != head or after != head:
            other_heads.add((after or before or "?")[:8])
            continue
        try:
            # 문자열 비교는 시간대가 섞이면 틀린다 — 시각으로 바꿔 비교한다.
            at = datetime.fromisoformat(str(m.get("created_at") or ""))
            if at.tzinfo is None:
                raise ValueError("시간대 없음")
        except ValueError:
            # 순서를 모르면 어느 쪽이 최신인지 판정할 수 없다 — 막는다.
            unreadable.append(f'{where} created_at({m.get("created_at")}) 으로 최신 run 을 정할 수 없다')
            continue
        groups.setdefault(str(m.get("command") or ""), []).append((at, where, run))
    if unreadable:
        return False, unreadable + lines
    if not groups:
        if other_heads:
            lines.append("지금 head 의 증거가 없다 — 있는 증거의 head: " + ", ".join(sorted(other_heads)))
        return False, lines or ["지금 head 의 증거가 없다"]
    passed_lines, failed_lines, best_units = [], [], None
    for _, items in sorted(groups.items()):
        # 증거는 초 단위로 찍혀 같은 시각이 나올 수 있다. 같은 시각끼리는 실제 순서를 알 수 없으므로
        # (branch·dir 이름은 실행 순서가 아니다) 최신 시각의 run 이 여럿이면 하나라도 실패면 막는다.
        newest = max(at for at, _, _ in items)
        tied = [(where, run) for at, where, run in items if at == newest]
        fails = [(where, why) for where, run in tied if (why := run_failure(run["manifest"]))]
        if fails:
            failed_lines.extend(f"{where} ({newest.isoformat()}, 같은 명령 최신{' · 같은 시각 ' + str(len(tied)) + '개' if len(tied) > 1 else ''}) {why}"
                                for where, why in fails)
            continue
        where, run = tied[0]
        per_device = []
        summary = run.get("summary") if isinstance(run.get("summary"), dict) else {}
        for d in summary.get("devicesAndConfigurations") or []:
            dev = (d.get("device") or {}).get("deviceName", "?")
            per_device.append(f'{dev} {d.get("passedTests")}/{d.get("failedTests")}')
        detail = " · ".join(per_device) or "기기별 요약 없음"
        passed = run["manifest"]["tests"]["passedTests"]
        units = max((u for _, r in tied if (u := units_passed(r.get("log"))) is not None), default=None)
        if units is not None:
            best_units = units if best_units is None else max(best_units, units)
            detail += f" · 단위 {units}"
        passed_lines.append(f"{where} head {head[:8]} 통과 {passed}/실패 0 ({detail})")
    if failed_lines:
        return False, failed_lines + passed_lines + lines
    if min_units is not None and (best_units is None or best_units < min_units):
        found = "없다" if best_units is None else f"{best_units} 뿐이다"
        return False, [f"단위 전체 결과가 {found} — dev-check.sh 의 'units passed N' 이 N ≥ {min_units} 인 run 이 필요하다"] + passed_lines + lines
    return True, passed_lines + lines


def approval_settings(policy):
    """정책의 approval 을 approver-check 가 읽는 설정 모양으로 바꾼다. 비어 있으면 approver-check 가 막는다."""
    a = policy.get("approval") if isinstance(policy.get("approval"), dict) else {}
    return {"github_team_account": a.get("author_account", ""),
            "github_approver_account": a.get("approver_account", ""),
            "merge_approvers_normal": ",".join(a.get("approvers") or [])}


def judge_approval(settings, reviews, pr_author, head):
    ok, msg = approver.check(settings, reviews, pr_author)
    if not ok:
        return False, msg
    stale = [(a, (r.get("commit_id") or "?")[:8]) for a, r in approver.standing_approvals(reviews)
             if r.get("commit_id") != head]
    if stale:
        return False, "승인이 지금 head 가 아닌 커밋에 있다: " + ", ".join(f"{a}@{c}" for a, c in stale)
    return True, msg + f" @ {head[:8]}"


def judge(data):
    """data = fetch() 결과. (status, 줄들)."""
    policy, pr = data["policy"], data["pr"]
    head = pr["head"]
    out, blockers = [], 0

    def line(ok, label, msg):
        nonlocal blockers
        out.append(f'{"OK  " if ok else "MISS"} {label}: {msg}')
        if not ok:
            blockers += 1

    line(pr["state"] == "OPEN" and not pr["draft"], "PR", f'{pr["state"]}{" draft" if pr["draft"] else ""} · head {head[:8]}')
    # GitHub 이 아직 계산 중이면 UNKNOWN 이 온다 — 모르는 것은 통과가 아니다.
    line(pr["mergeable"] == "MERGEABLE", "충돌", pr["mergeable"])
    line(pr["base"] == policy["base"], "base", pr["base"])
    line(data["behind_by"] == 0, "behind", f'{policy["base"]} 대비 {data["behind_by"]}')
    if policy.get("evidence") == "required":
        ok, lines = judge_evidence(data["repo"], data["number"], head, data["runs"], policy.get("min_unit_tests"))
        line(ok, "증거", lines[0])
        out.extend("     " + l for l in lines[1:])
    a_ok, a_msg = judge_approval(approval_settings(policy), data["reviews"], pr["author"], head)
    out.append(f'{"OK  " if a_ok else "MISS"} 승인: {a_msg}')
    out.append(f'정책 시험 범위: {policy.get("required_tests", "-")}')
    out.append(f'정책 팀장 승인: {policy.get("lead_approval", "-")} · 머지 방식 {policy.get("merge_method", "-")}')
    if blockers:
        return "NOT_READY", out
    if not a_ok:
        return "WAITING_APPROVAL", out
    return "READY", out


# ── 조회 ─────────────────────────────────────────────────────────────────────

class NotFound(Unknown):
    """GitHub 이 404 로 답했다 — 조회 실패가 아니라 '없다' 는 답이다."""


def gh(*args):
    r = subprocess.run(["gh", *args], capture_output=True, text=True)
    if r.returncode != 0:
        err = r.stderr.strip()[:200]
        raise (NotFound if "HTTP 404" in err else Unknown)(f"gh {' '.join(args[:2])} 실패: {err}")
    return r.stdout


def gh_json(path, paginate=False):
    raw = gh("api", *(["--paginate", "--slurp"] if paginate else []), path)
    try:
        data = json.loads(raw)
    except ValueError as e:
        raise Unknown(f"{path} 응답이 JSON 이 아니다: {e}")
    if paginate:
        data = [x for page in data for x in page]
    return data


def gh_text(repo, ref, path):
    """파일 본문. 없으면(404) None, 그 밖의 조회 실패는 Unknown."""
    try:
        return gh("api", "-H", "Accept: application/vnd.github.raw", f"repos/{repo}/contents/{path}?ref={ref}")
    except NotFound:
        return None


def gh_file(repo, ref, path):
    """파일이 없거나(404) JSON 이 아니면 None — 판정에서 '못 읽었다' 로 막힌다.
    그 밖의 조회 실패(5xx·인증·네트워크)는 Unknown 으로 올린다 — 없는 것과 모르는 것은 다르다."""
    try:
        raw = gh("api", "-H", "Accept: application/vnd.github.raw", f"repos/{repo}/contents/{path}?ref={ref}")
    except NotFound:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def fetch(repo, number):
    policies = json.loads(POLICY_PATH.read_text())
    if repo not in policies:
        raise LookupError(f"{repo} 는 pr-gate-policy.json 에 없다 — 이 저장소는 판정하지 않는다")
    policy = policies[repo]
    p = gh_json(f"repos/{repo}/pulls/{number}")
    # GitHub 은 mergeable 을 처음 물을 때 계산을 시작하고 UNKNOWN 을 준다 — 잠깐 기다려 두 번 더 묻는다.
    for attempt in range(3):
        gql = json.loads(gh("pr", "view", str(number), "-R", repo, "--json", "mergeable"))
        if gql.get("mergeable") != "UNKNOWN" or attempt == 2:
            break
        time.sleep(2)
    pr = {"head": p["head"]["sha"], "state": "OPEN" if p["state"] == "open" else p["state"].upper(),
          "draft": bool(p.get("draft")), "base": p["base"]["ref"], "author": p["user"]["login"],
          "mergeable": gql.get("mergeable") or "UNKNOWN"}
    behind = gh_json(f'repos/{repo}/compare/{policy["base"]}...{pr["head"]}')["behind_by"]
    reviews = gh_json(f"repos/{repo}/pulls/{number}/reviews", paginate=True)
    runs = []
    if policy.get("evidence") == "required":
        prefix = f'{policy["evidence_branch_prefix"]}{number}-'
        for ref in gh_json(f"repos/{repo}/git/matching-refs/heads/{prefix}"):
            branch = ref["ref"].removeprefix("refs/heads/")
            tree = gh_json(f'repos/{repo}/git/trees/{ref["object"]["sha"]}?recursive=1')
            for t in tree.get("tree", []):
                if t["path"].endswith("/manifest.json") and t["path"].count("/") == 1:
                    d = t["path"].split("/")[0]
                    runs.append({"branch": branch, "dir": d,
                                 "manifest": gh_file(repo, ref["object"]["sha"], t["path"]),
                                 "summary": gh_file(repo, ref["object"]["sha"], f"{d}/xcresult-summary.json"),
                                 "log": gh_text(repo, ref["object"]["sha"], f"{d}/run.log")
                                 if policy.get("min_unit_tests") is not None else None})
    return {"repo": repo, "number": number, "policy": policy, "pr": pr, "behind_by": behind,
            "reviews": reviews, "runs": runs}


EXIT = {"READY": 0, "NOT_READY": 1, "WAITING_APPROVAL": 2, "UNKNOWN": 3}


def main(argv):
    if len(argv) != 3 or "/" not in argv[1] or not argv[2].isdigit():
        print("사용: pr-gate.sh <owner/repo> <pr>", file=sys.stderr)
        return 64
    repo, number = argv[1], int(argv[2])
    try:
        status, lines = judge(fetch(repo, number))
    except LookupError as e:
        status, lines = "NOT_READY", [f"MISS 정책: {e}"]
    except Unknown as e:
        status, lines = "UNKNOWN", [f"???  {e}"]
    print(f"pr-gate {repo}#{number}")
    print("\n".join(lines))
    print(f"결과: {status}" + (" — 검사 통과일 뿐 머지 허가가 아니다" if status == "READY" else ""))
    return EXIT[status]


if __name__ == "__main__":
    sys.exit(main(sys.argv))
