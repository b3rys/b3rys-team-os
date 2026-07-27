#!/usr/bin/env bash
# task-new.sh — 칸반 카드를 만든다.
#
# ★왜 생겼나★ (2026-07-27, 제인 제보)
#   이 폴더에 조회(task-check)·닫기(task-close)·대기(task-wait)는 있는데 ★만드는 것만 없었다.★
#   BWF 스킬은 "착수 즉시 칸반 카드 등록(필수·자동)" 이라고 못박아놨는데 그걸 실행할 도구가 없었다.
#   그래서 카드를 만들려면 소스를 뒤져 POST /team/api/tasks 를 찾아내야 했다 — 일하다가 그걸 뒤질 사람은 없다.
#   실제로 맥스튜디오 팀(4명)의 칸반은 ★0건★ 이었다. 규칙 문제가 아니라 도구 문제였다.
#
# 사용:
#   task-new.sh --title "..." [--owner <id>] [--lane plan|doing|done] [--desc "..."]
#
#   --owner 를 생략하면 ★자기 자신★ 이 담당이 된다(_me.sh 로 판정).
#   --lane  기본값은 plan. 바로 착수하는 일이면 --lane doing.
#
# 예:
#   task-new.sh --title "[infra] openclaw 게이트웨이 재기동 근본수정"
#   task-new.sh --title "슬랙 문서 정리" --owner steve --lane doing --desc "SLACK_SETUP 이 옛 방식을 안내"
#
# 환경:
#   TEAM_BASE  기본 http://127.0.0.1:7878/team
#   ★라이브 트리의 스크립트를 절대경로로 부를 것★ — 워크트리(작업 사본)에서 부르면
#     그 사본의 team.db 를 보게 돼 신원 판별에 실패한다.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TEAM_BASE="${TEAM_BASE:-http://127.0.0.1:7878/team}"

TITLE=""; OWNER=""; LANE="plan"; DESC=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --title) TITLE="$2"; shift 2;;
    --owner) OWNER="$2"; shift 2;;
    --lane|--column) LANE="$2"; shift 2;;
    --desc|--description) DESC="$2"; shift 2;;
    -h|--help) sed -n '1,30p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

[ -n "$TITLE" ] || { echo "ERROR: --title 필요" >&2; exit 2; }
case "$LANE" in
  plan|doing|done) ;;
  *) echo "ERROR: --lane 은 plan|doing|done 중 하나여야 합니다 (받은 값: $LANE)" >&2; exit 2;;
esac

# owner 미지정 = 자기 자신. team-inbox 의 _me.sh 를 재사용한다(신원 판정 로직을 두 벌로 만들지 않는다).
if [ -z "$OWNER" ]; then
  ME_SH="$HERE/../../b3os-team-inbox/scripts/_me.sh"
  if [ -x "$ME_SH" ]; then
    OWNER="$("$ME_SH" 2>/dev/null || true)"
  fi
  [ -n "$OWNER" ] || {
    echo "ERROR: 담당자를 정할 수 없습니다. --owner <id> 로 명시하거나, 자기 워크스페이스에서 실행하세요." >&2
    exit 2
  }
fi

RESP="$(TITLE="$TITLE" OWNER="$OWNER" LANE="$LANE" DESC="$DESC" python3 -c "
import json, os, sys, urllib.request, urllib.error
payload = {'title': os.environ['TITLE'], 'owner': os.environ['OWNER'], 'column': os.environ['LANE']}
if os.environ.get('DESC'): payload['description'] = os.environ['DESC']
req = urllib.request.Request('${TEAM_BASE}/api/tasks',
    data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
    headers={'content-type': 'application/json'})
try:
    print(urllib.request.urlopen(req, timeout=15).read().decode('utf-8'))
except urllib.error.HTTPError as e:
    print(json.dumps({'ok': False, 'error': 'http_%d' % e.code, 'detail': e.read().decode('utf-8', 'replace')[:200]}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({'ok': False, 'error': 'unreachable', 'detail': str(e)[:200]}, ensure_ascii=False))
")"

# ★서버가 200 을 줬다고 만들어진 게 아니다★ — ok 와 id 를 실제로 확인하고, 아니면 실패로 끝낸다.
echo "$RESP" | RESP_LANE="$LANE" RESP_OWNER="$OWNER" python3 -c "
import json, os, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception:
    print('✖ 응답을 해석할 수 없습니다: ' + raw[:200], file=sys.stderr); sys.exit(1)
if not d.get('ok') or not (d.get('task') or {}).get('id'):
    print('✖ 카드 생성 실패: ' + json.dumps(d, ensure_ascii=False)[:300], file=sys.stderr); sys.exit(1)
t = d['task']
print('✓ 카드 생성 id=%s lane=%s owner=%s' % (t['id'], t.get('lane', os.environ['RESP_LANE']), t.get('owner') or os.environ['RESP_OWNER']))
print('  ' + t.get('title', ''))
"
