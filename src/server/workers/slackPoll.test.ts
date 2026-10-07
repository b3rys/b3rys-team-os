// slackPoll 쓰레드 댓글 회귀 가드 — conversations.history 는 최상위 글만 준다. 쓰레드 안 @멘션도 받는지,
// 같은 댓글을 두 번 처리하지 않는지, 폴링 시작 전 댓글을 되살리지 않는지.
import { test, expect, mock, beforeAll, afterAll } from "bun:test";

const CH = "CTESTCHAN1";
process.env.TEAM_SLACK_POLL_CHANNELS = CH;
process.env.TEAM_SLACK_POLL_TOKEN_AGENT = "bill";
process.env.TEAM_SLACK_POLL_INTERVAL_MS = "3600000"; // 테스트가 tick 을 직접 기다린다 — 자동 반복은 사실상 끔
process.env.TEAM_SLACK_POLL_LOOKBACK_SEC = "3600";
process.env.TEAM_SLACK_POLL_THREAD_WINDOW_SEC = String(7 * 86400);
process.env.TEAM_SLACK_POLL_THREAD_PARENT_LOOKBACK_SEC = String(90 * 86400);
process.env.TEAM_SLACK_POLL_THREAD_MAX_PAGES = "5";

const BILL_UID = "UBILL0001";
const handled: { text?: string; ts?: string; thread_ts?: string }[] = [];

const realSlackLib = await import("../lib/slack");
mock.module("../lib/slack", () => ({
  ...realSlackLib,
  loadAgentCreds: () => ({ bot_token: "xoxb-test" }),
}));
const realSlackRoute = await import("../routes/slack");
mock.module("../routes/slack", () => ({
  ...realSlackRoute,
  handleAppMention: async (_deps: unknown, ev: { text?: string; ts?: string; thread_ts?: string }) => {
    handled.push({ text: ev.text, ts: ev.ts, thread_ts: ev.thread_ts });
  },
}));

const audit: { action: string; detail: Record<string, unknown> }[] = [];
const realQueries = await import("../db/queries");
mock.module("../db/queries", () => ({
  ...realQueries,
  appendAudit: (_db: unknown, _actor: string, action: string, _id: unknown, detail: Record<string, unknown>) => {
    audit.push({ action, detail });
  },
}));

const { threadsDue, startSlackPoll, pollOnce, createSlackGetter } = await import("./slackPoll");

// ── 순수 판정 ──
test("threadsDue — 댓글 없는 글·이미 본 쓰레드는 빼고, 새 댓글 있는 쓰레드만", () => {
  const cursors = new Map([["100.0", 150]]);
  const due = threadsDue(
    [
      { ts: "100.0", reply_count: 2, latest_reply: "150.0" }, // 이미 150 까지 봄
      { ts: "200.0", reply_count: 1, latest_reply: "260.0" }, // 처음 — floor(250) 이후 댓글 있음
      { ts: "300.0" }, // 댓글 없음
      { ts: "400.0", reply_count: 1, latest_reply: "240.0" }, // floor 전 댓글만
    ],
    cursors,
    250,
  );
  expect(due).toEqual([{ threadTs: "200.0", oldest: 250 }]);
});

// ── 폴러 → 멘션 처리 함수까지: 가짜 Slack, 버스 저장/실제 wake는 모의 처리 ──
const now = Math.floor(Date.now() / 1000);
const parentTs = `${now - 65 * 86400}.000100`; // 7일 밖, 90일 안의 부모
const oldReplyTs = `${now - 7200}.000200`; // 폴링 시작 전(lookback 밖)
const newReplyTs = `${now - 50}.000300`;
let replyCalls = 0;
let historyPages = 0;
const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    const method = url.pathname.split("/").pop();
    if (method === "conversations.history") {
      // 최상위 글: 부모 하나(멘션 없음). 댓글은 여기 안 나온다 — Slack 실제 동작과 같게.
      const parent = { ts: parentTs, user: "UGD", text: "[b3chat] 주제", reply_count: 2, latest_reply: newReplyTs };
      if (url.searchParams.get("limit") === "200") {
        // 쓰레드 훑기: 활성 쓰레드는 ★둘째 쪽★에 있다(최근 글에 밀려난 오래된 쓰레드 — 리뷰가 잡은 경로)
        if (!url.searchParams.get("cursor")) {
          historyPages++;
          return Response.json({
            ok: true,
            messages: [{ ts: `${now - 10}.000900`, user: "UGD", text: "최근 잡담" }],
            response_metadata: { next_cursor: "page2" },
          });
        }
        historyPages++;
        return Response.json({ ok: true, messages: [parent].filter((p) => Number(p.ts) > Number(url.searchParams.get("oldest"))), response_metadata: { next_cursor: "" } });
      }
      return Response.json({ ok: true, messages: [parent].filter((p) => Number(p.ts) > Number(url.searchParams.get("oldest"))) });
    }
    if (method === "conversations.replies") {
      replyCalls++;
      const oldest = Number(url.searchParams.get("oldest"));
      const all = [
        { ts: parentTs, user: "UGD", text: "[b3chat] 주제" },
        { ts: oldReplyTs, thread_ts: parentTs, user: "UGD", text: `<@${BILL_UID}> 옛 댓글` },
        { ts: newReplyTs, thread_ts: parentTs, user: "UGD", text: `<@${BILL_UID}> 쓰레드 댓글` },
      ];
      return Response.json({ ok: true, messages: all.filter((m) => Number(m.ts) > oldest || m.ts === parentTs) });
    }
    return Response.json({ ok: false, error: "unexpected" });
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const deps = {
  db: {} as never,
  broadcast: () => {},
  agents: () => [{ id: "bill", slack_bot_user_id: BILL_UID }] as never,
};

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

