#!/usr/bin/env bash
# gen-test-map.sh — docs/TEST_CASES.md 의 '지키는 것' 절을 테스트 이름에서 다시 뽑는다.
#
# ★왜 자동인가★: 우리 테스트 이름은 이미 "무엇을 지키는지" 로 쓰여 있다
#   (예: "UTC 를 로컬로 오독하지 않는다 (이게 틀리면 9시간 거짓말)").
#   사람이 목록을 따로 관리하면 ★코드와 문서가 갈린다★ — 오늘 하루 그 사고만 3건이었다.
#   그래서 목록은 손으로 쓰지 않고 ★소스에서 뽑는다.★
#
# ★왜 '안 보는 것' 은 자동이 아닌가★: 기계는 우리가 무엇을 ★안 봤는지★ 모른다.
#   그건 판단이고, 판단이라서 값이 있다. 그 절은 ★손으로 쓰고 이 스크립트가 건드리지 않는다.★
#
# ★개수를 쓰지 않는다★: 테스트는 매일 늘어서 숫자는 며칠이면 낡는다.
#   낡은 숫자는 읽는 사람이 자기 환경을 의심하게 만든다(2026-07-28 steve).
#
# 사용: bash scripts/gen-test-map.sh        # docs/TEST_CASES.md 갱신
#       bash scripts/gen-test-map.sh --check # 갱신이 필요한지만 확인(CI용, 파일 안 바꿈)
set -euo pipefail
cd "$(dirname "$0")/.."
DOC="docs/TEST_CASES.md"
BEGIN="<!-- BEGIN GENERATED: 지키는 것 -->"
END="<!-- END GENERATED -->"

[ -f "$DOC" ] || { echo "ERROR: $DOC 가 없습니다. 먼저 만들어 주세요(손으로 쓰는 절이 있습니다)." >&2; exit 2; }
grep -qF "$BEGIN" "$DOC" || { echo "ERROR: $DOC 에 생성 구간 표시가 없습니다: $BEGIN" >&2; exit 2; }

TMP="$(mktemp)"; trap 'rm -f "$TMP" "$TMP.body"' EXIT

# 영역 = 경로에서 도출. 사람이 유지하는 매핑이 아니라 ★파일이 있는 곳★ 이 곧 영역이다.
area_of() {
  case "$1" in
    src/server/routes/*)   echo "HTTP 라우트 — 대시보드·API 가 지키는 계약" ;;
    src/server/bus/*)      echo "팀 버스 — 메시지가 실제로 배달되는가" ;;
    src/server/db/*)       echo "저장소 — 기록이 남고 안 깨지는가" ;;
    src/server/runtimes/*) echo "런타임 — 팀원 봇을 켜고 끄는 경로" ;;
    src/server/lib/*)      echo "서버 공용 — 신원·권한·활성화" ;;
    src/server/*)          echo "서버 기타" ;;
    src/web/*)             echo "화면 — 사용자가 실제로 보는 것" ;;
    src/shared/*)          echo "공용 규약 — 서버와 화면이 같이 쓰는 것" ;;
    skills/*)              echo "팀 스킬 — 셸 도구" ;;
    *)                     echo "그 밖" ;;
  esac
}

{
  echo "$BEGIN"
  echo "<!-- ★손으로 고치지 마세요★ — bash scripts/gen-test-map.sh 가 이 구간을 다시 씁니다. -->"
  echo
  echo "각 줄은 **테스트가 지키는 약속**입니다. 깨지면 그 줄이 빨간불이 됩니다."
  echo
} > "$TMP.body"

# 최상위 describe 만 뽑는다(중첩은 세부라 목록이 길어지기만 한다).
LAST_AREA=""
find src -name '*.test.ts' -type f 2>/dev/null | sort | while read -r f; do
  names="$(grep -hoE '^describe\("[^"]+"' "$f" 2>/dev/null | sed 's/^describe("//; s/"$//' || true)"
  [ -n "$names" ] || continue
  a="$(area_of "$f")"
  if [ "$a" != "$LAST_AREA" ]; then printf '\n### %s\n\n' "$a"; LAST_AREA="$a"; fi
  # ★'-' 로 시작하는 형식문자열은 printf 가 옵션으로 읽는다★ — `--` 로 끊어준다.
  printf -- '- `%s`\n' "$f"
  # 따옴표·파이프는 표를 깨뜨리므로 그대로 두되 목록으로만 낸다.
  printf '%s\n' "$names" | sed 's/^/  - /'
done >> "$TMP.body"

printf '\n%s\n' "$END" >> "$TMP.body"

# 생성 구간만 교체 — ★손으로 쓴 절('안 보는 것')은 절대 건드리지 않는다.★
awk -v b="$BEGIN" -v e="$END" -v bodyfile="$TMP.body" '
  $0 == b { while ((getline line < bodyfile) > 0) print line; close(bodyfile); skip=1; next }
  skip && $0 == e { skip=0; next }
  !skip { print }
' "$DOC" > "$TMP"

if [ "${1:-}" = "--check" ]; then
  if diff -q "$DOC" "$TMP" >/dev/null; then
    echo "✓ 최신입니다 ($DOC)"
  else
    echo "✖ 갱신이 필요합니다 — bash scripts/gen-test-map.sh 를 돌리세요" >&2
    diff -u "$DOC" "$TMP" | head -30 >&2
    exit 1
  fi
else
  mv "$TMP" "$DOC"
  echo "✓ 갱신 완료 — $DOC ('안 보는 것' 절은 그대로 두었습니다)"
fi
