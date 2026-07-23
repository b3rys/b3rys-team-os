#!/usr/bin/env bash
# b3os-report → /reports 포털 게시 (선택 단계 — GD 확인 후에만).
# MD/HTML 파일을 team-collab reports/<id>/ 로 복사하고 메타를 /reports/api/register 에 등록.
# 등록되면 your-team.example.com/reports 목록에 바로 뜬다.
#
# 사용: publish.sh --title "제목" --author bill --summary "요약" [--md a.md] [--html a.html] [--id slug] [--project P]
set -euo pipefail

# team-collab 루트 해석 — 서버의 reportsDir(<root>/reports)와 반드시 일치해야 등록된다.
# 예전 하드코딩($HOME/Development/...)이 실제 설치 위치와 어긋나면 register 가 파일 부재로 실패했다
# (공개 클린설치는 설치 경로가 다름). ★스크립트 자기 위치 기준이 가장 견고★ — 이 스크립트는
# <root>/skills/b3os-report/scripts/publish.sh 라 ../../.. 가 곧 루트(레포 이름 무관). 우선순위:
# env override → 스크립트상대(agents.json/dist 마커 확인) → 흔한 설치 위치 → 공개 기본.
resolve_root() {
  if [ -n "${TEAM_COLLAB_DIR:-}" ]; then echo "$TEAM_COLLAB_DIR"; return; fi
  local script_dir; script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local from_script; from_script="$(cd "$script_dir/../../.." 2>/dev/null && pwd || true)"
  local cand
  for cand in "$from_script" "$HOME/b3rys-team-os" "$HOME/Development/b3rys-team-os"; do
    [ -n "$cand" ] || continue
    if [ -f "$cand/agents.json" ] || [ -d "$cand/dist/server" ]; then echo "$cand"; return; fi
  done
  echo "$HOME/b3rys-team-os"  # 마커 못 찾을 때 공개 기본(빈 레거시 경로 대신)
}
TEAM_COLLAB="$(resolve_root)"
API="${TEAM_BASE:-http://127.0.0.1:7878}/reports/api/register"

TITLE=""; AUTHOR=""; SUMMARY=""; MD=""; HTML=""; ID=""; PROJECT=""; CATEGORY=""; DATE=""
while [ $# -gt 0 ]; do case "$1" in
  --title) TITLE="$2"; shift 2;; --author) AUTHOR="$2"; shift 2;;
  --summary) SUMMARY="$2"; shift 2;; --md) MD="$2"; shift 2;;
  --html) HTML="$2"; shift 2;; --id) ID="$2"; shift 2;;
  --project) PROJECT="$2"; shift 2;; --category) CATEGORY="$2"; shift 2;;
  --date) DATE="$2"; shift 2;;
  *) echo "unknown arg: $1" >&2; exit 1;;
esac; done

[ -z "$TITLE" ] && { echo "ERROR: --title 필요" >&2; exit 1; }
# id 슬러그 — tr 은 바이트 단위라 em대시(—) 등 멀티바이트 구두점을 못 걸러 경로 오염을 냈다.
# 유니코드 인식 파이썬으로 소문자화·비허용문자 하이픈화·중복/양끝 하이픈 정리.
[ -z "$ID" ] && ID="$(python3 - "$TITLE" "$(date +%y%m%d)" <<'PY'
import sys, re
title, stamp = sys.argv[1], sys.argv[2]
s = title.lower()
s = re.sub(r'[^a-z0-9가-힣]+', '-', s)   # 허용: 영소문자·숫자·한글, 그 외는 하이픈
s = re.sub(r'-{2,}', '-', s).strip('-')  # 중복·양끝 하이픈 제거
print(f"{s}-{stamp}" if s else stamp)
PY
)"

DEST="$TEAM_COLLAB/reports/$ID"
mkdir -p "$DEST"

# forms 배열 구성 + 파일 복사 (path 는 reports/ 루트 기준 상대경로)
# HTML이 있으면 포털의 기본 viewer가 완성된 report HTML을 먼저 연다. MD는 정본/다운로드용 보조 form이다.
FORMS="$(python3 - "$ID" "$MD" "$HTML" "$DEST" <<'PY'
import sys, os, shutil, json
id_, md, html, dest = sys.argv[1:5]
forms=[]
for typ, src in (("html", html), ("md", md)):
    if src and os.path.exists(src):
        fn = f"report.{typ}"
        shutil.copyfile(src, os.path.join(dest, fn))
        forms.append({"type": typ, "path": f"{id_}/{fn}"})
print(json.dumps(forms, ensure_ascii=False))
PY
)"

PAYLOAD="$(python3 - "$ID" "$TITLE" "$AUTHOR" "$SUMMARY" "$PROJECT" "$CATEGORY" "$DATE" "$FORMS" <<'PY'
import sys, json
id_, title, author, summary, project, category, date, forms = sys.argv[1:9]
print(json.dumps({"id": id_, "title": title, "author": author or None,
  "summary": summary or None, "project": project or None, "category": category or None,
  "date": date or None, "forms": json.loads(forms)}, ensure_ascii=False))
PY
)"

CODE="$(curl -s -o /tmp/b3os-report-register.json -w '%{http_code}' -X POST "$API" \
  -H 'content-type: application/json' --data-binary "$PAYLOAD")"
if [ "$CODE" = "200" ]; then
  echo "✅ /reports 게시 완료: id=$ID · forms=$(echo "$FORMS" | python3 -c 'import sys,json;print(",".join(f["type"] for f in json.load(sys.stdin)) or "none")')"
  echo "   → your-team.example.com/reports (또는 http://127.0.0.1:7878/reports)"
else
  echo "❌ 등록 실패 (HTTP $CODE) — team-collab 동작 확인 필요"; cat /tmp/b3os-report-register.json 2>/dev/null; exit 2
fi
