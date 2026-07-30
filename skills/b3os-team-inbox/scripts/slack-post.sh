#!/bin/bash
# Post a top-level message to a Slack channel as the current agent.
# (Not a thread reply — for proactive announcements, weekly meeting starters, daily briefs, etc.)
# Usage:
#   slack-post.sh --channel <C...> (--text "..." | --text-file <경로>)
#   slack-post.sh --channel <C...> --text-file <경로> --mention <U…|이름>     # 알림 받을 사람(반복 가능)
#   slack-post.sh --channel <C...> --text "..." --as <agent>     # impersonate (admin)
#   slack-post.sh --channel <C...> --text "..." --thread <ts>    # reply in thread instead
#
# ★멘션이 없으면 채널에 올라가도 알림이 아무에게도 가지 않습니다★ — 게시 후 경고합니다.
#   member ID 얻는 방법·보관 위치는 docs/SLACK_SETUP.md 참조 (저장소에 ID 를 두지 않습니다).
# ★본문에 홑따옴표·백틱·$(cmd) 가 있으면 --text-file 을 쓰세요★ — --text 는 셸이 해석해 본문이 훼손됩니다.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${TEAM_BASE:-http://127.0.0.1:7878/team}"

CHANNEL=""; TEXT=""; AS=""; THREAD=""; TEXT_FILE=""; TEXT_SET=""; MENTIONS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2 ;;
    --text)    TEXT="$2"; TEXT_SET=1; shift 2 ;;
    # --text-file: 본문을 셸 명령줄에 싣지 않는다 (send.sh --body-file 과 같은 이유 — 홑따옴표·백틱·$(cmd)
    #   가 셸에 해석돼 본문이 조용히 훼손된다. 실측 2건).
    --text-file) TEXT_FILE="$2"; shift 2 ;;
    # --mention <U…>: 반복 가능. 본문 맨 앞에 <@ID> 를 붙인다.
    #   ★이게 없으면 게시는 되고 알림은 아무에게도 안 간다★ — 실측으로 게시글 4건이 그렇게
    #   전달되지 않았고, 스크립트는 그때도 '✓ posted' 를 찍었다.
    --mention) MENTIONS="$MENTIONS $2"; shift 2 ;;
    --as)      AS="$2"; shift 2 ;;
    --thread)  THREAD="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

[ -z "$CHANNEL" ] && { echo "ERROR: --channel required (Slack channel id, starts with C)" >&2; exit 1; }

if [ -n "$TEXT_FILE" ] && [ -n "$TEXT_SET" ]; then
  echo "ERROR: --text 와 --text-file 은 동시에 쓸 수 없습니다 (하나만 지정하세요)" >&2; exit 1
fi
if [ -n "$TEXT_FILE" ]; then
  [ -f "$TEXT_FILE" ] || { echo "ERROR: --text-file 경로가 없거나 일반 파일이 아닙니다: $TEXT_FILE" >&2; exit 1; }
  [ -r "$TEXT_FILE" ] || { echo "ERROR: --text-file 을 읽을 수 없습니다(권한): $TEXT_FILE" >&2; exit 1; }
  TEXT="$(cat -- "$TEXT_FILE")"
  [ -n "$TEXT" ] || { echo "ERROR: --text-file 이 비어 있습니다: $TEXT_FILE" >&2; exit 1; }
fi
[ -z "$TEXT" ] && { echo "ERROR: --text 또는 --text-file 이 필요합니다" >&2; exit 1; }

# --mention 을 본문 맨 앞에 붙인다 (이미 본문에 있으면 중복으로 붙이지 않는다)
#   ★member ID 는 저장소에 두지 않는다★ — 워크스페이스 고유 값이라 공개 저장소에 박을 값이 아니다.
#   원시 ID(U…/W…)를 그대로 받고, 그 밖의 값은 이름으로 보고 slack-tokens/members.env 에서 찾는다
#   (그 폴더는 .gitignore 에 있다). 형식: 이름=U01234567 한 줄씩.
MEMBERS_FILE="${SLACK_MEMBERS_FILE:-$(cd "$HERE/../../.." && pwd)/slack-tokens/members.env}"
resolve_mention() {  # resolve_mention <원시ID|이름> -> ID 또는 빈 문자열
  local v="$1"
  v="${v#<@}"; v="${v%>}"                      # 사용자가 <@U…> 형태로 줘도 받아준다
  case "$v" in [UW][A-Z0-9]*) printf '%s' "$v"; return 0 ;; esac
  [ -f "$MEMBERS_FILE" ] || return 1
  # KEY=VALUE, 대소문자 무시, 주석·빈 줄 무시
  awk -F= -v want="$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')" '
    /^[[:space:]]*#/ || !/=/ { next }
    { k=$1; gsub(/^[[:space:]]+|[[:space:]]+$/, "", k); v2=$2; gsub(/^[[:space:]]+|[[:space:]]+$/, "", v2)
      if (tolower(k) == want) { print v2; exit } }' "$MEMBERS_FILE"
}
for _m in $MENTIONS; do
  _id="$(resolve_mention "$_m")"
  if [ -z "$_id" ]; then
    echo "ERROR: --mention '$_m' 을 member ID 로 풀 수 없습니다." >&2
    echo "  원시 ID(U…)를 직접 주거나, $MEMBERS_FILE 에 '이름=U01234567' 을 추가하세요." >&2
    echo "  ID 얻는 방법: Slack 프로필 → ⋯ → '멤버 ID 복사' (docs/SLACK_SETUP.md)" >&2
    exit 1
  fi
  case "$TEXT" in *"<@$_id>"*) continue ;; esac
  TEXT="<@$_id> $TEXT"
done

AGENT="${AS:-$($HERE/_me.sh)}"

PAYLOAD=$(AGENT="$AGENT" CHANNEL="$CHANNEL" TEXT="$TEXT" THREAD="$THREAD" python3 -c "
import json, os
p = {
  'agent_id': os.environ['AGENT'],
  'channel':  os.environ['CHANNEL'],
  'text':     os.environ['TEXT'],
}
if os.environ.get('THREAD'): p['thread_ts'] = os.environ['THREAD']
print(json.dumps(p, ensure_ascii=False))
")

RESP=$(curl -sS -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "$BASE/api/slack/post")
echo "$RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if d.get('ok'):
    print(f'✓ posted ts={d[\"ts\"]} channel=$CHANNEL as=$AGENT')
else:
    print(f'✗ {json.dumps(d, ensure_ascii=False)}')
    sys.exit(1)
"

# ★게시 성공 ≠ 누가 읽는다★ (2026-07-30 실측)
#   멘션이 없는 글은 채널에 올라가지만 ★아무에게도 알림이 가지 않는다.★ 실측 게시글 4건이
#   그렇게 전달되지 않았고, 스크립트는 그때도 '✓ posted' 만 찍었다. 게시 여부와 도달 여부는 다른 사실이다.
#   그래서 게시 뒤에 ★경고★ 한다(실패로 만들지는 않는다 — 알림 없는 게시가 정당한 경우도 있다).
#   `<!here>`·`<!channel>`·`<!subteam^…>` 도 알림을 만드므로 멘션으로 인정한다.
if ! printf '%s' "$TEXT" | grep -qE '<@[UW][A-Z0-9]+>|<!(here|channel)(\|[^>]*)?>|<!subteam\^'; then
  echo "⚠ 멘션 없음 — 채널에 게시됐지만 ★알림은 아무에게도 가지 않았습니다★." >&2
  echo "   받을 사람을 지정하려면: --mention <U…|이름>  (ID 얻는 방법 = docs/SLACK_SETUP.md)" >&2
fi
