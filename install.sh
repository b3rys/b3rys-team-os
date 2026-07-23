#!/usr/bin/env bash
# b3rys TEAM OS — 다운로드 후 원클릭 설치 (랩탑/Mac/PC, bun·tmux 없어도 OK).
#   1) bun 확인/설치  1a) 활성화 준비물 tmux 확인/설치(macOS)  2) 의존성 설치  3) 대시보드 빌드  4) .env 준비  5) 점검·안내
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

# ── 1a) 활성화 준비물: tmux (claude 팀원 기동에 필요, macOS 전용) ──────────
# claude_channel 팀원은 tmux 세션에 프롬프트를 주입해 동작한다(README '영입 전 준비').
# tmux 는 macOS 기본 미탑재라, 없으면 활성화 preflight 가 막는다. 여기서 미리 깔아
# 클린 머신(brew·tmux 없음)에서도 b3os 스킬 경로와 동등하게 바로 팀원을 기동하게 한다.
# tmux 설치엔 Homebrew 가 필요 → 없으면 먼저 부트스트랩. 활성화(launchd)는 macOS 전용이라
# tmux 준비도 macOS 에서만 시도. 실패해도 설치는 계속(대시보드는 tmux 없이 동작). (GD 2026-07-22)
if [ "$(uname -s)" = "Darwin" ] && ! command -v tmux >/dev/null 2>&1; then
  if ! command -v brew >/dev/null 2>&1; then
    if [ -t 0 ]; then
      warn "tmux 설치에 필요한 Homebrew 가 없어 설치합니다 (https://brew.sh · 중간에 암호를 물을 수 있음)…"
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || true
      [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
      [ -x /usr/local/bin/brew ]  && eval "$(/usr/local/bin/brew shellenv)"
    else
      warn "⚠ tmux·Homebrew 가 없습니다(비대화형 실행). 팀원 활성화 전에 https://brew.sh 설치 후 'brew install tmux' 를 직접 실행하세요."
    fi
  fi
  if command -v brew >/dev/null 2>&1; then
    warn "tmux 가 없어 설치합니다 (brew install tmux)…"
    brew install tmux || warn "⚠ tmux 자동 설치 실패 — 팀원 활성화 전에 'brew install tmux' 로 직접 설치하세요."
  fi
fi
if [ "$(uname -s)" = "Darwin" ] && command -v tmux >/dev/null 2>&1; then
  say "✅ tmux $(tmux -V 2>/dev/null | awk '{print $2}')"
fi

# ── 2) 의존성 설치 ───────────────────────────────────────────────
say "■ 의존성 설치 (bun install)…"
bun install

# ── 3) 대시보드 빌드 (서버가 정적 산출물을 서빙) ─────────────────
say "■ 대시보드 빌드 (bun run build)…"
bun run build

# ── 3a) 설치 스킬을 이 clone 에 심링크 (drift 영구해법) ───────────────
# 설치된 스킬 사본(~/.claude/skills/b3os)은 git pull 로 자동 갱신되지 않는다(별개 복사본).
#   → 이 clone 의 skills/b3os 로 심링크하면 pull 만 하면 스킬이 자동 최신. (GD 2026-07-20 proposal prop_11925c42fdfa)
# ★안전(ames 반대리뷰 반영)★: target 존재 검증 → 기존 실디렉터리는 백업 → 임시링크 원자적 rename → 실패 시 복원.
#   심링크 불가 환경(일부 Windows)은 안내만 하고 건너뜀(설치본 그대로 = 수동 갱신 필요).
SKILL_SRC="$ROOT/skills/b3os"
SKILL_DEST="$HOME/.claude/skills/b3os"
if [ -f "$SKILL_SRC/SKILL.md" ]; then
  if [ -L "$SKILL_DEST" ] && [ "$(readlink "$SKILL_DEST" 2>/dev/null)" = "$SKILL_SRC" ]; then
    say "✅ 설치 스킬이 이미 이 clone 에 심링크됨 (pull 로 자동 최신) → ${SKILL_DEST/#$HOME/~}"
  else
    mkdir -p "$HOME/.claude/skills"
    _tmp="$SKILL_DEST.tmp-$$"
    _bak="$SKILL_DEST.bak-$(date +%s)-$$"   # $$ 포함 → 같은-초 재실행 시 백업 이름 충돌 방지
    rm -rf "$_tmp" 2>/dev/null || true
    if ln -s "$SKILL_SRC" "$_tmp" 2>/dev/null; then
      # 기존 DEST(실디렉터리/링크)를 백업으로 옮겨 슬롯을 비운다. 실제로 옮겨졌을 때만 _moved 기록.
      _moved=""
      if [ -e "$SKILL_DEST" ] || [ -L "$SKILL_DEST" ]; then
        if mv "$SKILL_DEST" "$_bak" 2>/dev/null; then _moved="$_bak"; fi
      fi
      # ★슬롯이 실제로 빈 경우에만 rename★ — 안 비었으면 'mv tmp DEST' 가 DEST 안에 nesting 돼
      #   옛 사본이 그대로 남는데 -f SKILL.md 로는 거짓 성공이 된다(ames 반대리뷰). 성공검증은 -L(링크됨).
      if [ ! -e "$SKILL_DEST" ] && [ ! -L "$SKILL_DEST" ] && mv "$_tmp" "$SKILL_DEST" 2>/dev/null && [ -L "$SKILL_DEST" ]; then
        say "✅ 설치 스킬 → 이 clone 에 심링크 (이제 'git pull' 만 하면 스킬 자동 최신)"
        [ -n "$_moved" ] && say "   (기존 사본 백업: ${_moved/#$HOME/~})"
        warn "   Claude Code 에서 /reload-skills 한 번 실행하면 즉시 반영됩니다."
      else
        # 실패 → tmp 링크 제거 후, 옮긴 백업이 있고 슬롯이 비었으면 원위치 복원.
        rm -rf "$_tmp" 2>/dev/null || true
        if [ -n "$_moved" ] && [ ! -e "$SKILL_DEST" ] && [ ! -L "$SKILL_DEST" ]; then
          mv "$_moved" "$SKILL_DEST" 2>/dev/null || true
        fi
        warn "⚠ 스킬 심링크 실패 — 기존 설치본 유지(수동 갱신 필요). git pull 후 'cp -R $SKILL_SRC/. $SKILL_DEST/' + /reload-skills."
      fi
    else
      rm -rf "$_tmp" 2>/dev/null || true
      warn "⚠ 심링크 미지원 환경 — 설치본 그대로. 업데이트 시 'cp -R $SKILL_SRC/. $SKILL_DEST/' + /reload-skills."
    fi
  fi
fi

# ── 4) .env 준비 ─────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  say "✅ .env 생성 (.env.example 복사) — 기본값으로 대시보드는 바로 동작."
  say "  텔레그램 봇·팀장 chat_id·그룹 연결은 ★대시보드 Settings★에서 안내에 따라 넣으면 됩니다(수동 .env 편집 불필요). 봇 토큰은 BotFather에서 사람이 발급."
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

# Scheduler is operational by default on fresh and existing installs. Preserve
# explicit operator values; only append missing keys.
grep -q '^B3OS_SCHEDULER_ENABLED=' .env 2>/dev/null || printf 'B3OS_SCHEDULER_ENABLED=true\n' >> .env
grep -q '^B3OS_SCHEDULER_DRY_RUN=' .env 2>/dev/null || printf 'B3OS_SCHEDULER_DRY_RUN=0\n' >> .env

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
echo "    → 브라우저: http://localhost:${TEAM_HTTP_PORT:-7878}/team   # 포트 바꿨으면 그 포트(.env TEAM_HTTP_PORT)"
echo "    → 상단 'Settings' 탭에서 팀명·미션·팀원(영입) 설정"
echo ""
echo "  개발 모드(코드 수정 핫리로드):  bun run dev"
# ★파일로 튕기지 않는다 (2026-07-18 GD)★ — 사용자는 로컬 파일을 열지 않는다. 실제 단계 안내는
#   Claude Code(b3os 스킬)가 대시보드에서 대화로 처리한다. 여기서는 '사람만 할 수 있는 3가지'만 인라인으로 짚는다.
warn "  사람만 할 수 있는 3가지 (나머지 단계는 Claude Code 가 대시보드에서 안내합니다):"
echo "    1) 봇 토큰 — 텔레그램 @BotFather 에서 /newbot → 나온 토큰을 대시보드 영입 화면에 붙여넣기"
echo "    2) 런타임 선택 — Claude(권장) · OpenClaw · Hermes"
echo "    3) 활성화 승인 — 본인 맥에서 프롬프트에 y (APPROVAL_EXECUTION_ENABLED=1)"
echo "    · 슬랙 연동은 대시보드 Settings → Slack 위저드에서(공개 URL·웹훅 불필요)."
