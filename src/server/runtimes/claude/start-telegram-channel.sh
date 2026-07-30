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
# 모델: ★기본값 없음★ (2026-07-25 GD 결정). 비우면 --model 플래그를 아예 붙이지 않아
#   claude 가 저장된 기본값(사용자가 /model 로 고른 값)을 그대로 쓴다.
#   여기에 모델을 하드코딩하면 CLI 플래그가 저장 기본값을 항상 이겨서, /model 로 바꿔도
#   재시작마다 하드코딩 값으로 되돌아간다(2026-07-25 실측: 4.8 고착).
#   특정 봇만 모델을 고정하려면 CLAUDE_MODEL=<id> 로 실행.
#   ※ --continue(resume) 는 이전 세션의 모델을 그대로 이어받으므로, 모델 교체는 fresh 기동에서 적용된다.
CLAUDE_MODEL="${CLAUDE_MODEL:-}"

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

if command -v bun >/dev/null 2>&1; then
  BUN_BIN="$(command -v bun)"
else
  # launchd/좁은 PATH: shell rc 를 source 하지 않아 bun(~/.bun/bin)이 PATH 에 없을 수 있다.
  # claude 처럼 알려진 설치 위치를 순서대로 시도한다. (없으면 아래에서 에러)
  BUN_BIN=""
  for _candidate in \
    "$HOME/.bun/bin/bun" \
    "$HOME/.local/bin/bun" \
    "/opt/homebrew/bin/bun" \
    "/usr/local/bin/bun"; do
    if [[ -x "$_candidate" ]]; then
      BUN_BIN="$_candidate"
      break
    fi
  done
fi
if [[ -z "$BUN_BIN" ]]; then
  echo "ERROR: Bun not installed. Channels Telegram plugin requires Bun."
  if command -v brew >/dev/null 2>&1; then
    echo "  brew install oven-sh/bun/bun"
  else
    echo "  Homebrew 가 없으면: curl -fsSL https://bun.sh/install | bash"
    echo "  설치 후 ~/.bun/bin 을 PATH 에 추가해야 함."
  fi
  exit 1
fi
# ★MCP 텔레그램 서버는 claude 가 bun 으로 spawn 한다★ — 멤버 tmux 세션(non-interactive)의
# PATH 에 bun 이 없으면 ENOENT 로 MCP 서버가 안 뜨고 poller 가 안 붙는다(deaf bot).
# .zshrc 로만 bun PATH 를 넣은 fresh clone 에서 실측된 함정(GD 2026-07-24). bun 설치 dir 를
# 아래 INNER_CMD 의 세션 PATH 에 prepend 해서 claude 와 그 MCP 자식이 항상 bun 을 찾게 한다.
BUN_DIR="$(cd "$(dirname "$BUN_BIN")" && pwd)"

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

# 권한 모드 — 봇 tmux 세션엔 사람이 붙어있지 않아 권한 프롬프트에 답할 수 없다.
# 그래서 auto(분류기가 안전한 bash 는 자동 승인, 위험·유출·force-push 는 차단)로 기동한다.
# ★CLI 플래그라 유저/프로젝트 settings.json 과 무관하게 확실히 적용★ — 프로젝트 스코프의
# permissions.defaultMode:"auto" 는 Claude Code v2.1.142+ 에서 무시되므로 settings 로는 못 켠다.
# env override: CLAUDE_PERMISSION_MODE=default(사람 승인)·acceptEdits·bypassPermissions 등.
# 빈 문자열이면 플래그를 생략(멤버 settings.json 에 위임). fresh·resume(리스타트) 양쪽 다 적용.
CLAUDE_PERMISSION_MODE="${CLAUDE_PERMISSION_MODE-auto}"
PERM_FLAG=""
if [[ -n "$CLAUDE_PERMISSION_MODE" ]]; then
  PERM_FLAG=$(printf ' --permission-mode %q' "$CLAUDE_PERMISSION_MODE")
fi

