#!/usr/bin/env bash
# snapshot-team.sh 의 제외 목록이 ★구획별로 다른지★ 실제 rsync 를 돌려서 잰다.
#
# 왜 rsync 를 실제로 돌리나: 배열을 눈으로 비교하면 "--exclude 가 있다/없다"만 보이고,
#   그게 ★실제로 무엇을 걸러내는지★는 안 보인다. rsync 의 패턴 해석(디렉토리 vs 파일,
#   앵커링)까지 포함해서 결과물을 봐야 검사와 변경이 같은 축에 선다.
#
# 정의는 snapshot-team.sh 에서 ★그대로 뽑아 쓴다★ — 여기에 복사해두면 원본이 바뀔 때 조용히 어긋난다.
#
# 사용: bash scripts/snapshot-excludes.test.sh
set -uo pipefail
cd "$(dirname "$0")/.."
SRC="${SNAPSHOT_SRC:-scripts/snapshot-team.sh}"   # 옛 버전 대조용으로 바꿔 끼울 수 있다
[ -f "$SRC" ] || { echo "✗ $SRC 없음"; exit 1; }

# 제외 배열 정의 블록만 뽑아서 평가 (원본과 단일 출처 유지)
# ★첫 EX_ 배열부터 EX_HERMES 끝까지★ — 시작 이름을 EX_BASE 로 못박으면 구조가 다른 옛 버전에서
#   "블록 없음"으로 끝나버려서, 정작 재려던 .git 축을 못 재고 통과/실패가 뒤집힌다.
BLOCK="$(awk "/^EX_(BASE|COMMON)=\(/{p=1} p{print} /--exclude='skills'\)/{if(p)exit}" "$SRC")"
[ -n "$BLOCK" ] || { echo "✗ 제외 배열 블록을 못 찾았다 — snapshot-team.sh 구조가 바뀌었나"; exit 1; }
eval "$BLOCK"

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
FAIL=0
ok(){   printf '  ✓ %s\n' "$1"; }
bad(){  printf '  ✗ %s\n' "$1"; FAIL=$((FAIL+1)); }

# 가짜 워크스페이스 — 팀원 폴더가 실제로 갖는 것들
mk_ws(){
  local w="$1"; rm -rf "$w"; mkdir -p "$w"
  mkdir -p "$w/.git/objects" "$w/node_modules/x" "$w/backups/old" "$w/reports" "$w/decks"
  echo commit    > "$w/.git/HEAD"
  echo obj       > "$w/.git/objects/deadbeef"
  echo dep       > "$w/node_modules/x/index.js"
  echo stale     > "$w/backups/old/a.txt"
  echo 작업물    > "$w/MEMORY.md"
  echo 보고서    > "$w/reports/r.md"
  echo 덱        > "$w/decks/d.html"
  echo 로그      > "$w/run.log"
}

run_rsync(){  # $1=dest $2...=excludes
  local dest="$1"; shift
  rm -rf "$dest"; mkdir -p "$dest"
  rsync -a "$@" "$T/ws" "$dest/" 2>/dev/null
}

has(){ [ -e "$T/$1/ws/$2" ]; }

echo "■ snapshot-team.sh 제외 목록 — 구획별 동작"

mk_ws "$T/ws"

# ① 멤버 워크스페이스: .git 은 담고, 재생성물은 뺀다
run_rsync "$T/out-member" "${EX_MEMBER[@]}"
has out-member .git/objects/deadbeef && ok "멤버: .git 담긴다 (커밋 히스토리 보존)" \
                                     || bad "멤버: .git 이 빠졌다 — 파일만 복구되고 이력은 사라진다"
has out-member MEMORY.md      && ok "멤버: 작업물 MEMORY.md 담긴다"      || bad "멤버: MEMORY.md 가 빠졌다"
has out-member reports/r.md   && ok "멤버: reports 담긴다(작업물)"        || bad "멤버: reports 가 빠졌다"
has out-member decks/d.html   && ok "멤버: decks 담긴다(작업물)"          || bad "멤버: decks 가 빠졌다"
has out-member node_modules/x/index.js && bad "멤버: node_modules 가 담겼다(재생성물)" \
                                       || ok "멤버: node_modules 제외된다"
has out-member backups/old/a.txt       && bad "멤버: backups 가 담겼다(중복)" \
                                       || ok "멤버: backups 제외된다"
has out-member run.log                 && bad "멤버: *.log 가 담겼다" || ok "멤버: *.log 제외된다"

# ② 트리·hermes 구획: .git 은 계속 뺀다 (원격에 있고, 크다)
run_rsync "$T/out-tree" "${EX_TREE[@]}"
has out-tree .git/objects/deadbeef && bad "트리: .git 이 담겼다 — 원격에 있는 것을 중복 백업한다" \
                                  || ok "트리: .git 제외 유지"
run_rsync "$T/out-hermes" "${EX_HERMES[@]}"
has out-hermes .git/objects/deadbeef && bad "hermes: .git 이 담겼다" || ok "hermes: .git 제외 유지"
has out-hermes reports/r.md          && bad "hermes: reports 가 담겼다(재생성물)" || ok "hermes: reports 제외 유지"

# ③ ★뮤턴트★ — EX_MEMBER 에 .git 제외가 되돌아오면 ①이 반드시 깨져야 한다.
#    이게 안 깨지면 위 검사는 아무것도 안 재고 있는 것이다.
MUT=("${EX_MEMBER[@]}" --exclude='.git')
run_rsync "$T/out-mutant" "${MUT[@]}"
has out-mutant .git/objects/deadbeef && bad "뮤턴트: .git 제외를 되살렸는데도 담겼다 — 검사가 무력하다" \
                                     || ok "뮤턴트: .git 제외 복구 시 ①이 깨진다(검사 유효)"

echo
if [ "$FAIL" -eq 0 ]; then echo "✅ 통과"; else echo "❌ 실패 ${FAIL}건"; fi
exit "$FAIL"
