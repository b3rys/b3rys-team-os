#!/usr/bin/env bash
# b3rys TEAM OS — 설치 제거(uninstall). install.sh 의 짝.
#   1) 제거 대상 안내 + 확인  2) 팀원 전원 오프보드(런타임별 정리)  3) 서버 정지 + LaunchAgent 해제
#   4) 데이터 삭제(team.db·.env·var·team-media·slack-tokens)  5) repo 폴더 삭제 안내
#
# 사용:
#   bash uninstall.sh                repo 폴더 안에서, 확인 프롬프트 후 진행
#   bash uninstall.sh --yes          확인 없이 진행(스크립트/자동화용).  -y 동일
#   bash uninstall.sh --keep-data    오프보드 + 서버 정지만, team.db/.env/데이터는 보존
#
# 설계 원칙:
#   - best-effort teardown. 한 팀원/한 단계가 실패해도 전체를 멈추지 않는다(set -e 미사용).
#   - $HOME 기준 상대경로만. 특정 사용자(/Users/xxx) 하드코딩 없음 — 어느 Mac 에서나 동작.
#   - macOS 중심(launchctl). launchctl/tmux 가 없으면 해당 단계는 건너뛴다(크래시 없음).
#   - ★ 안전: 확인 프롬프트 + base hermes 프로필(b3ryshermes) 보존 가드 + "알려진 경로만 삭제".
#     빈/루트일 수 있는 변수는 절대 rm -rf 하지 않는다.
set -uo pipefail   # ★ -e 는 쓰지 않는다 — best-effort teardown 은 개별 실패를 넘어가야 한다.

# ── 자기 위치 = repo 루트(BASH_SOURCE 기준, symlink 안전) ─────────────
SELF="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$SELF"

# ── 출력 헬퍼(install.sh 톤: green=say / yellow=warn) ─────────────────
say()  { printf "\033[32m%s\033[0m\n" "$1"; }  # green
warn() { printf "\033[33m%s\033[0m\n" "$1"; }  # yellow
hl()   { printf "\033[1;36m%s\033[0m\n" "$1"; } # cyan bold — 섹션 헤더

# ── 안전 삭제 헬퍼(알려진 경로만, 빈/루트 거부) ───────────────────────
rmf() { # 파일 1개
  local p="${1:-}"
  [ -n "$p" ] || return 0
  [ -e "$p" ] || return 0
  rm -f "$p" 2>/dev/null && say "    ✓ 삭제: ${p/#$HOME/~}" || warn "    ⚠ 삭제 실패(무시): ${p/#$HOME/~}"
}
rmrf() { # 디렉토리(재귀) — 빈/루트/$HOME 자체는 거부(rm -rf 폭주 방지)
  local p="${1:-}"
  [ -n "$p" ] || { warn "    ⚠ 빈 경로 — 건너뜀"; return 0; }
  case "$p" in
    /|//|"$HOME"|"$HOME"/) warn "    ⚠ 위험 경로 거부: $p"; return 0 ;;
  esac
  [ -e "$p" ] || return 0
  rm -rf "$p" 2>/dev/null && say "    ✓ 삭제: ${p/#$HOME/~}" || warn "    ⚠ 삭제 실패(무시): ${p/#$HOME/~}"
}

# ── launchd/tmux 유무(없으면 우아하게 스킵) ───────────────────────────
HAVE_LAUNCHCTL=0; command -v launchctl >/dev/null 2>&1 && HAVE_LAUNCHCTL=1
HAVE_TMUX=0;      command -v tmux       >/dev/null 2>&1 && HAVE_TMUX=1
UID_N="$(id -u)"

launchd_stop() { # $1=label — bootout(정지+해제). 없으면 조용히 스킵.
  local label="${1:-}"; [ -n "$label" ] || return 0
  [ "$HAVE_LAUNCHCTL" = 1 ] || { warn "    (launchctl 없음 — $label 정지 스킵)"; return 0; }
  if launchctl print "gui/$UID_N/$label" >/dev/null 2>&1; then
    launchctl bootout "gui/$UID_N/$label" >/dev/null 2>&1 && say "    ⏹ 정지: $label" || warn "    ⚠ 정지 실패(무시): $label"
  fi
}
tmux_kill() { # $1=session
  local s="${1:-}"; [ -n "$s" ] || return 0
  [ "$HAVE_TMUX" = 1 ] || return 0
  tmux has-session -t "$s" 2>/dev/null && { tmux kill-session -t "$s" 2>/dev/null && say "    ⏹ tmux 종료: $s"; }
}

