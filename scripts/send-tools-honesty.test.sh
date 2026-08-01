#!/usr/bin/env bash
# send.sh --body-file / slack-post.sh 멘션 경고 인수테스트.
#
# 무엇을 막나 (2026-07-30 실측, 하루에 4건):
#   · 버스 본문의 백틱이 셸 명령치환돼 ★그 구절이 조용히 사라졌다★ — send 는 성공으로 떴다
#   · 버스 본문의 홑따옴표가 문자열을 끊어 인자 파싱 오류로 죽었다 (죽어서 오히려 알아챌 수 있었다)
#   · 슬랙 게시글 4건이 멘션 없이 올라가 ★아무에게도 알림이 가지 않았다★ — '✓ posted' 는 찍혔다
#   전부 "실패가 성공으로 보인다" 한 계열이다.
#
# 이 테스트는 ★서버를 필요로 하지 않는 부분만★ 본다(인자 검증·본문 보존·경고 조건).
#   실제 전송·배달 판정은 src/server/routes/inbox.messageRecipients.test.ts 와
#   send.sh --confirm 수동 확인이 담당한다(서버 기동 필요).
# 실행: scripts/send-tools-honesty.test.sh   (0=통과, 1=실패)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
SEND="$REPO/skills/b3os-team-inbox/scripts/send.sh"
SLACK="$REPO/skills/b3os-team-inbox/scripts/slack-post.sh"
for f in "$SEND" "$SLACK"; do [ -f "$f" ] || { echo "FAIL: 없음 $f"; exit 1; }; done

FAILED=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ★신원을 격리해서 명시한다★ — _me.sh 는 ★현재 폴더 ↔ team.db★ 로 발신자를 판별한다. worktree 에서
#   돌리면 판별에 실패하고 스크립트가 curl 전에 죽는다. 그러면 "경고가 안 나왔다" 같은 ★부정 단정이
#   전부 거짓 통과★ 한다(죽어서 출력이 없으니 grep 이 못 찾는다). 실제로 첫 실행에서 그렇게 통과했다.
#   해결: 최소 registry 를 임시 DB 에 만들고 TEAM_DB_PATH 로 가리킨다.
#   ★실 team.db 를 읽지 않는다★ (infra-safety ④) — 테스트는 실 파일시스템을 건드리지 않는다.
export TEAM_DB_PATH="$TMP/registry.db"
sqlite3 "$TEAM_DB_PATH" "CREATE TABLE agent (id TEXT PRIMARY KEY, tmux_session TEXT, workspace_path TEXT);
                         INSERT INTO agent (id, tmux_session, workspace_path) VALUES ('jane','claude-jane','$TMP/ws');" 2>/dev/null
export GD_AGENT_ID=jane
# 준비단계 가드 — 신원 해석이 실제로 되는지 먼저 확인한다. 안 되면 이후 단정이 전부 무의미하다.
if [ "$("$REPO/skills/b3os-team-inbox/scripts/_me.sh" 2>/dev/null)" = "jane" ]; then
  pass "신원 해석 준비됨 (격리 registry)"
else
  fail "신원 해석이 안 된다 — 이후 단정은 신뢰할 수 없다"
  echo "FAILED — send tools honesty"; exit 1
fi

# ★셸이 해석하면 훼손되는 문자를 전부 담은 픽스처★
#   백틱 · 홑따옴표 · $(cmd) · $VAR · 여러 줄 · ★ · 리터럴 \n (이건 펴지면 안 된다)
FIX="$TMP/body.txt"
{
  printf '%s\n' '백틱 `echo HACKED` 는 그대로 남아야 한다'
  printf '%s\n' "홑따옴표 ' 하나가 있어도 죽지 않아야 한다"
  printf '%s\n' '명령치환 $(echo HACKED) 도 문자 그대로'
  printf '%s\n' '변수 $HOME 과 ${PATH} 도 확장되지 않는다'
  printf '%s\n' '리터럴 백슬래시-n: a\nb  ← 이건 펴지면 안 된다'
  printf '%s\n' '★ 유니코드 · 여러 줄'
} > "$FIX"

echo "── A1-1: --body 와 --body-file 동시 지정은 거절 ──"
out="$("$SEND" --to lisa --body "x" --body-file "$FIX" 2>&1)"; rc=$?
[ $rc -ne 0 ] && pass "거절됨 (exit $rc)" || fail "동시 지정을 통과시켰다"
grep -q "동시에" <<<"$out" && pass "사유 설명 있음" || fail "사유 설명 없음: $out"

