#!/usr/bin/env bash
# hermes 런타임 팀원 활성화 매뉴얼 (2026-06-10)
#   새 hermes 프로필을 기존 seed 프로필(auth 보유 프로필 자동 탐지; env SRC_PROFILE 로 지정 가능)에서 복제 → 봇 토큰·멘션·cwd 교체 → 게이트웨이 기동.
#   인터랙티브 `hermes gateway setup` 안 씀 — config/.env 직접 작성으로 우회(스크립트 가능).
#
#   ⚠ hermes 프로필 생성 + 게이트웨이 기동 = self-mod → 터미널에서 직접 실행(또는 /approve).
#   ⚠ 게이트웨이는 프로필별 독립(gateway.pid) — base 프로필 영향 없어야 정상.
#
# 사용:  AGENT_ID=myagent DISPLAY="My Agent" KO=별칭 bash activate-hermes-agent.sh
#   (토큰은 미리 TOKEN_FILE 에 저장돼 있어야 함; 기본 ~/.hermes/credentials/<id>-token.txt)
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

AGENT_ID="${AGENT_ID:?AGENT_ID 필요 (예: myagent)}"
DISPLAY="${DISPLAY:-$(echo "$AGENT_ID" | tr '[:lower:]' '[:upper:]')}"   # ${var^^}는 bash 4+ 전용 → macOS 기본 bash 3.2 호환 위해 tr 사용
KO="${KO:-$AGENT_ID}"                     # 한글 멘션 별칭 (예: 별칭)
DESC="${DESC:-b3rys 팀원 ($AGENT_ID)}"
WS="${WS:-$HOME/Development/$AGENT_ID}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.hermes/credentials/$AGENT_ID-token.txt}"
PROF_DIR="$HOME/.hermes/profiles/$AGENT_ID"
HERMES_BASE_PROFILE="${HERMES_BASE_PROFILE:-b3os}"
say(){ printf "\033[32m%s\033[0m\n" "$1"; }

[ -n "$HERMES_BASE_PROFILE" ] && [[ "$HERMES_BASE_PROFILE" =~ ^[a-zA-Z0-9_-]+$ ]] \
  || { echo "❌ HERMES_BASE_PROFILE은 안전한 프로필 slug여야 합니다: 영문/숫자/_/-"; exit 1; }
[ -s "$TOKEN_FILE" ] || { echo "❌ 봇 토큰 없음: $TOKEN_FILE (BotFather 토큰 먼저 저장)"; exit 1; }

