#!/bin/bash
# Reply to a specific message — 올바른 주소로 자동 답장.
#   팀 커뮤니케이션 V1.0 핵심: 회신/인계는 항상 "요청자에게 directed + in_reply_to(원요청 가리킴)"로 보내야
#   요청자 inbox 에 정확히 도착한다(broadcast 로 묻히지 않음). 이 도구가 그 주소를 자동으로 채운다 —
#   에이전트는 "이 메시지에 답해"만 하면 to=원발신자 · in_reply_to=그 메시지 · thread=그 thread 가 자동 설정.
#
# Usage: reply.sh <message_id> (--body "..." | --body-file <경로>) [--priority low|normal|high] [--hop <n>]
#   message_id 는 inbox.sh / thread.sh 출력에 보이는 그 메시지 id.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${TEAM_BASE:-http://127.0.0.1:7878/team}"

MID="${1:-}"
[ -z "$MID" ] && { echo "usage: reply.sh <message_id> --body \"...\"" >&2; exit 1; }
case "$MID" in --*) echo "usage: reply.sh <message_id> --body \"...\"  (첫 인자는 메시지 id)" >&2; exit 1 ;; esac
shift

BODY=""; PRIORITY="normal"; FROM=""; HOP=""; DRY=""; BODY_FILE=""; BODY_SET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --body) BODY="$2"; BODY_SET=1; shift 2 ;;
    # ★--body-file — 본문을 셸 명령줄에 싣지 않는 경로★ (send.sh --body-file · slack-post.sh --text-file 과 같은 이유)
    #   본문에 홑따옴표·백틱·$(cmd)·$VAR·큰따옴표가 있으면 셸이 그것을 해석하거나 인자를 쪼갠다.
    #   send.sh 에는 이 경로가 있었는데 reply.sh 에는 없어서, 답장은 본문을 명령줄로만 보낼 수 있었다.
    --body-file) BODY_FILE="$2"; shift 2 ;;
    --priority) PRIORITY="$2"; shift 2 ;;
    # ★--from 은 막는다★ — send.sh 와 같은 이유 (2026-07-14 신원 사고).
    #   신원은 ★사실★ 이다(워크스페이스 → _me.sh). 모델에게 물으면 남의 이름을 적는다.
    --from)
      if [ -z "${B3OS_FROM_OVERRIDE:-}" ]; then
        echo "✖ --from 은 막혀 있다. 신원은 워크스페이스에서 자동으로 정해진다." >&2
        exit 1
      fi
      FROM="$2"; shift 2 ;;
    --hop) HOP="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    # 모르는 인자의 흔한 원인은 오타가 아니라 본문이 셸에서 쪼개졌기 때문이다 — 다음 행동을 같이 적는다.
    *) echo "unknown arg: $1" >&2
       echo "  본문에 큰따옴표가 있으면 셸이 인자를 쪼개 이런 토큰이 생긴다 — 본문은 --body-file <경로> 로 보내라." >&2
       exit 1 ;;
  esac
done
# ★--body 와 --body-file 을 동시에 주면 거절한다★ — 어느 쪽이 이겼는지 조용히 정해지면
#   보낸 사람이 아는 본문과 실제로 간 본문이 달라진다 (send.sh 와 같은 판단).
if [ -n "$BODY_FILE" ] && [ -n "$BODY_SET" ]; then
  echo "ERROR: --body 와 --body-file 은 동시에 쓸 수 없습니다 (하나만 지정하세요)" >&2; exit 1
fi
if [ -n "$BODY_FILE" ]; then
  # 없거나 못 읽으면 죽는다. 빈 본문으로 보내면 '보냈다' 는 기록만 남고 내용이 사라진다.
  [ -e "$BODY_FILE" ] || { echo "ERROR: --body-file 경로가 없습니다: $BODY_FILE" >&2; exit 1; }
  [ -f "$BODY_FILE" ] || { echo "ERROR: --body-file 이 일반 파일이 아닙니다: $BODY_FILE" >&2; exit 1; }
  [ -r "$BODY_FILE" ] || { echo "ERROR: --body-file 을 읽을 수 없습니다(권한): $BODY_FILE" >&2; exit 1; }
  BODY="$(cat -- "$BODY_FILE")"
  [ -n "$BODY" ] || { echo "ERROR: --body-file 이 비어 있습니다: $BODY_FILE" >&2; exit 1; }
fi
[ -z "$BODY" ] && { echo "ERROR: --body 또는 --body-file 이 필요합니다" >&2; exit 1; }

# 원본 메시지 해석 → from(=답장 대상), thread
RESOLVED=$(curl -sS "$BASE/api/messages/$MID")
EVAL=$(echo "$RESOLVED" | python3 -c "
import sys, json
d = json.load(sys.stdin)
m = d.get('message')
if not m:
    print('ERR none'); sys.exit(0)
to = m.get('from_agent_id') or ''
th = m.get('thread_id') or ''
print(f'{to}\t{th}')
")
if echo "$EVAL" | grep -q '^ERR'; then echo "ERROR: message $MID 못 찾음 (응답: $RESOLVED)" >&2; exit 1; fi
TO=$(printf '%s' "$EVAL" | cut -f1)
THREAD=$(printf '%s' "$EVAL" | cut -f2)

if [ -z "$TO" ]; then echo "ERROR: 답장 대상(from) 해석 실패" >&2; exit 1; fi
case "$TO" in
  user|system|moderator|broadcast)
    echo "⚠ 이 메시지의 발신자가 '$TO' 라 directed 답장 대상이 아닙니다." >&2
    echo "  (팀장/사람에게 보이는 답은 그룹 답글로, 공지/시스템엔 reply.sh 부적합)" >&2
    exit 2 ;;
esac

# send.sh 로 directed 답장: to=요청자, in_reply_to=원메시지, thread 유지(type 은 send.sh 기본 dm)
ARGS=(--to "$TO" --in-reply-to "$MID" --thread "$THREAD" --body "$BODY" --priority "$PRIORITY")
[ -n "$FROM" ] && ARGS+=(--from "$FROM")
[ -n "$HOP" ] && ARGS+=(--hop "$HOP")
echo "↳ reply → to=$TO  in_reply_to=$MID  thread=$THREAD"
if [ -n "$DRY" ]; then
  printf 'DRY-RUN — 실행 안 함. send.sh 인자:\n  '; printf '%q ' "${ARGS[@]}"; echo
  exit 0
fi
exec "$HERE/send.sh" "${ARGS[@]}"
