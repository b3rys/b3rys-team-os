#!/bin/bash
# Send a message via the team-collab inbox.
# Usage: send.sh --to <agent_id> (--body "..." | --body-file <경로>) [--thread <id>] [--in-reply-to <msg_id>]
#                [--mention <U…|이름>]              ★슬랙 스레드일 때만★ — 알림 받을 사람(반복 가능).
#                                                   안 주면 슬랙엔 올라가도 알림이 아무에게도 안 갑니다(경고함).
#                                                   이름 사전 = slack-tokens/members.env (slack-post.sh 와 공유)
#                [--confirm [초]]                  배달됐는지 실제로 확인하고 사실을 말한다.
#                                                   ★본문에 홑따옴표·백틱·$(cmd)·$VAR 가 있으면 --body-file 을 쓰세요★
#                                                   — --body 로 넘기면 셸이 해석해서 본문이 조용히 훼손됩니다(실측 2건).
#                                                   stdout=메시지 id · stderr=사람이 읽는 결과(파싱하는 코드 없음, 2026-07-30 확인)
#                [--type dm|reply] [--priority low|normal|high] [--hop <n>] [--all-hands <reason>]
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
BODY_FILE=""; BODY_SET=""; CONFIRM=""; MENTIONS=""; ALL_HANDS=""

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
    # --mention <U…|이름>: 반복 가능. ★슬랙 스레드로 나갈 때만★ 본문 맨 앞에 <@ID> 를 붙인다.
    #   slack-post.sh 와 ★같은 옵션 이름·같은 값 형식·같은 사전★ 이다(두 도구의 규약을 하나로).
    --mention) MENTIONS="$MENTIONS $2"; shift 2 ;;
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
    # 팀원 broadcast를 방 게시 1건 + 정식·활성 전원 수신행으로 보낸다.
    # 사유를 감사에 남기며, 본문에 @all을 쓰는 것과 무관한 명시적 발신 옵션이다.
    --all-hands) ALL_HANDS="${2:-}"; [ -n "$ALL_HANDS" ] || { echo "ERROR: $1 requires a reason" >&2; exit 1; }; shift 2 ;;
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
[ -n "$ALL_HANDS" ] && [ "$TO" != "broadcast" ] && {
  echo "ERROR: --all-hands 는 --to broadcast 에만 사용할 수 있습니다" >&2
  exit 1
}

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

