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

TMP="$(mktemp)"; trap 'rm -f "$TMP" "$TMP.body" "$TMP.nodesc"' EXIT

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
    echo "$f" >> "$TMP.nodesc"   # 기준선 대조용 (아래 자기검사)
  fi
done >> "$TMP.body"

printf '\n%s\n' "$END" >> "$TMP.body"

# ★자기검사 — '이름을 못 뽑은 파일' 이 늘어나면 멈춘다★
#
#   ★이 검사는 한 번 무력화된 적이 있다 (2026-07-29, steve 리뷰).★
#   처음엔 '파일 개수'(found vs listed)를 봤다. 그런데 같은 PR 의 다른 수정으로
#   ★describe 가 없어도 파일은 항상 싣게★ 되면서 listed == found 가 ★항상 참★ 이 됐다 —
#   ★검사가 설계상 실패할 수 없는 상태★ 였다. 그런데도 PR 검증란에는 "추출규칙 파손 → ERROR"
#   라고 적혀 있었다. ★감시기가 자기가 요구하는 신호를 못 보고 있었다.★
#
#   그래서 재는 대상을 바꿨다: 개수가 아니라 ★'이름을 못 뽑은 파일의 목록'★ 이다.
#   추출이 나빠지면 그 목록이 늘어나고, ★늘어난 이름을 찍고 멈춘다.★
#   목록을 늘리려면 기준선 파일을 ★고의로★ 고쳐야 하므로 리뷰에 걸린다.
#
#   ★이 검사가 잡는 것과 못 잡는 것 (실측)★ — 여기를 부풀리면 같은 사고를 반복한다:
#     · 파일이 이름을 ★전부★ 잃음 → ★이 검사가 잡는다★ (exit 3, 파일명 출력)
#     · 파일이 이름을 ★일부만★ 잃음 → ★이 검사는 못 잡는다.★ 대신 지도가 리포에 커밋돼 있어서
#       `--check` 가 diff 로 잡는다(exit 1). 그래서 pre-push 훅에 `--check` 를 거는 게 맞다.
#     · 마커 파손 → 위 마커 검증이 잡는다 (exit 2, 손으로 쓴 절 보존)
BASELINE="scripts/test-map-nodescribe.txt"
touch "$TMP.nodesc"
if [ ! -f "$BASELINE" ]; then
  echo "ERROR: 기준선 파일이 없습니다: $BASELINE" >&2
  echo "  현재 '이름을 못 뽑은' 파일 목록으로 만들려면:" >&2
  echo "    sort -u '$TMP.nodesc' > '$BASELINE'   # (경로가 임시라 직접 다시 생성하세요)" >&2
  exit 3
fi
NEW="$(sort -u "$TMP.nodesc" | comm -23 - <(grep -vE '^\s*(#|$)' "$BASELINE" | sort -u) || true)"
if [ -n "$NEW" ]; then
  echo "ERROR: ★이름을 못 뽑은 테스트 파일이 늘었습니다★ — 추출이 나빠졌거나, 새 파일이 최상위 describe 없이 쓰였습니다." >&2
  printf '%s\n' "$NEW" | sed 's/^/    /' >&2
  echo "  고칠 방법 둘 중 하나:" >&2
  echo "    · 그 파일에 최상위 describe 를 준다(권장 — 지도에 이름이 실린다)" >&2
  echo "    · 정말 예외면 $BASELINE 에 추가한다(리뷰에서 이유를 묻게 된다)" >&2
  exit 3
fi
GONE="$(grep -vE '^\s*(#|$)' "$BASELINE" | sort -u | comm -23 - <(sort -u "$TMP.nodesc") || true)"
if [ -n "$GONE" ]; then
  echo "참고: 아래 파일은 이제 이름이 뽑힙니다 — $BASELINE 에서 지워도 됩니다(줄어드는 건 좋은 일입니다)." >&2
  printf '%s\n' "$GONE" | sed 's/^/    /' >&2
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