# Quote-safe inline command for tmux: use printf %q on paths.
# TELEGRAM_STATE_DIR tells the channels plugin which state dir to use.
# --resume 시 --continue 추가 (working dir 의 마지막 세션 이어서)
# bun 설치 dir 를 세션 PATH 에 prepend ($PATH 는 tmux 셸이 확장) — claude 가 spawn 하는 MCP
# 텔레그램 서버가 non-interactive PATH 에서도 bun 을 찾게 한다(위 BUN_DIR 참고).
BUN_PATH_ENV="$(printf 'PATH=%q:"$PATH" ' "$BUN_DIR")"
# CLAUDE_MODEL 이 비어 있으면 --model 플래그 자체를 생략(= claude 저장 기본값 사용).
MODEL_FLAG=""
if [[ -n "$CLAUDE_MODEL" ]]; then
  MODEL_FLAG=$(printf ' --model %q' "$CLAUDE_MODEL")
fi
MODEL_DESC="--model ${CLAUDE_MODEL:-생략(저장된 기본값)}"
if [[ $RESUME_FLAG -eq 1 ]]; then
  INNER_CMD="${BUN_PATH_ENV}$(printf 'TELEGRAM_STATE_DIR=%q %q --channels plugin:%s' \
    "$STATE_DIR" "$CLAUDE_BIN" "$PLUGIN")$MODEL_FLAG$PERM_FLAG --continue"
  echo "RESUME mode — claude --continue $MODEL_DESC --permission-mode ${CLAUDE_PERMISSION_MODE:-<none>} (이전 세션 이어서)"
else
  INNER_CMD="${BUN_PATH_ENV}$(printf 'TELEGRAM_STATE_DIR=%q %q --channels plugin:%s' \
    "$STATE_DIR" "$CLAUDE_BIN" "$PLUGIN")$MODEL_FLAG$PERM_FLAG"
  echo "FRESH mode — claude $MODEL_DESC --permission-mode ${CLAUDE_PERMISSION_MODE:-<none>}"
fi

# ★telegram 플러그인 user-scope enable — settings.json 직접 기록(2026-07-25 하네스 §3 fix, 캐시 무접촉)★.
#   ⚠ `claude plugin install` 을 쓰지 않는다 — 그 명령은 공유 플러그인 캐시(`…/telegram/<ver>/`)를 temp 빌드 후
#   ★inode 째 스왑★해, 같은 캐시에서 실행 중인 다른 팀원 봇 세션의 cwd 를 unlink 시킨다(하네스 CONFIRMED: birthtime +
#   lsof cwd inode 불일치로 특정). `enabledPlugins` 키가 install 의 durable 결과물 전부이므로 그 키만 멱등 기록한다.
#   (scope 는 실패의 근본이 아니다 — 하네스 4-way 로 반증(양 워크스페이스 settings 바이트 동일). enable 은 채널 인식용
#    안전장치로만 유지. 진짜 근본=부팅 MCP 열거 누락이며 복구는 activation 의 auto-reconnect 가 담당.)
# ★멱등★: 이미 enable 돼 있으면 skip(머신당 1회, 첫 멤버만 기록).
_USER_SETTINGS="$HOME/.claude/settings.json"
if grep -q "\"$PLUGIN\"" "$_USER_SETTINGS" 2>/dev/null; then
  echo "  MCP plugin  : $PLUGIN 이미 user-scope enable(skip)"
elif command -v python3 >/dev/null 2>&1 && python3 -c '
import json, os, sys, tempfile
p, pl = sys.argv[1], sys.argv[2]
# ★파싱 실패 시 절대 덮어쓰지 않는다★(하네스 MEDIUM fix): 동시쓰기로 settings.json 이 순간 깨져 보이면 exit 1 →
#   셸 else 브랜치(수동 안내)로 폴백. d={} 후 전체 덮으면 permissions·hooks·env 등 전체 설정을 날린다.
try:
    d = json.load(open(p)) if os.path.exists(p) else {}
