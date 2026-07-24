#!/usr/bin/env bash
# Minimal, config-gated auto-heal for positively dead tmux bots/gateways and
# Claude's session survey. Ambiguous observations always result in no action.

set -uo pipefail

usage() {
  cat <<'EOF'
Usage: auto-heal-core.sh --config FILE [--dry-run]

Config (one pipe-delimited record per line):
  bot|NAME|TMUX_SESSION|PID_FILE|on|RECOVERY_PROGRAM|ARG...
  gateway|NAME|LAUNCHD_LABEL|-|on|RECOVERY_PROGRAM|ARG...

Set field 5 to "off" to skip a configured target. Recovery programs are
executed directly as argv; config lines are never evaluated as shell code.
EOF
}

CONFIG=""
DRY_RUN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --config)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      CONFIG=$2
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'ERROR unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[ -n "$CONFIG" ] && [ -r "$CONFIG" ] || {
  echo "ERROR --config must name a readable file" >&2
  exit 2
}

log() {
  printf '%s\n' "$*"
}

valid_atom() {
  [ -n "$1" ] && [[ "$1" != *"|"* ]] && [[ "$1" != *$'\n'* ]]
}

run_recovery() {
  local kind=$1 name=$2
  shift 2
  if [ "$#" -lt 1 ] || [ ! -x "$1" ]; then
    log "NOOP [$kind:$name] recovery program is missing or not executable"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN [$kind:$name] would run recovery"
    return 0
  fi
  if "$@"; then
    log "HEALED [$kind:$name] recovery completed"
  else
    log "FAILED [$kind:$name] recovery returned non-zero; no fallback attempted"
  fi
}

capture_sessions() {
  local out status
  command -v tmux >/dev/null 2>&1 || return 1
  out=$(tmux list-sessions -F '#S' 2>&1)
  status=$?
  if [ "$status" -eq 0 ]; then
    printf '%s\n' "$out"
    return 0
  fi
  # tmux uses exit 1 when there is no server. Its explicit diagnostic makes
  # the empty inventory positive evidence; all other failures stay unknown.
  if [ "$status" -eq 1 ] && printf '%s\n' "$out" |
    grep -Eqi 'no server running|failed to connect to server'; then
    return 0
  fi
  return 1
}

session_count() {
  printf '%s\n' "$SESSION_LIST" | awk -v wanted="$1" '$0 == wanted { count++ } END { print count + 0 }'
}

pid_state() {
  # Prints alive, dead, or ambiguous. A failed kill alone is not proof of death:
  # ps must also positively report that the numeric PID does not exist.
  local pid=$1 ps_out
  local kill_bin=${AUTO_HEAL_KILL_BIN:-kill}
  local ps_bin=${AUTO_HEAL_PS_BIN:-ps}
  if "$kill_bin" -0 "$pid" 2>/dev/null; then
    echo alive
    return
  fi
  command -v "$ps_bin" >/dev/null 2>&1 || { echo ambiguous; return; }
  ps_out=$("$ps_bin" -p "$pid" -o pid= 2>/dev/null)
  case "$?" in
    0)
      if printf '%s\n' "$ps_out" | awk -v wanted="$pid" '$1 == wanted { found=1 } END { exit !found }'; then
        echo ambiguous
      else
        echo ambiguous
      fi
      ;;
    1)
      [ -z "$ps_out" ] && echo dead || echo ambiguous
      ;;
    *)
      echo ambiguous
      ;;
  esac
}

prompt_input() {
  printf '%s\n' "$1" | sed -n -E 's/^❯[[:space:]]*//p' | tail -1
}

dismiss_survey() {
  local name=$1 session=$2 pane=$3 before after
  printf '%s\n' "$pane" | grep -Fqi "How is Claude doing this session" || return 0
  before=$(prompt_input "$pane")
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN [bot:$name] would dismiss Claude survey with literal 0"
    return 0
  fi
  if ! tmux send-keys -l -t "$session" -- 0 2>/dev/null; then
    log "FAILED [bot:$name] survey dismiss key was not sent; no retry attempted"
    return 0
  fi
  sleep "${AUTO_HEAL_SURVEY_WAIT_SECONDS:-1}"
  after=$(tmux capture-pane -p -t "$session" 2>/dev/null) || {
    log "FAILED [bot:$name] survey verification capture failed; no further input sent"
    return 0
  }
  if printf '%s\n' "$after" | grep -Fqi "How is Claude doing this session"; then
    log "FAILED [bot:$name] survey remains visible; no further input sent"
    return 0
  fi
  if [ "$(prompt_input "$after")" != "$before" ]; then
    log "FAILED [bot:$name] input line changed after survey dismiss; no restore attempted"
    return 0
  fi
  log "HEALED [bot:$name] Claude survey dismissed; input line preserved"
}

