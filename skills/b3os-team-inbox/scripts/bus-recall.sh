#!/usr/bin/env bash
# bus-recall.sh — 1:1 세션에서 '팀버스 맥락'을 쉽게 조회 (GD 2026-07-09).
#
# 문제: openclaw/hermes 는 1:1 방과 팀버스가 다른 세션이라, 1:1 에서 "팀버스 그거 어떻게 됐어?"·
#   "GD가 코덱스한테 뭐 시켰어?" 같은 질문을 받으면 버스 맥락을 몰라 다 뒤진다(토큰 낭비).
# 해결: 이 스크립트로 team.db(팀버스=message + GD 1:1=dm_message)를 한 번에 SQL 조회해 요점만 본다.
#   READ-ONLY — DB/서버/봇 안 건드림.
#
# 사용:
#   bus-recall.sh                      # 내가 최근 관여한 버스 맥락 (from/to=나) + 내 GD 1:1
#   bus-recall.sh --about "맛집"        # '맛집' 관련 버스 메시지 (누가 뭐 했나)
#   bus-recall.sh --with devon         # 나와 devon 사이 최근 오간 것
#   bus-recall.sh --from-gd devon      # GD가 devon에게 최근 뭐 했나(1:1 dm + 버스)
#   [--limit N] (기본 8)

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB="${TEAM_DB_PATH:-$(cd "$HERE/../../.." && pwd)/team.db}"
ME=""; ABOUT=""; WITH=""; FROM_GD=""; LIMIT=8; DAYS=7
while [ $# -gt 0 ]; do
  case "$1" in
    --me) ME="$2"; shift 2 ;;
    --about) ABOUT="$2"; shift 2 ;;
    --with) WITH="$2"; shift 2 ;;
    --from-gd) FROM_GD="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --days) DAYS="$2"; shift 2 ;;   # 최근 N일만 스캔(0=전체). 규모 커져도 풀스캔 바운드.
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
# 해석 실패는 ★빈 값★ 으로 남긴다 — 그리고 아래에서 ★반드시 검사한다.★ (기본값으로 '지어내지' 않는다)
ME="${ME:-$("$HERE/_me.sh" 2>/dev/null || true)}"
# _me.sh 는 이제 현재 폴더 ↔ agent.workspace_path 로 전 런타임 신원을 해석한다(설정 불필요).
# 그래도 실패하면 ★조용히 '팀 전체'로 fallback 하지 않는다★ — 자기 1:1 이 빠진 결과를
#   성공처럼 돌려주면 호출자가 "별 거 없네" 하고 넘어간다. 틀린 답 대신 멈춘다. (GD 2026-07-10)
# --with 는 '나 ↔ 상대' 쌍 조회라 ★신원이 필수★ 다. 신원 없이 돌리면 매칭이 0건이 되어
#   "둘이 대화한 적 없음" 처럼 보이는 조용한 false-negative 가 된다(Devon 리뷰, 2026-07-10).
#   반면 --about(주제) · --from-gd <member>(대상 지정) 는 신원 없이도 의미가 성립한다.
# ★--with 는 '나 ↔ 상대' 쌍 조회라 신원이 없으면 의미가 성립하지 않는다.★
#   예전 조건은 `ME 없음 AND FROM_GD 없음 AND ABOUT 없음` 이어서, ★--about 을 같이 주면 이 검사를 빠져나갔다★
#   → --with 가 ★빈 신원★ 으로 돌아 매칭 0건 → "둘이 대화한 적 없음" 이라는 ★조용한 거짓 음성★.
#   (이 갭은 2026-07-13 신원 가드가 잡아냈다. 주석은 '신원 필수'라 적혀 있었는데 ★코드가 안 그랬다.★)
if [ -z "$ME" ] && [ -n "$WITH" ]; then
  {
    echo "✖ --with 는 '나 ↔ 상대' 조회라 ★내 agent id 가 필요하다★ — 조회를 중단한다."
    echo "  신원 없이 돌리면 매칭이 0건이 되어 '둘이 대화한 적 없음' 처럼 보인다(거짓 음성)."
    echo "  해결: 자기 워크스페이스 폴더에서 실행하거나 --me <agent id> 를 붙여라."
  } >&2
  exit 1
