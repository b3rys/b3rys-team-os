#!/usr/bin/env bash
# 런타임 드리프트 감시 — claude / openclaw / hermes 는 b3os 와 무관하게 각자 업데이트된다.
# 우리를 깨뜨린 사고는 대부분 "시간이 지나서" 가 아니라 ★저쪽이 업데이트돼서★ 일어났다:
#   · claude 2번째 팀원부터 MCP 미열거   · 런처 --model 이 /model 저장값을 이김
#   · openclaw 데몬이 PATH 의 node 를 plist 에 구움   · hermes one-shot OAuth 401
# 그래서 매일 "여전히 정상" 을 확인하는 것보다 ★버전이 변한 순간을 잡는 것★ 이 값싸고 정확하다.
#
# 이 스크립트가 하는 일 (토큰 0 · 대화 없음):
#   1층 버전 감시 — 기준선과 다르면 알린다. 이게 무거운 스모크를 돌릴 방아쇠다.
#   2층 표면 프로브 — 우리가 실제로 의존하는 표면이 아직 있는지 값싸게 찌른다.
#
# 종료코드: 0 정상 · 1 드리프트(버전 변경) · 2 프로브 실패 · 3 사용법 오류
#   드리프트와 프로브 실패가 겹치면 2 (더 급한 쪽).
#
# 사용:
#   runtime-drift-check.sh            검사만
#   runtime-drift-check.sh --accept   현재 버전을 새 기준선으로 저장
#   runtime-drift-check.sh --json     기계 판독용 출력
#
# bash 3.2 호환 (macOS 기본) — 연관배열·${var^^} 안 씀.

set -u

STATE_DIR="${B3OS_STATE_DIR:-$HOME/.b3os}"
BASELINE="$STATE_DIR/runtime-baseline.tsv"
MODE="check"
# ★--accept 와 --json 은 배타다★ — 예전엔 마지막 인자가 MODE 를 덮어써서, 같은 두 옵션이
#   순서에 따라 정반대로 동작하면서 ★둘 다 rc=0★ 이었다(`--accept --json` = 저장 안 함 / JSON,
#   `--json --accept` = 저장함 / 텍스트). 호출자가 성공으로 읽는데 원하던 일이 안 된다.
#   조합에 의미를 부여하는 대신 ★사용법 오류로 거부★ 한다 — 모드가 늘어도 같은 규칙이 선다.
MODE_SET=""
set_mode() {
  if [ -n "$MODE_SET" ] && [ "$MODE_SET" != "$1" ]; then
    echo "--$MODE_SET 와 --$1 은 함께 쓸 수 없다 (배타적 모드)" >&2; exit 3
  fi
  MODE_SET="$1"; MODE="$1"
}
for arg in "$@"; do
  case "$arg" in
    --accept) set_mode accept ;;
    --json)   set_mode json ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "알 수 없는 인자: $arg" >&2; exit 3 ;;
  esac
done

# ── 바이너리 해석 ────────────────────────────────────────────────
# ★command -v 만 믿으면 안 된다★ — claude 는 셸 함수/alias 로 감싸여 있는 경우가 있고,
# 비대화형에서 그걸 부르면 함수 본문이 깨져 "command not found: _iterm2_ai_" 같은 엉뚱한
# 출력을 버전으로 기록하게 된다(2026-07-26 실제로 밟음). 실경로 후보를 먼저 본다.
resolve_bin() {
  _name="$1"; shift
  for _cand in "$@"; do
    [ -x "$_cand" ] && { printf '%s' "$_cand"; return 0; }
  done
  _which=$(command -v "$_name" 2>/dev/null || true)
  # 셸 함수/alias 면 command -v 가 경로가 아닌 것을 준다 → 실행 가능한 파일일 때만 받는다.
  [ -n "$_which" ] && [ -x "$_which" ] && { printf '%s' "$_which"; return 0; }
  return 1
}

# 설치 위치가 표준을 벗어나는 환경(리눅스·nix·커스텀 prefix)을 위한 주입구.
# 테스트에서 실패 경로를 재현할 때도 쓴다.
CLAUDE_BIN="${B3OS_CLAUDE_BIN:-$(resolve_bin claude "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" || true)}"
# ~/.local/bin 이 맨 앞 — openclaw 는 npm global 로 깔려 거기 들어간다(2026-07-27). 이게 빠져 있어
# 서버(launchd, PATH 에 ~/.local/bin 없음)가 openclaw 를 못 찾은 적이 있다. 드리프트 감시도 같은 눈을 갖는다.
OPENCLAW_BIN="${B3OS_OPENCLAW_BIN:-$(resolve_bin openclaw "$HOME/.local/bin/openclaw" /opt/homebrew/bin/openclaw /usr/local/bin/openclaw || true)}"
HERMES_BIN="${B3OS_HERMES_BIN:-$(resolve_bin hermes /opt/homebrew/bin/hermes "$HOME/.local/bin/hermes" || true)}"
BUN_BIN="${B3OS_BUN_BIN:-$(resolve_bin bun "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun || true)}"
NODE_BIN="${B3OS_NODE_BIN:-$(resolve_bin node /opt/homebrew/bin/node /usr/local/bin/node || true)}"

