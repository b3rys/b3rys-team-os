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