test("쓰레드 댓글의 @멘션이 handleAppMention 으로 간다 — 한 번만, 부모·옛 댓글 제외", async () => {
  handled.length = 0;
  const stop = startSlackPoll(deps);
  await settle();
  stop();
  expect(handled).toEqual([{ text: `<@${BILL_UID}> 쓰레드 댓글`, ts: newReplyTs, thread_ts: parentTs }]);
  expect(replyCalls).toBe(1);
  expect(historyPages).toBe(2); // 첫 쪽에 없던 쓰레드를 둘째 쪽까지 넘겨 찾았다
});

test("다시 시작해도 floor 이전 댓글(옛 댓글)은 되살리지 않는다", async () => {
  handled.length = 0;
  const stop = startSlackPoll(deps);
  await settle();
  stop();
  expect(handled.map((h) => h.text)).not.toContain(`<@${BILL_UID}> 옛 댓글`);
});


test("오래된 부모의 최근 답글만 후보: 같은 tick 반복은 재배달하지 않고 floor 이전 댓글도 제외", async () => {
  handled.length = 0;
  const floor = now - 3600;
  const cursors = new Map<string, number>();
  const tc = new Map<string, Map<string, number>>();
  const requested: string[] = [];
  const get = async (method: string, params: Record<string, string>) => {
    if (method === "conversations.history") {
      if (params.limit !== "200") return { ok: true, messages: [] };
      expect(Number(params.oldest)).toBeLessThan(Number(parentTs));
      return { ok: true, messages: [
        { ts: parentTs, reply_count: 2, latest_reply: newReplyTs },
        { ts: `${now - 60 * 86400}`, reply_count: 1, latest_reply: `${now - 8 * 86400}` },
        { ts: `${now - 50 * 86400}`, reply_count: 1, latest_reply: oldReplyTs },
      ] };
    }
    requested.push(params.ts!);
    expect(Number(params.oldest)).toBeGreaterThanOrEqual(floor);
    // Slack 응답에 floor 이전 항목이 섞여도 로컬에서 제외한다.
    return { ok: true, messages: [
      { ts: parentTs, text: `<@${BILL_UID}> 부모`, user: "UGD" },
      { ts: oldReplyTs, text: `<@${BILL_UID}> 옛 댓글`, user: "UGD" },
      { ts: newReplyTs, text: `<@${BILL_UID}> 최근 댓글`, user: "UGD" },
    ] };
  };
  await pollOnce(deps, cursors, tc, floor, get);
  await pollOnce(deps, cursors, tc, floor, get);
  expect(requested).toEqual([parentTs]);
  expect(handled).toEqual([{ text: `<@${BILL_UID}> 최근 댓글`, ts: newReplyTs, thread_ts: parentTs }]);
  // 재시작 뒤 새 floor 이전 답글은 조회하지 않는다.
  await pollOnce(deps, new Map(), new Map(), now, get);
  expect(requested).toEqual([parentTs]);
});

test("페이지 상한 5쪽: 더 있는 cursor를 audit에 남기고 호출을 멈춘다", async () => {
  audit.length = 0;
  let pages = 0;
  await pollOnce(deps, new Map(), new Map(), now - 3600, async (method, params) => {
    expect(method).toBe("conversations.history");
    if (params.limit === "200") {
      pages++;
      expect(params.cursor).toBe(pages === 1 ? undefined : `page${pages}`);
      return { ok: true, messages: [], response_metadata: { next_cursor: `page${pages + 1}` } };
    }
    return { ok: true, messages: [] };
  });
  expect(pages).toBe(5);
  expect(audit).toEqual([{ action: "slack_poll_thread_scan_capped", detail: {
    channel: CH, max_pages: 5, parent_lookback_sec: 90 * 86400, thread_window_sec: 7 * 86400,
  } }]);
});

