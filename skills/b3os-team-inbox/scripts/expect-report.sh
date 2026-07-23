#!/usr/bin/env bash
# expect-report — 팀장 응답 가드 자가등록 (GD 2026-07-18).
# "작업이 길어져서 팀장 보고를 잊으면 안 되겠다" 싶을 때 스스로 건다:
#   등록 → 기한(기본 10분 = 팀 작업 기준시간) 내 무보고면 ★1회성★ 재알림 → 보고 or 재등록은 네 결정.
#   이미 보고했으면(버스/direct-to-gd 경유) 서버가 알아서 무시한다. 알림은 딱 한 번 — 스팸 없음.
#
# 사용:
#   expect-report.sh --thread <지금 작업 thread>            # 10분 뒤 리마인드
#   expect-report.sh --thread <t> --in 30m                  # 기한 지정 (10m/30m/1h/'30'=30분)
#   expect-report.sh --thread <t> --cancel                  # 보고 마쳤으면 스스로 정리
#
# · 신원은 워크스페이스에서 자동(_me.sh) — 누구인지 적지 않는다.
# · 턴기반(openclaw/hermes_agent)만 등록된다 — 아니면 서버가 ★이유와 함께★ 거절한다 (조용히 안 죽음).
# · --thread 는 ★실제 작업 thread★ 여야 한다 — 보고 감지가 thread 로 묶인다. 자작 금지.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API="${TEAM_INBOX_API_BASE:-http://127.0.0.1:7878/team/api}"
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
if [ -n "$CANCEL" ]; then
  curl -sS -X DELETE "$API/followup/self" -H 'content-type: application/json' \
    -d "{\"agent_id\":\"$ME\",\"thread_id\":\"$THREAD\"}"
else
  curl -sS -X POST "$API/followup/self" -H 'content-type: application/json' \
    -d "{\"agent_id\":\"$ME\",\"thread_id\":\"$THREAD\",\"duration\":\"${IN:-10m}\"}"
fi
echo