except Exception:
    sys.exit(1)
if not isinstance(d, dict): sys.exit(1)
ep = d.get("enabledPlugins")
if not isinstance(ep, dict): ep = {}
ep[pl] = True
d["enabledPlugins"] = ep
dn = os.path.dirname(p) or "."
os.makedirs(dn, exist_ok=True)
# ★원자적 쓰기★: temp 에 쓴 뒤 os.replace — 중간에 죽어도 원본이 깨지지 않는다.
fd, tmp = tempfile.mkstemp(dir=dn)
try:
    with os.fdopen(fd, "w") as f: json.dump(d, f, indent=2)
    os.replace(tmp, p)
except Exception:
    try: os.unlink(tmp)
    except Exception: pass
    sys.exit(1)
' "$_USER_SETTINGS" "$PLUGIN" >/dev/null 2>&1; then
  echo "  MCP plugin  : $PLUGIN user-scope enable ✓ (settings.json 직접, 캐시 무접촉)"
else
  echo "  ⚠ MCP plugin enable 자동기록 실패(계속) — 안 붙으면 세션에서 /plugin 으로 수동 enable"
fi

# ★pre-warm 제거는 유지(2026-07-25 하네스 4-way 확정)★: 이전엔 "콜드 `bun install` → CC 30s MCP 핸드셰이크 초과 →
#   타임아웃"을 근본으로 보고 node_modules pre-warm + 버전락 mutex 를 뒀으나, ★실패 세션 MCP 로그에 `Starting connection`
#   이 0건★ = 타임아웃이 아니라 부팅 MCP 열거에서 telegram 이 아예 빠진 것으로 반증됐다. 그 타임아웃이 애초에 없으므로
#   pre-warm 은 헛수고이고, 오히려 매 스폰마다 공유 플러그인 캐시에서 `bun install` 을 돌려 형제 세션과 경합을 늘렸다 → 제거.
#   진짜 복구는 activation 의 auto-reconnect(`/mcp reconnect`)가 담당한다.
#   ⚠ 아래 stagger 는 그 pre-warm 의 부활이 아니다 — 공유 캐시를 ★건드리지 않는다★(bun install 없음). 스폰 순서만 직렬화한다.

# ─── Spawn stagger (공유 플러그인 캐시 binlink 경합 가드) ────────────────────
# 2026-07-30 실측(리사 28분 무응답): jane·lisa launchd 잡이 RunAtLoad 로 ★같은 초★(08:03:33)에 떠서
#   두 세션의 claude 가 공유 플러그인 캐시(…/telegram/<ver>/)에 `bun run` 을 동시에 걸었다.
#   bun 이 node_modules/.bin binlink 를 동시 생성 → 한쪽이 `error: Failed to link which: EEXIST` 로 죽고
#   `MCP error -32000: Connection closed`(144ms) → bot.pid 미생성 → 그 멤버는 텔레그램을 아예 못 받는다.
#   jane 은 경합을 이겨 정상, lisa 만 탈락 = 부팅마다 뽑기.
# ★2026-07-25 케이스와 실패 서명이 다르다★: 그땐 MCP 로그에 `Starting connection` 0건(열거 누락),
#   이번엔 `Starting connection` 있고 144ms 뒤 `Connection closed`(링크 실패). 그래서 다른 처방이 맞다.
# 처방: 머신 단위 mutex 로 ★스폰만★ 직렬화하고, 새 세션의 poller 가 bot.pid 를 쓸 때까지 기다렸다 락을 놓는다.
#   → 두 번째 멤버의 claude 는 캐시 링크가 끝난 뒤에 뜨므로 링크할 게 없다(경합 소멸).
# flock(1) 은 macOS 기본 미포함 → mkdir 원자성으로 구현. 락 획득 실패는 ★기동을 막지 않는다★(경고 후 진행).
STAGGER_LOCK="${CLAUDE_START_STAGGER_LOCK:-$HOME/.claude/channels/.spawn.lock}"
STAGGER_SETTLE_MAX="${CLAUDE_START_STAGGER_SETTLE:-25}"    # 내 poller 안착(bot.pid) 대기 상한(초)
# ★ACQUIRE 는 SETTLE 에서 유도한다★ — 고정 60 으로 두면 claude 멤버가 3명 이상일 때 마지막 멤버의
#   대기가 (N-1)×SETTLE 로 상한을 넘겨 '락 미확보 → 경합 안고 진행' = 고치려던 그 경합으로 되돌아간다.
#   (N-1)×SETTLE + 여유. N 은 claude 봇 LaunchAgent plist 수로 센다(없으면 2로 가정).
#   ※ `ls … | wc -l` 로 세지 않는다 — 매칭 0건이면 ls 가 실패하고 set -o pipefail + set -e 때문에
#     ★스크립트가 그 자리에서 죽는다★(기동 자체가 안 된다). 순수 glob 으로 센다.
_claude_members=0
for _p in "$HOME/Library/LaunchAgents/"*.claude-telegram-*.plist; do
  [[ -e "$_p" ]] && _claude_members=$(( _claude_members + 1 ))