# 버전 문자열 정규화 — 공백 정리 + 한 줄. 미설치는 "absent"(빈 값과 구분).
ver_of() {
  _bin="$1"; _args="${2:---version}"
  [ -z "$_bin" ] && { printf 'absent'; return 0; }
  _out=$("$_bin" $_args 2>&1 | head -1 | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [ -z "$_out" ] && _out="unknown"
  printf '%s' "$_out"
}

NAMES="claude openclaw hermes bun node"
claude_v=$(ver_of "$CLAUDE_BIN")
openclaw_v=$(ver_of "$OPENCLAW_BIN")
hermes_v=$(ver_of "$HERMES_BIN")
bun_v=$(ver_of "$BUN_BIN")
node_v=$(ver_of "$NODE_BIN")

cur_ver() {
  case "$1" in
    claude) printf '%s' "$claude_v" ;; openclaw) printf '%s' "$openclaw_v" ;;
    hermes) printf '%s' "$hermes_v" ;; bun) printf '%s' "$bun_v" ;; node) printf '%s' "$node_v" ;;
  esac
}

# ── 기준선 ───────────────────────────────────────────────────────
baseline_ver() {
  [ -f "$BASELINE" ] || return 1
  awk -F'\t' -v k="$1" '$1==k {print $2; found=1} END{exit !found}' "$BASELINE"
}

write_baseline() {
  mkdir -p "$STATE_DIR" || { echo "기준선 디렉터리를 만들 수 없다: $STATE_DIR" >&2; return 1; }
  _tmp="$BASELINE.tmp.$$"
  : > "$_tmp" || return 1
  for n in $NAMES; do printf '%s\t%s\n' "$n" "$(cur_ver "$n")" >> "$_tmp"; done
  mv "$_tmp" "$BASELINE"   # 원자적 교체 — 중간에 죽어도 반쪽 기준선이 남지 않는다
}

# ── 2층 표면 프로브 (토큰 0) ────────────────────────────────────
# 우리가 실제로 의존하는 표면만 찌른다. "설치돼 있나" 가 아니라 "우리가 쓰는 게 아직 되나".
PROBE_FAIL=0
PROBE_LINES=""
probe() {   # probe <이름> <설명> <명령...>
  _pname="$1"; _pdesc="$2"; shift 2
  if "$@" >/dev/null 2>&1; then
    PROBE_LINES="$PROBE_LINES
  OK   $_pname — $_pdesc"
  else
    PROBE_LINES="$PROBE_LINES
  FAIL $_pname — $_pdesc"
    PROBE_FAIL=$((PROBE_FAIL + 1))
  fi
}

run_probes() {
  # claude: 텔레그램 플러그인이 붙어 있어야 팀원 봇이 뜬다(fresh clone 최대 blocker 였다).
  if [ -n "$CLAUDE_BIN" ]; then
    probe claude-bin "바이너리 실행" "$CLAUDE_BIN" --version
    if [ -f "$HOME/.claude/plugins/installed_plugins.json" ]; then
      probe claude-telegram-plugin "telegram 플러그인 설치됨" \
        grep -q "telegram" "$HOME/.claude/plugins/installed_plugins.json"
    fi
  fi
  # openclaw: agents list 는 멱등 조회다(부작용 없음). 이게 죽으면 영입·활성화가 통째로 막힌다.
  [ -n "$OPENCLAW_BIN" ] && probe openclaw-agents "agents 조회 응답" "$OPENCLAW_BIN" agents list
  # hermes: --version 만. auth 계열은 대화형 프롬프트로 hang 할 수 있어 넣지 않는다.
  [ -n "$HERMES_BIN" ] && probe hermes-bin "바이너리 실행" "$HERMES_BIN" --version
  # bun: 서버가 이걸로 돈다.
  [ -n "$BUN_BIN" ] && probe bun-bin "바이너리 실행" "$BUN_BIN" --version
}

# ── 실행 ─────────────────────────────────────────────────────────
if [ "$MODE" = "accept" ]; then
  write_baseline || exit 2
  echo "기준선 저장: ${BASELINE/#$HOME/\~}"
  for n in $NAMES; do printf '  %-9s %s\n' "$n" "$(cur_ver "$n")"; done
  exit 0
fi

DRIFT=0
DRIFT_LINES=""
HAVE_BASELINE=0
[ -f "$BASELINE" ] && HAVE_BASELINE=1

for n in $NAMES; do
  _cur=$(cur_ver "$n")
  if [ "$HAVE_BASELINE" = 0 ]; then continue; fi
  _old=$(baseline_ver "$n" 2>/dev/null || printf '(기준선에 없음)')
  if [ "$_cur" != "$_old" ]; then
    DRIFT=$((DRIFT + 1))
    DRIFT_LINES="$DRIFT_LINES
  $n: $_old  →  $_cur"
  fi
done

run_probes

if [ "$MODE" = "json" ]; then
  printf '{"baseline":%s,"drift":%s,"probe_fail":%s,"versions":{' \
    "$HAVE_BASELINE" "$DRIFT" "$PROBE_FAIL"
  _first=1
  for n in $NAMES; do
    [ "$_first" = 1 ] || printf ','
    printf '"%s":"%s"' "$n" "$(cur_ver "$n" | sed 's/"/\\"/g')"
    _first=0
  done
  printf '}}\n'
else
  echo "■ 런타임 버전"
  for n in $NAMES; do printf '  %-9s %s\n' "$n" "$(cur_ver "$n")"; done
  echo
  if [ "$HAVE_BASELINE" = 0 ]; then
    echo "■ 기준선 없음 — --accept 로 현재 상태를 기준선으로 잡으세요."
  elif [ "$DRIFT" = 0 ]; then
    echo "■ 드리프트 없음"
  else
    echo "■ ★드리프트 $DRIFT 건★ — 이게 무거운 스모크를 돌릴 방아쇠다.$DRIFT_LINES"
    echo "   확인 후 --accept 로 새 기준선을 잡으세요."
  fi
  echo
  echo "■ 표면 프로브$PROBE_LINES"
fi

[ "$PROBE_FAIL" -gt 0 ] && exit 2
[ "$DRIFT" -gt 0 ] && exit 1
exit 0
