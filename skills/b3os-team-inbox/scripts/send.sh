#!/bin/bash
# Send a message via the team-collab inbox.
# Usage: send.sh --to <agent_id> --body "..." [--thread <id>] [--in-reply-to <msg_id>]
#                [--type dm|reply] [--priority low|normal|high] [--hop <n>]
#                [--direct-to-owner --source-thread <tg-...|group_id>] [--individual]
#                                                   send ALL asks for one task on ONE --thread. The server
#                                                   then gathers the replies and wakes you once with the
#                                                   aggregated bundle to report. Name-agnostic (no owner
#                                                   name needed). Only on the fan-out ask, never on a reply.
#                [--expect-report-by <duration>]   e.g. 10m, 30m, 2h — track a report from a
#                                                   one-shot recipient (openclaw/hermes); if none
#                                                   by the deadline the server re-wakes them once.
#                [--episode <id>]                  comm-suite v3 판정 결합키(meta.episode). probe 발신 시
#                                                   심어 answer/report 를 그 수집에 묶는다(측정=배포·codex-d).
#                                                   기존 meta 플래그와 같은 경로(마이그레이션 0). 안 붙이면 무영향.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${TEAM_BASE:-http://127.0.0.1:7878/team}"

TO=""; BODY=""; THREAD=""; REPLY_TO=""; TYPE="dm"; PRIORITY="normal"; FROM=""; HOP=""; SYNC=""; DIRECT_TO_GD=""; SOURCE_THREAD=""; EXPECT_REPORT_BY=""; INDIVIDUAL=""; EPISODE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --to) TO="$2"; shift 2 ;;
    --body) BODY="$2"; shift 2 ;;
    --thread) THREAD="$2"; shift 2 ;;
    --in-reply-to) REPLY_TO="$2"; shift 2 ;;
    --type) TYPE="$2"; shift 2 ;;
    --priority) PRIORITY="$2"; shift 2 ;;
    # ★--from 은 막는다 — 신원은 ★주장★ 이 아니라 ★사실★ 이다.★ (OWNER 2026-07-14)
    #   룰이 "send.sh --from <you>" 라고 시키고, 스킬 예시가 그 자리에 'codex' 를 보여줬다.
    #   → devon 이 <you> 에 ★codex★ 를 넣었다 (7/12 예시 커밋 당일부터, 오늘까지 68회).
    #   서버는 검증하지 않는다 → ★팀원이 남의 이름으로 말했고, 아무도 몰랐다.★
    #   _me.sh 는 이미 정확히 안다(워크스페이스 → 신원). ★아는 걸 모델에게 다시 묻지 않는다.★
    #   운영 대리발신이 필요하면 B3OS_FROM_OVERRIDE 라는 ★명시적 특권 경로★ 를 쓴다 — CLI 플래그로 열지 않는다.
    --from)
      if [ -z "${B3OS_FROM_OVERRIDE:-}" ]; then
        echo "✖ --from 은 막혀 있다. 신원은 워크스페이스에서 자동으로 정해진다(_me.sh)." >&2
        echo "  네가 누구인지 적을 필요가 없다 — 시스템이 이미 안다." >&2
        echo "  (운영 대리발신: B3OS_FROM_OVERRIDE=1 이 필요하다)" >&2
        exit 1
      fi
      FROM="$2"; shift 2 ;;
    --hop) HOP="$2"; shift 2 ;;
    --sync) SYNC="$2"; shift 2 ;;
    --direct-to-owner) DIRECT_TO_GD="1"; shift ;;
    # ★개별보고 위임 표시★ — "각자 OWNER께 직접 보고해라" 로 뿌릴 때 붙인다. 서버가 [마감] 독촉을 안 보낸다.
    #   안 붙여도 고장나지 않는다: 독촉이 한 번 올 뿐이고 그 본문이 "개별보고면 무시하세요" 라고 알려준다.
    --individual) INDIVIDUAL="1"; shift ;;
    --source-thread) SOURCE_THREAD="$2"; shift 2 ;;
    --expect-report-by) EXPECT_REPORT_BY="$2"; shift 2 ;;
    # comm-suite v3 결합키 — meta.episode 로 실림(기존 플래그 패턴 그대로, 서버 통과·마이그레이션 0).
    --episode) EPISODE="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

[ -z "$TO" ] && { echo "ERROR: --to required" >&2; exit 1; }
[ -z "$BODY" ] && { echo "ERROR: --body required" >&2; exit 1; }




# --direct-to-owner 는 owner 1:1 DM 으로 릴레이(서버가 owner_chat_id 로 타겟 결정, 2026-07-08 OWNER).
# --source-thread 는 더 이상 필수 아님(호환용으로 전달만 하며 서버는 무시). 팀방 없는 사용자도 릴레이 됨.
#
# ★NL 자동승격 제거(OWNER 2026-07-09): "팀장/OWNER께 보내·전달" 패턴 자동감지는 ★위임/메타 지시에도 오발화★해서
#   direct_to_gd 를 폭주시켰다. 예: Codex 가 "각 봇에게 'OWNER께 테스트 보내라' 위임" → 그 위임 본문이 자동승격 →
#   4봇 전원 direct_to_gd 봉투 수신 → 각자 OWNER DM 릴레이(+재시도로 3배). 자연어는 '내가 OWNER께 보고'와
#   '너가 OWNER께 보내라(위임)'를 구별 못 해서 오발화 불가피 → ★명시 플래그(--direct-to-owner)만 신뢰.★

