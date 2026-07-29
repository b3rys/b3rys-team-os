import { describe, test, expect } from "bun:test";
import { createCiStatusRoutes, normalizeRuns } from "./ciStatus";

const sample = {
  workflow_runs: [
    { name: "CI", event: "pull_request", status: "completed", conclusion: "success",
      head_branch: "docs/test-map", created_at: "2026-07-28T15:15:00Z", html_url: "https://x/1" },
    { name: "CI", event: "push", status: "in_progress", conclusion: null,
      head_branch: "main", created_at: "2026-07-29T00:00:00Z", html_url: "https://x/2" },
  ],
};

describe("CI 결과 표시 — ★모르는 것을 정상으로 보여주지 않는다★", () => {
  test("정상: 결과를 그대로 내려준다", async () => {
    const app = createCiStatusRoutes({ fetchRuns: async () => sample, now: () => 1000 });
    const j = await (await app.request("/ci-status")).json() as any;
    expect(j.ok).toBe(true);
    expect(j.runs.length).toBe(2);
    expect(j.runs[0].conclusion).toBe("success");
    expect(j.fetched_at).not.toBeNull();
  });

  test("★실패하면 ok:false 와 이유를 준다 — 빈 초록이 아니다★", async () => {
    const app = createCiStatusRoutes({ fetchRuns: async () => { throw new Error("github 403"); }, now: () => 1000 });
    const j = await (await app.request("/ci-status")).json() as any;
    expect(j.ok).toBe(false);
    expect(j.reason).toContain("403");
    expect(j.fetched_at).toBeNull();
  });

  test("★실패를 캐시하지 않는다★ — 일시적 오류가 5분간 굳으면 안 된다", async () => {
    let fail = true;
    const app = createCiStatusRoutes({ fetchRuns: async () => { if (fail) throw new Error("boom"); return sample; }, now: () => 1000 });
    expect(((await (await app.request("/ci-status")).json()) as any).ok).toBe(false);
    fail = false;
    // 같은 시각인데도 다시 시도해야 한다(실패는 캐시 안 됨)
    expect(((await (await app.request("/ci-status")).json()) as any).ok).toBe(true);
  });

  test("★실패했을 때 직전 성공값을 대신 보여주지 않는다★ — 낡은 초록이 현재처럼 보인다", async () => {
    let mode: "ok" | "err" = "ok";
    let t = 1000;
    const app = createCiStatusRoutes({
      fetchRuns: async () => { if (mode === "err") throw new Error("down"); return sample; },
      now: () => t,
    });
    expect(((await (await app.request("/ci-status")).json()) as any).runs.length).toBe(2);
    mode = "err"; t += 6 * 60_000;             // 캐시 만료 후 실패
    const j = await (await app.request("/ci-status")).json() as any;
    expect(j.ok).toBe(false);
    expect(j.runs.length).toBe(0);             // ★직전 성공 결과를 재사용하지 않는다★
  });

  test("성공은 캐시한다 — 한도 60/시간이라 매번 부르면 안 된다", async () => {
    let calls = 0;
    const app = createCiStatusRoutes({ fetchRuns: async () => { calls++; return sample; }, now: () => 1000 });
    await app.request("/ci-status");
    const j = await (await app.request("/ci-status")).json() as any;
    expect(calls).toBe(1);
    expect(j.cached).toBe(true);
  });

  test("응답이 이상해도 터지지 않고 빈 목록 — ★추측하지 않는다★", () => {
    expect(normalizeRuns(null)).toEqual([]);
    expect(normalizeRuns({})).toEqual([]);
    expect(normalizeRuns({ workflow_runs: "nope" })).toEqual([]);
    expect(normalizeRuns({ workflow_runs: [{}] })[0]?.name).toBe("");
  });
});

// ★화면이 '모르는 것' 을 '정상' 으로 그리지 않는지 — 렌더 함수 자체를 검증한다★
// 서버가 ok:false 를 줘도 화면이 조용히 비어 보이면 사용자는 "문제 없구나" 로 읽는다.
// 이 PR 의 목적이 정확히 그 착각을 없애는 것이라 렌더까지 테스트로 고정한다.
import { ciBlockHtml } from "../../web/components/TeamOS";

describe("ciBlockHtml — 실패가 초록으로 보이지 않는다", () => {
  test("★실패하면 '확인 불가' 와 이유가 화면에 뜬다★", () => {
    const h = ciBlockHtml({ ok: false, reason: "github 403", runs: [], fetched_at: null });
    expect(h).toContain("확인 불가");
    expect(h).toContain("github 403");
    expect(h).toContain("정상' 이 아닙니다");   // ★모르는 것 ≠ 정상★ 을 문장으로 말한다
  });

  test("아직 안 불러왔으면 '불러오는 중' — 빈 화면이 아니다", () => {
    expect(ciBlockHtml(null)).toContain("불러오는 중");
  });

  test("성공하면 기준 시각을 밝힌다 — 언제 것인지 모르는 초록은 위험하다", () => {
    const h = ciBlockHtml({ ok: true, fetched_at: "2026-07-29T00:00:00Z", runs: [
      { name: "CI", event: "push", status: "completed", conclusion: "success",
        branch: "main", created_at: "2026-07-29T00:00:00Z", url: "https://x" }]});
    expect(h).toContain("기준 시각");
    expect(h).toContain("main");
  });

  test("실행 중(completed 아님)은 초록도 빨강도 아닌 표시", () => {
    const h = ciBlockHtml({ ok: true, fetched_at: "2026-07-29T00:00:00Z", runs: [
      { name: "CI", event: "push", status: "in_progress", conclusion: null,
        branch: "main", created_at: "2026-07-29T00:00:00Z", url: "https://x" }]});
    expect(h).toContain("text-txt-amber");
  });
});