# 복제 원본(SRC_PROFILE) 결정 — activation.ts 는 SRC_PROFILE 를 주입하지 않으므로(AGENT_ID+WS 뿐),
#   env 명시가 없으면 설정된 base 프로필을 먼저 보고, 이어 auth 보유 프로필을 동적 탐지한다.
#   공개 사용자가 자기 이름 프로필(예: myhermes)만 인증돼 있어도 영입 가능(openclaw 스크립트의 동적 auth-소스 탐지와 동일 패턴).
#   우선순위: ① env SRC_PROFILE 명시 → ② HERMES_BASE_PROFILE(있으면 먼저) → ③ auth.json 보유하는 첫 프로필(타겟 제외).
#   auth.json = 응답 생성 인증(공유 원본). 없으면 '메시지는 받지만 응답 못 하는' 死봇이 되므로 이를 가진 프로필만 원본으로 인정.
if [ -z "${SRC_PROFILE:-}" ]; then
  SRC_PROFILE=""
  for cand in "$HOME/.hermes/profiles/$HERMES_BASE_PROFILE" "$HOME"/.hermes/profiles/*; do
    [ -d "$cand" ] || continue
    pname="$(basename "$cand")"
    [ "$pname" = "$AGENT_ID" ] && continue        # 타겟 자신은 원본이 될 수 없음
    [ -f "$cand/auth.json" ] || continue          # 인증(auth.json) 보유 프로필만 원본으로
    SRC_PROFILE="$pname"; break
  done
fi

# ★루트 폴백(preflight↔activate divergence 해소, OWNER 2026-07-19 맥북테스트)★
#   현대 hermes(v0.18+)의 `hermes auth [add]` 는 인증을 글로벌 ~/.hermes/auth.json 에만 저장하고
#   profiles/ 를 만들지 않는다. preflight(runtimeAuth.hermesAuthExists)는 글로벌 auth.json 을 인정하므로,
#   "auth 보유 프로필이 없다"는 이유로 여기서 exit 1 하면 → preflight 통과했는데 activate 실패(갭).
#   공개 hermes 사용자가 정상 인증하고도 전원 막히던 원인. 프로필이 없고 글로벌 auth 만 있으면,
#   그 글로벌 auth 로 base 프로필을 자동 시드해 clone 원본으로 삼는다(preflight 가 인정한 것을 activate 도 인정).
if [ -z "${SRC_PROFILE:-}" ] && [ -f "$HOME/.hermes/auth.json" ]; then
  BASE_PROFILE="$HERMES_BASE_PROFILE"
  while [ "$BASE_PROFILE" = "$AGENT_ID" ]; do BASE_PROFILE="${BASE_PROFILE}-base"; done
  say "■ 인증 프로필 없음 + 글로벌 auth 존재 → base 프로필 '$BASE_PROFILE' 자동 시드(글로벌 ~/.hermes/auth.json)"
  if [ ! -d "$HOME/.hermes/profiles/$BASE_PROFILE" ]; then
    # --clone: 활성(default) 프로필의 config/.env/SOUL/skills 복사 → 게이트웨이가 뜰 설정 확보.
    hermes profile create "$BASE_PROFILE" --clone --description "b3os base (auto-seeded from global ~/.hermes/auth.json)" \
      || hermes profile create "$BASE_PROFILE" --description "b3os base (auto-seeded from global ~/.hermes/auth.json)"
  fi
  # clone 은 auth.json 을 안 옮긴다 → 글로벌 auth 를 심링크(복사 아님 = 로테이션 시 stale 방지).
  ln -sf "$HOME/.hermes/auth.json" "$HOME/.hermes/profiles/$BASE_PROFILE/auth.json"
  SRC_PROFILE="$BASE_PROFILE"
  say "  ✅ base 프로필 준비됨: $BASE_PROFILE (auth = 글로벌 ~/.hermes/auth.json 심링크)"
fi
[ -n "${SRC_PROFILE:-}" ] || { echo "❌ hermes 인증이 없습니다 — 구독 OAuth 로 인증한 뒤 다시 활성화하세요: 'hermes auth add <provider> --type oauth'. (~/.hermes/auth.json 또는 ~/.hermes/profiles/<name>/auth.json 필요)"; exit 1; }
[ -d "$HOME/.hermes/profiles/$SRC_PROFILE" ] || { echo "❌ 원본 프로필 없음: $SRC_PROFILE"; exit 1; }
say "■ 복제 원본 프로필: $SRC_PROFILE"

say "■ 1) 프로필 생성 (clone-from $SRC_PROFILE)"
# ★완전-프로필 판정 version-aware(BUG8b): v0.17.0=config.yaml · v0.18.0+=profile.yaml → 둘 중 하나라도 있으면 완전.
#   config.yaml 만 보면 v0.18.0 정상 프로필을 half-state 로 오판해 rm-rf+재클론(불필요·위험)하던 갭. OWNER 2026-07-03.
PROF_PREEXISTING=0
B3OS_MARKER="$PROF_DIR/.b3os-managed"
if [ -d "$PROF_DIR" ] && { [ -f "$PROF_DIR/config.yaml" ] || [ -f "$PROF_DIR/profile.yaml" ]; }; then
  # ★"덮어쓰기 안 함"은 '재클론 안 함'이라는 뜻일 뿐★ — 아래 2)토큰·3)멘션/cwd·3b)model 단계는
  #   이 프로필에 그대로 적용된다. 그래서 소유권 판정이 필요하다(아래 가드).
  echo "  이미 존재(완전): $PROF_DIR — 재클론 건너뜀"
  PROF_PREEXISTING=1
else
  # 불완전 프로필 잔재(config.yaml·profile.yaml 둘 다 없음 = 이전 퇴사가 덜 정리한 half-state) 감지 시 제거 후 재클론.
  #   안 그러면 clone 건너뛰어 설정 없는 채로 진행→게이트웨이 못 뜸(2026-07-01 실측). 슬러그 가드+고정 prefix로 안전.
  if [ -d "$PROF_DIR" ] && [[ "$AGENT_ID" =~ ^[a-z0-9_-]+$ ]] && [ "$AGENT_ID" != "$HERMES_BASE_PROFILE" ] && [ "$AGENT_ID" != "$SRC_PROFILE" ]; then
    echo "  ⚠ 불완전 프로필 잔재($PROF_DIR, config.yaml·profile.yaml 둘 다 없음) — 제거 후 재클론"
    rm -rf "$PROF_DIR"
  fi
  hermes profile create "$AGENT_ID" --clone-from "$SRC_PROFILE" --description "$DESC"
  # ★소유권 마커★ — 이 프로필은 b3os 가 만들었다는 표시. 다음 활성화 때 '사용자 것'과 구별하는 근거.
  : > "$B3OS_MARKER" 2>/dev/null || true
fi

# ★소유권 가드 — 남의 hermes 프로필을 덮어쓰지 않는다★
#   b3os 팀원 id 가 사용자가 이미 쓰던 hermes 프로필 이름과 겹치면, 아래 단계들이 그 프로필을
#   그대로 개조한다: .env 의 TELEGRAM_BOT_TOKEN 을 b3os 봇 토큰으로 교체(=원래 봇이 죽는다),
#   멘션 패턴·terminal.cwd 재작성, model 재작성. 경고도 없이 조용히 일어난다.
#   → 기존 프로필인데 b3os 소유 근거가 없으면 중단한다. 근거는 아래 둘 중 하나:
#     ① 마커(.b3os-managed)  ② b3os 가 만든 게이트웨이 plist(= 과거에 b3os 가 활성화한 적 있음)
#   ②는 마커 도입 이전에 이미 운영 중이던 프로필을 막지 않기 위한 grace 경로다(마커를 채워 넣고 통과).
#   ※ 토큰 파일(~/.hermes/credentials/<id>-token.txt)은 근거가 될 수 없다 — provision 이 activate
#     이전에 항상 써두므로 첫 충돌에서도 존재한다.
if [ "$PROF_PREEXISTING" = 1 ] && [ ! -f "$B3OS_MARKER" ]; then
  if [ -f "$HOME/Library/LaunchAgents/ai.hermes.gateway-$AGENT_ID.plist" ]; then
    echo "  ℹ b3os 게이트웨이 plist 존재 — 기존 b3os 프로필로 인정하고 마커 생성(마커 도입 이전 프로필)"
    : > "$B3OS_MARKER" 2>/dev/null || true
  elif [ "${B3OS_ADOPT_PROFILE:-0}" = 1 ]; then
    echo "  ℹ B3OS_ADOPT_PROFILE=1 — 기존 프로필을 b3os 소유로 인수(마커 생성)"
    : > "$B3OS_MARKER" 2>/dev/null || true
  else
    echo "❌ hermes 프로필 '$AGENT_ID' 이(가) 이미 있는데 b3os 가 만든 것이 아닙니다 — 덮어쓰지 않고 중단합니다."
    echo "   그대로 진행하면 이 프로필의 봇 토큰이 b3os 봇으로 교체되어 ★원래 쓰시던 봇이 응답을 멈춥니다.★"
    echo "   조치(둘 중 하나):"
    echo "     · 팀원 id 를 다른 이름으로 바꿔 다시 영입   ← 권장"
    echo "     · 이 프로필이 정말 b3os 용이면 인수: B3OS_ADOPT_PROFILE=1 로 재실행"
    echo "   대상 경로: $PROF_DIR"
    exit 1
  fi
fi
# auth.json 심링크 — clone-from은 모델 provider 인증(auth.json)을 복제하지 않아 새 프로필이 '메시지는 받지만 응답 생성서 인증실패'로 떨어짐(2026-07-01 실측).
#   공유 인증($SRC_PROFILE)에 심링크(복사 아님=토큰 로테이션 시 stale 만료 방지·항상 현재).
if [ -f "$HOME/.hermes/profiles/$SRC_PROFILE/auth.json" ]; then
  ln -sf "$HOME/.hermes/profiles/$SRC_PROFILE/auth.json" "$PROF_DIR/auth.json"
  say "  ✅ auth.json 심링크($SRC_PROFILE 인증 공유 — 응답 생성 인증 확보)"
else
  echo "  ⚠ $SRC_PROFILE/auth.json 없음 — 새 프로필 인증 수동 필요(hermes --profile $AGENT_ID model 로 OAuth)"
fi
mkdir -p "$WS"

# SOUL.md 정본은 멤버 workspace 에 둔다. Hermes Agent 는 HERMES_HOME/SOUL.md 를 identity slot 으로
# 읽기 때문에, 프로필의 SOUL.md 는 별도 복사본이 아니라 workspace SOUL.md 를 가리키는 symlink 로 둔다.
# clone-from 이 seed profile 의 SOUL.md 를 복사해 멤버 정체성이 섞이는 문제(Ames/forin/hermes)를 막는 canonical bridge.
if [ -f "$WS/SOUL.md" ]; then
  rm -f "$PROF_DIR/SOUL.md"
  ln -s "$WS/SOUL.md" "$PROF_DIR/SOUL.md"
  say "  ✅ SOUL.md symlink: profile → workspace"
else
  echo "  ⚠ workspace SOUL.md 없음: $WS/SOUL.md — profile SOUL symlink skip"
fi

say "■ 2) 봇 토큰 교체 (.env — 자기 봇으로, 값 출력 안 함)"
python3 - "$PROF_DIR" "$TOKEN_FILE" <<'PY'
import sys, os, re
prof, tokfile = sys.argv[1], sys.argv[2]
tok = open(tokfile).read().strip()
envp = os.path.join(prof, ".env")
lines = open(envp).read().splitlines() if os.path.exists(envp) else []
out, seen = [], False
for ln in lines:
    if ln.startswith("TELEGRAM_BOT_TOKEN="):
        out.append("TELEGRAM_BOT_TOKEN=" + tok); seen = True
    else:
        out.append(ln)
if not seen:
    out.append("TELEGRAM_BOT_TOKEN=" + tok)
open(envp, "w").write("\n".join(out) + "\n")
os.chmod(envp, 0o600)
print("  ✓ TELEGRAM_BOT_TOKEN 교체 (0600)")
PY

say "■ 3) config.yaml — 멘션 별칭(=$KO/$AGENT_ID) + cwd + Telegram UX 기본값 조정 (자동 적용)"
# (c) 블록의 앵커는 base 프로필 config 의 exclusive(응답 제외) 목록 마지막 항목에 의존한다.
#   팀마다 다르므로 env HERMES_EXCLUDE_ANCHOR 로 지정(예: 마지막 멤버 id). 미지정이면 (c) 스킵 —
#   (b)에서 이미 멘션 패턴을 자기 이름으로 좁히므로 안전(제외 목록은 belt-and-suspenders).
HERMES_EXCLUDE_ANCHOR="${HERMES_EXCLUDE_ANCHOR:-}"
python3 - "$PROF_DIR" "$AGENT_ID" "$KO" "$WS" "$HERMES_EXCLUDE_ANCHOR" <<'PY'
import sys, os, re
prof, aid, ko, ws, anchor = sys.argv[1:6]
# ★hermes 버전드리프트(BUG8b, OWNER 2026-07-03): v0.17.0은 프로필별 config.yaml, v0.18.0+는 profile.yaml 을 쓴다.
#   config.yaml 있으면(구버전) 그걸, 없으면 profile.yaml(신버전) 을 편집 = 두 버전 커버(라이브 v0.17.0 동작 불변).
#   둘 다 없으면 예전엔 여기서 FileNotFoundError→exit1 로 activate 전체가 죽었다 → graceful skip 으로 바꿔 활성화는 계속.
cfgp = os.path.join(prof, "config.yaml")
if not os.path.exists(cfgp):
    alt = os.path.join(prof, "profile.yaml")
    cfgp = alt if os.path.exists(alt) else cfgp
if not os.path.exists(cfgp):
    print("  ⚠ 프로필 설정 파일 없음(config.yaml·profile.yaml 둘 다 부재) — cwd/멘션 자동적용 skip(활성화는 계속). hermes 버전 레이아웃 확인 필요.")
    sys.exit(0)
txt = open(cfgp).read()
changes = []
# config.yaml 은 한글을 \uXXXX 로 저장 → 영문 리터럴을 타겟해야 escape 무관하게 매칭됨(2026-06-11).
# (a) cwd → 이 에이전트 workspace
new, n = re.subn(r"(terminal:\s*\n\s*cwd:\s*).*", r"\g<1>" + ws, txt, count=1)
if n: txt = new; changes.append("cwd")
# (b) 자기 멘션: @(?:<원본이름>|hermes) → @(?:ko|aid)  자기 이름에만 응답
new, n = re.subn(r"@\(\?:[^)]*\|hermes\)", f"@(?:{ko}|{aid})", txt)
if n: txt = new; changes.append(f"mention→{ko}/{aid}")
# (c) exclusive(응답 제외 명단)에 member 추가 → hermes 멘션엔 침묵 (앵커 지정 시에만)
if anchor:
    a = re.escape(anchor)
    new, n = re.subn(rf"\|{a}\)", f"|{anchor}|member|hermes)", txt, count=1)
    if n: txt = new; changes.append("exclusive+hermes")

# (d) Telegram UX defaults for newly activated Hermes profiles.
#   Non-destructive: if the profile already has a value at the exact YAML path, keep it.
#   Avoid upstream/core defaults so webhook/team-bus routes do not inherit Telegram-only progress noise.
def _yaml_indent(line):
    return len(line) - len(line.lstrip(" "))

def _yaml_key(line):
    m = re.match(r"^(\s*)([A-Za-z0-9_-]+):(?:\s+.*)?$", line)
    return (len(m.group(1)), m.group(2)) if m else None

def _block_end(lines, idx):
    indent = _yaml_indent(lines[idx])
    j = idx + 1
    while j < len(lines):
        stripped = lines[j].strip()
        if stripped and not stripped.startswith("#") and _yaml_indent(lines[j]) <= indent:
            break
        j += 1
    return j

def _find_key(lines, key, indent, start=0, end=None):
    if end is None:
        end = len(lines)
    for i in range(start, end):
        parsed = _yaml_key(lines[i])
        if parsed == (indent, key):
            return i
    return None

def _ensure_scalar(lines, path, value):
    start, end = 0, len(lines)
    parent_idx = None
    for depth, key in enumerate(path[:-1]):
        indent = depth * 2
        idx = _find_key(lines, key, indent, start, end)
        if idx is None:
            insert_at = end if parent_idx is not None else len(lines)
            lines.insert(insert_at, " " * indent + key + ":")
            idx = insert_at
        parent_idx = idx
        start, end = idx + 1, _block_end(lines, idx)

    leaf = path[-1]
    indent = (len(path) - 1) * 2
    if _find_key(lines, leaf, indent, start, end) is not None:
        return False
    insert_at = end if parent_idx is not None else len(lines)
    lines.insert(insert_at, " " * indent + f"{leaf}: {value}")
    return True

lines = txt.splitlines()
ux_defaults = [
    (("telegram", "reactions"), "true"),
    (("display", "tool_progress"), "'off'"),
    (("display", "interim_assistant_messages"), "false"),
    (("display", "platforms", "telegram", "tool_progress"), "all"),
    (("display", "platforms", "telegram", "tool_progress_grouping"), "accumulate"),
    (("display", "platforms", "telegram", "interim_assistant_messages"), "true"),
]
ux_added = []
for path, value in ux_defaults:
    if _ensure_scalar(lines, path, value):
        ux_added.append(".".join(path))
if ux_added:
    txt = "\n".join(lines) + ("\n" if txt.endswith("\n") else "")
    changes.append("telegram-ux-defaults+" + str(len(ux_added)))

open(cfgp, "w").write(txt)
print("  ✓ 적용(" + os.path.basename(cfgp) + "):", ", ".join(changes) if changes else "(매칭 없음 — 이 hermes 버전의 " + os.path.basename(cfgp) + " 구조가 예상과 달라 cwd/멘션 자동적용 실패. 수동 확인 요망 — 활성화는 계속).")
PY

say "■ 3b) config.yaml — 메인 모델 명시(빈 model 이면 provider 기본모델로 채움)"
# ★왜: b3os 는 그룹/버스 턴을 `hermes -z` one-shot 으로 spawn 한다(hermesBridge.ts). 지속 게이트웨이는
#   빈 model 을 get_default_model_for_provider(active_provider) 로 자동 채우지만(gateway/run.py), -z exec
#   경로는 안 채운다 → codex 가 '빈 모델' 거부 → openrouter 폴백 → 키 없으면 401 → 턴 실패(그룹 침묵).
#   (2026-07-22 실측: herm — 1:1 은 되는데 그룹만 안 됨. 원인=빈 model.) clone 원본 config 의 빈 model 을
#   그대로 물려받는 게 근본. 활성화 시 프로필 config 에 명시 model 을 박아 one-shot 도 모델을 갖게 한다.
# 멱등: 이미 non-empty model 이면 건드리지 않는다. 실패 시 graceful skip(활성화는 계속).
# ★파이썬 선택 = '실제로 hermes_cli 를 import 할 수 있는' 인터프리터★
#   이 블록은 provider 기본모델 조회를 위해 hermes_cli.models 를 import 한다. 따라서 아무 python3 나
#   쓰면 안 되고 hermes 설치 venv 의 파이썬이어야 한다.
#   ▸ 종전 로직(shebang 파싱 → python 계열 아니면 python3 고정)은 이 맥에서 조용히 무력화됐다:
#     hermes 첫 줄이 `#!/usr/bin/env bash` → awk 가 `/usr/bin/env` 추출 → python 계열 아님 → python3 폴백
#     → 그 python3(예: anaconda)엔 hermes_cli 가 없음 → import 실패 → 항상 skip.
#     즉 '빈 model 채우기'조차 이런 머신에선 한 번도 실행된 적이 없다. (2026-07-25 실측)
#   ▸ dirname(realpath(hermes))/python3 도 부족하다 — hermes 가 심링크가 아니라
#     `exec "<HERMES_HOME>/hermes-agent/venv/bin/hermes" "$@"` 형태의 래퍼 스크립트인 설치가 있다(실측).
#   그래서 후보를 나열하고 ★import 가 실제로 되는 첫 후보★를 고른다(추론 대신 검증).
_hermes_bin="$(command -v hermes 2>/dev/null || true)"
_hermes_py_cands=""
# ① 알려진 설치 레이아웃(HERMES_HOME 우선)
_hh="${HERMES_HOME:-$HOME/.hermes}"
_hermes_py_cands="$_hermes_py_cands $_hh/hermes-agent/venv/bin/python3 $_hh/hermes-agent/venv/bin/python"
if [ -n "$_hermes_bin" ]; then
  # ② 래퍼가 exec 하는 venv 경로에서 역산(위 실측 케이스)
  # ★|| true 필수★ — set -euo pipefail 하에서 sed 가 비정상 종료하면(로케일 켜진 셸 + 바이너리
  #   hermes = "illegal byte sequence", 또는 실행권한만 있고 읽기 불가) 그 상태가 대입문으로 전파돼
  #   활성화가 ★여기서 조용히 죽는다★. 2>/dev/null 이라 에러도 안 남고, 프로필·토큰·config 는 이미
  #   만들어졌는데 팀 등록·게이트웨이 기동은 안 된 반쪽 상태로 끝난다. (2026-07-25 하네스 실측)
  _exec_target="$(sed -n 's/^[[:space:]]*exec[[:space:]]*"\([^"]*\)".*/\1/p' "$_hermes_bin" 2>/dev/null | head -1 || true)"
  [ -n "$_exec_target" ] && _hermes_py_cands="$_hermes_py_cands $(dirname "$_exec_target")/python3 $(dirname "$_exec_target")/python"
  # ③ hermes 자체가 venv bin 의 심링크/실행파일인 경우
  _real="$(realpath "$_hermes_bin" 2>/dev/null || readlink -f "$_hermes_bin" 2>/dev/null || echo "$_hermes_bin")"
  _hermes_py_cands="$_hermes_py_cands $(dirname "$_real")/python3 $(dirname "$_real")/python"
  # ④ shebang 이 진짜 python 인 설치
  _sb="$(head -1 "$_hermes_bin" 2>/dev/null | sed 's/^#!//' | awk '{print $1}' || true)"
  case "$_sb" in *python*) _hermes_py_cands="$_hermes_py_cands $_sb" ;; esac
