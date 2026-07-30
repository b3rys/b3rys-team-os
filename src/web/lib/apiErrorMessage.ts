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

  if (code === "x_actor_id_required") {
    // 주소를 못 읽는 환경(테스트 등)에서는 괄호를 아예 넣지 않는다 — "이 주소()" 는 사람이 읽기 나쁘다.
    const host = currentHost();
    const koWhere = host ? `이 주소(${host})에서는` : "이 주소에서는";
    const enWhere = host ? `This address (${host})` : "This address";
    return pick(
      `${koWhere} 쓰기 권한이 없습니다. ` +
        `b3os 는 서버가 로컬에만 열려 있을 때, 그 컴퓨터에서 연 화면(127.0.0.1 또는 localhost)만 팀리드로 인정합니다. ` +
        `도메인으로 쓰려면 관리자가 이 주소를 신뢰 목록에 등록해야 합니다.`,
      `${enWhere} has no write permission. ` +
        `When the server is bound to loopback, b3os only grants team-lead rights to the dashboard opened on that machine (127.0.0.1 or localhost). ` +
        `To use a domain, an administrator must add this address to the trusted list.`,
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
