#!/usr/bin/env bash
# inbox.sh --delivery 의 시각 표시 검증. ★서버·네트워크 안 씀★ — 변환 함수만 떼어 돌린다.
#
# ★왜 있나★: 저장은 UTC 인데 출력이 그대로 나가서, 화면의 09:39 가 실제로는 18:39(KST) 였다.
#   9시간 어긋난 값을 사람이 "언제 나갔나" 로 읽으면 매번 틀린다. 이 시험이 그 축을 고정한다.
set -uo pipefail
SRC="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/skills/b3os-team-inbox/scripts/inbox.sh}"
FAIL=0
ok(){ echo "  ✓ $1"; }; bad(){ echo "  ✗ $1"; FAIL=1; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
# 변환 함수만 떼어낸다(관례: send-mention.test.sh 와 같은 방식)
sed -n '/^def local_time(v):/,/^        return str(v)/p' "$SRC" > "$T/lt.py"
[ -s "$T/lt.py" ] || { echo "  ✗ local_time 을 못 떼어냈다 — 함수 이름이 바뀌었나"; exit 1; }

run(){ TZ="$1" python3 -c "
$(cat "$T/lt.py")
print(local_time('$2'))"; }

echo "── T1: UTC 저장값을 로컬로 바꾼다 ──"
[ "$(run Asia/Seoul '2026-08-21 09:39:46')" = "2026-08-21 18:39:46" ] \
  && ok "KST 는 +9 (09:39 → 18:39)" || bad "KST: $(run Asia/Seoul '2026-08-21 09:39:46')"
[ "$(run UTC '2026-08-21 09:39:46')" = "2026-08-21 09:39:46" ] \
  && ok "UTC 기계에서는 그대로" || bad "UTC: $(run UTC '2026-08-21 09:39:46')"

echo "── T2: ★오프셋을 박지 않았다★ — 기계 설정을 따른다 ──"
[ "$(run Asia/Kolkata '2026-08-21 09:39:46')" = "2026-08-21 15:09:46" ] \
  && ok "+05:30 처럼 분 단위 오프셋도 맞다" || bad "Kolkata: $(run Asia/Kolkata '2026-08-21 09:39:46')"

echo "── T3: 날짜 경계 ──"
[ "$(run Asia/Seoul '2026-08-21 15:30:00')" = "2026-08-22 00:30:00" ] \
  && ok "자정을 넘으면 날짜도 넘어간다" || bad "경계: $(run Asia/Seoul '2026-08-21 15:30:00')"

echo "── T4: ★모양이 다르면 원문 그대로★ (못 바꾼 걸 바꾼 척하지 않는다) ──"
[ "$(run Asia/Seoul '?')" = "?" ] && ok "물음표 통과" || bad "물음표: $(run Asia/Seoul '?')"
[ "$(run Asia/Seoul '2026-08-21T09:39:46Z')" = "2026-08-21T09:39:46Z" ] \
  && ok "ISO 형태는 손대지 않는다" || bad "ISO: $(run Asia/Seoul '2026-08-21T09:39:46Z')"

echo "── T5: ★호출부까지 — 스텁 서버로 실제 경로를 돌린다★ ──"
#   함수만 재면 ★호출부가 변환을 안 거치도록 되돌려도 시험이 통과한다.★ 그래서 여기까지 온다.
PORT=17879
python3 - "$PORT" <<'PY' &
import http.server, json, sys
BODY = json.dumps({"id": "m1", "recipients": [],
                   "deliveries": [{"channel": "bus", "to": "bill", "ok": True,
                                   "at": "2026-08-21 09:39:46"}]}).encode()
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(BODY))); self.end_headers(); self.wfile.write(BODY)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
STUB=$!; trap 'kill $STUB 2>/dev/null; rm -rf "$T"' EXIT
for _ in 1 2 3 4 5 6 7 8 9 10; do curl -sS "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break; sleep 0.2; done

OUT="$(TZ=Asia/Seoul TEAM_BASE="http://127.0.0.1:$PORT" bash "$SRC" --delivery m1 2>&1)"
case "$OUT" in
  *"2026-08-21 18:39:46"*) ok "출력 줄에 로컬 시각이 찍힌다" ;;
  *"2026-08-21 09:39:46"*) bad "★UTC 가 그대로 나갔다 — 호출부가 변환을 안 거친다★" ;;
  *) bad "예상 못 한 출력: $OUT" ;;
esac

[ "$FAIL" = 0 ] && echo "PASS" || echo "FAIL"
exit "$FAIL"