fi
# ⑤ 최후 폴백 — hermes_cli 가 없으면 아래 블록이 보수적으로 skip 한다(종전과 동일 동작).
_hermes_py_cands="$_hermes_py_cands python3"
HERMES_PY=""
for _c in $_hermes_py_cands; do
  command -v "$_c" >/dev/null 2>&1 || [ -x "$_c" ] || continue
  if "$_c" -c "import hermes_cli.models" >/dev/null 2>&1; then HERMES_PY="$_c"; break; fi
done
if [ -n "$HERMES_PY" ]; then
  say "  파이썬: $HERMES_PY (hermes_cli import 확인됨)"
else
  HERMES_PY="python3"
  echo "  ⚠ hermes_cli 를 import 할 수 있는 파이썬을 못 찾음 — provider 기본모델 조회 불가(아래에서 보수적 skip)"
fi
[ -x "$HERMES_PY" ] || command -v "$HERMES_PY" >/dev/null 2>&1 || HERMES_PY="python3"
# set -e 하에서도 실패 시 graceful skip(활성화 계속) — 주석(위) 의도대로 || 로 흡수.
"$HERMES_PY" - "$PROF_DIR" <<'PY' || echo "  ⚠ 명시 model 자동설정 스킵(활성화는 계속)"
import sys, os, json
prof = sys.argv[1]
try:
    import yaml