# ── launchd label prefix (teamosLaunchdPrefix 규약과 동일) ────────────
#   src/server/lib/agentControl.ts: TEAMOS_LAUNCHD_PREFIX 우선, 없으면 com.<USER>, 후행 '.' 제거.
launchd_prefix() {
  local ov="${TEAMOS_LAUNCHD_PREFIX:-}"
  if [ -n "${ov// }" ]; then printf '%s' "${ov%.}"; return; fi
  printf 'com.%s' "${USER:-local}"
}
PREFIX="$(launchd_prefix)"

# ── LaunchAgent 소유 판별 (같은 머신 다중 설치본 안전) ────────────────
#   ★ label prefix 는 com.<USER> 라 같은 머신의 설치본끼리 공유된다 — label 만으론 '내 설치본'인지
#     구분 못 해, 비-라이브 사본에서 uninstall 하면 라이브 설치본의 LaunchAgent 를 bootout+삭제할 수 있다.
#   해결: plist 의 경로 필드가 이 설치본($SELF)을 가리킬 때만 '내 것'으로 본다.
#     - 서버 plist: WorkingDirectory=REPO_ROOT(=$SELF)  (serverService.ts)
#     - claude/codex 멤버 plist: ProgramArguments·로그 경로가 $SELF/... (launcher.ts)
#   hermes 게이트웨이 plist 는 레포 경로를 안 담고 프로필명으로 식별 → 이 가드 대상 아님(기존 base 가드 유지).
plist_is_self() {
  local plist="${1:-}"
  [ -f "$plist" ] || return 1
  local wd=""
  wd="$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$plist" 2>/dev/null || true)"
  case "$wd" in "$SELF"|"$SELF"/*) return 0 ;; esac
  # 어느 <string> 이든 "$SELF/" 로 시작하면 내 설치본(뒤 '/' 를 요구해 형제 설치본 <SELF>-2 접두 오탐 방지).
  grep -qF "<string>$SELF/" "$plist" 2>/dev/null && return 0
  return 1
}
# plist 가 존재하는데 내 것이 아니면 = 다른 설치본(라이브 포함) 소유 → true.
#   없으면(미활성) false: bootout/rm 은 어차피 no-op, 데이터 정리는 기존 로직대로 진행.
owned_by_other_install() {
  local plist="${1:-}"
  [ -f "$plist" ] || return 1
  plist_is_self "$plist" && return 1
  return 0
}

# ── B3RYS_HOME(멤버 워크스페이스·데이터 루트, 퍼블릭/members 모드) 조기 캡처 ──
#   ★ 데이터 삭제 단계에서 .env 를 지우므로, 그 전에 값을 읽어둔다.
#   ★ .env 는 시크릿 포함 → 전체 echo 금지. B3RYS_HOME 한 줄만 추출한다(값 노출 최소화).
B3RYS_HOME_VAL="${B3RYS_HOME:-}"
if [ -z "${B3RYS_HOME_VAL// }" ] && [ -f "$SELF/.env" ]; then
  B3RYS_HOME_VAL="$(grep -E '^[[:space:]]*B3RYS_HOME=' "$SELF/.env" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^["'\'' ]*//' -e 's/["'\'' ]*$//')"
fi
case "$B3RYS_HOME_VAL" in "~"|"~/"*) B3RYS_HOME_VAL="${HOME}${B3RYS_HOME_VAL#\~}" ;; esac   # ~ 확장

# ── agents.json 파서(node→bun→python3→jq 순, 없으면 실패) ────────────
#   출력: "id<TAB>runtime<TAB>hermes_profile" 한 줄/멤버.
AGENTS_FILE="$SELF/agents.json"
parse_agents() {
  local f="$1"
  if   command -v node >/dev/null 2>&1; then
    AGENTS_JSON="$f" node -e 'const a=require(process.env.AGENTS_JSON);(Array.isArray(a)?a:[]).forEach(m=>console.log([m.id||"",m.runtime||"",m.hermes_profile||""].join("\t")))' 2>/dev/null
  elif command -v bun  >/dev/null 2>&1; then
    AGENTS_JSON="$f" bun  -e 'const a=require(process.env.AGENTS_JSON);(Array.isArray(a)?a:[]).forEach(m=>console.log([m.id||"",m.runtime||"",m.hermes_profile||""].join("\t")))' 2>/dev/null
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
for m in (d if isinstance(d,list) else []):
    print("\t".join([m.get("id","") or "", m.get("runtime","") or "", m.get("hermes_profile","") or ""]))' "$f" 2>/dev/null
  elif command -v jq >/dev/null 2>&1; then
    jq -r '.[] | [(.id//""),(.runtime//""),(.hermes_profile//"")] | @tsv' "$f" 2>/dev/null
  else
    return 1
  fi
}