FROM="${FROM:-$($HERE/_me.sh)}"

# self-route 가드 (OWNER 2026-07-09, steve 발견): directed 메시지의 발신자==수신자면 자기 자신에게 보내는
# 것 → 상대는 못 받는다. 보통 '내가 보낸 메시지'에 reply.sh 로 답할 때 발생(reply 대상=원발신자=나).
# direct_to_gd 는 실제 전달이 OWNER DM 이라 예외(--to 는 위임자). 그 외 from==to 는 거의 항상 실수라 차단.
if [ -z "$DIRECT_TO_GD" ] && [ "$FROM" = "$TO" ]; then
  echo "ERROR: self-route 차단 — 발신자와 수신자가 모두 '$FROM' 입니다(자기 자신에게 directed)." >&2
  echo "  '내가 보낸 메시지'가 아니라 '상대가 보낸 메시지 id'로 답하세요 (reply.sh <상대_msg_id>)." >&2
  exit 3
fi

# ★리터럴 \n 을 진짜 줄바꿈으로 편다.★ (2026-07-13 라이브 — 팀장 단톡방에 "\n\n" 이 문자 그대로 찍혔다)
#   ★[B] 전환 후 팀원이 본문을 직접 쓴다★ — 예전엔 서버가 턴 본문을 그대로 게시해서 이 문제가 없었다.
#   그런데 팀원이 셸에서 `--body "...\n\n..."` 라고 쓰면 ★큰따옴표 안의 \n 은 진짜 개행이 아니라
#   백슬래시+n 두 글자다★ → 그대로 JSON 에 실려 ★사람 눈에 "\n" 으로 보인다.★
#   ★팀원을 탓할 게 아니라(그게 자연스러운 표기다) 여기서 받아주는 게 맞다.★
#   \n · \t 만 편다 (\\ 는 안 건드린다 — 코드 붙여넣기를 망가뜨리지 않기 위해).
BODY=$(BODY="$BODY" python3 -c 'import os, sys; sys.stdout.write(os.environ["BODY"].replace("\\n", "\n").replace("\\t", "\t"))')

# Build JSON via python to handle escaping safely.
PAYLOAD=$(BODY="$BODY" FROM="$FROM" TO="$TO" THREAD="$THREAD" REPLY_TO="$REPLY_TO" TYPE="$TYPE" PRIORITY="$PRIORITY" HOP="$HOP" SYNC="$SYNC" DIRECT_TO_GD="$DIRECT_TO_GD" SOURCE_THREAD="$SOURCE_THREAD" EXPECT_REPORT_BY="$EXPECT_REPORT_BY" INDIVIDUAL="$INDIVIDUAL" EPISODE="$EPISODE" python3 -c "
import json, os
p = {
  'from_agent_id': os.environ['FROM'],
  'to_agent_id':   os.environ['TO'],
  'body':          os.environ['BODY'],
  'type':          os.environ['TYPE'],
  'priority':      os.environ['PRIORITY'],
  'source':        'agent',
}
if os.environ.get('THREAD'):    p['thread_id'] = os.environ['THREAD']
if os.environ.get('REPLY_TO'):  p['in_reply_to'] = os.environ['REPLY_TO']
if os.environ.get('HOP'):       p['hop_count'] = int(os.environ['HOP'])
if os.environ.get('SYNC'):      p['sync'] = os.environ['SYNC']
meta = {}
if os.environ.get('DIRECT_TO_GD'):
    src = os.environ.get('SOURCE_THREAD', '').strip()
    if src and not src.startswith('tg-'):
        src = 'tg-' + src
    meta['reply_mode'] = 'direct_to_gd'
    meta['source_thread_id'] = src
# expect_report_by: track a report from a one-shot recipient. Server resolves the duration to an
# absolute deadline and (only for openclaw/hermes recipients) re-wakes once if no report arrives.
if os.environ.get('EXPECT_REPORT_BY', '').strip():
    meta['expect_report_by'] = os.environ['EXPECT_REPORT_BY'].strip()
# individual: 개별보고 위임(각자 OWNER께 직접 보고) 표시. 서버는 이 칸만 보고 [마감] 독촉을 건너뛴다.
#   ★글자 해석이 아니라 칸이다★ — 본문에 '각자 보고하세요' 라고 써도 서버는 본문을 안 읽는다.
if os.environ.get('INDIVIDUAL'):
    meta['individual'] = True
# episode: comm-suite v3 판정 결합키. probe 가 발신 시 심고 answer/report 가 같은 값을 달면
#   판정기가 json_extract(meta_json,'\$.episode') 로 그 수집만 묶는다(measure=deploy·codex-d).
if os.environ.get('EPISODE', '').strip():
    meta['episode'] = os.environ['EPISODE'].strip()
if meta:
    p['meta'] = meta
print(json.dumps(p, ensure_ascii=False))
")

RESP=$(curl -sS -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "$BASE/api/inbox")
echo "$RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if d.get('ok'):
    m = d['message']
    print(f'✓ sent {m[\"id\"]} thread={m[\"thread_id\"]} (hop={m[\"hop_count\"]})')
else:
    print(f'✗ failed: {json.dumps(d, ensure_ascii=False)}')
    sys.exit(1)
"