# ─── 슬랙 멘션 ────────────────────────────────────────────────────────────
# ★멘션이 없으면 슬랙에 글은 올라가도 알림이 아무에게도 안 간다.★
#   실측(2026-07-30): 내가 이 경로로 올린 7건 중 6건이 멘션 없이 나갔고, 답을 기다리던 사람에게
#   ★알림이 한 번도 안 갔다.★ slack-post.sh 에는 --mention 도 경고도 있는데 ★이 경로에만 없었다★ —
#   즉 그 경고를 봐야 할 사람이 경고가 없는 쪽으로만 다녔다.
#   ★막지는 않는다★: "슬랙에 정리해서 올려줘" 처럼 받는 사람이 없는 게시도 정당하다(slack-post 와 같은 판단).
#   그래서 옵션은 선택이고, 안 줬을 때 ★알려만 준다★.
#   ID 는 저장소에 두지 않는다 — slack-tokens/members.env(.gitignore)에서 이름→ID 를 찾고,
#   원시 ID(U…/W…)는 그대로 받는다. slack-post.sh 와 ★같은 사전·같은 해석★ 이다.
MEMBERS_FILE="${SLACK_MEMBERS_FILE:-$(cd "$HERE/../../.." && pwd)/slack-tokens/members.env}"
resolve_mention() {  # resolve_mention <원시ID|이름> -> ID 또는 빈 문자열
  local v="$1"
  v="${v#<@}"; v="${v%>}"
  case "$v" in [UW][A-Z0-9]*) printf '%s' "$v"; return 0 ;; esac
  [ -f "$MEMBERS_FILE" ] || return 1
  awk -F= -v want="$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')" '
    /^[[:space:]]*#/ || !/=/ { next }
    { k=$1; gsub(/^[[:space:]]+|[[:space:]]+$/, "", k); v2=$2; gsub(/^[[:space:]]+|[[:space:]]+$/, "", v2)
      if (tolower(k) == want) { print v2; exit } }' "$MEMBERS_FILE"
}
# ★본문에 넣지 않는다★ (2026-07-30 실측) — `--to broadcast` 는 슬랙만이 아니라
#   ★텔레그램 그룹방으로도 나간다.★ 본문에 미리 `<@U…>` 를 박으면 그 문자열이
#   ★단체방에 그대로 찍힌다★(팀장님이 발견). 슬랙 문법은 슬랙에서만 뜻이 있다.
#   → ID 로 풀기만 하고 ★meta 로 넘긴다.★ 실제 부착은 ★슬랙으로 릴레이하는 서버★ 가 한다
#     (채널마다 다른 것은 그 채널로 나갈 때 붙인다. 저장 본문은 채널 중립으로 둔다).
MENTION_IDS=""
for _m in $MENTIONS; do
  # ★`|| true` 를 떼지 말 것★ (2026-07-31 실측). 이 스크립트는 `set -e` 다.
  #   resolve_mention 은 members 파일이 없으면 `return 1` 한다. 그러면 대입문의 명령치환이
  #   0 이 아닌 값으로 끝나고 `set -e` 가 ★바로 이 줄에서 스크립트를 죽인다★ — 아래 에러
  #   분기가 ★한 번도 실행되지 않는다.★ 결과는 stdout 0바이트 · stderr 0바이트 · 종료코드 1.
  #   보내는 사람 눈에는 아무 일도 안 일어난 것처럼 보이고, 메시지는 생성되지 않는다.
  #   라이브에서 이렇게 5건이 조용히 사라졌다(맥스튜디오 보고 2건 · 카드 정리 1건 포함).
  _id="$(resolve_mention "$_m" || true)"
  if [ -z "$_id" ]; then
    echo "ERROR: --mention '$_m' 을 member ID 로 풀 수 없습니다 — ★메시지를 보내지 않았습니다.★" >&2
    if [ -f "$MEMBERS_FILE" ]; then
      echo "  '$MEMBERS_FILE' 에 '$_m=U01234567' 줄이 없습니다. 추가하거나 원시 ID(U…)를 직접 주세요." >&2
    else
      echo "  members 파일이 없습니다: $MEMBERS_FILE" >&2
      echo "  파일을 만들어 '이름=U01234567' 을 넣거나, 원시 ID(U…)를 직접 주세요." >&2
    fi
    echo "  멘션 없이 보내려면 --mention 을 빼세요(알림은 안 갑니다)." >&2
    exit 1
  fi
  MENTION_IDS="$MENTION_IDS $_id"
done