echo "── A1-2: 없는 파일은 에러로 죽는다 (빈 본문으로 조용히 보내지 않는다) ──"
out="$("$SEND" --to lisa --body-file "$TMP/nope.txt" 2>&1)"; rc=$?
[ $rc -ne 0 ] && pass "죽었다 (exit $rc)" || fail "없는 파일인데 계속 진행했다"
grep -qE "없습니다|경로" <<<"$out" && pass "경로 문제를 알려준다" || fail "메시지 불명확: $out"

echo "── A1-3: 빈 파일도 에러 ──"
: > "$TMP/empty.txt"
out="$("$SEND" --to lisa --body-file "$TMP/empty.txt" 2>&1)"; rc=$?
[ $rc -ne 0 ] && pass "빈 파일 거절 (exit $rc)" || fail "빈 본문으로 보내려 했다"

echo "── A1-4: 디렉토리를 주면 에러 ──"
out="$("$SEND" --to lisa --body-file "$TMP" 2>&1)"; rc=$?
[ $rc -ne 0 ] && pass "디렉토리 거절 (exit $rc)" || fail "디렉토리를 본문으로 읽으려 했다"

echo "── A1-5: ★본문이 문자 단위로 보존되는가★ (핵심) ──"
# 서버 없이 검증하려면 페이로드 생성까지만 돌려야 한다 → curl 을 가짜로 바꿔 POST 를 가로챈다.
FAKEBIN="$TMP/bin"; mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/curl" <<'STUB'
#!/usr/bin/env bash
# -d 다음 인자가 JSON 페이로드다. 그걸 파일로 떨어뜨리고 성공 응답을 흉내낸다.
prev=""
for a in "$@"; do
  if [ "$prev" = "-d" ]; then printf '%s' "$a" > "$CAPTURE"; fi
  prev="$a"
done
printf '{"ok":true,"message":{"id":"testid","thread_id":"t","hop_count":0}}'
STUB
chmod +x "$FAKEBIN/curl"
export CAPTURE="$TMP/payload.json"
PATH="$FAKEBIN:$PATH" "$SEND" --to lisa --body-file "$FIX" >/dev/null 2>&1
if [ -s "$CAPTURE" ]; then
  if CAPTURE="$CAPTURE" FIX="$FIX" python3 - <<'PY'
import json, os, sys
sent = json.load(open(os.environ["CAPTURE"]))["body"]
want = open(os.environ["FIX"], encoding="utf-8").read()
if want.endswith("\n"): want = want[:-1]   # 끝 개행 1개 절삭은 규격
if sent == want:
    sys.exit(0)
print("  전송된 본문이 파일과 다르다", file=sys.stderr)
for i,(a,b) in enumerate(zip(sent, want)):
    if a != b:
        print(f"    첫 불일치 {i}: 전송={a!r} 파일={b!r}", file=sys.stderr); break
print(f"    길이 전송={len(sent)} 파일={len(want)}", file=sys.stderr)
sys.exit(1)
PY
  then pass "파일 내용과 문자 단위로 동일 (백틱·홑따옴표·\$(cmd)·\$VAR·리터럴 \\n 전부 원문 보존)"
  else fail "본문이 훼손됐다"
  fi
  grep -q "HACKED" "$CAPTURE" && pass "명령치환이 실행되지 않았다(문자로 남음)" \
                              || fail "HACKED 가 사라졌다 = 셸이 실행해버렸다"
else
  fail "페이로드를 잡지 못했다(테스트 하네스 문제 — 아래 단정은 신뢰할 수 없다)"
fi

echo "── A1-6: --all-hands 는 사유를 명시 필드로 싣고 이전 표기는 옵션으로 받지 않는다 ──"
PATH="$FAKEBIN:$PATH" "$SEND" --to broadcast --body "공지" --all-hands "서비스 점검" >/dev/null 2>&1
CAPTURE="$CAPTURE" python3 - <<'PY' \
  && pass "all_hands 사유가 페이로드에 실림" \
  || fail "all_hands 사유가 페이로드에 없음"
import json, os, sys
p = json.load(open(os.environ["CAPTURE"]))
sys.exit(0 if p.get("all_hands") == "서비스 점검" and "notice" not in p and "@all" not in p.get("body", "") else 1)
PY
out="$(PATH="$FAKEBIN:$PATH" "$SEND" --to broadcast --body "공지" --공지 "전원 확인 필요" 2>&1)"; rc=$?
[ $rc -ne 0 ] && grep -q 'unknown arg: --공지' <<<"$out" \
  && pass "--공지 는 unknown arg 로 크게 실패" \
  || fail "--공지 를 조용히 받거나 오류가 불명확함: $out"
