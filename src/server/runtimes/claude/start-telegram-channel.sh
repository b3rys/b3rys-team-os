#!/usr/bin/env bash
# Start Claude Code Telegram Channel session in tmux.
#
# 디자인 원칙: 항상 named state dir (multi-bot ready by default).
#   봇 1개 운영 시에도 명시적 이름 사용 → 봇 추가 시 migration 없음.
#
# Usage:
#   start-telegram-channel.sh <name>            # 봇 이름 필수 (예: dev, mbp, asset)
#   start-telegram-channel.sh                   # 이름 비우면 default = "claude"
#   start-telegram-channel.sh <name> --resume   # 이전 세션 이어서 (context 유지)
#   RESUME=1 start-telegram-channel.sh <name>   # env 변수로도 가능
#
# 자원 매핑 (name 별):
#   - tmux session   : claude-<name>
#   - State dir      : ~/.claude/channels/telegram-<name>/
#   - Token          : ~/.claude/channels/telegram-<name>/.env
#   - Working dir    : 우선순위 — env WORKDIR > ~/Development/<name>/ > $HOME
#
# 페어링:
#   - 항상 작동: access.json 의 allowFrom 에 DM chat_id 추가 + dmPolicy="allowlist" (수동/Claude Code 편집)
#   - setup-claude-telegram-bot 스킬 있으면 promote-pending.sh <name> <code> 도 가능
#   - slash '/telegram:access pair' 는 named 봇(telegram-<name>)엔 미지원(기본 dir만 봄)
#
# 환경변수:
#   WORKDIR — Claude Code 가 시작할 디렉토리 명시 지정
#             예: WORKDIR=~/Development/myapp ./start-telegram-channel.sh dev
#
# Idempotent: if the target session already exists, prints attach hint and exits 0.
# Safe to call from launchd at every login.

set -euo pipefail

# --resume / --force 인자 검사 (위치 무관) — 플래그는 ARGS(BOT_NAME 계산)에서 제외
RESUME_FLAG=0
FORCE_FLAG=0
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--resume" || "$arg" == "-r" ]]; then
    RESUME_FLAG=1
  elif [[ "$arg" == "--force" || "$arg" == "-f" ]]; then
    FORCE_FLAG=1
  else
    ARGS+=("$arg")
  fi
done
# env 변수로도 활성화 가능
if [[ "${RESUME:-}" == "1" || "${RESUME:-}" == "true" ]]; then
  RESUME_FLAG=1
fi

BOT_NAME="${ARGS[0]:-claude}"   # 비우면 default = "claude" (multi-bot ready)
PLUGIN="telegram@claude-plugins-official"
# 모델 명시 (2026-05-30 GD 결정): CLI default 가 아직 4.7 이라 명시 필요. env 로 override 가능.
CLAUDE_MODEL="${CLAUDE_MODEL:-claude-opus-4-8}"

SESSION_NAME="claude-$BOT_NAME"
STATE_DIR="$HOME/.claude/channels/telegram-$BOT_NAME"

# WORKDIR 결정 — 우선순위:
#   1) 환경변수 WORKDIR (서버 launcher 가 항상 MEMBERS_ROOT/<id> 로 명시 전달 = 프로덕션 경로)
#   2) <워크스페이스 루트>/$BOT_NAME (수동 실행 폴백). 루트는 서버 resolveMembersRoot 와 ★동일 관례★로 해석
#      (퍼블릭 포터블 — ~/Development 하드코딩 회피): B3RYS_MEMBERS_ROOT > $B3RYS_HOME/members > ~/b3os/members(기본).
#      레거시 ~/Development/$BOT_NAME 도 확인(OWNER 관례 무마이그레이션 보존).
#   3) 어느 루트에도 없으면: 등록 팀원 → exit 1(좀비봇 방지), 미등록 → $HOME(WARN).
if [[ -n "${WORKDIR:-}" ]]; then
  : # 그대로 사용 (프로덕션 = launcher 전달)
