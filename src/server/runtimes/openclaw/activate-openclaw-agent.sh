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
DISPLAY="${DISPLAY:-${AGENT_ID^^}}"
WS="${WS:-$HOME/Development/$AGENT_ID}"
MODEL="${MODEL:-openai/gpt-5.5}"      # 기본 모델(codex 런타임 라우팅). 공개 사용자는 자신의 provider/모델에 맞게 env MODEL 로 override.
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
tg = c["channels"]["telegram"]
acc = tg["accounts"]
acc[aid] = {"name": disp, "enabled": True, "tokenFile": tok}
# ★그룹 무차별응답 차단(OWNER 2026-07-20)★: openclaw 게이트웨이가 팀방에 직접 붙어 '모든' 그룹
#   메시지에 응답하던 문제 수정. 그룹은 봇 멘션(@)·답장일 때만 트리거하게 한다.
#   (openclaw 문서 channels/telegram.md: "Plain group messages do not trigger the bot while
#   requireMention: true".) hermes 의 TELEGRAM_REQUIRE_MENTION 과 동형 — 비-claude 게이트웨이는
#   방 native 자동응답을 닫고, 그룹 협업은 System OP capture(owner-gate) 경로로만 도달한다.
#   기존 groups 설정은 보존하고 "*"(모든 그룹) 엔트리에만 requireMention 을 보장.
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
#   시스템/보호 에이전트(owner·main 등)면 해당 agent 폴더를 잘못 지울 위험(#1 footgun, 2026-07-01).
#   보호 목록은 env OPENCLAW_PROTECTED_IDS(공백 구분)로 지정 — 기본은 시스템 id 만. 팀 운영 시 추가 id 를 넣어 함께 보호.
OPENCLAW_PROTECTED_IDS="${OPENCLAW_PROTECTED_IDS:-owner main claude codex default}"
PROTECTED_RE="^($(echo $OPENCLAW_PROTECTED_IDS | tr -s ' ' '|'))$"
if [ -d "$OC/agents/$AGENT_ID" ] && [[ "$AGENT_ID" =~ ^[a-z0-9_-]+$ ]] && [[ ! "$AGENT_ID" =~ $PROTECTED_RE ]]; then
  echo "  ⚠ 잔재 agent 폴더($OC/agents/$AGENT_ID) 제거 후 재생성"
  openclaw agents remove "$AGENT_ID" --non-interactive 2>/dev/null; rm -rf "$OC/agents/$AGENT_ID"
fi
openclaw agents add "$AGENT_ID" --workspace "$WS" --model "$MODEL" --non-interactive --bind "telegram:$AGENT_ID"

say "■ 3) auth 프로필 복제 (살아있는 openclaw 에이전트 → $AGENT_ID; openai-codex 키)"
DEST="$OC/agents/$AGENT_ID/agent"
mkdir -p "$DEST"
# 동적 소스: auth-profiles.json 있는 다른 openclaw 에이전트에서 복제(특정 에이전트 하드코딩 X — 부재 시 silent 死봇 방지).
#   소스 없으면 hard-fail(exit 1) → 영입이 조용히 죽은 봇 만드는 대신 실패를 명확히 보고(fail-safe, 2026-07-01).
AUTH_SRC=""
for cand in "$OC"/agents/*/agent/auth-profiles.json; do
  [ -f "$cand" ] || continue
  aname="$(basename "$(dirname "$(dirname "$cand")")")"
  [ "$aname" = "$AGENT_ID" ] && continue
  AUTH_SRC="$(dirname "$cand")"; break
done
if [ -z "$AUTH_SRC" ]; then echo "  ❌ auth-profiles 소스 없음(auth 보유 openclaw 에이전트 부재) — 활성화 중단(수동 auth 필요)"; exit 1; fi
cp "$AUTH_SRC/auth-profiles.json" "$DEST/" || { echo "  ❌ auth-profiles 복사 실패 — 중단"; exit 1; }
[ -d "$AUTH_SRC/codex-home" ] && cp -r "$AUTH_SRC/codex-home" "$DEST/" || true
say "  (auth 소스: $(basename "$(dirname "$AUTH_SRC")"))"

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
