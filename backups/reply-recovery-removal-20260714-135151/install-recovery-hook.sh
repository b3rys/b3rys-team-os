#!/bin/bash
# install-recovery-hook.sh — 팀원 claude 세션에 tg-reply-recovery Stop 훅 설치(malform reply 자동복구).
#
# ⚠️ self-mod(~/Development/<id>/.claude) 라서 OWNER가 터미널에서 직접 실행한다.
#   (Stop 훅=지속 실행 메커니즘 → 팀원 승인/에이전트론 auto-mode 분류기가 차단. settings/hooks는 OWNER 경계.)
#   실행:  bash scripts/install-recovery-hook.sh bill
#          bash scripts/install-recovery-hook.sh demis   # 등 팀원별
#
# - idempotent: 이미 설치면 no-op
# - 백업먼저: settings.json → .bak-recovery-<ts>
# - 정본 훅 = src/server/runtimes/claude/tg-reply-recovery.py (regex (?:antml:)? 확장본)
# - 토큰 배선: TG_RECOVERY_ENV=~/.claude/channels/telegram-<id>/.env (그 멤버 봇 TELEGRAM_BOT_TOKEN)
# - 워크스페이스 스코프라 오너 세션 무영향(reply-guard와 동일)
set -euo pipefail

MEMBER="${1:?usage: install-recovery-hook.sh <member_id>}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/src/server/runtimes/claude/tg-reply-recovery.py"
DOT="$HOME/Development/$MEMBER/.claude"
DST="$DOT/hooks/tg-reply-recovery.py"
SETTINGS="$DOT/settings.json"
TOKEN_ENV="$HOME/.claude/channels/telegram-$MEMBER/.env"

[ -f "$SRC" ] || { echo "❌ 정본 훅 없음: $SRC"; exit 1; }
[ -f "$SETTINGS" ] || { echo "❌ settings 없음: $SETTINGS ('$MEMBER' 세션 맞나?)"; exit 1; }
[ -f "$TOKEN_ENV" ] || echo "⚠️ 토큰파일 없음: $TOKEN_ENV — 훅은 설치되나 토큰 없으면 block 폴백(경고만). 확인 요망."

cp "$SETTINGS" "$SETTINGS.bak-recovery-$(date +%s)"
mkdir -p "$DOT/hooks"
cp "$SRC" "$DST"
chmod 755 "$DST"

python3 - "$SETTINGS" "$DST" "$TOKEN_ENV" <<'PY'
import json, sys
sp, dst, tok = sys.argv[1:4]
s = json.load(open(sp))
h = s.setdefault("hooks", {})
st = h.setdefault("Stop", [])
if "tg-reply-recovery" not in json.dumps(st):
    st.append({"hooks": [{"type": "command", "command": f'TG_RECOVERY_ENV="{tok}" python3 "{dst}"'}]})
    print("  Stop 훅 추가됨")
else:
    print("  이미 설치됨(no-op)")
h["Stop"] = st
with open(sp, "w") as f:
    f.write(json.dumps(s, indent=2, ensure_ascii=False) + "\n")
PY

echo "✅ '$MEMBER' 세션에 tg-reply-recovery 훅 설치 완료. 다음 Stop 이벤트부터 malform reply 자동복구."