fi
if [ -z "$ME" ] && [ -z "$FROM_GD" ] && [ -z "$ABOUT" ]; then
  {
    echo "✖ 내 agent id 를 해석하지 못했다 — 조회를 중단한다(팀 전체 fallback 안 함)."
    echo "  이 상태로 진행하면 '내 GD 1:1' 이 빠진 결과가 나와서 맥락을 잃는다."
    echo "  해결: 자기 워크스페이스 폴더에서 실행하거나 --me <agent id> 를 붙여라."
    echo "  (범위를 직접 지정하는 --about / --from-gd <member> 는 신원 없이도 동작한다."
    echo "   --with 는 '나 ↔ 상대' 조회라 신원이 필요하다.)"
  } >&2
  exit 1
fi

# 오타/유령 id 가 '활동 없음'처럼 조용히 0건을 내지 않게, 실제 팀원인지 확인한다(하네스 F2).
if [ -n "$ME" ] && [ -f "$DB" ]; then
  if [ -z "$(sqlite3 -readonly "$DB" "SELECT 1 FROM agent WHERE id = '$(printf '%s' "$ME" | sed "s/'/''/g")' LIMIT 1;" 2>/dev/null)" ]; then
    echo "✖ agent id '$ME' 는 팀에 없다 — 오타면 0건이 '활동 없음'처럼 보인다. 중단한다." >&2
    exit 1
  fi
fi
# 인자 검증(하네스): 숫자 아니면 기본값.
case "$LIMIT" in ''|*[!0-9]*) LIMIT=8 ;; esac
case "$DAYS" in ''|*[!0-9]*) DAYS=7 ;; esac
[ -f "$DB" ] || { echo "team.db 없음: $DB" >&2; exit 1; }

DB="$DB" ME="$ME" ABOUT="$ABOUT" WITH="$WITH" FROM_GD="$FROM_GD" LIMIT="$LIMIT" DAYS="$DAYS" python3 - <<'PY'
import os, sqlite3
db, me, about, with_a, from_gd, limit, days = (os.environ[k] for k in ("DB","ME","ABOUT","WITH","FROM_GD","LIMIT","DAYS"))
limit = int(limit); days = int(days)
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True); con.row_factory = sqlite3.Row
def q(sql, args):
    try: return con.execute(sql, args).fetchall()
    except Exception as e: print(f"  (쿼리 오류: {e})"); return []

# 1) 팀버스(message) — 관련 있는 것만. 최근 N일 시간창으로 스캔 바운드(규모 커져도 풀스캔 안 함).
where, args = [], []
if days > 0: where.append("created_at > datetime('now', ?)"); args.append(f"-{days} days")
if about:   where.append("body LIKE ?"); args.append(f"%{about}%")
if with_a:  where.append("((from_agent_id=? AND to_agent_id=?) OR (from_agent_id=? AND to_agent_id=?))"); args += [me, with_a, with_a, me]
elif from_gd: where.append("to_agent_id=?"); args.append(from_gd)
elif me and not about: where.append("(from_agent_id=? OR to_agent_id=?)"); args += [me, me]
wsql = (" WHERE " + " AND ".join(where)) if where else ""
rows = q(f"SELECT from_agent_id,to_agent_id,body,created_at FROM message{wsql} ORDER BY created_at DESC LIMIT ?", args + [limit])
print(f"=== 팀버스 (message) — {len(rows)}건 ===")
for r in reversed(rows):
    print(f"  [{r['created_at'][11:16]}] {r['from_agent_id']}→{r['to_agent_id']}: {(r['body'] or '')[:70]}")
if not rows: print(f"  (없음{'' if days<=0 else f' — 최근 {days}일 내. 오래된 건 --days 0 으로 전체 스캔'})")

# 2) GD 1:1 (dm_message) — 나 또는 지정 멤버
target = from_gd or me
if target:
    dw, da = ["member_id=?"], [target]
    if about: dw.append("body LIKE ?"); da.append(f"%{about}%")
    drows = q(f"SELECT direction,body,created_at FROM dm_message WHERE {' AND '.join(dw)} ORDER BY created_at DESC LIMIT ?", da + [limit])
    print(f"\n=== GD 1:1 ({target}, dm_message) — {len(drows)}건 ===")
    for r in reversed(drows):
        who = "GD→" if r['direction']=='in' else f"{target}→GD"
        print(f"  [{r['created_at'][11:16]}] {who}: {(r['body'] or '')[:70]}")
    if not drows: print("  (없음 — 해당 멤버 GD 1:1 캡처 없음)")
con.close()
print("\n(read-only 조회 — 이걸로 '뒤지기' 대신 요점 확인. 팀버스=message, GD 1:1=dm_message)")
PY
