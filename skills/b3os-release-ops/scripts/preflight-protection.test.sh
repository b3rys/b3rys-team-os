#!/usr/bin/env bash
# release-preflight.sh 의 ★브랜치 보호 판정★ 만 잰다.
#
# 왜: 이 검사는 admin 전용 API 를 쓴다. admin 이 아니면 ★설정이 멀쩡해도 404★ 라,
#   404 를 전부 "없음" 으로 보면 ★작업 계정으로는 영원히 통과 못 한다★ (2026-08-03 실측: bill·codex 둘 다 정지).
#   그래서 "권한 없어 못 읽음(warn)" 과 "admin 인데 없음(fail)" 이 갈리는지를 본다.
#
# gh 를 PATH mock 으로 갈아끼워 세 경우를 만든다. 실 GitHub·실 계정 미접촉.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${PREFLIGHT_SRC:-$HERE/release-preflight.sh}"   # 옛 버전 대조용으로 바꿔 끼울 수 있다
[ -f "$SCRIPT" ] || { echo "✗ release-preflight.sh 없음"; exit 1; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
FAIL=0
ok(){ printf '  ✓ %s\n' "$1"; }
bad(){ printf '  ✗ %s\n' "$1"; FAIL=$((FAIL+1)); }

# 검사 대상 repo — noreply 이메일 커밋 1개, clean, main 아님
R="$T/repo"; mkdir -p "$R"; cd "$R"
git init -q -b main .
git remote add origin https://github.com/b3rys/b3rys-team-os.git
git -c user.name=t -c user.email='1+t@users.noreply.github.com' commit -q --allow-empty -m base
git branch -q -f origin/main HEAD          # BASE=origin/main 로 비교되게 로컬 ref 를 만든다
git checkout -q -b work
git -c user.name=t -c user.email='1+t@users.noreply.github.com' commit -q --allow-empty -m work

mk_gh(){ # $1=protection(ok|404) $2=admin(true|false)
  cat > "$T/bin/gh" <<SH
#!/usr/bin/env bash
case "\$*" in
  *branches/main/protection*) [ "$1" = ok ] && exit 0 || exit 1 ;;
  *repos/*--jq*permissions.admin*) printf '%s\n' "$2"; exit 0 ;;
esac
exit 0
SH
  chmod +x "$T/bin/gh"
}
mkdir -p "$T/bin"; export PATH="$T/bin:$PATH"

run(){ bash "$SCRIPT" --mode merge --base origin/main --skip-approver-check "test harness" 2>&1; }

echo "■ release-preflight 브랜치 보호 판정"

mk_gh ok true
out="$(run)"; rc=$?
[ $rc -eq 0 ] && printf '%s' "$out" | grep -q '✓ main branch protection exists' \
  && ok "보호 있음 → 통과" || bad "보호 있음인데 통과 못 함 (rc=$rc)"

mk_gh 404 false
out="$(run)"; rc=$?
[ $rc -eq 0 ] && printf '%s' "$out" | grep -q 'not verifiable' \
  && ok "★admin 아님 + 404 → 판정불가로 경고하고 통과★" \
  || bad "admin 없는 계정이 막힌다 — 게이트가 상시 빨간불이 된다 (rc=$rc)"

mk_gh 404 true
out="$(run)"; rc=$?
[ $rc -ne 0 ] && printf '%s' "$out" | grep -q 'protection missing' \
  && ok "★admin 인데 404 → 진짜 없음이므로 실패★" \
  || bad "보호가 진짜 없는데 통과시켰다 (rc=$rc)"

echo
[ "$FAIL" -eq 0 ] && echo "✅ 통과" || echo "❌ 실패 ${FAIL}건"
exit "$FAIL"