# id 슬러그 가드(경로/rm 안전) — 라이브 코드의 /^[a-z0-9_-]+$/i 와 동일.
valid_id() { printf '%s' "${1:-}" | grep -Eq '^[A-Za-z0-9_-]+$'; }

# ── 인자 파싱 ─────────────────────────────────────────────────────────
ASSUME_YES=0
KEEP_DATA=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes)   ASSUME_YES=1 ;;
    --keep-data) KEEP_DATA=1 ;;
    -h|--help)
      sed -n '2,10p' "$SELF/uninstall.sh"; exit 0 ;;
    *) warn "알 수 없는 옵션(무시): $arg" ;;
  esac
done

# ══════════════════════════════════════════════════════════════════════
# 1) 제거 대상 안내 + 확인
# ══════════════════════════════════════════════════════════════════════
hl "■ b3rys TEAM OS 설치 제거(uninstall)"
echo "  대상 repo: $SELF"
echo "  launchd prefix: $PREFIX   (팀원/서버 LaunchAgent 라벨 규약)"
# ★ 다중 설치본 안전: 서버 LaunchAgent 가 다른 설치본(라이브) 것이면 미리 알린다 — 라이브 항목은 자동으로 건너뛴다.
if owned_by_other_install "$HOME/Library/LaunchAgents/$PREFIX.team-collab.plist"; then
  echo ""
  warn "  ⛔ 감지: 이 머신의 서버 LaunchAgent 는 다른 설치본 소유입니다(경로가 $SELF 아님)."
  warn "     라이브 서버·봇을 건드리지 않도록, 그 설치본과 겹치는 LaunchAgent/데이터는 자동으로 건너뜁니다."
fi
echo ""
echo "  다음을 제거합니다:"
echo "    • 팀원 전원 오프보드 — tmux 종료 · LaunchAgent 해제 · 런타임 디렉토리/토큰 정리"
echo "        claude  → ~/.claude/channels/telegram-<id> · $PREFIX.claude-telegram-<id> plist"
echo "        openclaw→ ~/.openclaw/agents/<id> · ~/.openclaw/credentials/telegram-<id>-token.txt(+allowFrom)"
echo "        hermes  → ~/.hermes/profiles/<프로필> · ai.hermes.gateway-<프로필> plist · credential 토큰"
echo "                  ★ base 프로필 'b3ryshermes' 는 절대 삭제하지 않음(공유 auth 소스)"
echo "    • 서버 정지 + LaunchAgent 해제 ($PREFIX.team-collab · $PREFIX.team-os-boot)"
if [ "$KEEP_DATA" = 1 ]; then
  warn "    • 데이터 삭제는 건너뜁니다 (--keep-data): team.db · .env · var/ · team-media · slack-tokens${B3RYS_HOME_VAL:+ · B3RYS_HOME} 보존"
else
  echo "    • 데이터 삭제 — team.db(+wal/shm) · .env · var/ · ../team-media · slack-tokens/${B3RYS_HOME_VAL:+ · B3RYS_HOME(${B3RYS_HOME_VAL/#$HOME/~})}"
fi
echo ""
warn "  ⚠ 이 작업은 되돌릴 수 없습니다. (repo 폴더 자체는 마지막에 수동 삭제 안내)"
echo ""

if [ "$ASSUME_YES" = 1 ]; then
  say "  --yes 지정 — 확인 없이 진행합니다."
else
  printf "계속하시겠습니까? (y/N) "
  read -r _reply || _reply=""
  case "$_reply" in
    y|Y|yes|YES) ;;
    *) warn "중단했습니다. 아무것도 삭제하지 않았습니다."; exit 0 ;;
  esac
fi
echo ""

# ══════════════════════════════════════════════════════════════════════
# 2) 팀원 전원 오프보드 (런타임별 FS/launchctl 정리, best-effort)
# ══════════════════════════════════════════════════════════════════════
hl "■ 1/4  팀원 오프보드"

