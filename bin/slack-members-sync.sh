#!/usr/bin/env bash
# slack-members-sync.sh — 슬랙 워크스페이스 사람·봇 목록을 받아 이름→ID 사전을 만든다.
#
# ★왜 필요한가★ (2026-07-30)
#   `send.sh --mention <이름>` 과 `slack-post.sh --mention <이름>` 은 `slack-tokens/members.env`
#   에서 이름을 ID 로 바꾼다. 그런데 ★그 파일을 만드는 절차가 어디에도 없었다★ —
#   문서에도 대시보드 위저드에도 없다. 그래서 실제로 이런 일이 났다:
#     · 팀장님이 슬랙 UI 에서 멤버 ID 를 못 찾으심(메뉴 위치가 앱이 아니라 api.slack.com 이다)
#     · 다른 기계(gdstudio)는 그 파일이 없어 ★이름 대신 원시 ID 를 손으로 넣어야 했다★
#   ID 를 사람이 찾게 두면 안 된다. 슬랙이 API 로 주는 값이다.
#
# 사용:
#   bash bin/slack-members-sync.sh            # 미리보기(파일 안 씀)
#   bash bin/slack-members-sync.sh --apply    # slack-tokens/members.env 갱신
#
# 전제: 봇에 `users:read` 스코프. 없으면 missing_scope 로 끝나며 무엇을 해야 하는지 안내한다.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
TOKENS_DIR="${SLACK_TOKENS_DIR:-$REPO/slack-tokens}"
OUT="${SLACK_MEMBERS_FILE:-$TOKENS_DIR/members.env}"
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1

