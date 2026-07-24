#!/usr/bin/env bash
# openclaw 런타임 팀원 활성화 매뉴얼 (누구나 따라하면 되게 · 2026-06-09)
#   새 openclaw 에이전트를 만들고 텔레그램 봇·auth·게이트웨이까지 연결한다.
#   ⚠ 게이트웨이 재시작 = 같은 게이트웨이의 다른 openclaw 에이전트들 1~2분 중단.
#   ⚠ openclaw.json(공유 config) 수정 + 게이트웨이 재시작 = self-mod → 반드시 터미널에서 직접 실행.
#
# 사용:  AGENT_ID=myagent DISPLAY="My Agent" bash activate-openclaw-agent.sh
#   (토큰은 미리 ~/.openclaw/credentials/telegram-<id>-token.txt 에 저장돼 있어야 함)
set -euo pipefail

AGENT_ID="${AGENT_ID:?AGENT_ID 필요 (예: myagent)}"
DISPLAY="${DISPLAY:-$(echo "$AGENT_ID" | tr '[:lower:]' '[:upper:]')}"   # ${var^^}는 bash 4+ 전용 → macOS 기본 bash 3.2 호환 위해 tr 사용
WS="${WS:-$HOME/Development/$AGENT_ID}"
MODEL="${MODEL:-openai/gpt-5.6-sol}"  # 기본 모델(openclaw 시스템 default·configured, text+image 1050k). ★plain gpt-5.6은 라우팅 에러 → sol 변형 사용★. 공개 사용자는 env MODEL 로 override.
OC="$HOME/.openclaw"
TOKEN_FILE="$OC/credentials/telegram-$AGENT_ID-token.txt"
say(){ printf "\033[32m%s\033[0m\n" "$1"; }

[ -s "$TOKEN_FILE" ] || { echo "❌ 토큰 없음: $TOKEN_FILE (BotFather 토큰 먼저 저장)"; exit 1; }

say "■ openclaw 백업"
cp "$OC/openclaw.json" "$OC/openclaw.json.bak.$AGENT_ID-$(date +%s)"
say "■ baseline 에이전트: $(ls "$OC/agents/" | tr '\n' ' ')"
mkdir -p "$WS"

say "■ 1) 텔레그램 account 추가 (openclaw.json)"
python3 - "$AGENT_ID" "$DISPLAY" "$TOKEN_FILE" <<'PY'
import json, sys
aid, disp, tok = sys.argv[1], sys.argv[2], sys.argv[3]
p = f"{__import__('os').path.expanduser('~')}/.openclaw/openclaw.json"
c = json.load(open(p))
tg = c.setdefault("channels", {}).setdefault("telegram", {})
acc = tg.setdefault("accounts", {})
acc[aid] = {"name": disp, "enabled": True, "tokenFile": tok}
# 그룹 native 응답은 명시 멘션/답장에만 반응한다. 기존 그룹별 설정은 보존한다.
grp = tg.setdefault("groups", {})
grp.setdefault("*", {})["requireMention"] = True
json.dump(c, open(p, "w"), ensure_ascii=False, indent=2)
json.load(open(p))  # 검증: 다시 파싱돼야 함
print("  account 추가 + JSON 유효 ✓")
PY

say "■ 2) 에이전트 생성 (openclaw agents add)"
# 잔재 정리 — 이전 퇴사가 덜 지운 agent 폴더가 남으면 'agents add'가 "이미 있음"으로 등록 불완전→활성화 실패(2026-07-01 실측).
#   제거 후 재생성. 슬러그 가드 + 고정 prefix로 안전. (openclaw.json account 엔트리는 아래 재생성 X — 이미 있으면 유지)
# ★보호 에이전트 denylist — 이 스크립트는 operator env(AGENT_ID)로 돌아 registry 게이트 밖이라, AGENT_ID 가
#   시스템/보호 에이전트(gd·main 등)면 해당 agent 폴더를 잘못 지울 위험(#1 footgun, 2026-07-01).
#   보호 목록은 env OPENCLAW_PROTECTED_IDS(공백 구분)로 지정 — 기본은 시스템 id 만. 팀 운영 시 추가 id 를 넣어 함께 보호.
OPENCLAW_PROTECTED_IDS="${OPENCLAW_PROTECTED_IDS:-gd main claude codex default}"
PROTECTED_RE="^($(echo $OPENCLAW_PROTECTED_IDS | tr -s ' ' '|'))$"
# ★재활성화 멱등★ — add 충돌의 실제 원인은 폴더가 아니라 openclaw.json 의 ★agents.list 등록 엔트리★다.
#   폴더를 rm 해도 등록은 남아 `agents add` 가 "already exists"(비대화 error)로 exit≠0 → set -e 종료
#   (2026-07-24 재활성화 실패 근본). 옛 `openclaw agents remove` 는 ★존재하지 않는 서브커맨드★라 no-op였고
#   (정본=`agents delete`이나 delete 는 workspace 를 휴지통행 → 방금 쓴 persona/AGENTS.md 를 날리므로 금지).
#   그래서: 이미 등록됐으면 add 생략(멱등, folder/auth 는 step3, 라우팅은 게이트웨이 재시작이 재적용),
#   미등록(신규·폴더만 남은 잔재)일 때만 폴더 청소 후 add.
if openclaw agents list --json 2>/dev/null \
   | python3 -c 'import json,sys; aid=sys.argv[1]; d=json.load(sys.stdin); sys.exit(0 if isinstance(d,list) and any(a.get("id")==aid for a in d) else 1)' "$AGENT_ID" 2>/dev/null; then
  say "  ↺ 이미 등록된 에이전트 — 재추가 생략(멱등). 텔레그램 바인딩만 보장."
  openclaw agents bind --agent "$AGENT_ID" --bind "telegram:$AGENT_ID" >/dev/null 2>&1 \
    && say "  바인딩 확인/추가 ✓" || say "  바인딩 이미 존재 — 변경 없음"
