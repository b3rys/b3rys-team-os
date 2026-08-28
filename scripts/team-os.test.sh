#!/usr/bin/env bash
# team-os.test.sh — team-os 진입 동작 인수 테스트.
#
# ★왜 이 시험이 있나★ (2026-07-30, 팀장님 지적)
#   `team-os` 를 인자 없이 치면 ★곧바로 up 이 실행됐다.★ 기본값이 up 이었다.
#   처음 쓰는 사람이 이름만 쳐보는 건 가장 흔한 첫 동작인데, 그 자리에서 설명 대신
#   서비스 기동이 시작되고 20초를 기다린다. 공개 사용자에게는 그게 첫인상이다.
#
# ★이 시험은 부작용이 없어야 한다★ — 진짜 up 을 돌리면 시험이 팀을 건드린다.
#   그래서 launchctl·curl·tmux 를 stub 으로 가리고 PATH 앞에 둔다. 하나라도 불리면
#   그 사실 자체를 기록해 실패시킨다 — "안 불렸겠지" 를 짐작하지 않는다.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HERE/../bin/team-os"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

STUB="$TMP/bin"; mkdir -p "$STUB"
CALLS="$TMP/calls.log"; : > "$CALLS"
for cmd in launchctl curl tmux; do
  cat > "$STUB/$cmd" <<EOF
#!/bin/sh
echo "$cmd \$*" >> "$CALLS"
exit 0
EOF
  chmod +x "$STUB/$cmd"
done

FAILED=0
ok()   { echo "  ✓ $1"; }
bad()  { echo "  ✗ $1"; FAILED=1; }

run() { # run <인자...> → stdout+stderr, 종료코드는 RC 에
  : > "$CALLS"
  OUT="$(PATH="$STUB:$PATH" bash "$TARGET" "$@" 2>&1)"; RC=$?
}

echo "── T1: 인자 없이 치면 설명이 나오고 ★아무것도 안 건드린다★ ──"
run
[ "$RC" -eq 0 ] && ok "종료코드 0 (설명을 본 것은 잘못이 아니다)" || bad "종료코드 $RC (0이어야 한다)"
case "$OUT" in *"사용법: team-os"*) ok "설명 출력됨" ;; *) bad "설명이 안 나왔다" ;; esac
case "$OUT" in *"■ 올립니다"*) bad "★up 이 실행됐다★ — 이 시험이 존재하는 이유" ;; *) ok "up 이 실행되지 않았다" ;; esac
if [ -s "$CALLS" ]; then
  bad "★부작용 발생★ — 외부 명령이 불렸다: $(tr '\n' ';' < "$CALLS")"
else
  ok "launchctl·curl·tmux 를 하나도 부르지 않았다"
fi

echo "── T2: help · -h · --help 전부 같은 설명 ──"
for a in help -h --help; do
  run "$a"
  [ "$RC" -eq 0 ] || bad "$a: 종료코드 $RC"
  case "$OUT" in *"사용법: team-os"*) ok "$a → 설명" ;; *) bad "$a → 설명이 안 나왔다" ;; esac
  [ -s "$CALLS" ] && bad "$a: 부작용 발생"
done

echo "── T3: 모르는 명령은 실패로 끝난다 (조용히 넘어가지 않는다) ──"
run wat
[ "$RC" -eq 1 ] && ok "종료코드 1" || bad "종료코드 $RC (1이어야 한다)"
case "$OUT" in *"모르는 명령입니다: wat"*) ok "무엇이 잘못됐는지 말한다" ;; *) bad "친 명령을 안 알려준다" ;; esac
case "$OUT" in *"사용법: team-os"*) ok "설명도 같이 나온다" ;; *) bad "설명이 없다" ;; esac
[ -s "$CALLS" ] && bad "부작용 발생"

echo "── T4: 설명은 ★한 곳에서만★ 나온다 (두 벌이면 한쪽만 고쳐진다) ──"
n="$(grep -c 'usage()' "$TARGET")"
[ "$n" -eq 1 ] && ok "usage 정의 1개" || bad "usage 정의가 $n 개"
if grep -q 'echo "사용법: team-os up | team-os doctor | team-os down"' "$TARGET"; then
  bad "옛 인라인 설명이 남아 있다 — usage 와 갈라진다"
else
  ok "인라인 중복 설명 없음"
fi

