#!/bin/bash
# Send a message via the team-collab inbox.
# Usage: send.sh --to <agent_id> (--body "..." | --body-file <경로>) [--thread <id>] [--in-reply-to <msg_id>]
#                [--confirm [초]]                  배달됐는지 실제로 확인하고 사실을 말한다.
#                                                   ★본문에 홑따옴표·백틱·$(cmd)·$VAR 가 있으면 --body-file 을 쓰세요★
#                                                   — --body 로 넘기면 셸이 해석해서 본문이 조용히 훼손됩니다(실측 2건).
#                                                   stdout=메시지 id · stderr=사람이 읽는 결과(파싱하는 코드 없음, 2026-07-30 확인)
#                [--type dm|reply] [--priority low|normal|high] [--hop <n>]
#                [--direct-to-gd --source-thread <tg-...|group_id>] [--individual]
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
BODY_FILE=""; BODY_SET=""; CONFIRM=""

while [ $# -gt 0 ]; do
  case "$1" in
    --to) TO="$2"; shift 2 ;;
    --body) BODY="$2"; BODY_SET=1; shift 2 ;;
    # ★--body-file — 본문을 셸 명령줄에 싣지 않는 경로★ (2026-07-30)
    #   본문에 홑따옴표·백틱·$(cmd)·$VAR 가 있으면 셸이 그것을 해석한다. 실측 사고 2건:
    #   · 백틱이 명령치환돼 본문 일부가 ★조용히 사라졌고★ send 는 성공으로 떴다
    #   · 홑따옴표가 문자열을 끊어 인자 파싱 오류로 죽었다 — 이건 죽어서 오히려 알아챌 수 있었다
    #   회피법(--body "$(cat 파일)")이 있었지만 ★아는 사람만 안전한 것은 고쳐진 게 아니다.★
    --body-file) BODY_FILE="$2"; shift 2 ;;
    --thread) THREAD="$2"; shift 2 ;;
    --in-reply-to) REPLY_TO="$2"; shift 2 ;;
    --type) TYPE="$2"; shift 2 ;;
    --priority) PRIORITY="$2"; shift 2 ;;
    # ★--from 은 막는다 — 신원은 ★주장★ 이 아니라 ★사실★ 이다.★ (GD 2026-07-14)
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
    --direct-to-gd) DIRECT_TO_GD="1"; shift ;;
    # ★개별보고 위임 표시★ — "각자 GD께 직접 보고해라" 로 뿌릴 때 붙인다. 서버가 [마감] 독촉을 안 보낸다.
    #   안 붙여도 고장나지 않는다: 독촉이 한 번 올 뿐이고 그 본문이 "개별보고면 무시하세요" 라고 알려준다.
    --individual) INDIVIDUAL="1"; shift ;;
    --source-thread) SOURCE_THREAD="$2"; shift 2 ;;
    --expect-report-by) EXPECT_REPORT_BY="$2"; shift 2 ;;
    # comm-suite v3 결합키 — meta.episode 로 실림(기존 플래그 패턴 그대로, 서버 통과·마이그레이션 0).
    --episode) EPISODE="$2"; shift 2 ;;
    # ★--confirm [초] — 실제 배달됐는지 확인한다★ (2026-07-30)
    #   POST 응답은 '행이 들어갔다' 까지만 안다. 차단 판정은 그 뒤 dispatcher 가 비동기로 한다
    #   (poll 1500ms). 그래서 POST 시점에 배달 여부를 아는 것은 ★구조적으로 불가능★ 하다.
    #   이 플래그는 판정이 날 때까지 잠깐 기다렸다 사실을 말한다. 기본 5초(dispatcher 3틱).
    --confirm) case "${2:-}" in ''|--*) CONFIRM=5 ;; *) CONFIRM="$2"; shift ;; esac; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

[ -z "$TO" ] && { echo "ERROR: --to required" >&2; exit 1; }

# ─── 본문 확정: --body 또는 --body-file (둘 중 하나) ────────────────────────
# ★둘 다 주면 거절한다★ — 어느 쪽이 이겼는지 조용히 정해지면, 보낸 사람은 자기가 보낸 줄 아는
#   본문과 실제로 간 본문이 다를 수 있다. 오늘 사고가 전부 그 계열이라 여기서 애매함을 만들지 않는다.
if [ -n "$BODY_FILE" ] && [ -n "$BODY_SET" ]; then
  echo "ERROR: --body 와 --body-file 은 동시에 쓸 수 없습니다 (하나만 지정하세요)" >&2
  exit 1