# Build JSON via python to handle escaping safely.
PAYLOAD=$(MENTION_IDS="$MENTION_IDS" BODY="$BODY" FROM="$FROM" TO="$TO" THREAD="$THREAD" REPLY_TO="$REPLY_TO" TYPE="$TYPE" PRIORITY="$PRIORITY" HOP="$HOP" SYNC="$SYNC" DIRECT_TO_GD="$DIRECT_TO_GD" SOURCE_THREAD="$SOURCE_THREAD" EXPECT_REPORT_BY="$EXPECT_REPORT_BY" INDIVIDUAL="$INDIVIDUAL" EPISODE="$EPISODE" ALL_HANDS="$ALL_HANDS" python3 -c "
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
if os.environ.get('ALL_HANDS'): p['all_hands'] = os.environ['ALL_HANDS']
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
# slack_mentions: 슬랙으로 릴레이될 때만 서버가 본문 앞에 <@ID> 를 붙인다.
#   ★본문에 직접 넣지 않는 이유★ — broadcast 는 텔레그램 그룹방으로도 나가고, 거기선 이 문법이
#   의미 없는 문자열로 그대로 보인다(실측). 채널별 표현은 그 채널로 나갈 때 붙인다.
if os.environ.get('MENTION_IDS', '').strip():
    meta['slack_mentions'] = os.environ['MENTION_IDS'].split()
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

# ★메시지 id 를 stdout 으로 내보낸다★ — 사용법 주석이 "stdout=메시지 id" 라고 적어놨는데 실제로는
#   위 명령치환이 id 를 ★내부 변수로만★ 받고 stdout 에는 아무것도 안 나갔다. 실측: MSGID=$(send.sh …)
#   가 빈 문자열이 됐다. 문서가 약속한 것을 코드가 지키지 않으면 그 문서를 믿은 쪽이 조용히 깨진다.
printf '%s\n' "$MSG_ID"

# ★멘션이 없으면 알려준다★ — 실패로 만들지는 않는다.
#   "슬랙에 정리해서 올려줘" 처럼 받는 사람이 없는 게시는 멘션이 없는 게 맞다(slack-post 와 같은 판단).
#   문제는 ★받는 사람이 있는데 안 붙인 경우★ 이고, 그건 보낸 사람만 안다 — 판단을 대신하지 않고 사실만 알린다.
#
# ★슬랙인지 서버에 물어보지 않는다★ (steve 교차검증, 2026-07-30):
#   처음엔 `GET /api/messages/<id>` 응답에 "slack 이 있는지" 로 판정했다. 그 응답에는
#   ★슬랙을 뜻하는 필드가 아예 없다★ — 슬랙 발신 판단은 message 행이 아니라 디스패처가 런타임에 한다.
#   실측 결과 판정이 ★정확히 뒤집혀 있었다★: thread_id 가 slack 으로 시작하는 평범한 팀 DM(라이브 16건)에는
#   경고가 뜨고, ★진짜 슬랙 발신에서는 안 떴다.★ 즉 잔소리는 엉뚱한 데 하고 정작 막으려던 자리에선 침묵한다.
#   알 수 없는 것을 아는 척하면 사람이 곧 경고를 무시하게 되고, 그게 이 기능을 무력화한다.
#   → ★모르는 것은 흉내내지 않는다.★ 슬랙으로 릴레이되는 실제 경로(--to broadcast)에서 멘션이 없으면
#     그냥 안내한다. 거짓 경보도 놓침도 사라지고, 조회 실패 시 침묵하는 문제도 같이 없어진다.
if [ -z "$MENTIONS" ] && [ "$TO" = "broadcast" ]; then
  case "$BODY" in
    *"<@"*) : ;;   # 본문에 직접 넣었다 — 알릴 것 없음
    *)
      echo "⚠ 멘션이 없습니다 — 슬랙 스레드였다면 ★아무에게도 알림이 가지 않습니다★." >&2
      echo "  받는 사람이 있으면: --mention <이름|U…>  (받는 사람 없는 공지면 그대로 두셔도 됩니다)" >&2
      ;;
  esac
fi

[ -z "$CONFIRM" ] && exit 0

