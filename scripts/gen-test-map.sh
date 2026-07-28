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

# ★마커 검증 — BEGIN·END 각각 정확히 1개 (2026-07-29, steve 리뷰에서 재현된 사고)★
#   ★END 를 검사하지 않으면 이 스크립트가 손으로 쓴 절을 조용히 지운다.★
#   실측: END 에 하이픈 하나만 더해도(`-->` → `--->`) awk 의 skip 이 영원히 안 풀려
#   ★BEGIN 이후 전부 삭제★ 되고, 그러면서 종료코드 0 에 "'안 보는 것' 절은 그대로 두었습니다" 를 출력했다.
#   ★성공했다고 말하면서 지운다★ — 이 문서가 다루려는 사고 유형 그 자체다.
#   BEGIN 이 2개여도 생성 블록이 둘로 갈라지므로 개수까지 본다.
nb="$(grep -cF "$BEGIN" "$DOC" || true)"
ne="$(grep -cF "$END"   "$DOC" || true)"
if [ "$nb" != "1" ] || [ "$ne" != "1" ]; then
  echo "ERROR: 생성 구간 표시가 정확히 1쌍이어야 합니다 (BEGIN=${nb}개, END=${ne}개)." >&2
  echo "  BEGIN: $BEGIN" >&2
  echo "  END  : $END" >&2
  echo "  ★한 글자라도 다르면 이 스크립트가 손으로 쓴 절을 지웁니다 — 그래서 여기서 멈춥니다.★" >&2
  exit 2
fi

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

# 최상위 describe 를 뽑는다(중첩은 세부라 목록이 길어지기만 한다).
#
# ★describe 가 없는 파일도 반드시 싣는다 (2026-07-29, steve 리뷰)★
#   이전 판은 `^describe("` 에 안 걸리는 파일을 ★통째로 빼버렸다★ — 155개 중 19개(12%).
#   그중 personaTemplates.test.ts 는 테스트가 36개인데 지도에서 안 보였다.
#   ★이게 이 문서의 목적과 정면으로 어긋난다★ — 지도에 없는 영역을 읽는 사람은
#   "여긴 테스트가 없구나" 로 읽는다. ★없는 것보다 나쁜 게, 있는데 없다고 보이는 것이다.★
#   완벽히 뽑을 필요는 없다. ★빠졌다는 사실이 보이면 된다.★
LAST_AREA=""
find src -name '*.test.ts' -type f 2>/dev/null | sort | while read -r f; do
  a="$(area_of "$f")"
  if [ "$a" != "$LAST_AREA" ]; then printf '\n### %s\n\n' "$a"; LAST_AREA="$a"; fi
  # ★'-' 로 시작하는 형식문자열은 printf 가 옵션으로 읽는다★ — `--` 로 끊어준다.
  printf -- '- `%s`\n' "$f"
  names="$(grep -hoE '^describe\("[^"]+"' "$f" 2>/dev/null | sed 's/^describe("//; s/"$//' || true)"
  if [ -n "$names" ]; then
    # 따옴표·파이프는 표를 깨뜨리므로 그대로 두되 목록으로만 낸다.
    printf '%s\n' "$names" | sed 's/^/  - /'
  else
    n="$(grep -cE '^[[:space:]]*(test|it)\(' "$f" 2>/dev/null || true)"
    printf -- '  - _(최상위 describe 없음 — test/it %s개. 이름은 파일에서 확인하세요)_\n' "${n:-0}"
  fi
done >> "$TMP.body"

printf '\n%s\n' "$END" >> "$TMP.body"

# ★자기검사 — 테스트 파일이 하나라도 지도에서 빠지면 여기서 멈춘다★
#   이전 판은 19개를 ★말없이★ 빠뜨렸고, 아무 신호도 없어서 리뷰어가 직접 세어보고서야 찾았다.
#   추출 규칙을 다음에 누가 바꿔도 ★같은 누락이 조용히 재발하지 않게★ 개수를 맞춰본다.
found="$(find src -name '*.test.ts' -type f 2>/dev/null | wc -l | tr -d ' ')"
listed="$(grep -cE '^- `src/.*\.test\.ts`$' "$TMP.body" || true)"
if [ "$found" != "$listed" ]; then
  echo "ERROR: 테스트 파일 $found 개 중 지도에 실린 것이 $listed 개입니다 — ★말없이 빠진 파일이 있습니다.★" >&2
  echo "  빠진 파일:" >&2
  find src -name '*.test.ts' -type f | sort | while read -r m; do
    grep -qF -- "- \`$m\`" "$TMP.body" || echo "    $m" >&2
  done
  exit 3
fi

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