fi
if [ -n "$BODY_FILE" ]; then
  # ★없거나 못 읽으면 죽는다.★ 빈 본문으로 조용히 보내면 '보냈다' 는 기록만 남고 내용이 사라진다.
  [ -e "$BODY_FILE" ] || { echo "ERROR: --body-file 경로가 없습니다: $BODY_FILE" >&2; exit 1; }
  [ -f "$BODY_FILE" ] || { echo "ERROR: --body-file 이 일반 파일이 아닙니다: $BODY_FILE" >&2; exit 1; }
  [ -r "$BODY_FILE" ] || { echo "ERROR: --body-file 을 읽을 수 없습니다(권한): $BODY_FILE" >&2; exit 1; }
  # 파일 내용을 ★그대로★ 읽는다. 셸 확장을 타지 않으므로 백틱·홑따옴표·$(cmd)·$VAR 가 원문 보존된다.
  #   끝 개행 1개는 절삭한다(기존 회피법 --body "$(cat 파일)" 과 동일 동작 — 마이그레이션 0).
  BODY="$(cat -- "$BODY_FILE")"
  [ -n "$BODY" ] || { echo "ERROR: --body-file 이 비어 있습니다: $BODY_FILE" >&2; exit 1; }
fi
[ -z "$BODY" ] && { echo "ERROR: --body 또는 --body-file 이 필요합니다" >&2; exit 1; }




# --direct-to-gd 는 owner 1:1 DM 으로 릴레이(서버가 owner_chat_id 로 타겟 결정, 2026-07-08 GD).
# --source-thread 는 더 이상 필수 아님(호환용으로 전달만 하며 서버는 무시). 팀방 없는 사용자도 릴레이 됨.
#
# ★NL 자동승격 제거(GD 2026-07-09): "팀장/GD께 보내·전달" 패턴 자동감지는 ★위임/메타 지시에도 오발화★해서
#   direct_to_gd 를 폭주시켰다. 예: Codex 가 "각 봇에게 'GD께 테스트 보내라' 위임" → 그 위임 본문이 자동승격 →
#   4봇 전원 direct_to_gd 봉투 수신 → 각자 GD DM 릴레이(+재시도로 3배). 자연어는 '내가 GD께 보고'와
#   '너가 GD께 보내라(위임)'를 구별 못 해서 오발화 불가피 → ★명시 플래그(--direct-to-gd)만 신뢰.★

FROM="${FROM:-$($HERE/_me.sh)}"

# self-route 가드 (GD 2026-07-09, steve 발견): directed 메시지의 발신자==수신자면 자기 자신에게 보내는
# 것 → 상대는 못 받는다. 보통 '내가 보낸 메시지'에 reply.sh 로 답할 때 발생(reply 대상=원발신자=나).
#
# ★direct_to_gd 예외를 걷어냈다 (2026-07-28, codex 리뷰로 확인).★ 예전 주석은 "direct_to_gd 는 실제
# 전달이 GD DM 이라 예외" 라고 했지만, ★서버는 direct_to_gd 여도 from==to 를 먼저 막는다★
# (routes/inbox.ts:91 `protocol_self_report` — reply_mode 를 보기 ★전에★ 무조건 400).
# 즉 이 예외는 ★스크립트만 통과시키고 서버가 거부하던 죽은 코드★ 였다. 여기서 바로 막고 대안을 알려준다.
# (`--direct-to-gd` 자체는 정상이다 — 내 최종 보고에 붙이는 플래그이고, `--to` 는 그 요청자다.)
if [ "$FROM" = "$TO" ]; then
  echo "ERROR: self-route 차단 — 발신자와 수신자가 모두 '$FROM' 입니다(자기 자신에게 directed)." >&2
  echo "  '내가 보낸 메시지'가 아니라 '상대가 보낸 메시지 id'로 답하세요 (reply.sh <상대_msg_id>)." >&2
  echo "  종합·보고는 ★요청자에게★ 보냅니다 → --to <요청자>" >&2
  echo "  팀장께 하는 최종 보고도 마찬가지입니다 → --to <요청자> --in-reply-to <그 요청 msg id> --direct-to-gd" >&2
  echo "    (--direct-to-gd 의 --to 는 '어느 요청에 대한 보고인지' 를 남기는 주소입니다 — 본문은 팀장 DM 에 게시됩니다)" >&2
  exit 3
fi

# ★리터럴 \n 을 진짜 줄바꿈으로 편다.★ (2026-07-13 라이브 — 팀장 단톡방에 "\n\n" 이 문자 그대로 찍혔다)
#   ★[B] 전환 후 팀원이 본문을 직접 쓴다★ — 예전엔 서버가 턴 본문을 그대로 게시해서 이 문제가 없었다.
#   그런데 팀원이 셸에서 `--body "...\n\n..."` 라고 쓰면 ★큰따옴표 안의 \n 은 진짜 개행이 아니라
#   백슬래시+n 두 글자다★ → 그대로 JSON 에 실려 ★사람 눈에 "\n" 으로 보인다.★
#   ★팀원을 탓할 게 아니라(그게 자연스러운 표기다) 여기서 받아주는 게 맞다.★
#   \n · \t 만 편다 (\\ 는 안 건드린다 — 코드 붙여넣기를 망가뜨리지 않기 위해).
#   ★--body-file 에는 이 변환을 적용하지 않는다★ (2026-07-30): 파일 본문은 이미 진짜 개행을 갖고
#   있고, 파일 안의 `\n` 은 ★글자 그대로 의도된 것★ 이다(코드·정규식·로그를 붙여넣는 경우).
#   여기서 펴버리면 파일과 저장된 본문이 달라진다 — --body-file 을 만든 이유가 "원문 그대로 전달"
#   인데 마지막 단계에서 원문을 바꾸면 앞의 노력이 무의미해진다.
if [ -z "$BODY_FILE" ]; then
  BODY=$(BODY="$BODY" python3 -c 'import os, sys; sys.stdout.write(os.environ["BODY"].replace("\\n", "\n").replace("\\t", "\t"))')
