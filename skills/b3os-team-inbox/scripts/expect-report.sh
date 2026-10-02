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
ME="$("$HERE/_me.sh")"
[ -n "$ME" ] || { echo "✖ 신원 해석 실패 (_me.sh) — 멤버 워크스페이스에서 실행해라" >&2; exit 1; }

# JSON 은 문자열을 이어 붙이지 않고 python 으로 만든다 — thread 에 " 나 \ 가 들어도 깨지지 않는다.
json_obj() { python3 -c 'import json,sys; it=iter(sys.argv[1:]); print(json.dumps(dict(zip(it,it)), ensure_ascii=False))' "$@"; }
valid_job_id() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_-]{1,64}$'; }

# 리마인더 id 를 thread 별로 기억한다(--cancel 용). 파일 이름은 thread 의 해시 — 글자를 바꿔 끼우면
#   서로 다른 thread(a/b·a:b)가 같은 파일이 되고, 긴 thread 는 파일 이름 한도를 넘는다.
THREAD_KEY="$(printf '%s' "$THREAD" | shasum -a 256 | cut -c1-32)"
STATE_FILE="$STATE_DIR/${ME}__${THREAD_KEY}.id"

# 서버에서 리마인더를 취소한다. 취소됐거나 이미 없으면(404 = 발화·취소 끝) 0, 그 밖은 1.
cancel_job() {
  local id="$1" code
  valid_job_id "$id" || { echo "✖ 상태 파일의 job id 가 이상하다: $id" >&2; return 1; }
  code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/schedules/$id/cancel" -H 'content-type: application/json' -d '{}' || echo 000)"
  case "$code" in 200|404) return 0 ;; *) echo "✖ 리마인더 취소 실패 (HTTP $code): $id" >&2; return 1 ;; esac
}

if [ -n "$CANCEL" ]; then
  curl -sS -X DELETE "$API/followup/self" -H 'content-type: application/json' \
    -d "$(json_obj agent_id "$ME" thread_id "$THREAD")"
  echo
  if [ -f "$STATE_FILE" ]; then
    # 서버 취소가 실패하면 상태를 남긴다 — 지우면 그 리마인더를 다시는 못 지운다.
    cancel_job "$(cat "$STATE_FILE")" || exit 1
    rm -f "$STATE_FILE"
    echo '{"ok":true,"cancelled_reminder":true}'
  fi
  exit 0
fi

RESP="$(curl -sS -X POST "$API/followup/self" -H 'content-type: application/json' \
  -d "$(json_obj agent_id "$ME" thread_id "$THREAD" duration "${IN:-10m}")")"
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
print(json.dumps({"target_agent_id": me, "delay_seconds": delay, "title": f"expect-report {thread}"[:200], "body": body[:2000]}, ensure_ascii=False))
PY
)"
mkdir -p "$STATE_DIR"
RESP2="$(curl -sS -X POST "$API/schedules/reminder" -H 'content-type: application/json' -d "$BODY_JSON")"
JOB_ID="$(printf '%s' "$RESP2" | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["job"]["id"])
except Exception: pass')"
if [ -z "$JOB_ID" ] || ! valid_job_id "$JOB_ID"; then
  echo "✖ 리마인더 등록 실패: $RESP2" >&2
  exit 1
fi
# 새 것을 기억한 다음에 옛 것을 취소한다. 기억에 실패하면 방금 만든 것을 지운다(고아 리마인더 방지).
OLD_ID=""
[ -f "$STATE_FILE" ] && OLD_ID="$(cat "$STATE_FILE")"
TMP_FILE="$STATE_FILE.$$"
if ! { printf '%s' "$JOB_ID" > "$TMP_FILE" && mv -f "$TMP_FILE" "$STATE_FILE"; }; then
  rm -f "$TMP_FILE"
  cancel_job "$JOB_ID" || true
  echo "✖ 상태 파일을 쓰지 못해 방금 만든 리마인더를 취소했다: $STATE_FILE" >&2
  exit 1
fi
# 같은 thread 에 걸려 있던 리마인더는 바꾼다(중복 알림 방지). 실패해도 새 등록은 유효하다.
if [ -n "$OLD_ID" ] && [ "$OLD_ID" != "$JOB_ID" ]; then
  cancel_job "$OLD_ID" || echo "⚠ 앞 리마인더 취소 실패 — 알림이 한 번 더 올 수 있다: $OLD_ID" >&2
fi
echo "{\"ok\":true,\"via\":\"scheduler_reminder\",\"job_id\":\"$JOB_ID\",\"delay_seconds\":$DELAY}"