else
  if [[ -n "${B3RYS_MEMBERS_ROOT:-}" ]]; then _MEMBERS_ROOT="$B3RYS_MEMBERS_ROOT"
  elif [[ -n "${B3RYS_HOME:-}" ]]; then _MEMBERS_ROOT="$B3RYS_HOME/members"
  else _MEMBERS_ROOT="$HOME/b3os/members"; fi
  if [[ -n "$BOT_NAME" && -d "$_MEMBERS_ROOT/$BOT_NAME" ]]; then
    WORKDIR="$_MEMBERS_ROOT/$BOT_NAME"
  elif [[ -n "$BOT_NAME" && -d "$HOME/Development/$BOT_NAME" ]]; then
    WORKDIR="$HOME/Development/$BOT_NAME"   # 레거시 OWNER 관례 폴백
  else
    # 워크스페이스가 어느 루트에도 없음. $HOME 폴백은 항상 존재해 아래 -d 가드를 그냥 통과 → 룰(CLAUDE.md/TEAM-OS.md)
    # 0개 '좀비봇'이 에러 없이 뜬다(demis 2026-07-17 실측: cwd 만 바꿔도 TEAM-OS 가 컨텍스트에서 통째로 사라짐).
    # 그래서 agents.json 에 등록된 진짜 팀원이면 폴백을 막고 큰 소리로 실패한다(룰 상실을 조용→시끄럽게).
    _SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    _AGENTS_JSON="$_SCRIPT_DIR/../../../../agents.json"
    if [[ -n "$BOT_NAME" && -f "$_AGENTS_JSON" ]] && grep -qE "\"id\"[[:space:]]*:[[:space:]]*\"$BOT_NAME\"" "$_AGENTS_JSON"; then
      echo "ERROR: '$BOT_NAME' 은 agents.json 에 등록된 팀원인데 워크스페이스가 없습니다('$_MEMBERS_ROOT/$BOT_NAME')." >&2
      echo "  → \$HOME 폴백을 막습니다(룰 없는 좀비봇 방지). 워크스페이스를 만들거나 WORKDIR 를 명시하세요." >&2
      exit 1
    fi
    echo "WARN: '$BOT_NAME' 워크스페이스가 없어 \$HOME 에서 실행합니다(팀 룰 미로드 가능)." >&2
    WORKDIR="$HOME"
  fi
fi
if [[ ! -d "$WORKDIR" ]]; then
  echo "ERROR: WORKDIR '$WORKDIR' 디렉토리가 없습니다."
  exit 1
fi

PLUGIN_ENV="$STATE_DIR/.env"

# ─── Pre-flight ───────────────────────────────────────────────────────────

if [[ ! -f "$PLUGIN_ENV" ]]; then
  echo "ERROR: $PLUGIN_ENV missing. Plugin token not configured."
  echo ""
  echo "First-time setup:"
  echo "  1. BotFather: /newbot → save the token"
  echo "  2. mkdir -p $STATE_DIR"
  echo "  3. echo 'TELEGRAM_BOT_TOKEN=<token>' > $PLUGIN_ENV"
  echo "  4. chmod 600 $PLUGIN_ENV"
  echo "  5. Re-run this script"
  exit 1
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "ERROR: tmux not installed."
  if command -v brew >/dev/null 2>&1; then
    echo "  brew install tmux"
  else
    echo "  Homebrew (https://brew.sh) 또는 MacPorts 로 설치 필요."
  fi
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "ERROR: Bun not installed. Channels Telegram plugin requires Bun."
  if command -v brew >/dev/null 2>&1; then
    echo "  brew install oven-sh/bun/bun"
  else
    echo "  Homebrew 가 없으면: curl -fsSL https://bun.sh/install | bash"
    echo "  설치 후 ~/.bun/bin 을 PATH 에 추가해야 함."
  fi
  exit 1
fi

if command -v claude >/dev/null 2>&1; then
  CLAUDE_BIN="$(command -v claude)"
else
  # launchd 가 shell rc 를 source 하지 않아 PATH 가 좁을 때, 알려진 설치 위치들을
  # 순서대로 시도한다. ~/.claude/local/claude 레이아웃(preflight checkClaudeAuth 가
  # 유효로 인정)까지 커버 — 없으면 봇 tmux 세션이 죽고 deaf-bot 루프에 빠지던 함정
  # 방지(하네스 근본, GD 2026-07-02).
  CLAUDE_BIN=""
  for _candidate in \
    "$HOME/.local/bin/claude" \
    "$HOME/.claude/local/claude" \
    "/opt/homebrew/bin/claude" \
    "/usr/local/bin/claude"; do
    if [[ -x "$_candidate" ]]; then
      CLAUDE_BIN="$_candidate"
      break
    fi
  done
  if [[ -z "$CLAUDE_BIN" ]]; then
    echo "ERROR: claude binary not found"
    exit 1
  fi
fi

