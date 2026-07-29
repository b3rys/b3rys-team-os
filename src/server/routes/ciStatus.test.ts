import { describe, test, expect } from "bun:test";
import { createCiStatusRoutes, normalizeRuns, parseRateLimit, RateLimitedError } from "./ciStatus";

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

  // ★이 테스트는 뒤집혔다 (Codex 반려, 2026-07-29)★
  //   예전엔 "이상한 응답 → 빈 목록" 을 옳다고 봤다. ★틀렸다.★
  //   빈 목록은 화면에 ★"실행 0건 = 정상"★ 으로 보이고, ★진짜 0건과 구분이 안 된다.★
  //   상류가 깨진 것은 ★모르는 상태★ 지 정상이 아니다 — 이 파일의 존재 이유가 그것이다.
  test("★상류 응답이 우리가 아는 모양이 아니면 '확인 불가' 다 — 빈 목록으로 삼키지 않는다★", () => {
    expect(() => normalizeRuns(null)).toThrow();
    expect(() => normalizeRuns({})).toThrow();
    expect(() => normalizeRuns({ workflow_runs: "nope" })).toThrow();
    // 배열이면 항목이 비어 있어도 정상 — ★진짜 0건은 0건이다★
    expect(normalizeRuns({ workflow_runs: [] })).toEqual([]);
    expect(normalizeRuns({ workflow_runs: [{}] })[0]?.name).toBe("");
  });

  test("★깨진 응답은 ok:false 로 나간다 — 초록 0건이 아니다★", async () => {
    const app = createCiStatusRoutes({ fetchRuns: async () => ({ oops: 1 }), now: () => 1000 });
    const j = await (await app.request("/ci-status")).json() as any;
    expect(j.ok).toBe(false);
    expect(j.reason).toContain("workflow_runs");
  });
});

// ★한도(rate limit) 를 지키는가 — 토큰 없는 GitHub API 는 IP 당 60 req/hr★
// 캐시만으로는 못 막는 두 구멍을 고정한다(Codex 반려, 2026-07-29).
describe("한도 보호 — ★캐시가 못 막는 두 경로★", () => {
  test("★동시 요청 10개 → 실제 호출 1회★ (캐시는 '응답 후' 라 동시엔 무력하다)", async () => {
    let calls = 0;
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => { release = r; });
    const app = createCiStatusRoutes({
      fetchRuns: async () => { calls++; await gate; return sample; },
      now: () => 1000,
    });
    // 캐시가 빈 상태에서 한꺼번에 들어온다 — 아무도 아직 응답을 못 받았다.
    const all = Promise.all(Array.from({ length: 10 }, () => app.request("/ci-status")));
    await Promise.resolve();
    release(null);
    const res = await all;
    expect(calls).toBe(1);                       // ★10 이 아니라 1★
    for (const r of res) expect(((await r.json()) as any).ok).toBe(true);
  });

  test("★한도에 걸리면 리셋까지 한 번도 안 부른다★ — 계속 두드리면 차단이 늘어난다", async () => {
    let calls = 0;
    let t = 1_000_000;
    const resetMs = t + 10 * 60_000;
    const app = createCiStatusRoutes({
      fetchRuns: async () => {
        calls++;
        throw new RateLimitedError(resetMs, "github 403 rate limited");
      },
      now: () => t,
    });
    const first = await (await app.request("/ci-status")).json() as any;
    expect(first.ok).toBe(false);
    expect(first.retry_after).toBe(new Date(resetMs).toISOString());  // ★언제 풀리는지 밝힌다★
    expect(calls).toBe(1);

    // 리셋 전 — 캐시가 만료돼도(6분 뒤) ★추가 호출 0★
    t += 6 * 60_000;
    for (let i = 0; i < 5; i++) await app.request("/ci-status");
    expect(calls).toBe(1);                       // ★여전히 1★

    // 리셋 후 — 다시 한 번만 시도한다
    t = resetMs + 1;
    await app.request("/ci-status");
    expect(calls).toBe(2);
  });

  test("★403 을 전부 한도로 보지 않는다★ — 권한 오류도 403 이다", () => {
    const h = (m: Record<string, string>) => ({ get: (k: string) => m[k.toLowerCase()] ?? null });
    // remaining 이 0 이 아니면 한도가 아니다 → null
    expect(parseRateLimit(403, h({ "x-ratelimit-remaining": "42" }), 0)).toBeNull();
    expect(parseRateLimit(404, h({}), 0)).toBeNull();
    // 한도 맞음 — retry-after 우선
    expect(parseRateLimit(403, h({ "x-ratelimit-remaining": "0", "retry-after": "60" }), 1000))
      .toBe(1000 + 60_000);
    // retry-after 없으면 x-ratelimit-reset(초 단위 epoch)
    expect(parseRateLimit(429, h({ "x-ratelimit-reset": "500" }), 1000)).toBe(500_000);
    // 리셋이 과거면 신뢰하지 않고 기본 백오프로 — ★즉시 재시도로 떨어지지 않는다★
    expect(parseRateLimit(429, h({ "x-ratelimit-reset": "1" }), 10_000_000)).toBeGreaterThan(10_000_000);
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