fi

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
# individual: 개별보고 위임(각자 GD께 직접 보고) 표시. 서버는 이 칸만 보고 [마감] 독촉을 건너뛴다.
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

# ★'✓ sent' 는 거짓이었다★ (2026-07-30): POST /api/inbox 는 ★행 삽입만★ 하고 ok 를 준다.
#   차단 판정(핑퐁 상한·dead_letter 등)은 그 뒤 dispatcher 가 ★비동기로★ 한다(poll 1500ms).
#   그래서 이 시점에 배달 여부를 아는 것은 구조적으로 불가능하다. 실측: 미배달 메시지에 '✓ sent' 가
#   찍혔고, 보낸 사람은 전달된 줄 알았다 — 실제로 정정 메시지 한 건이 그렇게 사라졌다.
#   알 수 없는 것을 안다고 말하지 않는다 — '접수됨'까지만 단정하고, 확인은 --confirm 이 한다.
MSG_ID=$(echo "$RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if d.get('ok'):
    m = d['message']
    print(f'접수됨 {m[\"id\"]} thread={m[\"thread_id\"]} (hop={m[\"hop_count\"]}) — 배달 확인 전', file=sys.stderr)
    print(m['id'])
else:
    print(f'✗ 접수 실패: {json.dumps(d, ensure_ascii=False)}', file=sys.stderr)
    sys.exit(1)
")

[ -z "$CONFIRM" ] && exit 0

# ─── --confirm: 판정이 날 때까지 기다렸다 사실을 말한다 ────────────────────
# 판정 근거는 ★message_recipient.delivery_state★ 다.
#   message.delivery_status 와 recipient_state 는 ★미배달에도 delivered/acknowledged 로 박힌다★
#   (2026-07-30 실측: 차단된 메시지가 각각 그 값이었다). 그 둘을 근거로 쓰면 이 기능이 무의미해진다.
CONF_DEADLINE=$(( $(date +%s) + CONFIRM ))
while :; do
  STATE_JSON=$(curl -sS "$BASE/api/inbox/messages/$MSG_ID" 2>/dev/null || echo '{}')
  VERDICT=$(STATE_JSON="$STATE_JSON" python3 -c "
import os, json, sys
try: d = json.loads(os.environ['STATE_JSON'])
except Exception: print('unknown'); sys.exit(0)
rs = d.get('recipients')
if rs is None: print('noapi'); sys.exit(0)
if len(rs) == 0: print('norecipient'); sys.exit(0)
bad = [r for r in rs if r.get('delivery_state') in ('blocked', 'dead_letter')]
if bad:
    r = bad[0]
    print('failed\t' + str(r.get('delivery_state')) + '\t' + str(r.get('last_error') or '(사유 없음)'))
    sys.exit(0)
if all(r.get('delivery_state') in ('completed', 'delivered') for r in rs):
    print('ok'); sys.exit(0)
print('pending')
")
  case "${VERDICT%%$'\t'*}" in
    ok) echo "✓ 배달 확인 ($MSG_ID)" >&2; exit 0 ;;
    failed)
      echo "✗ ★미배달★ ($MSG_ID) — $(echo "$VERDICT" | cut -f2): $(echo "$VERDICT" | cut -f3)" >&2
      echo "  같은 스레드 왕복 상한이면 --in-reply-to 없이 ★새 스레드★ 로 다시 보내세요(카운터 리셋)." >&2
      exit 1 ;;
    # ★빈 배열과 '아직 판정 전' 을 구분한다★: 둘을 뭉치면 수신자가 아예 안 붙은
    #   사고(진짜 문제)를 "아직 안 왔네" 로 흘린다. 빈 배열은 경고로 낸다.
    norecipient) echo "⚠ 수신자가 붙지 않았습니다 ($MSG_ID) — 배달 대상이 0명입니다. --to 값과 registry 를 확인하세요." >&2; exit 1 ;;
    noapi) echo "⚠ 이 서버는 recipients 를 주지 않습니다 — --confirm 을 쓸 수 없습니다(서버 업데이트 필요)." >&2; exit 0 ;;
  esac
  [ "$(date +%s)" -ge "$CONF_DEADLINE" ] && {
    echo "⚠ ${CONFIRM}초 안에 판정이 나지 않았습니다 ($MSG_ID) — 아직 처리 중일 수 있습니다(미배달 단정 아님)." >&2
    exit 0
  }
  sleep 1
done