else
  if [ -d "$OC/agents/$AGENT_ID" ] && [[ "$AGENT_ID" =~ ^[a-z0-9_-]+$ ]] && [[ ! "$AGENT_ID" =~ $PROTECTED_RE ]]; then
    echo "  ⚠ 미등록인데 폴더 잔재 존재 → 폴더 제거 후 생성"
    rm -rf "$OC/agents/$AGENT_ID"
  fi
  openclaw agents add "$AGENT_ID" --workspace "$WS" --model "$MODEL" --non-interactive --bind "telegram:$AGENT_ID"
fi

say "■ 3) auth 프로필 (전역 auth.profiles 우선 · 없으면 per-agent 복제)"
DEST="$OC/agents/$AGENT_ID/agent"
mkdir -p "$DEST"
GLOBAL_AUTH="$(python3 - "$OC/openclaw.json" <<'PY'
import json, sys
try:
    j = json.load(open(sys.argv[1]))
    p = (j.get("auth") or {}).get("profiles") or {}
    print("yes" if isinstance(p, dict) and len(p) > 0 else "no")
except Exception:
    print("no")
PY
)"
if [ "$GLOBAL_AUTH" = "yes" ]; then
  say "  (전역 openclaw.json auth.profiles 사용 — per-agent 복제 생략 · 신 레이아웃)"
else
  # 구 레이아웃 fallback: 다른 에이전트의 per-agent auth를 복제한다.
  AUTH_SRC=""
  for cand in "$OC"/agents/*/agent/auth-profiles.json; do
    [ -f "$cand" ] || continue
    aname="$(basename "$(dirname "$(dirname "$cand")")")"
    [ "$aname" = "$AGENT_ID" ] && continue
    AUTH_SRC="$(dirname "$cand")"; break
  done
  if [ -z "$AUTH_SRC" ]; then echo "  ❌ auth 소스 없음(전역 auth.profiles 도 없고 auth 보유 openclaw 에이전트도 부재) — 활성화 중단(수동 auth 필요)"; exit 1; fi
  cp "$AUTH_SRC/auth-profiles.json" "$DEST/" || { echo "  ❌ auth-profiles 복사 실패 — 중단"; exit 1; }
  [ -d "$AUTH_SRC/codex-home" ] && cp -r "$AUTH_SRC/codex-home" "$DEST/" || true
  say "  (auth 소스: $(basename "$(dirname "$AUTH_SRC")"))"
fi
say "  ✅ auth 준비됨(전역 auth.profiles 또는 per-agent auth-profiles.json)"

say "■ 4) 게이트웨이 재시작 (⚠ 다른 openclaw 에이전트 잠깐 중단)"
openclaw gateway restart

say "■ 5) 검증"
sleep 3
openclaw agents list 2>/dev/null | grep -i "$AGENT_ID" && say "✅ $AGENT_ID 활성화됨" || echo "⚠ agents list에 안 보임 — 로그 확인"
echo ""
say "■ 완료. 다음:"
echo "  · team-collab agents.json 에 $AGENT_ID 등록돼 있어야 버스 라우팅 (이미 됨)"
echo "  · 대시보드 1:1 또는 텔레그램으로 $AGENT_ID 에게 메시지 → 응답 확인"
echo "  · 팀방 초대: 텔레그램 그룹에 @$AGENT_ID 봇 추가 + 멘션 테스트"
