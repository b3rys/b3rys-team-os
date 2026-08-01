/**
 * Chat(1:1 대화창) 스크롤 유지 — DOM 회귀 테스트 (threadViewScroll.dom.test.ts 의 Chat 판).
 *   Chat 은 자체 1.5s 폴링(fetchMsgs→paintMessages)으로 재렌더한다. 가드하는 계약:
 *   ① 위에서 읽는 중 폴링 재렌더 → 위치 보존   ② 내 전송(낙관적 렌더) → 무조건 바닥(forceStick)
 *   fetch 는 전부 목킹 — 실서버(localhost:7878)로 나가면 안 된다.
 */
import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { Window } from "happy-dom";

afterEach(() => {
  const b = (globalThis as { document?: Document }).document?.body;
  if (b) b.innerHTML = "";
});

const installedGlobals: string[] = [];
const savedGlobals: Record<string, unknown> = {};
let prevFetch: typeof fetch;

const MSGS = [
  { id: "c1", thread_id: "dm-user-lisa", from_agent_id: "lisa", to_agent_id: "user", type: "dm", body: "보고 1", source: "agent", hop_count: 0, in_reply_to: null, read_at: null, delivery_status: "delivered", retry_count: 0, expires_at: null, priority: "normal", dedupe_key: null, created_at: "2026-08-01 04:00:00" },
  { id: "c2", thread_id: "dm-user-lisa", from_agent_id: "lisa", to_agent_id: "user", type: "dm", body: "보고 2", source: "agent", hop_count: 0, in_reply_to: null, read_at: null, delivery_status: "delivered", retry_count: 0, expires_at: null, priority: "normal", dedupe_key: null, created_at: "2026-08-01 04:01:00" },
];

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  const win = (g.window as Window | undefined) ?? new Window();
  for (const [k, v] of [
    ["window", win],
    ["document", win.document],
    ["MutationObserver", win.MutationObserver],
  ] as const) {
    if (!g[k]) {
      savedGlobals[k] = g[k];
      installedGlobals.push(k);
      g[k] = v;
    }
  }
  // happy-dom 20.9 워크어라운드 (inboxAudit.dom.test.ts 참조): querySelector 가 window.SyntaxError 요구.
  (win as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;

  // fetch 전면 목킹: threads 조회 = 고정 메시지, inbox 전송 = 성공. (Bun 전역 Response 사용 —
  // happy-dom Response 를 심으면 뒤에 도는 서버 테스트가 오염된다, inboxRefined 교훈.)
  prevFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("/threads/")) {
      return new Response(JSON.stringify({ messages: MSGS }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/inbox")) {
      return new Response(JSON.stringify({ ok: true, message: { thread_id: "dm-user-lisa" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = prevFetch;
  const g = globalThis as Record<string, unknown>;
  for (const k of installedGlobals) g[k] = savedGlobals[k];
});

const MSG_PX = 500;
const VIEWPORT_PX = 400;

function mockMetrics(el: HTMLElement): void {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => el.children.length * MSG_PX });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => VIEWPORT_PX });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Chat(1:1) scroll retention", () => {
  test("위에서 읽는 중 폴링 재렌더 → 위치 보존 · 내 전송 → 바닥(forceStick)", async () => {
    const { store } = await import("../store");
    const { renderChat } = await import("./Chat");

    const st = store.getState();
    const prevMainView = store.getState().mainView;
    const prevAgents = store.getState().agents;
    const prevAgent = store.getState().selectedAgentId;

    const root = document.createElement("div");
    document.body.appendChild(root);

    try {
      st.setAgents([
        {
          id: "lisa", display_name: "Lisa", role: "PM", runtime: "claude_channel",
          status_provider: "claude_tmux", tmux_session: null, telegram_bot_username: null,
          workspace_path: "/tmp/x", persona_file: "SOUL.md", moderator_eligible: false, avatar_emoji: "🤖",
        } as never,
      ]);
      st.setMainView("chat" as never);
      st.selectAgent("lisa");
      renderChat(root);
      await sleep(80); // reinit → fetchMsgs(목킹) 반영 대기

      const wrap = root.querySelector<HTMLElement>("#chat-msgs");
      expect(wrap).not.toBeNull();
      expect(wrap!.children.length).toBe(2);
      mockMetrics(wrap!); // scrollHeight 1000 · viewport 400

      // ── ① 위에서 읽는 중 + 폴링 재렌더(1.5s 주기) → 위치 보존 ──
      wrap!.scrollTop = 100;
      // 첫 자식에 마커를 심어, 폴링 후 마커가 사라졌는지로 "innerHTML 재작성이 실제 일어났음"을 증명
      // (재렌더 없이 통과하는 공허한 테스트 방지).
      wrap!.children[0]!.setAttribute("data-marker", "pre-poll");
      await sleep(1700); // 폴링 1틱 이상 경과(fetchMsgs→paintMessages)
      expect(wrap!.querySelector("[data-marker]")).toBeNull(); // 재렌더가 실제로 일어났고
      expect(wrap!.children.length).toBe(2); // 내용은 동일한데
      expect(wrap!.scrollTop).toBe(100); // ★위치가 보존되어야 한다★

      // ── ② 위에서 읽는 중이어도 ★내 전송★(낙관적 렌더)은 바닥으로 ──
      const input = root.querySelector<HTMLInputElement>("#chat-input")!;
      const form = root.querySelector<HTMLFormElement>("#chat-form")!;
      input.value = "지시 하나";
      const EventCtor = (globalThis.window as unknown as { Event: typeof Event }).Event;
      form.dispatchEvent(new EventCtor("submit", { bubbles: true, cancelable: true }));
      // submit 핸들러 동기 구간: 낙관적 메시지 추가(3개) + paintMessages(true) → 바닥
      expect(wrap!.children.length).toBe(3);
      expect(wrap!.scrollTop).toBe(1500); // scrollHeight(3×500) — happy-dom 은 클램프 없음
    } finally {
      // 폴링 정지: mainView 를 chat 밖으로 돌리면 update() 가 stopPoll 한다. 이후 원상 복원.
      st.setMainView(prevMainView as never);
      st.selectAgent(prevAgent);
      st.setAgents(prevAgents as never);
      root.remove();
    }
  });
});
