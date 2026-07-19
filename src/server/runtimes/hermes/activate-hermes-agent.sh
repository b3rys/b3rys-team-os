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
DISPLAY="${DISPLAY:-${AGENT_ID^^}}"
KO="${KO:-$AGENT_ID}"                     # 한글 멘션 별칭 (예: 별칭)
DESC="${DESC:-b3rys 팀원 ($AGENT_ID)}"
WS="${WS:-$HOME/Development/$AGENT_ID}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.hermes/credentials/$AGENT_ID-token.txt}"
PROF_DIR="$HOME/.hermes/profiles/$AGENT_ID"
say(){ printf "\033[32m%s\033[0m\n" "$1"; }

[ -s "$TOKEN_FILE" ] || { echo "❌ 봇 토큰 없음: $TOKEN_FILE (BotFather 토큰 먼저 저장)"; exit 1; }

# 복제 원본(SRC_PROFILE) 결정 — activation.ts 는 SRC_PROFILE 를 주입하지 않으므로(AGENT_ID+WS 뿐),
#   env 명시가 없으면 auth 보유 프로필을 동적 탐지한다. 특정 이름(b3ryshermes) 하드요구를 없애 →
#   공개 사용자가 자기 이름 프로필(예: myhermes)만 인증돼 있어도 영입 가능(openclaw 스크립트의 동적 auth-소스 탐지와 동일 패턴).
#   우선순위: ① env SRC_PROFILE 명시 → ② b3ryshermes(라이브 base, 있으면 먼저) → ③ auth.json 보유하는 첫 프로필(타겟 제외).
#   auth.json = 응답 생성 인증(공유 원본). 없으면 '메시지는 받지만 응답 못 하는' 死봇이 되므로 이를 가진 프로필만 원본으로 인정.
if [ -z "${SRC_PROFILE:-}" ]; then
  SRC_PROFILE=""
  for cand in "$HOME/.hermes/profiles/b3ryshermes" "$HOME"/.hermes/profiles/*; do
    [ -d "$cand" ] || continue
    pname="$(basename "$cand")"
    [ "$pname" = "$AGENT_ID" ] && continue        # 타겟 자신은 원본이 될 수 없음
    [ -f "$cand/auth.json" ] || continue          # 인증(auth.json) 보유 프로필만 원본으로
    SRC_PROFILE="$pname"; break
  done
fi
[ -n "${SRC_PROFILE:-}" ] || { echo "❌ 인증된 hermes 프로필이 최소 1개 필요합니다 (auth 복제 원본). 먼저 ~/.hermes/profiles/<name>/auth.json 이 있는 프로필을 만드세요"; exit 1; }
[ -d "$HOME/.hermes/profiles/$SRC_PROFILE" ] || { echo "❌ 원본 프로필 없음: $SRC_PROFILE"; exit 1; }
say "■ 복제 원본 프로필: $SRC_PROFILE"

say "■ 1) 프로필 생성 (clone-from $SRC_PROFILE)"
# ★완전-프로필 판정 version-aware(BUG8b): v0.17.0=config.yaml · v0.18.0+=profile.yaml → 둘 중 하나라도 있으면 완전.
#   config.yaml 만 보면 v0.18.0 정상 프로필을 half-state 로 오판해 rm-rf+재클론(불필요·위험)하던 갭. OWNER 2026-07-03.
if [ -d "$PROF_DIR" ] && { [ -f "$PROF_DIR/config.yaml" ] || [ -f "$PROF_DIR/profile.yaml" ]; }; then
  echo "  이미 존재(완전): $PROF_DIR — 건너뜀(덮어쓰기 안 함)"
else
  # 불완전 프로필 잔재(config.yaml·profile.yaml 둘 다 없음 = 이전 퇴사가 덜 정리한 half-state) 감지 시 제거 후 재클론.
  #   안 그러면 clone 건너뛰어 설정 없는 채로 진행→게이트웨이 못 뜸(2026-07-01 실측). 슬러그 가드+고정 prefix로 안전.
  if [ -d "$PROF_DIR" ] && [[ "$AGENT_ID" =~ ^[a-z0-9_-]+$ ]] && [ "$AGENT_ID" != "b3ryshermes" ] && [ "$AGENT_ID" != "$SRC_PROFILE" ]; then
    echo "  ⚠ 불완전 프로필 잔재($PROF_DIR, config.yaml·profile.yaml 둘 다 없음) — 제거 후 재클론"
    rm -rf "$PROF_DIR"
  fi
  hermes profile create "$AGENT_ID" --clone-from "$SRC_PROFILE" --description "$DESC"
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

say "■ 3) config.yaml — 멘션 별칭(=$KO/$AGENT_ID) + cwd 조정 (자동 적용)"
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
open(cfgp, "w").write(txt)
print("  ✓ 적용(" + os.path.basename(cfgp) + "):", ", ".join(changes) if changes else "(매칭 없음 — 이 hermes 버전의 " + os.path.basename(cfgp) + " 구조가 예상과 달라 cwd/멘션 자동적용 실패. 수동 확인 요망 — 활성화는 계속).")
PY

say "■ 4) team-collab 등록 안내 (recruit 가 했으면 hermes_profile 만 확인)"
echo "  agents.json: runtime=hermes_agent, hermes_profile=$AGENT_ID, status_provider=hermes_gateway"
echo "  (대시보드 영입으로 등록됐으면 persona/경로 자동 — hermes_profile 필드만 추가 필요할 수 있음)"

say "■ 5) 게이트웨이 기동 (프로필별 독립 LaunchAgent — 재부팅 생존)"
# durability(2026-07-01): seed 프로필($SRC_PROFILE) plist 템플릿에서 프로필명만 치환해 프로필별 LaunchAgent 생성+bootstrap.
#   unmanaged `hermes gateway start`는 재부팅·크래시 시 사라져 restart/auto-heal 대상 밖 → LaunchAgent(RunAtLoad/KeepAlive)로 관리.
#   템플릿은 seed 프로필의 plist 사용(라이브=b3ryshermes); 없으면 아래 unmanaged 폴백.
HTMPL="$HOME/Library/LaunchAgents/ai.hermes.gateway-$SRC_PROFILE.plist"
HPLIST="$HOME/Library/LaunchAgents/ai.hermes.gateway-$AGENT_ID.plist"
GENERIC_PLIST="$HOME/Library/LaunchAgents/ai.hermes.gateway.plist"
mkdir -p "$HOME/.hermes/profiles/$AGENT_ID/logs"
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
    || { echo "  ⚠ LaunchAgent bootstrap 실패 — unmanaged 폴백"; HERMES_PROFILE="$AGENT_ID" hermes gateway start 2>&1 | tail -3; }
  say "  ✅ LaunchAgent 생성+기동: ai.hermes.gateway-$AGENT_ID (재부팅 생존)"
else
  echo "  ⚠ seed($SRC_PROFILE) plist 템플릿 없음 — unmanaged 폴백"; HERMES_PROFILE="$AGENT_ID" hermes gateway start 2>&1 | tail -5 || echo "  ⚠ gateway start 확인 필요"
fi
sleep 2
STATUS_OUT="$(HERMES_PROFILE="$AGENT_ID" hermes gateway status 2>&1 || true)"
printf "%s\n" "$STATUS_OUT" | head -5
if ! HERMES_STATUS_OUT="$STATUS_OUT" python3 - "$AGENT_ID" <<'PY'
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
  echo "❌ hermes gateway not running for profile $AGENT_ID"
  exit 1
fi

echo ""
say "■ 완료. 다음:"
echo "  · config.yaml mention_patterns 수동 확인($PROF_DIR/config.yaml.newpattern 참고)"
echo "  · team-collab agents.json 에 hermes_profile=$AGENT_ID 확인 + var/bus-wake-extra 에 $AGENT_ID 추가"
echo "  · 텔레그램 그룹에 봇 추가(사람) + DM/멘션 테스트"
echo "  · seed($SRC_PROFILE) 게이트웨이 정상인지 확인(영향 없어야)"