done
(( _claude_members < 2 )) && _claude_members=2
STAGGER_ACQUIRE_MAX="${CLAUDE_START_STAGGER_ACQUIRE:-$(( (_claude_members - 1) * STAGGER_SETTLE_MAX + 20 ))}"
STAGGER_STALE_CONFIRM="${CLAUDE_START_STAGGER_STALE_CONFIRM:-5}"  # 같은 죽은 pid 를 연속 관찰해야 하는 초
_stagger_held=0
# release 도 ★내 락인지 확인하고★ 지운다. 회수 로직이 창을 극단적으로 좁혔어도 완전히 닫지는
#   못하므로(오회수 → 되돌리기 실패 경로가 이론상 남는다), 그 최악 결과가 '해제할 때 남의 락을
#   지운다' 로 연쇄되는 걸 여기서 끊는다. 좁은 경합을 더 쫓는 대신 최악 결과를 없애는 쪽.
#   (리사 리뷰 F1, 2026-07-30)
_stagger_release() {
  [[ $_stagger_held -eq 1 ]] || return 0
  local _cur
  _cur="$(cat "$STAGGER_LOCK/pid" 2>/dev/null || true)"
  if [[ "$_cur" == "$$" ]]; then
    rm -rf "$STAGGER_LOCK" 2>/dev/null || true
  fi
  return 0
}

if [[ "${CLAUDE_START_NO_STAGGER:-}" == "1" || "${CLAUDE_START_NO_STAGGER:-}" == "true" ]]; then
  echo "  Stagger     : OFF (CLAUDE_START_NO_STAGGER)"