out="$(PATH="$FAKEBIN:$PATH" "$SEND" --to broadcast --body "공지" --notice "전원 확인 필요" 2>&1)"; rc=$?
[ $rc -ne 0 ] && grep -q 'unknown arg: --notice' <<<"$out" \
  && pass "--notice 는 unknown arg 로 크게 실패" \
  || fail "--notice 를 조용히 받거나 오류가 불명확함: $out"
out="$(PATH="$FAKEBIN:$PATH" "$SEND" --to broadcast --body "공지" --all-hands 2>&1)"; rc=$?
[ $rc -ne 0 ] && pass "사유 없는 --all-hands 거절" || fail "사유 없는 --all-hands를 허용했다"
out="$(PATH="$FAKEBIN:$PATH" "$SEND" --to lisa --body "공지" --all-hands "사유" 2>&1)"; rc=$?
[ $rc -ne 0 ] && pass "directed 메시지의 --all-hands 거절" || fail "--all-hands를 directed 메시지에 허용했다"

echo "── A2-1: 접수 문구가 '보냈다' 라고 단정하지 않는다 ──"
out="$(PATH="$FAKEBIN:$PATH" "$SEND" --to lisa --body-file "$FIX" 2>&1)"
grep -q "✓ sent" <<<"$out" && fail "아직 '✓ sent' 라고 단정한다" || pass "'✓ sent' 단정 제거됨"
grep -qE "접수됨|배달 확인 전" <<<"$out" && pass "접수까지만 말한다" || fail "접수 문구 없음: $out"

echo "── A3-1: 멘션 없으면 게시 후 경고 ──"
SLACKSTUB="$TMP/sbin"; mkdir -p "$SLACKSTUB"
cat > "$SLACKSTUB/curl" <<'STUB'
#!/usr/bin/env bash
printf '{"ok":true,"ts":"1.0"}'
STUB
chmod +x "$SLACKSTUB/curl"
out="$(PATH="$SLACKSTUB:$PATH" "$SLACK" --channel C123 --text "Bill 확인 부탁드립니다" 2>&1)"
grep -q "멘션 없음" <<<"$out" && pass "경고 나옴 (이름만 쓴 글)" || fail "경고가 안 나왔다: $out"

echo "── A3-2: 멘션 있으면 경고 없음 ──"
# ★부정 단정에는 반드시 '실제로 끝까지 갔다' 는 증거를 같이 본다★ — 스크립트가 중간에 죽어도
#   "경고 없음" 은 참이 되어버린다. 첫 실행에서 그렇게 거짓 통과했다.
out="$(PATH="$SLACKSTUB:$PATH" "$SLACK" --channel C123 --text "<@U01234567> 확인 부탁" 2>&1)"
if grep -q "✓ posted" <<<"$out"; then
  grep -q "멘션 없음" <<<"$out" && fail "멘션이 있는데 경고했다" || pass "경고 없음 (게시까지 도달 확인)"
else
  fail "게시 단계에 도달하지 못했다 — 이 단정은 무효: $out"
fi

echo "── A3-3: <!here> 도 멘션으로 인정 ──"
out="$(PATH="$SLACKSTUB:$PATH" "$SLACK" --channel C123 --text "<!here> 공지" 2>&1)"
if grep -q "✓ posted" <<<"$out"; then
  grep -q "멘션 없음" <<<"$out" && fail "<!here> 를 멘션으로 안 봤다" || pass "<!here> 인정 (게시까지 도달 확인)"
else
  fail "게시 단계에 도달하지 못했다 — 이 단정은 무효: $out"
fi

echo "── A3-4: --mention 이 본문 앞에 붙는다 ──"
export CAPTURE="$TMP/slackpayload.json"
cat > "$SLACKSTUB/curl" <<'STUB'
#!/usr/bin/env bash
prev=""
for a in "$@"; do
  if [ "$prev" = "-d" ]; then printf '%s' "$a" > "$CAPTURE"; fi
  prev="$a"
done
printf '{"ok":true,"ts":"1.0"}'
STUB
chmod +x "$SLACKSTUB/curl"
PATH="$SLACKSTUB:$PATH" "$SLACK" --channel C123 --text "본문" --mention U01234567 >/dev/null 2>&1
if [ -s "$CAPTURE" ]; then
  python3 -c "
import json,os,sys
t=json.load(open(os.environ['CAPTURE']))['text']
sys.exit(0 if t.startswith('<@U01234567> ') else 1)
" && pass "본문 맨 앞에 <@ID> 부착" || fail "부착 안 됨"
else fail "슬랙 페이로드를 잡지 못했다"; fi

