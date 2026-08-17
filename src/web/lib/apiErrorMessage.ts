/**
 * 서버가 돌려주는 오류 코드를 사람 말로 바꾼다.
 *
 * 2026-07-30 실측: 도메인으로 대시보드를 열고 태그를 만들면 화면에 이것만 떴다.
 *
 *     태그 관리 실패: x_actor_id_required
 *
 * 이걸 보고 원인(주소가 로컬이 아니라 권한이 안 붙음)이나 해결(주소 등록)로 갈 수 있는
 * 사람은 없다. 팀장님과 원인을 찾는 데 한참 걸렸고, 화면이 한 줄만 말해줬으면 끝날 일이었다.
 *
 * 코드는 그대로 두고 표시만 바꾼다 — 서버 응답 계약을 건드리지 않는다.
 * 모르는 코드는 원문 그대로 보여준다(감추면 디버깅이 더 어려워진다).
 *
 * ★두 가지 전제가 있다. 둘 다 깨질 수 있어서 적어둔다(steve 교차검증 2026-07-30).★
 *
 * 1. **호출부가 `showAlert({message})` 로 넘긴다** — `dialogShell` 이 `messageHtml ?? escape(message)`
 *    로 그리므로 escape 경로다. 여기서 만든 문장에 주소(`location.host`)가 들어가는데,
 *    누가 나중에 `messageHtml` 로 바꾸면 그 순간 주입 경로가 된다. 바꾸려면 여기부터 다시 보라.
 *
 * 2. **모르는 코드를 원문 통과시키는 건 "지금 호출부 기준" 판단이다.** 태그 경로의 `error` 는
 *    예외 메시지가 그대로 실리는데, 거기엔 파일 경로가 안 실린다(최악이 SQLite 제약 문구).
 *    ★다른 계열에는 절대경로·셸 출력이 실린 error 가 실제로 있다★ (예: 기동 스크립트 경로,
 *    재시작 실패 시 명령 출력). 그런 곳에 이 헬퍼를 쓰기 전에 이 판단을 다시 하라.
 *    안전판으로 길이 상한을 둔다.
 */
import { pick } from "../i18n";

/** 현재 화면이 열려 있는 주소. 안내문에 그대로 넣어 사용자가 복사할 수 있게 한다. */
function currentHost(): string {
  try {
    return location.host || "";
  } catch {
    return "";
  }
}

/** 원문 통과 시 상한. 셸 출력이 통째로 실려도 모달을 뒤덮지 않게 한다. */
const RAW_MAX = 300;

export function humanizeApiError(raw: unknown): string {
  const code = String((raw as Error)?.message ?? raw ?? "").trim();

  // ★이름이 바뀌어도 이 문장이 살아 있어야 한다(steve 교차검증 2026-07-30).★
  //   서버의 이 실패는 지금 `x_actor_id_required` 로 나오지만, 그 이름은 실제 원인을 가리키지 않는다
  // (주소를 한 번도 안 본 헤더 검사 함수가 만든 값이 그대로 돌아온다 — 팀장님이 잡으셨다).
  //   그래서 서버 쪽 이름을 `dashboard_host_not_trusted` 로 바꾸는 별건이 예정돼 있다.
  //   ★정확히 일치로만 분기해 두면, 그 별건이 들어오는 순간 이 문장이 조용히 사라지고
  //   사용자 화면에 새 코드가 원문으로 뜬다 — 이 PR 이 없애려던 상태로 되돌아간다.★
  //   테스트도 안 깨진다(옛 이름만 단정하므로). 그래서 ★두 이름을 다 받는다.★
  if (code === "x_actor_id_required" || code === "dashboard_host_not_trusted") {
    // 주소를 못 읽는 환경(테스트 등)에서는 괄호를 아예 넣지 않는다 — "이 주소()" 는 사람이 읽기 나쁘다.
    const host = currentHost();
    const koWhere = host ? `이 주소(${host})에서는` : "이 주소에서는";
    const enWhere = host ? `This address (${host})` : "This address";
    return pick(
      `${koWhere} 쓰기 권한이 없습니다. ` +
        `b3os 는 서버가 로컬에만 열려 있을 때, 그 컴퓨터에서 연 화면(127.0.0.1 또는 localhost)만 팀리드로 인정합니다. ` +
        `도메인으로 쓰려면 관리자가 이 주소를 신뢰 목록에 등록해야 합니다.\n\n` +
        // ★사용자는 "뭘 물어야 할지" 를 몰라서 막힌다.★ 그대로 붙여넣을 문장을 준다 —
        //   자기 주소가 이미 들어 있어서 팀원이 되물을 것도 없다.
        `팀원에게 이대로 물어보세요:\n` +
        `"대시보드를 ${host || "이 주소"} 로 여는데 쓰기가 막힙니다. ` +
        `TEAM_TRUSTED_DASHBOARD_HOSTS 에 이 주소를 등록해 주세요."`,
      `${enWhere} has no write permission. ` +
        `When the server is bound to loopback, b3os only grants team-lead rights to the dashboard opened on that machine (127.0.0.1 or localhost). ` +
        `To use a domain, an administrator must add this address to the trusted list.\n\n` +
        `Ask a teammate, copying this as-is:\n` +
        `"The dashboard at ${host || "this address"} blocks writes. ` +
        `Please add this address to TEAM_TRUSTED_DASHBOARD_HOSTS."`,
    );
  }

  if (code === "op_auth_disabled") {
    return pick(
      "서버에 운영 토큰이 설정되어 있지 않아 이 동작을 할 수 없습니다. 관리자에게 문의하세요.",
      "The server has no operation token configured, so this action is unavailable. Contact an administrator.",
    );
  }

  if (code === "unauthorized") {
    return pick(
      "열쇠가 맞지 않습니다. 관리자에게 문의하세요.",
      "The provided key does not match. Contact an administrator.",
    );
  }

  // 모르는 코드는 원문 그대로 — 다만 길이만 자른다(위 주석 2번).
  return code.length > RAW_MAX ? `${code.slice(0, RAW_MAX)}…` : code;
}