SESSION_LIST=""
SESSIONS_KNOWN=0
if SESSION_LIST=$(capture_sessions); then
  SESSIONS_KNOWN=1
else
  log "NOOP [tmux] session inventory unavailable; bot recovery and survey handling disabled"
fi

LAUNCHD_LIST=""
LAUNCHD_KNOWN=0
if command -v launchctl >/dev/null 2>&1 && LAUNCHD_LIST=$(launchctl list 2>/dev/null); then
  LAUNCHD_KNOWN=1
else
  log "NOOP [launchd] service inventory unavailable; gateway recovery disabled"
fi

line_no=0
while IFS= read -r raw || [ -n "$raw" ]; do
  line_no=$((line_no + 1))
  case "$raw" in
    ""|\#*) continue ;;
  esac
  IFS='|' read -r -a fields <<< "$raw"
  if [ "${#fields[@]}" -lt 6 ]; then
    log "NOOP [config:$line_no] expected at least 6 fields"
    continue
  fi
  kind=${fields[0]}
  name=${fields[1]}
  target=${fields[2]}
  pid_file=${fields[3]}
  mode=${fields[4]}
  recovery=("${fields[@]:5}")

  if ! valid_atom "$name" || ! valid_atom "$target"; then
    log "NOOP [config:$line_no] empty or invalid name/target"
    continue
  fi
  case "$mode" in
    off)
      log "SKIP [$kind:$name] configured off"
      continue
      ;;
    on) ;;
    *)
      log "NOOP [$kind:$name] mode must be on or off"
      continue
      ;;
  esac

  case "$kind" in
    bot)
      if [ "$SESSIONS_KNOWN" -ne 1 ]; then
        log "NOOP [bot:$name] tmux state is unknown"
        continue
      fi
      count=$(session_count "$target")
      if [ "$count" -eq 0 ]; then
        run_recovery bot "$name" "${recovery[@]}"
        continue
      elif [ "$count" -ne 1 ]; then
        log "NOOP [bot:$name] tmux session match is ambiguous"
        continue
      fi

      if [ ! -e "$pid_file" ]; then
        log "NOOP [bot:$name] poller PID file is missing"
      elif [ ! -r "$pid_file" ]; then
        log "NOOP [bot:$name] poller PID file is unreadable"
      else
        pid=$(sed -n '1p' "$pid_file" 2>/dev/null)
        if ! [[ "$pid" =~ ^[1-9][0-9]*$ ]] || [ "$(wc -l < "$pid_file" 2>/dev/null)" -gt 1 ]; then
          log "NOOP [bot:$name] poller PID is malformed"
        else
          state=$(pid_state "$pid")
          case "$state" in
            dead)
              run_recovery bot "$name" "${recovery[@]}"
              continue
              ;;
            ambiguous)
              log "NOOP [bot:$name] poller PID state is ambiguous"
              ;;
          esac
        fi
      fi

      pane=$(tmux capture-pane -p -t "$target" 2>/dev/null) || {
        log "NOOP [bot:$name] pane capture failed"
        continue
      }
      dismiss_survey "$name" "$target" "$pane"
      ;;
    gateway)
      if [ "$LAUNCHD_KNOWN" -ne 1 ]; then
        log "NOOP [gateway:$name] launchd state is unknown"
        continue
      fi
      matches=$(printf '%s\n' "$LAUNCHD_LIST" | awk -v label="$target" '$3 == label { print $1 }')
      match_count=$(printf '%s\n' "$matches" | awk 'NF { count++ } END { print count + 0 }')
      if [ "$match_count" -eq 0 ]; then
        run_recovery gateway "$name" "${recovery[@]}"
      elif [ "$match_count" -ne 1 ]; then
        log "NOOP [gateway:$name] launchd label match is ambiguous"
      else
        pid=$(printf '%s\n' "$matches" | head -1)
        if [ "$pid" = "-" ]; then
          run_recovery gateway "$name" "${recovery[@]}"
        elif ! [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
          log "NOOP [gateway:$name] launchd PID is malformed"
        else
          state=$(pid_state "$pid")
          case "$state" in
            dead) run_recovery gateway "$name" "${recovery[@]}" ;;
            ambiguous) log "NOOP [gateway:$name] launchd PID state is ambiguous" ;;
          esac
        fi
      fi
      ;;
    *)
      log "NOOP [config:$line_no] unknown kind"
      ;;
  esac
done < "$CONFIG"
