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

export function humanizeApiError(raw: unknown): string {
  const code = String((raw as Error)?.message ?? raw ?? "").trim();

  if (code === "x_actor_id_required") {
    // 주소를 못 읽는 환경(테스트 등)에서는 괄호를 아예 넣지 않는다 — "이 주소()" 는 사람이 읽기 나쁘다.
    const host = currentHost();
    const koWhere = host ? `이 주소(${host})에서는` : "이 주소에서는";
    const enWhere = host ? `This address (${host})` : "This address";
    return pick(
      `${koWhere} 쓰기 권한이 없습니다. ` +
        `b3os 는 서버가 도는 컴퓨터에서 연 화면(127.0.0.1)만 팀리드로 인정합니다. ` +
        `도메인으로 쓰려면 관리자가 이 주소를 신뢰 목록에 등록해야 합니다.`,
      `${enWhere} has no write permission. ` +
        `b3os only grants team-lead rights to the dashboard opened on the machine itself (127.0.0.1). ` +
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

  return code;
}