# 서버가 떠 있으면 원래는 대시보드(Settings 탭)의 오프보드가 graceful path.
# 여기선 teardown 이므로 직접 FS/launchctl 정리를 수행한다.
if [ "$HAVE_LAUNCHCTL" = 1 ] && launchctl print "gui/$UID_N/$PREFIX.team-collab" >/dev/null 2>&1; then
  warn "  ⓘ 서버가 실행 중입니다. 정상 오프보드는 대시보드 Settings 탭이지만, 제거 작업이므로 직접 정리합니다."
fi

if [ ! -f "$AGENTS_FILE" ]; then
  warn "  agents.json 없음 — 팀원 오프보드 건너뜀(서버 정지/데이터 삭제는 계속)."
else
  _members="$(parse_agents "$AGENTS_FILE")"
  if [ -z "${_members:-}" ]; then
    warn "  agents.json 을 읽을 JSON 도구(node/bun/python3/jq)가 없거나 비어 있음 — 팀원 오프보드 건너뜀."
    warn "  필요 시 런타임 디렉토리를 수동 정리하세요: ~/.claude/channels · ~/.openclaw/agents · ~/.hermes/profiles"
  else
    while IFS=$'\t' read -r id runtime prof; do
      [ -n "${id:-}" ] || continue
      if ! valid_id "$id"; then warn "  ⚠ 비정상 id 건너뜀: '$id'"; continue; fi
      echo ""
      say "  ▶ $id  (runtime=${runtime:-?})"
      case "$runtime" in
        claude_channel)
          _plist="$HOME/Library/LaunchAgents/$PREFIX.claude-telegram-$id.plist"
          if owned_by_other_install "$_plist"; then
            warn "    ⛔ 다른 설치본 소유(plist 가 $SELF 아님) — '$id' 정리 건너뜀(라이브 봇 보호)."
          else
            tmux_kill "claude-$id"
            launchd_stop "$PREFIX.claude-telegram-$id"
            rmf   "$_plist"
            rmrf  "$HOME/.claude/channels/telegram-$id"
          fi
          ;;
        codex)
          _plist="$HOME/Library/LaunchAgents/$PREFIX.codex-bridge-$id.plist"
          if owned_by_other_install "$_plist"; then
            warn "    ⛔ 다른 설치본 소유(plist 가 $SELF 아님) — '$id' 정리 건너뜀(라이브 브리지 보호)."
          else
            launchd_stop "$PREFIX.codex-bridge-$id"
            rmf  "$_plist"
            rmf  "$SELF/var/codex-bridge/$id-launch.sh"
            rmf  "$SELF/var/codex-bridge/$id.log"
            rmf  "$SELF/var/codex-bridge/$id.pid"
            rmf  "$SELF/var/secrets/$id.bot-token"
            rmrf "$HOME/.codex-agents/$id"
          fi
          ;;
        openclaw)
          # 계정 자체 disable(openclaw.json)은 self-mod → 수동/스크립트 영역. 여기선 토큰/디렉토리만 정리.
          rmf  "$HOME/.openclaw/credentials/telegram-$id-token.txt"
          rmf  "$HOME/.openclaw/credentials/telegram-$id-allowFrom.json"
          rmrf "$HOME/.openclaw/agents/$id"
          ;;
        hermes_agent)
          _prof="${prof:-$id}"
          if [ "$_prof" = "b3ryshermes" ]; then
            # ★★ CRITICAL 가드 — base 프로필은 모든 hermes 멤버의 공유 auth.json 소스 + clone 원본.
            #   삭제하면 hermes 런타임 전멸(auth dangling). 프로필 dir·게이트웨이·plist 를 절대 건드리지 않는다.
            warn "    ★ base hermes 프로필 'b3ryshermes' 보존 — 게이트웨이/프로필/plist 삭제하지 않음(공유 auth 소스)."
          else
            launchd_stop "ai.hermes.gateway-$_prof"
            rmf  "$HOME/Library/LaunchAgents/ai.hermes.gateway-$_prof.plist"
            # 프로필 dir 은 슬러그 가드된 프로필명 + base 제외 확인 후에만 삭제.
            if valid_id "$_prof" && [ "$_prof" != "b3ryshermes" ]; then
              rmrf "$HOME/.hermes/profiles/$_prof"
            fi
            # per-id credential 토큰(멤버 봇 토큰) 정리 — 공유 auth 아님(라이브 코드와 동일, non-base 만).
            rmf  "$HOME/.hermes/credentials/$id-token.txt"
          fi
          ;;
        *)
          warn "    (알 수 없는 runtime '$runtime' — 런타임 정리 스킵)"
          ;;
      esac
    done <<< "$_members"
  fi
