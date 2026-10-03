// slackPoll 쓰레드 댓글 회귀 가드 — conversations.history 는 최상위 글만 준다. 쓰레드 안 @멘션도 받는지,
// 같은 댓글을 두 번 처리하지 않는지, 폴링 시작 전 댓글을 되살리지 않는지.
import { test, expect, mock, beforeAll, afterAll } from "bun:test";

const CH = "CTESTCHAN1";
process.env.TEAM_SLACK_POLL_CHANNELS = CH;
process.env.TEAM_SLACK_POLL_TOKEN_AGENT = "bill";
process.env.TEAM_SLACK_POLL_INTERVAL_MS = "3600000"; // 테스트가 tick 을 직접 기다린다 — 자동 반복은 사실상 끔
process.env.TEAM_SLACK_POLL_LOOKBACK_SEC = "3600";

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

const { threadsDue, startSlackPoll } = await import("./slackPoll");

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

// ── 끝까지: 가짜 Slack ──
const now = Math.floor(Date.now() / 1000);
const parentTs = `${now - 100}.000100`;
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
        return Response.json({ ok: true, messages: [parent], response_metadata: { next_cursor: "" } });
      }
      return Response.json({ ok: true, messages: [parent] });
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
  }) as typeof fetch;
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