# ─── Idempotent: skip if session already exists (unless --force/RESTART) ────
# --force(또는 RESTART_FORCE=1): 기존 세션을 kill 후 새로 띄운다. 깨진 세션(예: MCP poller가 죽어 bot.pid 없음)을
#   단순 재실행 시 이 가드가 no-op이라 복구가 안 되던 함정 방지(하네스 근본, GD 2026-07-02).
[[ "${RESTART_FORCE:-}" == "1" || "${RESTART_FORCE:-}" == "true" ]] && FORCE_FLAG=1

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  if [[ $FORCE_FLAG -eq 1 ]]; then
    echo "Force restart — killing existing session '$SESSION_NAME'."
    tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
    sleep 1
  else
    echo "Session '$SESSION_NAME' already running."
    echo "Attach: tmux attach -t $SESSION_NAME"
    exit 0
  fi
fi

# ─── Spawn ────────────────────────────────────────────────────────────────

# Quote-safe inline command for tmux: use printf %q on paths.
# TELEGRAM_STATE_DIR tells the channels plugin which state dir to use.
# --resume 시 --continue 추가 (working dir 의 마지막 세션 이어서)
if [[ $RESUME_FLAG -eq 1 ]]; then
  INNER_CMD=$(printf 'TELEGRAM_STATE_DIR=%q %q --channels plugin:%s --model %q --continue' \
    "$STATE_DIR" "$CLAUDE_BIN" "$PLUGIN" "$CLAUDE_MODEL")
  echo "RESUME mode — claude --continue --model $CLAUDE_MODEL (이전 세션 이어서)"
else
  INNER_CMD=$(printf 'TELEGRAM_STATE_DIR=%q %q --channels plugin:%s --model %q' \
    "$STATE_DIR" "$CLAUDE_BIN" "$PLUGIN" "$CLAUDE_MODEL")
  echo "FRESH mode — claude --model $CLAUDE_MODEL"
fi

tmux new-session -d -s "$SESSION_NAME" -c "$WORKDIR" "$INNER_CMD"

echo "Started tmux session: $SESSION_NAME"
echo "  State dir   : $STATE_DIR"
echo "  Working dir : $WORKDIR"
echo "  Resume mode : $([[ $RESUME_FLAG -eq 1 ]] && echo "ON (--continue)" || echo "OFF (fresh)")"
echo "Attach: tmux attach -t $SESSION_NAME"

# ─── First-time pairing hint ──────────────────────────────────────────────

if [[ ! -s "$STATE_DIR/access.json" ]] \
  || ! grep -q '"allowFrom"' "$STATE_DIR/access.json" 2>/dev/null; then
  echo ""
  echo "─── 첫 셋업 — 다음 단계 ───────────────────────────────────────"
  echo ""
  echo "[A] tmux 세션 attach (새 터미널 권장):"
  echo "    tmux attach -t $SESSION_NAME"
  echo ""
  echo "[B] 안에서 trust 폴더 prompt 가 뜨면 'Enter' 로 trust 선택"
  echo ""
  echo "[C] plugin 설치 + 활성화 (한 줄씩 입력):"
  echo "    /plugin install $PLUGIN"
  echo "    (user-scope 선택, Enter)"
  echo "    /reload-plugins"
  echo ""
  echo "[D] 텔레그램 폰에서 봇 채팅 열기:"
  if [[ -n "${TELEGRAM_BOT_USERNAME:-}" ]]; then
    echo "    https://t.me/$TELEGRAM_BOT_USERNAME"
  else
    echo "    @<your-bot-username>  # BotFather 가 알려준 username"
  fi
  echo ""
  echo "[E] 봇에 두 번 메시지:"
  echo "    1) /start  → 사용 안내문 옴 (정상)"
  echo "    2) 'hi' (또는 아무 메시지) → 6자리 페어링 코드 응답"
  echo ""
  echo "[F] 페어링 통과 (DM 허용) — 항상 작동: 이 봇의 access.json"
  echo "    ($STATE_DIR/access.json)에서 allowFrom 에 본인 텔레그램 DM chat_id 를 추가하고"
  echo "    dmPolicy 를 \"allowlist\" 로 바꾼다. (setup-claude-telegram-bot 스킬이 있으면"
  echo "    promote-pending.sh <name> <코드> 도 가능. slash '/telegram:access pair' 는 named 봇엔 미지원.)"
  echo "    (팀 그룹 응답은 그룹 셋업 시 자동 시드 — DM만 페어링 필요)"
  echo ""
  echo "[G] 다시 텔레그램 → 메시지 보내면 Claude 응답이 폰으로 도착 ✅"
fi