except Exception:
    print("  ⚠ pyyaml 없음 — 명시 model 자동설정 skip(활성화는 계속)"); sys.exit(0)
cfgp = os.path.join(prof, "config.yaml")
if not os.path.exists(cfgp):
    alt = os.path.join(prof, "profile.yaml")
    cfgp = alt if os.path.exists(alt) else cfgp
if not os.path.exists(cfgp):
    print("  ⚠ 프로필 설정 파일 없음 — 명시 model skip(활성화는 계속)"); sys.exit(0)
try:
    cfg = yaml.safe_load(open(cfgp)) or {}
except Exception as e:
    print(f"  ⚠ config 로드 실패({e}) — 명시 model skip(활성화는 계속)"); sys.exit(0)
m = cfg.get("model")
# ★str·dict 이외(리스트·정수 등)는 '설정 안 됨'으로 본다★ — 종전엔 m.get() 을 그대로 불러
#   AttributeError 트레이스백이 났다(셸 || 가 흡수해 활성화는 계속됐지만 로그가 지저분).
if isinstance(m, str):
    cur = m.strip() or False
elif isinstance(m, dict):
    cur = m.get("default") or m.get("model") or m.get("name") or False
else:
    cur = False
known = None  # provider 의 라이브 모델 목록(호환성 검사에서 채워짐). 아래 dm 검증에 재사용.
# ★active_provider 를 먼저 판정한다 — 아래 호환성 검사에 필요(종전엔 has 체크 뒤에 있었다).
#   ★provider 의 '출처'를 함께 기억한다★ — 프로필 자체 auth.json 이 아니라 전역(~/.hermes/auth.json)으로
#   폴백해 얻은 provider 로 ★교체★까지 하면, 멀티 프로필 환경에서 남의 provider 기준으로 이 프로필의
#   모델을 덮어쓸 수 있다. 전역 폴백은 원본 동작인 '빈 model 채우기'에만 쓰고 교체에는 쓰지 않는다.
prov = None
prov_from_profile = False
for ap, is_prof in ((os.path.join(prof, "auth.json"), True), (os.path.expanduser("~/.hermes/auth.json"), False)):
    try:
        got = (json.load(open(ap)) or {}).get("active_provider")
    except Exception:
        got = None
    if got:
        prov, prov_from_profile = got, is_prof
        break
