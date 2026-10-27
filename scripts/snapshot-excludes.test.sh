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
  mkdir -p "$w/.git/objects" "$w/node_modules/x" "$w/backups/old" "$w/reports" "$w/decks" "$w/src" "$w/docs"
  echo commit    > "$w/.git/HEAD"
  echo obj       > "$w/.git/objects/deadbeef"
  echo dep       > "$w/node_modules/x/index.js"
  echo stale     > "$w/backups/old/a.txt"
  echo 기억      > "$w/MEMORY.md"
  echo 규칙      > "$w/CLAUDE.md"
  echo 영혼      > "$w/SOUL.md"
  echo 로그      > "$w/run.log"
  echo 보고서    > "$w/reports/r.md"
  echo 덱        > "$w/decks/d.html"
  echo 코드      > "$w/src/a.ts"
  echo 문서      > "$w/docs/guide.md"
  mkdir -p "$w/.claude/agents" "$w/.claude/worktrees/x" "$w/memory" "$w/artifacts/r1/video"
  echo '{}'      > "$w/.claude/settings.local.json"
  echo agent     > "$w/.claude/agents/a.md"
  echo wt        > "$w/.claude/worktrees/x/file.ts"
  echo 하루      > "$w/memory/2026-10-27.md"
  echo mov       > "$w/artifacts/r1/video/capture.mov"
}

run_rsync(){  # $1=dest $2...=excludes
  local dest="$1"; shift
  rm -rf "$dest"; mkdir -p "$dest"
  rsync -a "$@" "$T/ws" "$dest/" 2>/dev/null
}

has(){ [ -e "$T/$1/ws/$2" ]; }

echo "■ snapshot-team.sh 제외 목록 — 구획별 동작"

mk_ws "$T/ws"

# ① 멤버 워크스페이스: 규칙·설정·기억만 담고, 코드·작업물·.git 은 뺀다 (작업은 GitHub 에 있다)
run_rsync "$T/out-member" "${EX_MEMBER[@]}"
has out-member MEMORY.md                  && ok "멤버: MEMORY.md 담긴다"            || bad "멤버: MEMORY.md 가 빠졌다"
has out-member CLAUDE.md                  && ok "멤버: CLAUDE.md 담긴다"            || bad "멤버: CLAUDE.md 가 빠졌다"
has out-member SOUL.md                    && ok "멤버: SOUL.md 담긴다"              || bad "멤버: SOUL.md 가 빠졌다"
has out-member .claude/settings.local.json && ok "멤버: .claude 설정 담긴다"         || bad "멤버: .claude 설정이 빠졌다"
has out-member .claude/agents/a.md        && ok "멤버: .claude/agents 담긴다"       || bad "멤버: .claude/agents 가 빠졌다"
has out-member memory/2026-10-27.md       && ok "멤버: memory/ 일별 기억 담긴다"     || bad "멤버: memory/ 가 빠졌다"
has out-member .claude/worktrees/x/file.ts && bad "멤버: .claude/worktrees 가 담겼다" || ok "멤버: .claude/worktrees 제외된다"
has out-member .git/objects/deadbeef      && bad "멤버: .git 이 담겼다"             || ok "멤버: .git 제외된다(GitHub 에 있다)"
has out-member src/a.ts                   && bad "멤버: 코드가 담겼다"              || ok "멤버: 코드 제외된다"
has out-member docs/guide.md              && bad "멤버: 하위 폴더 .md 가 담겼다"     || ok "멤버: 하위 폴더 문서 제외된다(맨 위 .md 만)"
has out-member reports/r.md               && bad "멤버: reports 가 담겼다"          || ok "멤버: reports 제외된다"
has out-member artifacts/r1/video/capture.mov && bad "멤버: artifacts 가 담겼다"    || ok "멤버: artifacts 제외된다"
has out-member node_modules/x/index.js    && bad "멤버: node_modules 가 담겼다"     || ok "멤버: node_modules 제외된다"
has out-member run.log                    && bad "멤버: *.log 가 담겼다"            || ok "멤버: *.log 제외된다"
# ② 트리·hermes 구획: .git 은 계속 뺀다 (원격에 있고, 크다)
run_rsync "$T/out-tree" "${EX_TREE[@]}"
has out-tree .git/objects/deadbeef && bad "트리: .git 이 담겼다 — 원격에 있는 것을 중복 백업한다" \
                                  || ok "트리: .git 제외 유지"
