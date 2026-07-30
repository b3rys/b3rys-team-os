import { describe, expect, test } from "bun:test";
import { humanizeApiError } from "./apiErrorMessage";

describe("서버 오류 코드를 사람 말로", () => {
  test("★x_actor_id_required 는 코드가 아니라 문장으로 나온다★ (2026-07-30 실측 결함)", () => {
    const m = humanizeApiError(new Error("x_actor_id_required"));
    expect(m).not.toBe("x_actor_id_required");
    expect(m).not.toContain("x_actor_id_required");
    // 원인과 해결이 둘 다 있어야 한다 — 하나만 있으면 사용자가 다음 행동을 못 정한다
    expect(m).toContain("127.0.0.1");
    expect(m).toContain("등록");
    // ★loopback 은 localhost·::1 도 포함한다★ — 127.0.0.1 만 적으면 실제보다 좁다(steve)
    expect(m).toContain("localhost");
    // ★이 예외는 서버가 로컬에만 열려 있을 때만 성립한다★ — 그 전제를 빼면 막힌 길로 안내하게 된다
    expect(m).toContain("로컬에만");
    // ★사용자가 뭘 물어야 할지 알 수 있어야 한다★ — 그대로 붙여넣을 문장을 준다(팀장님 지시)
    expect(m).toContain("팀원에게 이대로 물어보세요");
    expect(m).toContain("TEAM_TRUSTED_DASHBOARD_HOSTS");
  });

  test("★서버가 이름을 바꿔도 문장이 살아 있다★ — 뒤 고침이 앞 고침을 지우지 않게", () => {
    // 서버 쪽 이름을 dashboard_host_not_trusted 로 바꾸는 별건이 예정돼 있다.
    // 정확히 일치로만 분기해 두면 그 순간 이 문장이 사라지고 코드가 원문으로 뜬다.
    const m = humanizeApiError("dashboard_host_not_trusted");
    expect(m).not.toContain("dashboard_host_not_trusted");
    expect(m).toContain("쓰기 권한");
    expect(m).toContain("등록");
    // 옛 이름과 같은 문장이어야 한다 — 둘이 갈리면 나중에 하나만 고치게 된다
    expect(m).toBe(humanizeApiError("x_actor_id_required"));
  });

  test("Error 가 아니라 문자열로 와도 같다", () => {
    expect(humanizeApiError("x_actor_id_required")).toContain("쓰기 권한");
  });

  test("다른 알려진 코드도 바꾼다", () => {
    expect(humanizeApiError("op_auth_disabled")).not.toContain("op_auth_disabled");
    expect(humanizeApiError("unauthorized")).not.toContain("unauthorized");
  });

  test("★모르는 코드는 원문 그대로★ — 감추면 디버깅이 더 어려워진다", () => {
    expect(humanizeApiError("some_new_code_we_dont_know")).toBe("some_new_code_we_dont_know");
    expect(humanizeApiError(new Error("HTTP 500"))).toBe("HTTP 500");
  });

  test("★주소를 못 읽어도 '이 주소()' 같은 문장이 안 나온다★", () => {
    const m = humanizeApiError("x_actor_id_required");
    expect(m).not.toContain("()");
    expect(m).not.toContain("( )");
  });

  test("★모르는 코드가 길어도 모달을 뒤덮지 않는다★ — 셸 출력이 실릴 수 있는 계열 대비", () => {
    const long = "x".repeat(1000);
    const out = humanizeApiError(long);
    expect(out.length).toBeLessThanOrEqual(301);
    expect(out.endsWith("…")).toBe(true);
    // 짧은 것은 그대로 둔다
    expect(humanizeApiError("short_code")).toBe("short_code");
  });

  test("빈 값에도 안 터진다", () => {
    expect(humanizeApiError(undefined)).toBe("");
    expect(humanizeApiError(null)).toBe("");
  });
});