echo "── A3-5: --text-file 도 원문 보존 ──"
PATH="$SLACKSTUB:$PATH" "$SLACK" --channel C123 --text-file "$FIX" >/dev/null 2>&1
python3 - <<'PY' && pass "--text-file 원문 보존" || fail "--text-file 본문 훼손"
import json, os, sys
t = json.load(open(os.environ["CAPTURE"]))["text"]
sys.exit(0 if "`echo HACKED`" in t and "$(echo HACKED)" in t else 1)
PY

echo "── A3-6: --mention 이 ★이름★ 을 로컬 설정에서 ID 로 푼다 (저장소에 ID 를 두지 않는다) ──"
MEMBERS="$TMP/members.env"
printf '# comment\nmaintainer=U07654321\nOther-Person = U11112222\n' > "$MEMBERS"
PATH="$SLACKSTUB:$PATH" SLACK_MEMBERS_FILE="$MEMBERS" \
  "$SLACK" --channel C123 --text "본문" --mention maintainer >/dev/null 2>&1
python3 -c "
import json,os,sys
t=json.load(open(os.environ['CAPTURE']))['text']
sys.exit(0 if t.startswith('<@U07654321> ') else 1)
" && pass "이름 → ID 해석됨" || fail "이름을 ID 로 풀지 못했다"
# 대소문자 무시 + 공백 허용
PATH="$SLACKSTUB:$PATH" SLACK_MEMBERS_FILE="$MEMBERS" \
  "$SLACK" --channel C123 --text "본문" --mention OTHER-PERSON >/dev/null 2>&1
python3 -c "
import json,os,sys
t=json.load(open(os.environ['CAPTURE']))['text']
sys.exit(0 if t.startswith('<@U11112222> ') else 1)
" && pass "대소문자 무시·공백 허용" || fail "대소문자/공백 처리 실패"
# 못 풀면 ★조용히 넘기지 않고★ 죽는다 — 멘션 없는 글이 되면 알림이 안 가므로
out="$(PATH="$SLACKSTUB:$PATH" SLACK_MEMBERS_FILE="$MEMBERS" \
  "$SLACK" --channel C123 --text "본문" --mention nobody 2>&1)"; rc=$?
[ $rc -ne 0 ] && pass "못 푸는 이름은 에러 (exit $rc)" || fail "못 푸는 이름을 조용히 넘겼다"
grep -q "SLACK_SETUP" <<<"$out" && pass "ID 얻는 방법을 알려준다" || fail "안내 없음: $out"

echo "── A2-2: 메시지 id 가 ★stdout★ 으로 나온다 (사용법이 약속한 것) ──"
# 실측으로 MSGID=$(send.sh …) 가 빈 문자열이었다 — id 를 내부 변수로만 받고 stdout 에 안 내보냈다.
mid="$(PATH="$FAKEBIN:$PATH" "$SEND" --to lisa --body-file "$FIX" 2>/dev/null)"
[ "$mid" = "testid" ] && pass "stdout 에서 id 를 받을 수 있다 ($mid)" \
                      || fail "stdout 이 비었다 — 사용법은 id 를 약속하는데 코드가 안 지킨다 (받은 값: '$mid')"

echo "── A2-3: --confirm 이 ★JSON 이 아닌 응답★ 을 조용히 넘기지 않는다 ──"
# 실측 사고: 경로 오류로 SPA 가 HTML 을 200 으로 돌려줬고, 판정기가 'unknown' 을 냈지만 처리 분기가
#   없어서 ★조용히 타임아웃까지 루프★ 했다. 원인(경로)은 타임아웃 메시지에 전혀 드러나지 않았다.
HTMLBIN="$TMP/hbin"; mkdir -p "$HTMLBIN"
cat > "$HTMLBIN/curl" <<'STUB'
#!/usr/bin/env bash
# POST(접수)에는 정상 JSON, GET(조회)에는 HTML 을 준다 — 경로 오류 상황 재현
for a in "$@"; do [ "$a" = "-X" ] && { printf '{"ok":true,"message":{"id":"testid","thread_id":"t","hop_count":0}}'; exit 0; }; done
printf '<!doctype html><html><body>SPA</body></html>'
STUB
chmod +x "$HTMLBIN/curl"
start=$(date +%s)
out="$(PATH="$HTMLBIN:$PATH" "$SEND" --to lisa --body-file "$FIX" --confirm 6 2>&1)"; rc=$?
elapsed=$(( $(date +%s) - start ))
if grep -qE "JSON 이 아닙니다|읽지 못했습니다" <<<"$out"; then
  pass "JSON 아님을 즉시 알린다 (${elapsed}s)"
