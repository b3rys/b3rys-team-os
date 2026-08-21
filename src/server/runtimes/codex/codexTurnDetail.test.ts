/**
 * ★성공과 "완료했지만 최종 텍스트가 비었다" 는 다른 이름을 가져야 한다.★
 *
 * 2026-08-20 라이브: `codex_run_7a087419` 가 status=failed 인데 detail 은 `appserver_completed` 였다.
 * 성공 detail 과 ★글자까지 같은 문자열★ 이라, 기록만 보고는 두 사건을 가를 수 없었다.
 * 옛 식은 `ok ? "appserver_completed" : \`appserver_${status}\`` 였고, status 가 completed 인 채
 * 본문만 비면 두 갈래가 ★같은 값으로 합쳐졌다.★
 */
import { describe, expect, test } from "bun:test";
import { codexTurnDetail } from "./appServerRunner";

describe("codexTurnDetail — 두 사건에 두 이름", () => {
  test("완료 + 본문 있음 = 성공 이름", () => {
    expect(codexTurnDetail("completed", "답변 본문")).toBe("appserver_completed");
  });

  test("★완료 + 본문 없음 = 성공과 다른 이름★ (이게 이번 결함의 핵심)", () => {
    const empty = codexTurnDetail("completed", "");
    expect(empty).not.toBe("appserver_completed");
    expect(empty).toBe("appserver_completed_empty");
  });

  test("공백만 있는 본문도 '비었다' 쪽이다 — ok 판정(trim)과 같은 기준을 쓴다", () => {
    expect(codexTurnDetail("completed", "   \n  ")).toBe("appserver_completed_empty");
  });

  test("완료가 아닌 상태는 그 상태 이름을 그대로 쓴다 (기존 계약 유지)", () => {
    expect(codexTurnDetail("interrupted", "")).toBe("appserver_interrupted");
    expect(codexTurnDetail("timeout", "")).toBe("appserver_timeout");
  });

  test("사유(detail)는 뒤에 붙는다 — rate-limit 진단용 (#8 픽스 계약 유지)", () => {
    expect(codexTurnDetail("interrupted", "", "rate limited")).toBe("appserver_interrupted: rate limited");
    expect(codexTurnDetail("completed", "", "no final")).toBe("appserver_completed_empty: no final");
  });

  test("사유는 300자에서 자른다 (로그 폭주 방지)", () => {
    const long = "x".repeat(500);
    expect(codexTurnDetail("failed", "", long)).toBe(`appserver_failed: ${"x".repeat(300)}`);
  });
});
