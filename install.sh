#!/usr/bin/env bash
# b3rys TEAM OS — 다운로드 후 원클릭 설치 (랩탑/Mac/PC, bun 없어도 OK).
#   1) bun 확인/설치  2) 의존성 설치  3) 대시보드 빌드  4) .env 준비  5) 점검·안내
# 설치 후:  bun run start  →  http://localhost:7878/team  →  Settings 탭에서 팀 구성.
#
# 사용:  bash install.sh        (repo 폴더 안에서)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
say()  { printf "\033[32m%s\033[0m\n" "$1"; }  # green
warn() { printf "\033[33m%s\033[0m\n" "$1"; }  # yellow

say "■ b3rys TEAM OS 설치 시작 ($ROOT)"

# ── 1) bun 확인/설치 ─────────────────────────────────────────────
if ! command -v bun >/dev/null 2>&1; then
  warn "bun 이 없어 설치합니다 (https://bun.sh)…"
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
command -v bun >/dev/null 2>&1 || { warn "❌ bun 설치 실패 — https://bun.sh 에서 수동 설치 후 다시 실행."; exit 1; }
say "✅ bun $(bun --version)"

# ── 2) 의존성 설치 ───────────────────────────────────────────────
say "■ 의존성 설치 (bun install)…"
bun install

# ── 3) 대시보드 빌드 (서버가 정적 산출물을 서빙) ─────────────────
say "■ 대시보드 빌드 (bun run build)…"
bun run build

# ── 4) .env 준비 ─────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  say "✅ .env 생성 (.env.example 복사) — 기본값으로 대시보드는 바로 동작."
  warn "  텔레그램 다중 에이전트까지 쓰려면 .env 에 채우세요: TEAM_GROUP_ID · OWNER_CHAT_ID · 각 봇 토큰(BotFather)."
else
  say "✅ .env 이미 있음 — 유지."
fi

# ── 4a) B3RYS_HOME 데이터 루트 ────────────────────────────────────
# 팀원 워크스페이스는 $B3RYS_HOME/members/<id> 에 생성된다. 미설정 시 ~/Development/<id> 로
# 떨어짐(개발 머신 기본) → 공개 설치는 repo 밖 자체완결 루트로 명시(git 업데이트가 팀 상태 안 건드림).
if ! grep -q '^B3RYS_HOME=' .env 2>/dev/null; then
  printf 'B3RYS_HOME=%s/b3os\n' "$HOME" >> .env
  say "✅ B3RYS_HOME=$HOME/b3os (팀원 워크스페이스·데이터 루트, repo 밖)."
fi

# ── 4b) 팀원 활성화 허용 스위치 (APPROVAL_EXECUTION_ENABLED) ──────
# 본인 전용 장비에서만 팀원(봇) 활성화를 허용. 대화형으로 물어보고 .env 에 자동 설정
# (예전엔 사용자가 .env 를 수동 편집해야 했음 → 프롬프트로 자동화).
if ! grep -q '^APPROVAL_EXECUTION_ENABLED=1' .env 2>/dev/null; then
  ans=""
  if [ -t 0 ]; then
    printf "\033[33m이 장비에서 팀원(봇) 활성화를 허용할까요? 본인 전용 맥이면 y. [y/N] \033[0m"
    read -r ans || ans=""
  fi
  case "$ans" in
    y|Y)
      grep -v '^APPROVAL_EXECUTION_ENABLED=' .env > .env.tmp 2>/dev/null || true
      mv .env.tmp .env
      printf 'APPROVAL_EXECUTION_ENABLED=1\n' >> .env
      say "✅ 팀원 활성화 허용됨 (APPROVAL_EXECUTION_ENABLED=1)."
      ;;
    *)
      say "  팀원 활성화는 나중에 .env 에 APPROVAL_EXECUTION_ENABLED=1 로 켤 수 있어요."
      ;;
  esac
fi

# ── 5) DB·점검 (DB 는 첫 서버 기동 시 자동 생성) ─────────────────
say "■ 타입 점검…"
bun run typecheck >/dev/null 2>&1 && say "✅ typecheck OK" || warn "⚠ typecheck 경고(동작엔 영향 없을 수 있음)"

# ── 안내 ─────────────────────────────────────────────────────────
echo ""
say "■ 설치 완료! 실행:"
echo "    bun run start                 # 서버 기동 (DB 자동 생성)"
echo "    → 브라우저: http://localhost:7878/team"
echo "    → 상단 'Settings' 탭에서 팀명·미션·팀원(영입) 설정"
echo ""
echo "  개발 모드(코드 수정 핫리로드):  bun run dev"
# ★파일로 튕기지 않는다 (2026-07-18 OWNER)★ — 사용자는 로컬 파일을 열지 않는다. 실제 단계 안내는
#   Claude Code(b3os 스킬)가 대시보드에서 대화로 처리한다. 여기서는 '사람만 할 수 있는 3가지'만 인라인으로 짚는다.
warn "  사람만 할 수 있는 3가지 (나머지 단계는 Claude Code 가 대시보드에서 안내합니다):"
echo "    1) 봇 토큰 — 텔레그램 @BotFather 에서 /newbot → 나온 토큰을 대시보드 영입 화면에 붙여넣기"
echo "    2) 런타임 선택 — Claude(권장) · OpenClaw · Hermes"
echo "    3) 활성화 승인 — 본인 맥에서 프롬프트에 y (APPROVAL_EXECUTION_ENABLED=1)"
echo "    · 슬랙 연동은 대시보드 Settings → Slack 위저드에서(공개 URL·웹훅 불필요)."