else
  mkdir -p "$(dirname "$STAGGER_LOCK")" 2>/dev/null || true
  _waited=0
  _stale_pid=""      # 연속 관찰 중인 '죽은 소유자' pid
  _stale_seen=0      # 그 pid 를 연속 관찰한 횟수(초)
  while (( _waited < STAGGER_ACQUIRE_MAX )); do
    if mkdir "$STAGGER_LOCK" 2>/dev/null; then
      # ★pid 를 못 적으면 락을 쥔 채로 진행하지 않는다★ — 그 상태가 ★영구 고아 락★ 을 만든다.
      #   아래 회수 로직은 pid 를 읽어 죽었는지 보는데, ★pid 가 없으면 그 판정이 성립하지 않는다.★
      #   실측(2026-07-30 격리 재현): pid 없는 락 폴더 하나면 그 뒤 모든 기동이 상한까지 기다렸다가
      #   ★경합을 안고 뜨고 폴더는 영구 잔존★ 한다. 우리 기계 기준 매 기동 120초 + 경합 무방비.
      #   적기에 실패하면 ★내가 만든 폴더를 즉시 지우고★ 락 없이 간다 — 경합 위험은 감수하되 영구화는 막는다.
      if echo "$$" > "$STAGGER_LOCK/pid" 2>/dev/null; then
        _stagger_held=1
        trap _stagger_release EXIT
        break
      fi
      rm -rf "$STAGGER_LOCK" 2>/dev/null || true
      echo "  ⚠ Stagger   : 락 pid 기록 실패 — 고아 락을 안 남기려 되돌리고 락 없이 진행합니다"
      break
    fi
    # ─ stale 회수 (부팅 중 크래시가 락을 영구 점유하지 않게) ─
    # ★TOCTOU 를 막는다★: "pid 읽고 죽었으면 rm" 은 위험하다 — 읽고 rm 하는 사이에 원 소유자가
    #   정상 release 하고 다른 멤버가 mkdir 로 획득하면 ★남의 살아있는 락을 지운다★(상호배제 붕괴).
    #   그래서 두 겹으로 막는다:
    #   ① 같은 죽은 pid 를 STAGGER_STALE_CONFIRM 초 ★연속★ 관찰해야 회수 후보가 된다.
    #      살아있는 소유자나 새 획득자는 이 조건을 만들 수 없다(새 획득자는 자기 살아있는 pid 를 쓰므로
    #      관찰이 리셋된다). 즉 '방금 갈아치워진 락' 은 후보에서 자동 탈락한다.
    #   ② 회수는 rm 이 아니라 ★원자적 mv★ 로 들어낸 뒤, 들어낸 것의 pid 를 다시 확인한다. mv 는
    #      주어진 디렉토리를 정확히 한 프로세스만 옮길 수 있다. 옮긴 게 알고 보니 살아있는 주인의
    #      락이면 즉시 제자리로 되돌린다.
    #   ③ 회수했다고 스스로 락을 주지 않는다 — 루프 위로 돌아가 mkdir 로 공정하게 다시 경쟁한다.
    _owner="$(cat "$STAGGER_LOCK/pid" 2>/dev/null || true)"
    if [[ -n "$_owner" ]] && ! kill -0 "$_owner" 2>/dev/null; then
      if [[ "$_owner" == "$_stale_pid" ]]; then
        _stale_seen=$(( _stale_seen + 1 ))
      else
        _stale_pid="$_owner"; _stale_seen=1
      fi
      if (( _stale_seen >= STAGGER_STALE_CONFIRM )); then
        _stale_dir="${STAGGER_LOCK}.stale.$$"
        if mv "$STAGGER_LOCK" "$_stale_dir" 2>/dev/null; then
          _moved_pid="$(cat "$_stale_dir/pid" 2>/dev/null || true)"
          if [[ -n "$_moved_pid" ]] && kill -0 "$_moved_pid" 2>/dev/null; then
            # 살아있는 주인의 락을 잘못 들어냈다 → 제자리로. 되돌리기 실패(그새 남이 획득)면 버린다.
            mv "$_stale_dir" "$STAGGER_LOCK" 2>/dev/null || rm -rf "$_stale_dir" 2>/dev/null || true
          else
            rm -rf "$_stale_dir" 2>/dev/null || true
            echo "  Stagger     : stale 락 회수 (죽은 pid=$_owner, ${_stale_seen}s 연속 확인)"
          fi
        fi
        _stale_pid=""; _stale_seen=0
      fi
    else
      # 소유자가 살아있다 / pid 파일이 아직 안 쓰인 찰나 → 관찰 리셋(성급한 탈취 방지)
      _stale_pid=""; _stale_seen=0
    fi
    sleep 1
    _waited=$(( _waited + 1 ))
  done
  if [[ $_stagger_held -eq 1 ]]; then
    if (( _waited > 0 )); then
      echo "  Stagger     : 락 확보 (앞 세션 대기 ${_waited}s) — 스폰 직렬화"
    else
      echo "  Stagger     : 락 확보 (즉시) — 스폰 직렬화"
    fi
  else
    echo "  ⚠ Stagger   : 락 대기 ${STAGGER_ACQUIRE_MAX}s 초과(멤버 ${_claude_members}명 기준) — 경합 위험을 안고 계속 진행"
    # ★락 없이 뜬 사실을 흔적으로 남긴다★ — 지금까지 이 경로는 launchd 의 /tmp 로그 한 줄이 전부였다.
    #   고아 락 하나로 이 경로가 ★상시화★ 될 수 있는데(위 재현), 그러면 보호장치가 사실상 꺼진 채
    #   아무도 모른다. 파일 한 줄이면 doctor·헬스체크가 나중에 주워갈 수 있다. (codex 교차검증)
    printf '%s %s acquire_timeout=%ss members=%s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BOT_NAME" "$STAGGER_ACQUIRE_MAX" "$_claude_members" \
      >> "$(dirname "$STAGGER_LOCK")/.spawn-failopen.log" 2>/dev/null || true
  fi
  # ★스폰 직전에 '내가 아직 주인인가' 를 한 번 더 본다★ (codex HIGH1).
  #   회수 절차가 락을 mv 로 들어내는 순간 경로가 잠깐 빈다. 그 틈에 제3자가 mkdir 로 선점하면
  #   ★원 소유자와 선점자가 동시에 스폰★ 한다 — 이 장치가 막으려던 바로 그 상황이다.
  #   처음 잡을 때만 확인하면 이 창을 못 막는다. 확인 지점을 ★쓰기 직전★ 으로 한 번 더 둔다.
  #   내 것이 아니면 홀더 자격을 내려놓는다(그래야 뒤에서 남의 락을 지우지도 않는다).
  if [[ $_stagger_held -eq 1 ]] && [[ "$(cat "$STAGGER_LOCK/pid" 2>/dev/null || true)" != "$$" ]]; then
    _stagger_held=0
    trap - EXIT
    echo "  ⚠ Stagger   : 스폰 직전 확인 결과 락이 남의 것으로 바뀌었습니다 — 홀더 자격을 내려놓고 진행합니다"
  fi