# ─── --confirm: 판정이 날 때까지 기다렸다 사실을 말한다 ────────────────────
# 판정 근거는 ★message_recipient.delivery_state★ 다.
#   message.delivery_status 와 recipient_state 는 ★미배달에도 delivered/acknowledged 로 박힌다★
#   (2026-07-30 실측: 차단된 메시지가 각각 그 값이었다). 그 둘을 근거로 쓰면 이 기능이 무의미해진다.
CONF_DEADLINE=$(( $(date +%s) + CONFIRM ))
while :; do
  # ★경로 주의★: inbox 라우트는 api 아래 "/" 에 마운트된다(index.ts: api.route("/", inboxApi)).
  #   그래서 올바른 경로는 $BASE/api/messages/<id> 다. "/api/inbox/messages/..." 로 쓰면 SPA fallback 이
  #   ★HTML 을 200 으로★ 돌려주고 JSON 파싱이 깨진다 — 실측으로 그렇게 조용히 타임아웃까지 돌았다.
  STATE_JSON=$(curl -sS "$BASE/api/messages/$MSG_ID" 2>/dev/null || echo '{}')
  VERDICT=$(STATE_JSON="$STATE_JSON" python3 -c "
import os, json, sys
try: d = json.loads(os.environ['STATE_JSON'])
except Exception: print('unknown'); sys.exit(0)
rs = d.get('recipients')
if rs is None: print('noapi'); sys.exit(0)
if len(rs) == 0: print('norecipient'); sys.exit(0)
# ★expired 도 미배달이다★ — 실측으로 이 상태가 21건 있었다(blocked 는 1건). expired 를 실패로
#   보지 않으면 ★가장 흔한 미배달이 '아직 판정 전' 으로 흘러★ 타임아웃 메시지만 남는다.
#   wake_dispatched 는 진행 중이라 pending 으로 둔다(곧 completed 가 된다).
bad = [r for r in rs if r.get('delivery_state') in ('blocked', 'dead_letter', 'expired')]
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
    #
    #   ★단 broadcast 는 빈 배열이 정상이다.★ 방 발언 전달이 멘션 기준으로 바뀌면서(#221)
    #   멘션 없는 방 글은 수신행이 0 이 된다 — 그런데 ★방 게시 자체는 성공한다.★
    #   그걸 실패로 내면 성공한 발송을 실패로 읽고 재전송하거나 "안 갔다" 고 잘못 보고한다
    #   (실측: 방 글이 정상 게시됐는데 이 분기가 exit 1 을 냈고, 받은 쪽이 원인 조사부터 했다).
    #   directed 발송(--to <팀원>)의 빈 배열은 여전히 사고라 그대로 실패로 둔다.
    norecipient)
      if [ "$TO" = "broadcast" ]; then
        echo "✓ 방 게시 완료 ($MSG_ID) — 수신행 0. 멘션 없는 방 발언은 0 이 정상입니다." >&2
        echo "  특정 팀원이 받아야 하면 --mention <이름> 을 붙이세요." >&2
        exit 0
      fi
      echo "⚠ 수신자가 붙지 않았습니다 ($MSG_ID) — 배달 대상이 0명입니다. --to 값과 registry 를 확인하세요." >&2
      exit 1 ;;
    noapi) echo "⚠ 이 서버는 recipients 를 주지 않습니다 — --confirm 을 쓸 수 없습니다(서버 재시작 필요)." >&2; exit 0 ;;
    # ★응답을 못 읽은 경우를 반드시 처리한다★ — 이 분기가 없어서 경로 오류(HTML 200)가 'unknown' 을
    #   내는데 아무 case 에도 안 걸리고 ★조용히 타임아웃까지 루프★ 했다. 실측으로 그렇게 6초를 돌았고,
    #   원인(경로 오류)은 타임아웃 메시지에 전혀 드러나지 않았다. 판정 도구가 자기 고장을
    #   '아직 판정 전' 으로 흘리면 이 기능을 만든 이유가 없어진다.
    unknown)
      echo "⚠ 배달 상태를 읽지 못했습니다 ($MSG_ID) — 응답이 JSON 이 아닙니다." >&2
      echo "  확인: curl -sS \"$BASE/api/messages/$MSG_ID\"  (HTML 이 오면 경로·서버 상태 문제입니다)" >&2
      exit 0 ;;
  esac
  [ "$(date +%s)" -ge "$CONF_DEADLINE" ] && {
    # ★타임아웃에도 현재 상태를 보여준다★ — 상태 없이 "판정이 안 났다" 만 내면 ★진행 중인지 막힌
    #   건지 구분할 수 없다.★ 실측으로 이 문구를 "정상 처리 중" 으로 읽고 잘못 보고한 사례가 있었다.
    #   ★--confirm 은 실패는 빨리 잡지만 성공은 짧은 창에서 확인할 수 없다★:
    #     wake_dispatched = 서버가 전달을 시도함(초 단위)
    #     completed       = ★수신자가 실제로 처리함★ — 수신자 차례가 돌아야 하므로 분 단위가 될 수 있다
    #   그래서 타임아웃은 '미배달' 이 아니라 '아직 성공을 확인하지 못함' 이다. 그 구분을 문구로 남긴다.
    _cur_state=$(STATE_JSON="$STATE_JSON" python3 -c "
import os, json
try: rs = json.loads(os.environ['STATE_JSON']).get('recipients') or []
except Exception: rs = []
print(', '.join(f\"{r.get('agent_id')}={r.get('delivery_state')}\" for r in rs) or '(상태 없음)')
" 2>/dev/null || echo '(상태 없음)')
    echo "⚠ ${CONFIRM}초 안에 배달 확인이 안 됐습니다 ($MSG_ID) — 현재: $_cur_state" >&2
    echo "  ★미배달이 아닙니다★ — wake_dispatched 는 전달 시도까지 됐다는 뜻이고, 수신자가 처리하면 completed 가 됩니다." >&2
    echo "  실패(blocked·expired·dead_letter)는 이 시간 안에 잡힙니다. 성공 확인만 더 걸립니다." >&2
    exit 0
  }
  sleep 1
done