run_rsync "$T/out-hermes" "${EX_HERMES[@]}"
has out-hermes .git/objects/deadbeef && bad "hermes: .git 이 담겼다" || ok "hermes: .git 제외 유지"
has out-hermes reports/r.md          && bad "hermes: reports 가 담겼다(재생성물)" || ok "hermes: reports 제외 유지"

# ③ ★뮤턴트★ — EX_MEMBER 끝의 --exclude='*' 가 빠지면 ①의 "코드 제외"가 반드시 깨져야 한다.
#    이게 안 깨지면 위 검사는 아무것도 안 재고 있는 것이다.
MUT=(); for x in "${EX_MEMBER[@]}"; do [ "$x" = "--exclude=*" ] || MUT+=("$x"); done
run_rsync "$T/out-mutant" "${MUT[@]}"
has out-mutant src/a.ts && ok "뮤턴트: 마지막 제외를 빼면 코드가 담긴다(검사 유효)" \
                        || bad "뮤턴트: 마지막 제외를 뺐는데도 코드가 빠졌다 — 검사가 무력하다"

# ④ 기기밖(iCloud) 정리 — 폴더 바로 아래의 일반 파일 중 정확한 이름만, 최신 N개를 남기고 지운다.
P="$T/cloud"; mkdir -p "$P/b3os-snapshot-00000000-000000.tar.gz" "$P/sub"
echo x > "$P/b3os-snapshot-00000000-000000.tar.gz/unrelated.txt"; echo v > "$T/victim.txt"
for n in 20261020 20261021 20261022 20261023; do echo s > "$P/b3os-snapshot-$n-035000.tar.gz"; done
ln -s "$T/victim.txt" "$P/b3os-snapshot-20200101-000000.tar.gz"
echo s > "$P/sub/b3os-snapshot-20190101-000000.tar.gz"; echo s > "$P/b3os-snapshot-20261024-035000.tar.gz.part"
python3 scripts/snapshot-cloud-prune.py "$P" 3 >/dev/null
[ -e "$P/b3os-snapshot-20261020-035000.tar.gz" ] && bad "기기밖: 오래된 스냅샷이 남았다" || ok "기기밖: 최신 3개 밖의 스냅샷 지운다"
[ -e "$P/b3os-snapshot-20261021-035000.tar.gz" ] && ok "기기밖: 최신 3개 남는다" || bad "기기밖: 남길 스냅샷을 지웠다"
[ -e "$P/b3os-snapshot-00000000-000000.tar.gz/unrelated.txt" ] && ok "기기밖: 같은 이름 폴더는 건드리지 않는다" || bad "기기밖: 같은 이름 폴더 안을 지웠다"
[ -e "$T/victim.txt" ] && [ -L "$P/b3os-snapshot-20200101-000000.tar.gz" ] && ok "기기밖: 링크는 건드리지 않는다" || bad "기기밖: 링크(또는 대상)를 지웠다"
[ -e "$P/sub/b3os-snapshot-20190101-000000.tar.gz" ] && [ -e "$P/b3os-snapshot-20261024-035000.tar.gz.part" ] \
  && ok "기기밖: 하위 폴더·다른 이름은 건드리지 않는다" || bad "기기밖: 하위 폴더나 다른 이름을 지웠다"
python3 scripts/snapshot-cloud-prune.py "$P" 0 2>/dev/null && bad "기기밖: 남길 개수 0 을 받았다" || ok "기기밖: 남길 개수 0 은 거부한다"

echo
if [ "$FAIL" -eq 0 ]; then echo "✅ 통과"; else echo "❌ 실패 ${FAIL}건"; fi
exit "$FAIL"