test("스레드 조회 상한 10개: 미조회 후보를 다음 tick에서 읽는다", async () => {
  audit.length = 0;
  const parents = Array.from({ length: 11 }, (_, i) => ({
    ts: `${now - 65 * 86400 + i}`, reply_count: 1, latest_reply: `${now - 10 + i}`,
  }));
  const requested: string[] = [];
  const get = async (method: string, params: Record<string, string>) => {
    if (method === "conversations.history") return { ok: true, messages: params.limit === "200" ? parents : [] };
    requested.push(params.ts!);
    return { ok: true, messages: [{ ts: parents.find((p) => p.ts === params.ts)!.latest_reply, user: "UGD", text: "댓글" }] };
  };
  const tc = new Map<string, Map<string, number>>();
  await pollOnce(deps, new Map(), tc, now - 3600, get);
  expect(requested.length).toBe(10);
  expect(audit.some((a) => a.action === "slack_poll_thread_replies_capped")).toBe(true);
  await pollOnce(deps, new Map(), tc, now - 3600, get);
  expect(new Set(requested).size).toBe(11);
});

test("API 메서드별 전 채널 합계 40회/60초 예산, 만료 후 재개", async () => {
  const savedFetch = globalThis.fetch;
  const savedNow = Date.now;
  let clock = now * 1000;
  let calls = 0;
  Date.now = () => clock;
  globalThis.fetch = (async () => { calls++; return Response.json({ ok: true }); }) as unknown as typeof fetch;
  try {
    const get = createSlackGetter();
    for (let i = 0; i < 40; i++) expect((await get("conversations.history", { channel: `CH${i % 3}` })).ok).toBe(true);
    expect(await get("conversations.history", { channel: CH })).toEqual({ ok: false, error: "rate_budget_exhausted" });
    expect(calls).toBe(40);
    expect((await get("conversations.replies", { channel: CH })).ok).toBe(true);
    clock += 60_000;
    expect((await get("conversations.history", { channel: CH })).ok).toBe(true);
    expect(calls).toBe(42);
  } finally { globalThis.fetch = savedFetch; Date.now = savedNow; }
});

test("429 Retry-After 동안 네트워크 재호출 없이 대기, 이후 재개", async () => {
  const savedFetch = globalThis.fetch;
  const savedNow = Date.now;
  let clock = now * 1000;
  let calls = 0;
  Date.now = () => clock;
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1 ? new Response(null, { status: 429, headers: { "Retry-After": "120" } }) : Response.json({ ok: true });
  }) as unknown as typeof fetch;
  try {
    const get = createSlackGetter();
    expect(await get("conversations.history", { channel: CH })).toEqual({ ok: false, error: "ratelimited" });
    clock += 60_000;
    expect(await get("conversations.history", { channel: CH })).toEqual({ ok: false, error: "rate_limit_backoff" });
    expect(calls).toBe(1);
    clock += 60_000;
    expect((await get("conversations.history", { channel: CH })).ok).toBe(true);
    expect(calls).toBe(2);
  } finally { globalThis.fetch = savedFetch; Date.now = savedNow; }
});


test("답글 조회 실패는 커서를 진전시키지 않아 다음 tick에서 재시도한다", async () => {
  handled.length = 0;
  const tc = new Map<string, Map<string, number>>();
  const since = now - 3600;
  let attempts = 0;
  const get = async (method: string, params: Record<string, string>) => {
    if (method === "conversations.history") return { ok: true, messages: params.limit === "200"
      ? [{ ts: parentTs, reply_count: 1, latest_reply: newReplyTs }] : [] };
    attempts++;
    expect(params.oldest).toBe(String(since));
    if (attempts === 1) return { ok: false, error: "rate_budget_exhausted" };
    return { ok: true, messages: [{ ts: newReplyTs, text: `<@${BILL_UID}> 재시도`, user: "UGD" }] };
  };
  await pollOnce(deps, new Map(), tc, since, get);
  expect(tc.get(CH)?.has(parentTs)).toBe(false);
  await pollOnce(deps, new Map(), tc, since, get);
  expect(attempts).toBe(2);
  expect(handled).toEqual([{ ts: newReplyTs, text: `<@${BILL_UID}> 재시도`, thread_ts: parentTs }]);
});