# 토큰은 ★어느 팀원 것이든 상관없다★ — users.list 는 워크스페이스 전체를 준다.
#   값은 변수에만 담고 화면·로그에 내지 않는다.
TOKEN=""
for f in "$TOKENS_DIR"/*.env; do
  [ -f "$f" ] || continue
  case "$(basename "$f")" in members.env) continue ;; esac
  # shellcheck disable=SC1090
  TOKEN="$(set -a; . "$f" >/dev/null 2>&1; set +a; printf '%s' "${SLACK_BOT_TOKEN:-}")"
  [ -n "$TOKEN" ] && break
done
if [ -z "$TOKEN" ]; then
  echo "✗ 봇 토큰을 못 찾았습니다: $TOKENS_DIR/<팀원>.env 의 SLACK_BOT_TOKEN" >&2
  echo "  슬랙을 아직 안 붙였다면 이 스크립트는 필요 없습니다(슬랙은 선택입니다)." >&2
  exit 1
fi

# ★토큰을 명령줄 인자로 넘기지 않는다★ (hermes 교차검증)
#   `curl -H "Authorization: Bearer $TOKEN"` 는 argv 에 실려 ★이 맥의 아무 프로세스나 ps 로 읽는다.★
#   실제로 같은 형태를 오늘 라이브에서 발견했다(cloudflared 가 --token 을 argv 로 받고 있었다).
#   `--config -` 는 curl 설정을 ★stdin★ 으로 받는다 — argv 에도 파일에도 안 남는다.
RESP="$(printf 'header = "Authorization: Bearer %s"\nurl = "https://slack.com/api/users.list?limit=500"\n' "$TOKEN" \
  | curl -sS --config - 2>/dev/null)"

printf '%s' "$RESP" | RESP_OUT="$OUT" RESP_APPLY="$APPLY" python3 -c '
import json, os, sys, tempfile

d = json.load(sys.stdin)
if not d.get("ok"):
    err = d.get("error", "unknown")
    print(f"✗ 슬랙 API 실패: {err}", file=sys.stderr)
    if err == "missing_scope":
        print("  봇에 users:read 스코프가 필요합니다.", file=sys.stderr)
        print("  https://api.slack.com/apps → 앱 선택 → OAuth & Permissions", file=sys.stderr)
        print("  → Bot Token Scopes → Add an OAuth Scope → users:read → 페이지 위 Reinstall", file=sys.stderr)
    sys.exit(1)

rows = []
for m in d.get("members", []):
    if m.get("deleted") or m.get("id") == "USLACKBOT":
        continue
    name = (m.get("name") or "").strip()
    if not name:
        continue
    # 우리 팀원 봇은 gd_bill·gdlisa 처럼 접두사가 붙는다 — 부르기 쉬운 짧은 이름으로 정리한다.
    #   ★원본 이름도 같이 넣는다★ — 정리가 틀렸을 때 원본으로 부를 수 있어야 한다.
    short = name
    for p in ("gd_", "gd"):
        if short.startswith(p) and len(short) > len(p):
            short = short[len(p):]
            break
    keys = [short] if short == name else [short, name]
    for k in keys:
        rows.append((k, m["id"], name))

# ★같은 이름이 두 사람을 가리키면 조용히 하나를 고르지 않는다★ (hermes 교차검증).
#   `gdlisa` 를 줄인 `lisa` 와 진짜 계정 `lisa` 가 같이 있으면, 예전 코드는
#   ★API 응답 순서★ 로 이긴 쪽을 남겼다 — 사람이 예측할 수 없고, 엉뚱한 사람을 부르게 된다.
#   멘션은 사람을 부르는 일이라 ★틀린 사람을 조용히 부르는 것★ 이 제일 나쁘다. 그래서 멈춘다.
by_key = {}
for k, v, orig in rows:
    by_key.setdefault(k, []).append((v, orig))
conflicts = {k: vs for k, vs in by_key.items() if len({v for v, _ in vs}) > 1}
if conflicts:
    print("✗ 이름이 겹칩니다 — 사전을 만들지 않았습니다(엉뚱한 사람을 부를 수 있습니다):", file=sys.stderr)
    for k, vs in sorted(conflicts.items()):
        print(f"  {k} ← " + " / ".join(sorted(o for _, o in vs)), file=sys.stderr)
    print("  원본 이름으로 부르시거나, 겹치는 계정 이름을 슬랙에서 정리해 주세요.", file=sys.stderr)
    sys.exit(1)

lines = sorted(f"{k}={vs[0][0]}" for k, vs in by_key.items())

body = (
    "# slack-tokens/members.env — 이름 → 슬랙 멤버 ID\n"
    "#   이 폴더는 .gitignore 라 커밋되지 않습니다(같은 폴더에 봇 토큰이 있습니다).\n"
    "#   ★손으로 고치지 마세요★ — 다시 만들려면: bash bin/slack-members-sync.sh --apply\n"
    "#   쓰는 곳: send.sh --mention <이름> · slack-post.sh --mention <이름>\n"
    + "\n".join(lines) + "\n"
)

out = os.environ["RESP_OUT"]
print(f"수집: {len(lines)}개 항목")
for l in lines[:40]:
    print("  " + l.split("=")[0])
if os.environ["RESP_APPLY"] != "1":
    print("\n(미리보기 — 적용하려면 --apply)")
    sys.exit(0)

# ★임시파일 → 원자적 교체★ — 쓰다 죽어도 반쪽 파일이 남지 않는다.
os.makedirs(os.path.dirname(out), exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(out), prefix=".members.env.")
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write(body)
# ★기존 모드를 복사하지 않는다★ (hermes 교차검증) — 앞서 만든 파일이 644 였다.
#   사람 ID 자체는 비밀이 아니지만 ★워크스페이스 구성원 목록★ 이고, 같은 폴더에 봇 토큰이 있다.
#   폴더 정책(0600)에 맞춰 항상 낮춘다. 느슨한 기존 권한을 물려받으면 고쳐지지 않는다.
os.chmod(tmp, 0o600)
os.replace(tmp, out)
print(f"\n★적용★ {out}")
'
