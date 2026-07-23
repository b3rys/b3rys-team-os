#!/bin/bash
# 이 프로세스가 '어느 팀원'인지 해석한다. 실패하면 조용히 넘어가지 않고 종료한다.
#   (예전엔 실패 시 호출자가 '팀 전체'로 fallback 해서, 자기 1:1 이 빠진 결과를 성공처럼 돌려줬다.)
#
# 해석 순서:
#   1) GD_AGENT_ID 환경변수 — 명시적 override (레거시 이름 유지, GD 2026-07-10)
#   2) 현재 디렉토리 ↔ team.db 의 agent.workspace_path — 기본 경로. 설정 불필요, 전 런타임 동작
#   3) tmux 세션 이름 ↔ agent.tmux_session — DB 값과 대조(이름 규칙을 코드가 추측하지 않는다)
#   4) claude-<id> 접두사 — 레거시 하위호환
#   5) 실패 → stderr 안내 + exit 1
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB="${TEAM_DB_PATH:-$(cd "$HERE/../../.." && pwd)/team.db}"

# SQL 문자열 리터럴 이스케이프(' → '')
sq() { printf "%s" "$1" | sed "s/'/''/g"; }
q() {
  [ -f "$DB" ] || return 1
  sqlite3 -readonly "$DB" "$1" 2>/dev/null
}

# 1) 명시적 override — 단, ★DB 에 실제 존재하는 id 일 때만★ 인정한다.
#    (낡은/유출된 GD_AGENT_ID 가 올바른 폴더 판별을 조용히 덮어쓰는 것을 막는다. 하네스 F3)
if [ -n "${GD_AGENT_ID:-}" ]; then
  if [ -z "$(q "SELECT 1 FROM agent WHERE id = '$(sq "$GD_AGENT_ID")' LIMIT 1;")" ]; then
    echo "✖ GD_AGENT_ID='$GD_AGENT_ID' 는 팀에 없는 id 다. 해석을 중단한다." >&2
    exit 1
  fi
  echo "$GD_AGENT_ID"
  exit 0
fi

# 2) 현재 디렉토리 → workspace_path (하위 폴더에서 실행해도 잡히게 prefix 매칭, 가장 깊은 것 우선)
#    ★LIKE 를 쓰지 않는다★: workspace_path 가 패턴 쪽이라 경로에 '_' 나 '%' 가 있으면 와일드카드가 되어
#    형제 디렉토리가 매칭 → ★다른 멤버로 해석★된다(하네스 적대검증 F1, 2026-07-10).
#    substr 로 '경로 + /' 접두사를 리터럴 비교한다(경로 구분자까지 확인 → /dex 가 /devon 에 안 걸림).
CWD="$(sq "$(pwd -P)")"
ID="$(q "SELECT id FROM agent
          WHERE workspace_path IS NOT NULL AND workspace_path <> ''
            AND ('$CWD' = workspace_path
                 OR substr('$CWD', 1, length(workspace_path) + 1) = workspace_path || '/')
          ORDER BY length(workspace_path) DESC LIMIT 1;")"
if [ -n "${ID:-}" ]; then echo "$ID"; exit 0; fi

# 3) tmux 세션 이름을 DB 값과 대조
#    ★$TMUX 가 있을 때만★ 묻는다. tmux 클라이언트 밖에서 display-message 를 부르면
#    tmux 가 '서버의 가장 최근 세션'을 돌려줘서 ★남의 id 로 오인★한다(실측: /tmp 에서 lui 반환).
SESSION=""
if [ -n "${TMUX:-}" ]; then
  SESSION="$(tmux display-message -p '#S' 2>/dev/null || true)"
fi
if [ -n "$SESSION" ]; then
  ID="$(q "SELECT id FROM agent WHERE tmux_session = '$(sq "$SESSION")' LIMIT 1;")"
  if [ -n "${ID:-}" ]; then echo "$ID"; exit 0; fi
  # 4) 레거시: claude-<id> (DB 에 실제 존재하는 id 일 때만 인정)
  case "$SESSION" in
    claude-*)
      CAND="${SESSION#claude-}"
      ID="$(q "SELECT id FROM agent WHERE id = '$(sq "$CAND")' LIMIT 1;")"
      if [ -n "${ID:-}" ]; then echo "$ID"; exit 0; fi
      ;;
  esac
fi

# 5) 실패 — 틀린 답을 성공처럼 돌려주지 않는다
{
  echo "✖ agent id 해석 실패."
  echo "  시도: GD_AGENT_ID → 현재 폴더($(pwd -P)) ↔ agent.workspace_path → tmux 세션(${SESSION:-없음})"
  echo "  해결: 자기 워크스페이스에서 실행하거나 --me <agent id> 를 명시하라."
  echo "  (DB: $DB)"
} >&2
exit 1
