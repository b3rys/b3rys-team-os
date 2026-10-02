#!/usr/bin/env bash
# expect-report — 팀장 응답 가드 자가등록 (GD 2026-07-18).
# "작업이 길어져서 팀장 보고를 잊으면 안 되겠다" 싶을 때 스스로 건다:
#   등록 → 기한(기본 10분 = 팀 작업 기준시간) 내 무보고면 ★1회성★ 재알림 → 보고 or 재등록은 네 결정.
#   알림은 딱 한 번 — 스팸 없음.
#
# 사용:
#   expect-report.sh --thread <지금 작업 thread>            # 10분 뒤 리마인드
#   expect-report.sh --thread <t> --in 30m                  # 기한 지정 (10m/30m/1h/'30'=30분)
#   expect-report.sh --thread <t> --cancel                  # 보고 마쳤으면 스스로 정리
#
# · 신원은 워크스페이스에서 자동(_me.sh) — 누구인지 적지 않는다.
# · 런타임에 따라 두 경로로 간다. 어느 쪽이든 명령은 같다.
#   - 턴기반(openclaw/hermes_agent): 서버 follow-up 추적. 기한 안에 보고(버스/--direct-to-gd)가
#     보이면 서버가 알아서 무시한다.
#   - 그 밖(claude·codex): 서버는 이 런타임을 추적하지 않는다(not_one_shot_runtime) — 팀장 1:1 보고가
#     서버에 안 보여서 '보고했는지' 를 잴 수 없기 때문이다. 대신 팀 스케줄러에 ★나를 깨우는 1회성
#     리마인더★ 를 건다. 보고했는지는 깨어난 내가 판단한다. --cancel 이 그 리마인더를 취소한다.
# · --thread 는 ★실제 작업 thread★ 여야 한다 — 보고 감지·취소가 thread 로 묶인다. 자작 금지.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API="${TEAM_INBOX_API_BASE:-http://127.0.0.1:7878/team/api}"
STATE_DIR="${EXPECT_REPORT_STATE_DIR:-$HOME/.b3os/expect-report}"
THREAD=""; IN=""; CANCEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --thread) THREAD="$2"; shift 2 ;;
    --in) IN="$2"; shift 2 ;;
    --cancel) CANCEL=1; shift ;;
    *) echo "unknown arg: $1" >&2; echo "usage: expect-report.sh --thread <t> [--in 10m] [--cancel]" >&2; exit 1 ;;
  esac
done
[ -n "$THREAD" ] || { echo "usage: expect-report.sh --thread <t> [--in 10m] [--cancel]" >&2; exit 2; }
ME="${EXPECT_REPORT_ME:-$("$HERE/_me.sh")}"
[ -n "$ME" ] || { echo "✖ 신원 해석 실패 (_me.sh) — 멤버 워크스페이스에서 실행해라" >&2; exit 1; }

# 리마인더 id 를 thread 별로 기억한다(--cancel 용). 파일 이름에 쓸 수 없는 글자는 _ 로.
SAFE_THREAD="$(printf '%s' "$THREAD" | tr -c 'A-Za-z0-9._-' '_')"
STATE_FILE="$STATE_DIR/${ME}__${SAFE_THREAD}.id"

if [ -n "$CANCEL" ]; then
  curl -sS -X DELETE "$API/followup/self" -H 'content-type: application/json' \
    -d "{\"agent_id\":\"$ME\",\"thread_id\":\"$THREAD\"}"
  echo
  if [ -f "$STATE_FILE" ]; then
    JOB_ID="$(cat "$STATE_FILE")"
    curl -sS -X POST "$API/schedules/$JOB_ID/cancel" -H 'content-type: application/json' -d '{}'
    echo
    rm -f "$STATE_FILE"
  fi
  exit 0
fi

RESP="$(curl -sS -X POST "$API/followup/self" -H 'content-type: application/json' \
  -d "{\"agent_id\":\"$ME\",\"thread_id\":\"$THREAD\",\"duration\":\"${IN:-10m}\"}")"
case "$RESP" in
  *not_one_shot_runtime*) ;;
  *) echo "$RESP"; exit 0 ;;
esac

# claude·codex: 스케줄러 리마인더로 나를 깨운다.
DELAY="$(python3 - "${IN:-10m}" <<'PY'
import re, sys
s = sys.argv[1].strip().lower()
m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)?", s)
if not m or float(m.group(1)) <= 0:
    sys.exit(1)
unit = m.group(2) or "m"
mult = 1 if unit.startswith("s") else 3600 if unit.startswith("h") else 60
print(round(float(m.group(1)) * mult))
PY
)" || { echo "✖ --in 값을 못 읽었다: ${IN} (예: 10m, 30m, 1h, 30)" >&2; exit 1; }

BODY_JSON="$(python3 - "$ME" "$THREAD" "$DELAY" <<'PY'
import json, sys
me, thread, delay = sys.argv[1], sys.argv[2], int(sys.argv[3])
mins = max(1, round(delay / 60))
body = (f"[보고 리마인더] thread={thread} — {mins}분 전에 '팀장님께 보고할 일' 로 걸어 둔 리마인더다. "
        f"보고했으면 아무것도 하지 않는다. 안 했으면 지금 보고하거나, 더 걸리면 expect-report.sh 로 다시 건다.")
print(json.dumps({"target_agent_id": me, "delay_seconds": delay, "title": f"expect-report {thread}"[:200], "body": body}, ensure_ascii=False))
PY
)"
RESP2="$(curl -sS -X POST "$API/schedules/reminder" -H 'content-type: application/json' -d "$BODY_JSON")"
JOB_ID="$(printf '%s' "$RESP2" | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["job"]["id"])
except Exception: pass')"
if [ -z "$JOB_ID" ]; then
  echo "✖ 리마인더 등록 실패: $RESP2" >&2
  exit 1
fi
mkdir -p "$STATE_DIR"
# 같은 thread 에 이미 걸린 리마인더가 있으면 새 것으로 바꾼다(중복 알림 방지).
if [ -f "$STATE_FILE" ]; then
  curl -sS -o /dev/null -X POST "$API/schedules/$(cat "$STATE_FILE")/cancel" -H 'content-type: application/json' -d '{}' || true
fi
printf '%s' "$JOB_ID" > "$STATE_FILE"
echo "{\"ok\":true,\"via\":\"scheduler_reminder\",\"job_id\":\"$JOB_ID\",\"delay_seconds\":$DELAY}"