else
  fail "조용히 넘겼다 — 출력: $(head -3 <<<"$out" | tr '\n' ' ')"
fi
[ "$elapsed" -lt 5 ] && pass "타임아웃까지 기다리지 않는다 (${elapsed}s < 5s)" \
                     || fail "타임아웃까지 루프했다 (${elapsed}s) — 자기 고장을 '아직 판정 전' 으로 흘린다"

echo "── A2-4: --confirm 조회 경로가 올바른가 (SPA fallback 이 아닌 API) ──"
# inbox 라우트는 api 아래 "/" 에 마운트된다 → /api/messages/<id> 가 맞다.
grep -q 'api/messages/\$MSG_ID' "$SEND" && pass "\$BASE/api/messages/<id> 를 쓴다" \
  || { fail "조회 경로가 틀렸다 — /api/inbox/messages 는 SPA HTML 을 200 으로 준다"; grep -n 'api/.*messages' "$SEND" | sed 's/^/    /'; }

echo "── A2-5: --confirm 이 ★expired★ 를 미배달로 본다 (실측 21건) ──"
# expired 를 실패로 안 보면 ★가장 흔한 미배달이 '아직 판정 전' 으로 흘러★ 타임아웃만 남는다.
EXPBIN="$TMP/ebin"; mkdir -p "$EXPBIN"
cat > "$EXPBIN/curl" <<'STUB'
#!/usr/bin/env bash
for a in "$@"; do [ "$a" = "-X" ] && { printf '{"ok":true,"message":{"id":"testid","thread_id":"t","hop_count":0}}'; exit 0; }; done
printf '{"message":{"id":"testid"},"recipients":[{"agent_id":"lisa","delivery_state":"expired","last_error":null}]}'
STUB
chmod +x "$EXPBIN/curl"
out="$(PATH="$EXPBIN:$PATH" "$SEND" --to lisa --body-file "$FIX" --confirm 6 2>&1)"; rc=$?
[ $rc -ne 0 ] && pass "expired 를 실패로 보고 (exit $rc)" || fail "expired 를 성공/보류로 흘렸다 (exit $rc)"
grep -q "미배달" <<<"$out" && pass "미배달이라고 말한다" || fail "미배달 표현 없음: $(head -2 <<<"$out")"


echo "── A2-6: 타임아웃에도 ★현재 상태★ 를 보여준다 (진행 중 vs 막힘 구분) ──"
# 상태 없이 "판정이 안 났다" 만 내면 진행 중인지 막힌 건지 알 수 없다. 실측으로 그 문구가
#   "정상 처리 중" 으로 오독돼 잘못된 보고가 나갔다.
WDBIN="$TMP/wbin"; mkdir -p "$WDBIN"
cat > "$WDBIN/curl" <<'STUB'
#!/usr/bin/env bash
for a in "$@"; do [ "$a" = "-X" ] && { printf '{"ok":true,"message":{"id":"testid","thread_id":"t","hop_count":0}}'; exit 0; }; done
printf '{"message":{"id":"testid"},"recipients":[{"agent_id":"lisa","delivery_state":"wake_dispatched","last_error":null}]}'
STUB
chmod +x "$WDBIN/curl"
out="$(PATH="$WDBIN:$PATH" "$SEND" --to lisa --body-file "$FIX" --confirm 2 2>&1)"; rc=$?
# ★설명문에도 'wake_dispatched' 가 들어있다★ — 그 단어만 grep 하면 상태 출력을 지우고도 통과한다
#   (실제로 그렇게 거짓 통과했다). 상태만 만드는 형식 `<agent>=<state>` 로 단정한다.
grep -qE "현재:[^\n]*lisa=wake_dispatched" <<<"$out" \
  && pass "현재 상태를 <agent>=<state> 형식으로 출력한다" \
  || fail "상태가 안 나온다: $(tail -3 <<<"$out")"
grep -q "미배달이 아닙니다" <<<"$out" && pass "미배달로 오독하지 않게 명시한다" || fail "구분 문구 없음"
[ $rc -eq 0 ] && pass "타임아웃은 실패로 단정하지 않는다 (exit 0)" || fail "타임아웃을 실패로 만들었다 (exit $rc)"


echo
if [ $FAILED -eq 0 ]; then echo "ALL PASS — send tools honesty"; else echo "FAILED — send tools honesty"; fi
exit $FAILED
