#!/usr/bin/env bash
# pr-gate.mutants.sh — 판정의 각 가드를 되돌렸을 때 pr-gate.test.py 가 빨개지는지 확인한다.
# 변이가 파일에 안 걸리면 그 자체를 오류로 낸다('안 걸린 것' 과 '안 잡힌 것' 은 다른 문제다).
# 사용: bash skills/b3os-github-workflow/scripts/pr-gate.mutants.sh
set -uo pipefail
cd "$(dirname "$0")"
S=pr-gate.py
T=pr-gate.test.py
ORIG="$(mktemp)"; cp "$S" "$ORIG"; trap 'cp "$ORIG" "$S"; rm -f "$ORIG"' EXIT
bad=0

mutate() {  # mutate <설명> <찾을 문자열> <바꿀 문자열>
  local desc="$1"
  if ! MUT_FROM="$2" MUT_TO="$3" python3 - "$S" <<'PY'
import os, sys
p = sys.argv[1]; s = open(p).read()
f, t = os.environ["MUT_FROM"], os.environ["MUT_TO"]
if f not in s:   sys.exit(3)
if s.count(f) != 1: sys.exit(4)
open(p, "w").write(s.replace(f, t, 1))
PY
  then
    printf '  %-40s → ✖ 변이가 안 걸렸다 — 이 스크립트가 낡았다\n' "$desc"
    bad=$((bad+1)); cp "$ORIG" "$S"; return
  fi
  local fails
  fails="$(python3 "$T" 2>&1 | tail -1 | sed -n 's/.*실패 \([0-9]*\).*/\1/p')"
  printf '  %-40s → 실패 %s건' "$desc" "${fails:-?}"
  if [ "${fails:-0}" = "0" ]; then printf '   ✖ 이 가드는 시험이 없다'; bad=$((bad+1)); fi
  printf '\n'
  cp "$ORIG" "$S"
}

echo "── 뮤턴트: 되돌리면 빨개져야 그 시험이 살아있다 ──"
mutate "① 승인 head 대조 제거" '             if r.get("commit_id") != head]' '             if False]'
mutate "② mergeable UNKNOWN 통과" 'line(pr["mergeable"] == "MERGEABLE",' 'line(pr["mergeable"] != "CONFLICTING",'
mutate "③ behind 검사 제거" 'line(data["behind_by"] == 0,' 'line(True,'
mutate "④ 증거 head 대조 제거" '        if before != head or after != head:' '        if False:'
mutate "⑤ 증거 repo·PR 대조 제거" '        if m.get("repo") != repo or str(m.get("pr")) != str(pr):' '        if False:'
mutate "⑥ 실패 수 검사 제거" 'failed != 0 or passed <= 0:' 'passed <= 0:'
mutate "⑦ 시험 수 0 허용" 'failed != 0 or passed <= 0:' 'failed != 0:'
mutate "⑧ exit·result 검사 제거" '    if m.get("exit_code") != 0 or m.get("result") != "Passed":' '    if False:'
mutate "⑨ 막힘보다 승인 대기를 먼저" '    if blockers:
        return "NOT_READY", out' '    if blockers and a_ok:
        return "NOT_READY", out'
mutate "⑩ draft 통과" 'pr["state"] == "OPEN" and not pr["draft"]' 'pr["state"] == "OPEN"'
mutate "⑪ 조회 실패를 READY 로" '"UNKNOWN": 3}' '"UNKNOWN": 0}'

mutate "⑫ 명령별 최신 대신 가장 이른 run" '        newest = max(at for at, _, _ in items)' '        newest = min(at for at, _, _ in items)'
mutate "⑯ 같은 시각 묶음에서 첫 run 만" '        fails = [(where, why) for where, run in tied if' '        fails = [(where, why) for where, run in tied[:1] if'
mutate "⑰ 시간대 없는 created_at 허용" '            if at.tzinfo is None:' '            if False:'
mutate "⑬ 못 읽은 manifest 건너뛰기" '    if unreadable:
        return False, unreadable + lines' '    if False:
        return False, unreadable + lines'
mutate "⑭ 조회 실패(5xx)를 없음으로 삼킴" '    except NotFound:
        return None
    try:' '    except Unknown:
        return None
    try:'
mutate "㉒ run.log 조회 실패를 없음으로 삼킴" 'f"repos/{repo}/contents/{path}?ref={ref}")
    except NotFound:
        return None


def gh_file' 'f"repos/{repo}/contents/{path}?ref={ref}")
    except Unknown:
        return None


def gh_file'
mutate "⑮ 404 를 조회 실패로" 'raise (NotFound if "HTTP 404" in err else Unknown)' 'raise Unknown'
mutate "⑱ 정책 승인자 명단 대신 아무나" '"merge_approvers_normal": ",".join(a.get("approvers") or [])}' '"merge_approvers_normal": "anyone,else"}'
mutate "⑲ 단위 하한 검사 제거" '    if min_units is not None and (best_units is None or best_units < min_units):' '    if False:'
mutate "⑳ 하한을 1 로" 'best_units < min_units):' 'best_units < 1):'
mutate "㉑ 줄 머리 앵커 제거" 'UNITS_LINE = re.compile(r"^units passed' 'UNITS_LINE = re.compile(r"units passed'

[ "$bad" -eq 0 ] && echo "모든 변이가 잡혔다" || { echo "✖ 문제 $bad 건"; exit 1; }