fi

_spawn_t0=$(date +%s)
tmux new-session -d -s "$SESSION_NAME" -c "$WORKDIR" "$INNER_CMD"

# 내 poller 가 bot.pid 를 ★새로★ 쓸 때까지 락을 쥔 채 기다린다(= 캐시 링크 완료 신호).
#   기존 bot.pid 가 남아있을 수 있으므로 mtime 이 스폰 이후인지 본다(오래된 파일로 조기 통과 방지).
#   bot.pid 를 미리 지우지 않는다 — 플러그인이 그 값으로 stale orphan poller 를 죽이기 때문(server.ts PID_FILE).
if [[ $_stagger_held -eq 1 ]]; then
  _settled=0
  for (( i = 0; i < STAGGER_SETTLE_MAX; i++ )); do
    if [[ -f "$STATE_DIR/bot.pid" ]]; then
      _mt=$(stat -f %m "$STATE_DIR/bot.pid" 2>/dev/null || stat -c %Y "$STATE_DIR/bot.pid" 2>/dev/null || echo 0)
      if (( _mt >= _spawn_t0 )); then _settled=1; break; fi
    fi
    sleep 1
  done
  if [[ $_settled -eq 1 ]]; then
    echo "  Poller      : bot.pid 확인 ✓ (${i}s) — 다음 멤버 스폰 안전"
  else
    echo "  ⚠ Poller    : bot.pid 미확인 (${STAGGER_SETTLE_MAX}s) — MCP 미기동 가능, activation auto-reconnect 대상"
  fi
  _stagger_release
  _stagger_held=0
  trap - EXIT
fi

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
  echo "[C] plugin 설치 + 활성화 (보통 위에서 자동 project-scope 설치됨 — 안 붙었을 때만 수동):"
  echo "    /plugin install $PLUGIN"
  echo "    (★project scope 선택★ — user scope 면 fresh 세션서 MCP 가 안 붙는다)"
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