fi
echo ""

# ══════════════════════════════════════════════════════════════════════
# 3) 서버 정지 + LaunchAgent 해제
# ══════════════════════════════════════════════════════════════════════
hl "■ 2/4  서버 정지"
_srv_plist="$HOME/Library/LaunchAgents/$PREFIX.team-collab.plist"
if owned_by_other_install "$_srv_plist"; then
  # ★ 서버 LaunchAgent 가 다른 설치본(라이브) 것 — team-os.sh down·bootout 모두 건너뛴다(라이브 서버 정지 방지).
  warn "  ⛔ 다른 설치본($SELF 아님) 소유 서버 LaunchAgent — 서버 정지/해제 건너뜀(라이브 서버 보호)."
  warn "    이 머신에 다른 team-collab 설치본이 실행 중입니다. 서버를 내리려면 그 설치본에서 uninstall 하세요."
else
  # team-os.sh 가 있으면 best-effort 로 호출(정지 시도). 없거나 실패해도 아래 bootout 이 실제 정지.
  if [ -x "$SELF/scripts/team-os.sh" ] || [ -f "$SELF/scripts/team-os.sh" ]; then
    bash "$SELF/scripts/team-os.sh" down >/dev/null 2>&1 || true
  fi
  launchd_stop "$PREFIX.team-collab"
  rmf "$_srv_plist"
fi
# 부팅 재기동 plist(있으면) — 동일 소유 가드.
_boot_plist="$HOME/Library/LaunchAgents/$PREFIX.team-os-boot.plist"
if owned_by_other_install "$_boot_plist"; then
  warn "  ⛔ 다른 설치본 소유 부팅 LaunchAgent — 건너뜀(라이브 보호): $PREFIX.team-os-boot"
else
  launchd_stop "$PREFIX.team-os-boot"
  rmf "$_boot_plist"
fi
echo ""

# ══════════════════════════════════════════════════════════════════════
# 4) 데이터 삭제 (--keep-data 면 건너뜀)
# ══════════════════════════════════════════════════════════════════════
if [ "$KEEP_DATA" = 1 ]; then
  hl "■ 3/4  데이터 삭제 — 건너뜀(--keep-data)"
  say "  team.db · .env · var/ · team-media · slack-tokens 보존."
else
  hl "■ 3/4  데이터 삭제"
  # repo 내부 + 알려진 sibling(team-media) 만 삭제. 그 외 경로는 절대 건드리지 않는다.
  rmf  "$SELF/team.db"
  rmf  "$SELF/team.db-wal"
  rmf  "$SELF/team.db-shm"
  rmf  "$SELF/.env"
  rmrf "$SELF/var"
  rmrf "$SELF/slack-tokens"
  # TEAM_MEDIA_DIR 기본값 = <설치폴더>/../team-media (mediaStore.ts). sibling 만 삭제.
  rmrf "$(dirname "$SELF")/team-media"
  # B3RYS_HOME(멤버 워크스페이스·persona·CLAUDE.md 데이터 루트, 퍼블릭/members 모드) — var/ 와 동급 데이터.
  #   없으면(기본 dev 설치=~/Development 사용) 스킵. repo 폴더와 같으면 마지막 수동삭제 안내로 넘긴다.
  if [ -n "${B3RYS_HOME_VAL// }" ]; then
    case "$B3RYS_HOME_VAL" in
      "$SELF"|"$SELF"/) warn "  ⚠ B3RYS_HOME 이 repo 폴더와 동일 — 여기선 건너뜀(마지막 'rm -rf repo' 안내로 함께 삭제)" ;;
      *) say "  • B3RYS_HOME 데이터 루트: ${B3RYS_HOME_VAL/#$HOME/~}"; rmrf "$B3RYS_HOME_VAL" ;;
    esac
  fi
fi
echo ""

# ══════════════════════════════════════════════════════════════════════
# 5) repo 폴더 삭제 안내 (실행 중 자기 폴더는 못 지움)
# ══════════════════════════════════════════════════════════════════════
hl "■ 4/4  완료"
say "  런타임/서버/데이터 정리가 끝났습니다."
echo ""
warn "  이 스크립트는 실행 중인 자기 repo 폴더를 삭제할 수 없습니다. 마지막으로 아래를 실행하세요:"
echo ""
echo "이제 이 폴더를 삭제하세요:  rm -rf \"$SELF\""
echo ""