if not prov:
    if cur:
        print("  ✓ model 이미 설정됨 — skip(멱등, active_provider 판정 실패로 호환성 미검사)"); sys.exit(0)
    print("  ⚠ active_provider 판정 실패 — 명시 model skip(활성화는 계속)"); sys.exit(0)
# ★멱등 조건 = '비어있음'이 아니라 '비어있거나 active_provider 와 호환 불가'★
#   종전엔 non-empty 면 무조건 skip 했다. 그런데 clone 원본이 전역 ~/.hermes/config.yaml 의 기본 model
#   (예: anthropic/claude-opus-4.6)을 물려받으면 non-empty 라 skip → codex(ChatGPT) 구독에 Claude 모델이
#   붙은 채로 활성화가 '성공'하고, 첫 메시지에서야 HTTP 400 으로 죽는다:
#     "The 'anthropic/claude-opus-4.6' model is not supported when using Codex with a ChatGPT account."
#   (2026-07-25 실측: herm — activate 전 단계 ✅ 통과 후 텔레그램 첫 턴에서 실패.)
#   판정은 provider_model_ids(prov) 목록 대조로 한다 — detect_static_provider_for_model 은 슬래시
#   네임스페이스 형태('anthropic/claude-opus-4.6')를 못 잡아 이 케이스에서 None 을 준다(실측).
#   ★보수적으로: 목록을 못 얻거나 비면 판정 불가로 보고 종전대로 skip(멱등).★
# ★교체는 '모델 집합이 닫힌' provider 로만 한정한다★
#   provider_model_ids() 는 provider 에 따라 성격이 다르다:
#     - openai-codex(n=10): 구독 엔드포인트가 서빙하는 ★전체 목록★ → 목록에 없으면 진짜로 호출 불가.
#     - openrouter(n=36)·nous(n=32): 실제로는 수백 개를 서빙하는데 ★큐레이션 부분집합★만 반환.
#       여기서 목록 대조로 교체하면 팀장이 일부러 지정한 정상 모델을 덮어쓴다(회귀).
#   그래서 닫힌 집합이 확실한 provider 만 교체 대상으로 둔다. 나머지는 종전대로 멱등 skip.
#   (새 provider 를 추가할 땐 그 provider 의 목록이 '전체'인지 먼저 확인할 것.)
CLOSED_SET_PROVIDERS = {"openai-codex"}
if cur:
    if prov not in CLOSED_SET_PROVIDERS:
        print(f"  ✓ model 이미 설정됨({cur}) — provider={prov} 는 모델목록이 부분집합일 수 있어 교체 안 함 · skip(멱등)"); sys.exit(0)
    if not prov_from_profile:
        print(f"  ✓ model 이미 설정됨({cur}) — provider 를 전역 auth.json 에서 얻어(프로필 자체 값 아님) 교체 안 함 · skip(멱등)"); sys.exit(0)
    try:
        from hermes_cli.models import provider_model_ids
        known = [x for x in (provider_model_ids(prov) or []) if isinstance(x, str)]
    except Exception as e:
        # ★예외 문자열을 그대로 찍지 않는다★ — 이 경로는 인증/토큰 갱신을 타므로(provider_model_ids →
        #   resolve_codex_runtime_credentials) 예외 메시지에 토큰·URL 이 실릴 수 있다. 타입명만 남긴다.
        print(f"  ✓ model 이미 설정됨 — skip(멱등, 호환성 조회 실패: {type(e).__name__})"); sys.exit(0)
    if not known:
        print(f"  ✓ model 이미 설정됨 — skip(멱등, provider={prov} 모델목록 비어 판정 불가)"); sys.exit(0)
    if cur in known:
        print(f"  ✓ model 이미 설정됨({cur}) — provider={prov} 와 호환 · skip(멱등)"); sys.exit(0)
    print(f"  ⚠ model({cur}) 이 active_provider={prov} 와 호환 불가 — provider 기본모델로 교체")