echo "── T5: up 은 ★팀 서버를 먼저★ 켠다 (알파벳순이면 봇이 먼저 뜬다) ──"
# ★이름 목록을 세지 않는다.★ 새 팀원 plist 를 하나 만들어 넣고,
#   그 팀원이 대상에 들어오면서 ★서버 뒤★ 에 오는지를 본다.
#   개수를 상수로 박으면 그 시험은 오늘만 맞다 (steve 지적).
T5H="$TMP/home5"; mkdir -p "$T5H/Library/LaunchAgents"
mk_plist() { # mk_plist <라벨> <본문에 넣을 저장소경로>
  cat > "$T5H/Library/LaunchAgents/$1.plist" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>RunAtLoad</key><true/>
  <key>ProgramArguments</key><array><string>$2/bin/dummy</string></array>
</dict></plist>
XML
}
T5REPO="$TMP/repo5"; mkdir -p "$T5REPO/src/server"; : > "$T5REPO/package.json"
mk_plist "com.test.aaa-first-alphabetically" "$T5REPO"
mk_plist "com.test.team-collab"              "$T5REPO"
mk_plist "com.test.claude-telegram-newbie"   "$T5REPO"   # ← 오늘 없던 팀원

ORDER="$(HOME="$T5H" TEAM_OS_REPO="$T5REPO" TEAMOS_LIB_ONLY=1          bash -c 'source "'"$TARGET"'"; boot_services_ordered | cut -d"|" -f1')"

case "$(printf '%s\n' "$ORDER" | head -1)" in
  *team-collab*) ok "팀 서버가 맨 앞이다" ;;
  *) bad "팀 서버가 맨 앞이 아니다 — 실제 순서: $(printf '%s' "$ORDER" | tr '\n' ' ')" ;;
esac

printf '%s\n' "$ORDER" | grep -q 'claude-telegram-newbie' \
  && ok "목록에 없던 새 팀원도 대상에 들어온다" \
  || bad "새 팀원이 빠졌다 — 이름을 박아둔 것이다"

SRV_N="$(printf '%s\n' "$ORDER" | grep -n 'team-collab' | cut -d: -f1)"
NEW_N="$(printf '%s\n' "$ORDER" | grep -n 'claude-telegram-newbie' | cut -d: -f1)"
if [ -n "$SRV_N" ] && [ -n "$NEW_N" ] && [ "$SRV_N" -lt "$NEW_N" ]; then
  ok "새 팀원은 서버보다 뒤다"
else
  bad "새 팀원이 서버보다 앞이다 (서버 ${SRV_N} · 팀원 ${NEW_N})"
fi

echo "── T6: ★up 이 실제로 그 순서를 쓰는지★ (함수만 고치고 배선을 안 하면 여기서 걸린다) ──"
# T5 는 boot_services_ordered 를 직접 부른다. 그래서 up 이 옛 열거를 쓰도록 되돌려도 T5 는 통과한다.
#   실제로 그 뮤턴트를 넣어보니 T5 가 살아남았다. 그래서 up 을 돌려서 처리 순서를 본다.
#   가짜 HOME·가짜 저장소·stub launchctl 이라 실제 서비스는 건드리지 않는다.
UPOUT="$(HOME="$T5H" TEAM_OS_REPO="$T5REPO" PATH="$STUB:$PATH" bash "$TARGET" up 2>&1)"

UP_SRV="$(printf '%s\n' "$UPOUT" | grep -n 'team-collab' | head -1 | cut -d: -f1)"
UP_NEW="$(printf '%s\n' "$UPOUT" | grep -n 'claude-telegram-newbie' | head -1 | cut -d: -f1)"

if [ -z "$UP_SRV" ] || [ -z "$UP_NEW" ]; then
  bad "up 출력에 서버나 새 팀원이 안 보인다 — 순서를 잴 수 없다"
elif [ "$UP_SRV" -lt "$UP_NEW" ]; then
  ok "up 이 서버를 새 팀원보다 먼저 처리한다"
else
  bad "up 이 새 팀원을 서버보다 먼저 처리한다 (서버 ${UP_SRV}번째 · 팀원 ${UP_NEW}번째)"
fi

echo
if [ "$FAILED" -eq 0 ]; then echo "ALL PASS — team-os 진입 동작"; else echo "FAIL — team-os 진입 동작"; fi
exit "$FAILED"
