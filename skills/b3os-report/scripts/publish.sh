#!/usr/bin/env bash
# b3os-report → /reports 포털 게시 (선택 단계 — OWNER 확인 후에만).
# MD/HTML 파일을 team-collab reports/<id>/ 로 복사하고 메타를 /reports/api/register 에 등록.
# 등록되면 your-team.example.com/reports 목록에 바로 뜬다.
#
# 사용: publish.sh --title "제목" --author bill --summary "요약" [--md a.md] [--html a.html] [--id slug] [--project P]
set -euo pipefail

TEAM_COLLAB="${TEAM_COLLAB_DIR:-$HOME/Development/b3rys-team-os}"
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
[ -z "$ID" ] && ID="$(echo "$TITLE" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9가-힣-')-$(date +%y%m%d)"

DEST="$TEAM_COLLAB/reports/$ID"
mkdir -p "$DEST"

# forms 배열 구성 + 파일 복사 (path 는 reports/ 루트 기준 상대경로)
FORMS="$(python3 - "$ID" "$MD" "$HTML" "$DEST" <<'PY'
import sys, os, shutil, json
id_, md, html, dest = sys.argv[1:5]
forms=[]
for typ, src in (("md", md), ("html", html)):
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