try:
    from hermes_cli.models import get_default_model_for_provider
    dm = get_default_model_for_provider(prov)
except Exception as e:
    print(f"  ⚠ 기본모델 조회 실패({e}) — 명시 model skip(활성화는 계속)"); sys.exit(0)
if not dm:
    print(f"  ⚠ provider={prov} 기본모델 없음 — 명시 model skip(활성화는 계속)"); sys.exit(0)
# ★자기가 써넣는 값이 호환성 검사를 통과하는지 확인한다★
#   판정은 provider_model_ids(라이브 목록), 쓰기는 get_default_model_for_provider(정적 카탈로그)라
#   출처가 다르다. 정적 기본모델이 그 계정의 라이브 목록에 없으면 '호환 불가 → 교체'를 매 활성화마다
#   무한 반복하고 교체 결과도 여전히 호환 불가다. 목록을 아는 경우에만 교차확인한다.
if known and dm not in known:
    # ★known[0] 로 바로 떨어지면 '요금 지뢰'가 된다★ — hermes 카탈로그는 provider 에 따라
    #   '가장 강력한 순'으로 정렬돼 있어 0번이 ★최고가 모델★이다. hermes 자신도 이걸 막고 있다:
    #     get_default_model_for_provider() docstring —
    #     "silently defaulting to it is a billing footgun ... a missing model must never
    #      auto-escalate to the flagship"
    #   그래서 과금형(_SILENT_DEFAULT_PROVIDERS = openrouter·nous)은 카탈로그 0번 대신
    #   비용안전 기본값으로 해석된다. 실측(2026-07-25):
    #     openrouter  provider_model_ids[0]=anthropic/claude-fable-5  vs  기본값=z-ai/glm-5.2  ← 불일치
    #     openai-codex 는 둘 다 gpt-5.6-sol 이라 현재 CLOSED_SET 에선 영향 없음(잠재 결함).
    #   CLOSED_SET_PROVIDERS 에 과금형 provider 를 추가하는 순간 조용히 플래그십으로 승격되므로,
    #   대체할 때도 ★비용안전 기본값을 먼저★ 시도한다.
    alt = ""
    try:
        from hermes_cli.models import get_preferred_silent_default_model
        alt = get_preferred_silent_default_model(prov) or ""
    except Exception:
        alt = ""
    if alt and alt in known:
        print(f"  ⚠ provider 기본모델({dm})이 실제 목록에 없음 — 비용안전 기본값({alt})으로 대체")
        dm = alt
    else:
        print(f"  ⚠ provider 기본모델({dm})이 실제 목록에 없음 — 목록 첫 항목({known[0]})으로 대체(카탈로그 상단=고가일 수 있음)")
        dm = known[0]
# ★model 매핑을 통째로 갈지 않는다★ — 종전엔 {provider, default} 로 치환해서 형제 키
#   (api_key·base_url·reasoning_effort·context_length 등 hermes 가 실제로 읽는 값)가 전량 소실됐다.
#   복사 후 두 키만 갱신하고, 중복 표기인 별칭(model·name)만 정리한다.
m2 = dict(m) if isinstance(m, dict) else {}
m2["provider"] = prov
m2["default"] = dm
m2.pop("model", None)
m2.pop("name", None)
cfg["model"] = m2
# ★쓰기 전 백업★ — safe_load→safe_dump 전체 재직렬화라 주석·YAML 앵커는 보존할 수 없다.
#   값은 보존되지만 주석이 사라지므로, 되돌릴 자산을 남긴다(best-effort).
try:
    import shutil
    shutil.copy2(cfgp, cfgp + ".bak")
except Exception:
    pass
# ★원자적 쓰기★ — open(w) 는 먼저 truncate 하므로 쓰기 중 오류가 나면 config 가 잘린 채 남는다.
try:
    tmpp = cfgp + ".tmp"
    with open(tmpp, "w") as fh:
        yaml.safe_dump(cfg, fh, allow_unicode=True, sort_keys=False, default_flow_style=False)
    os.replace(tmpp, cfgp)
    print(f"  ✓ 명시 model 설정: provider={prov}, default={dm} ({os.path.basename(cfgp)})")
except Exception as e:
    try: os.unlink(cfgp + ".tmp")
    except Exception: pass
    print(f"  ⚠ config 쓰기 실패({e}) — 활성화는 계속")
PY

say "■ 4) team-collab 등록 안내 (recruit 가 했으면 hermes_profile 만 확인)"
echo "  agents.json: runtime=hermes_agent, hermes_profile=$AGENT_ID, status_provider=hermes_gateway"
echo "  (대시보드 영입으로 등록됐으면 persona/경로 자동 — hermes_profile 필드만 추가 필요할 수 있음)"

say "■ 5) 게이트웨이 기동 (프로필별 독립 LaunchAgent — 재부팅 생존)"
# ★팀장 텔레그램 chat_id 해석 — hermes v0.18 페어링 게이트를 팀장은 코드 없이 통과시키기 위해 게이트웨이
#   plist EnvironmentVariables 의 TELEGRAM_ALLOWED_USERS 에 동적 주입한다(telegram/adapter.py os.getenv 로 읽음).
#   ①activation.ts 가 넘긴 OWNER_CHAT_ID(설정 owner_chat_id/도출) ②수동 실행 폴백: team.db owner_chat_id 설정.
#   ★하드코딩 금지 — 값은 항상 설정에서 동적으로.★ 없으면 미주입(팀장이 수동 pairing 필요).  GD 2026-07-19.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEAM_DB="${TEAM_DB_PATH:-$SCRIPT_DIR/../../../../team.db}"
if [ -z "${OWNER_CHAT_ID:-}" ] && command -v sqlite3 >/dev/null 2>&1 && [ -f "$TEAM_DB" ]; then
  OWNER_CHAT_ID="$(sqlite3 "$TEAM_DB" "SELECT value FROM setting WHERE key='owner_chat_id'" 2>/dev/null || true)"
fi
OWNER_CHAT_ID="$(printf '%s' "${OWNER_CHAT_ID:-}" | tr -d '[:space:]')"
export OWNER_CHAT_ID
if [ -n "$OWNER_CHAT_ID" ]; then say "  팀장 chat_id 확보 — 게이트웨이 allowlist 에 시드(페어링 게이트 통과)"; else echo "  ⚠ owner_chat_id 미확보 — 게이트웨이 allowlist 시드 skip(팀장이 봇에 수동 pairing 필요)"; fi
# durability(2026-07-01): seed 프로필($SRC_PROFILE) plist 템플릿에서 프로필명만 치환해 프로필별 LaunchAgent 생성+bootstrap.
#   unmanaged `hermes gateway start`는 재부팅·크래시 시 사라져 restart/auto-heal 대상 밖 → LaunchAgent(RunAtLoad/KeepAlive)로 관리.
#   템플릿은 seed 프로필의 plist 사용; 없으면 아래 unmanaged 폴백.
HTMPL="$HOME/Library/LaunchAgents/ai.hermes.gateway-$SRC_PROFILE.plist"
HPLIST="$HOME/Library/LaunchAgents/ai.hermes.gateway-$AGENT_ID.plist"
GENERIC_PLIST="$HOME/Library/LaunchAgents/ai.hermes.gateway.plist"
mkdir -p "$HOME/.hermes/profiles/$AGENT_ID/logs"
# ★seed 전용 plist 폴백(자동시드 base 대응, OWNER 2026-07-19 맥북테스트)★ — 현대 hermes(v0.18+)의
#   `hermes gateway install` 은 프로필별 plist 를 만들지 않고 generic ai.hermes.gateway.plist 하나만 만든다.
#   그래서 자동시드된 base 프로필엔 전용 plist가 없어
#   아래 per-profile 복제가 unmanaged 폴백으로 빠지고, 그 폴백의 `hermes gateway start` 는 generic(=default
#   프로필) 게이트웨이만 띄워 'herm 프로필 게이트웨이 안 뜸' 으로 실패했다(preflight/base 시드는 통과한 뒤 여기서 막힘).
#   → seed 전용 plist 가 없으면 generic 을 복제 템플릿으로 삼는다(generic 도 없으면 install 로 만든 뒤).
#     복제 python 이 Label/--profile/HERMES_HOME 을 이 프로필용으로 바꿔 per-profile plist 를 만든다.
if [ ! -f "$HTMPL" ]; then
  [ -f "$GENERIC_PLIST" ] || HERMES_PROFILE="$SRC_PROFILE" hermes gateway install --no-start-now >/dev/null 2>&1 || true
  [ -f "$GENERIC_PLIST" ] && HTMPL="$GENERIC_PLIST"
fi
if [ -f "$HTMPL" ] && [ "$AGENT_ID" != "$SRC_PROFILE" ]; then
  python3 - "$HTMPL" "$HPLIST" "$AGENT_ID" <<'PY'
import os, plistlib, sys
src, dst, profile = sys.argv[1:4]
with open(src, "rb") as f:
    data = plistlib.load(f)
data["Label"] = f"ai.hermes.gateway-{profile}"
args = list(data.get("ProgramArguments") or [])
args = [arg for arg in args if arg != "--replace"]
if "--profile" in args:
    idx = args.index("--profile")
    if idx + 1 < len(args):
        args[idx + 1] = profile
else:
    try:
        gateway_idx = args.index("gateway")
    except ValueError:
        gateway_idx = 3
    args[gateway_idx:gateway_idx] = ["--profile", profile]
data["ProgramArguments"] = args
# ThrottleInterval — 죽어도 최소 30s 간격 재기동. launchd 기본 10s면 SIGTERM 받을 때마다 10초마다 respawn →
#   6회/60s 로 hermes 자체 restart-loop breaker 발동(업그레이드·매니저 경합 시 respawn 전쟁, BUG8b 인시던트 OWNER 2026-07-03).
#   30s 간격이면 경합이 폭주 전에 가라앉고 breaker도 덜 민감하게 걸린다. --replace 제거(위)와 함께 respawn 전쟁 방지.
data["ThrottleInterval"] = 30
env = dict(data.get("EnvironmentVariables") or {})
env["HERMES_HOME"] = os.path.expanduser(f"~/.hermes/profiles/{profile}")
# 팀장 chat_id 를 게이트웨이 process env allowlist 에 병합 주입 → hermes v0.18 페어링 게이트를 팀장은 통과
#   (telegram/adapter.py 가 os.getenv("TELEGRAM_ALLOWED_USERS") 로 읽음). 값=설정 owner_chat_id(동적, 하드코딩 아님).
#   기존 항목 보존 + 중복 제거. 미설정(빈 값)이면 건드리지 않음(open 게이트웨이 그대로).
#   ★설계상 owner-DM-only★(하네스 검토 2026-07-19): 이 봇 게이트는 '팀장 1:1 DM' 을 여는 용도다. 그룹(팀방)
#   협업은 이 봇 게이트가 아니라 ①System OP capture 봇이 그룹을 읽어 ②버스로 팀원을 깨우는 경로로 도달하므로
#   (텔레그램은 bot→bot 그룹메시지를 전달 안 함), 여기에 그룹 chat_id 를 넣지 않는다. 그룹 내 non-owner '사람'
#   발신이 이 봇에 직접 필요해지면 그때 TELEGRAM_GROUP_ALLOWED_CHATS 를 별도 주입한다(현재 미해당).
owner = os.environ.get("OWNER_CHAT_ID", "").strip()
if owner:
    ids = [u.strip() for u in env.get("TELEGRAM_ALLOWED_USERS", "").split(",") if u.strip()]
    if owner not in ids:
        ids.append(owner)
    env["TELEGRAM_ALLOWED_USERS"] = ",".join(ids)
# 재활성화 때 stale false도 교정해 무멘션 차단 보호를 강제한다.
env["TELEGRAM_REQUIRE_MENTION"] = "true"
data["EnvironmentVariables"] = env
data["StandardErrorPath"] = os.path.expanduser(f"~/.hermes/profiles/{profile}/logs/gateway.error.log")
data["StandardOutPath"] = os.path.expanduser(f"~/.hermes/profiles/{profile}/logs/gateway.log")
with open(dst, "wb") as f:
    plistlib.dump(data, f)
PY
  if [ -f "$GENERIC_PLIST" ] && ! /usr/libexec/PlistBuddy -c "Print :ProgramArguments" "$GENERIC_PLIST" 2>/dev/null | grep -q -- "--profile"; then
    echo "  ⚠ generic ai.hermes.gateway 감지 — per-profile 충돌 방지를 위해 비활성화"
    launchctl bootout "gui/$(id -u)/ai.hermes.gateway" 2>/dev/null || true
    launchctl disable "gui/$(id -u)/ai.hermes.gateway" 2>/dev/null || true
    mv "$GENERIC_PLIST" "$GENERIC_PLIST.disabled-by-profile-activation" 2>/dev/null || true
  fi
  launchctl bootstrap "gui/$(id -u)" "$HPLIST" 2>/dev/null \
    || launchctl kickstart -k "gui/$(id -u)/ai.hermes.gateway-$AGENT_ID" 2>/dev/null \
    || { echo "  ⚠ LaunchAgent bootstrap 실패 — unmanaged 폴백"; HERMES_PROFILE="$AGENT_ID" ${OWNER_CHAT_ID:+TELEGRAM_ALLOWED_USERS=$OWNER_CHAT_ID} hermes gateway start 2>&1 | tail -3; }
  say "  ✅ LaunchAgent 생성+기동: ai.hermes.gateway-$AGENT_ID (재부팅 생존)"
else
  echo "  ⚠ seed($SRC_PROFILE) plist 템플릿 없음 — unmanaged 폴백"; HERMES_PROFILE="$AGENT_ID" ${OWNER_CHAT_ID:+TELEGRAM_ALLOWED_USERS=$OWNER_CHAT_ID} hermes gateway start 2>&1 | tail -5 || echo "  ⚠ gateway start 확인 필요"
fi
sleep 2
# ★검증(OWNER 2026-07-19 맥북테스트)★ — b3os 는 per-profile launchd 서비스(ai.hermes.gateway-<id>)를 직접 만든다.
#   modern hermes 의 `hermes gateway status` 는 generic 서비스만 봐 per-profile 를 'not running' 으로 오탐한다
#   (게이트웨이가 실제 떠 있어도 activate 실패로 뜸 — `hermes gateway list` 엔 ✓ <id> — PID N 로 정상 표시).
#   그래서 우리가 만든 그 launchd 서비스 상태를 직접 확인하고, 못 잡으면 예전 status 파서로 폴백한다.
GW_LABEL="ai.hermes.gateway-$AGENT_ID"
LC_OUT="$(launchctl print "gui/$(id -u)/$GW_LABEL" 2>/dev/null || true)"
STATUS_OUT="$(HERMES_PROFILE="$AGENT_ID" hermes gateway status 2>&1 || true)"
if printf "%s" "$LC_OUT" | grep -qE "state = running" && printf "%s" "$LC_OUT" | grep -qE "pid = [0-9]+"; then
  say "  ✅ 게이트웨이 실행 확인(launchd: $GW_LABEL)"
elif HERMES_STATUS_OUT="$STATUS_OUT" python3 - "$AGENT_ID" <<'PY'
import os, re, sys

profile = sys.argv[1]
status = os.environ.get("HERMES_STATUS_OUT", "")

def healthy(line):
    return bool(re.search(r"\bPID\s+\d+\b", line, re.I)) and (
        "✓" in line
        or "✔" in line
        or re.search(r"\bloaded\b", line, re.I)
        or re.search(r"\bsupervised by launchd\b", line, re.I)
        or re.search(r"\bis running\b", line, re.I)
        or re.search(r"\bhealthy\b", line, re.I)
    )

def has_profile_evidence(lines):
    p = re.escape(profile)
    patterns = [
        re.compile(rf"ai\.hermes\.gateway-{p}\.plist", re.I),
        re.compile(rf"--profile\s+{p}\b", re.I),
        re.compile(rf"\bprofile\b\s*[:=]\s*{p}\b", re.I),
        re.compile(rf"\.hermes/profiles/{p}(/|\b)", re.I),
    ]
    return any(any(pat.search(line) for pat in patterns) for line in lines)

lines = [line.strip() for line in status.splitlines() if line.strip()]
try:
    other_at = next(i for i, line in enumerate(lines) if re.match(r"Other profiles:", line, re.I))
except StopIteration:
    other_at = -1

current = lines[:other_at] if other_at >= 0 else lines
profile_line = re.compile(rf"(^|[^A-Za-z0-9_-]){re.escape(profile)}([^A-Za-z0-9_-]|$)", re.I)
ok = (any(healthy(line) for line in current) and has_profile_evidence(current)) or any(
    profile_line.search(line) and healthy(line) for line in lines
)
sys.exit(0 if ok else 1)
PY
then
  say "  ✅ 게이트웨이 실행 확인(status 파서)"
else
  echo "❌ hermes gateway not running for profile $AGENT_ID"
  printf "%s\n" "$STATUS_OUT" | head -5
  exit 1
fi

echo ""
say "■ 완료. 다음:"
echo "  · config.yaml mention_patterns 수동 확인($PROF_DIR/config.yaml.newpattern 참고)"
echo "  · team-collab agents.json 에 hermes_profile=$AGENT_ID 확인 + var/bus-wake-extra 에 $AGENT_ID 추가"
echo "  · 텔레그램 그룹에 봇 추가(사람) + DM/멘션 테스트"
echo "  · seed($SRC_PROFILE) 게이트웨이 정상인지 확인(영향 없어야)"
