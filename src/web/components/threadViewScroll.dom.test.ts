/**
 * ThreadView 스크롤 유지 — DOM 회귀 테스트.
 *   증상(2026-08-01, GD 리포트): 1:1 스레드에서 위로 스크롤해 이전 보고를 읽는 중에도
 *   폴링 재렌더마다 무조건 바닥으로 끌려 내려감 (구현이 재렌더 후 scrollTop=scrollHeight 고정).
 *   기대: 바닥 근처일 때만 stick, 위에서 읽는 중이면 위치 보존.
 *
 *   happy-dom 은 레이아웃이 없어 scrollHeight 를 "메시지 노드 수 × 500px" getter 로 주입한다 —
 *   innerHTML 재작성 순간에 scrollHeight 가 변하는 실제 브라우저 타이밍(캡처는 옛 높이,
 *   적용은 새 높이)을 그대로 재현하기 위해서다.
 */
import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { Window } from "happy-dom";

afterEach(() => {
  const b = (globalThis as { document?: Document }).document?.body;
  if (b) b.innerHTML = "";
});

// ★여기서 심은 전역은 여기서 걷는다★ (inboxRefined.dom.test.ts 와 동일 규약 — bun test 는
//   파일들을 한 프로세스에서 돌리므로 되돌리지 않으면 뒤에 도는 서버 테스트가 오염된다.)
const installedGlobals: string[] = [];
const savedGlobals: Record<string, unknown> = {};

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  // 다른 DOM 테스트 파일이 먼저 window 를 심었을 수 있다 — 있으면 재사용, 없는 global 만 보강.
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
  // happy-dom 20.9 워크어라운드(inboxAudit.dom.test.ts 와 동일): SelectorParser 가 querySelector
  // 마다 `new this.window.SyntaxError(...)` 를 즉시 생성하는데 Window 에 SyntaxError 가 없어
  // "undefined is not a constructor" 로 터진다 → 표준 SyntaxError 를 심는다.
  (win as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
});

afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const k of installedGlobals) g[k] = savedGlobals[k];
});

const MSG_PX = 500; // 메시지 1개당 가상 높이
const VIEWPORT_PX = 400;

/** happy-dom 레이아웃 부재 보완: scrollHeight = 자식 수 × MSG_PX (innerHTML 재작성 시 자동 반영). */
function mockMetrics(el: HTMLElement): void {
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => el.children.length * MSG_PX,
  });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => VIEWPORT_PX });
}

function msg(id: string, body: string) {
  return {
    id,
    thread_id: "th-scroll",
    from_agent_id: "lisa",
    to_agent_id: "user",
    type: "dm",
    body,
    source: "agent" as const,
    hop_count: 0,
    in_reply_to: null,
    read_at: null,
    delivery_status: "delivered" as const,
    retry_count: 0,
    expires_at: null,
    priority: "normal" as const,
    dedupe_key: null,
    created_at: "2026-08-01 04:00:00",
  };
}

const thread = {
  id: "th-scroll",
  title: "scroll test",
  kind: "dm" as const,
  participants: ["user", "lisa"],
  moderator_agent_id: null,
  status: "open" as const,
  state: "active",
  round_no: 0,
  last_message_at: null,
  opened_by: "user",
  opened_at: "2026-08-01 04:00:00",
  closed_at: null,
};

describe("ThreadView scroll retention", () => {
  test("위에서 읽는 중 재렌더 → 위치 보존 · 바닥 근처 재렌더 → 바닥 stick · 내 전송 → 바닥", async () => {
    const { store } = await import("../store");
    const { renderThreadView } = await import("./ThreadView");

    const root = document.createElement("div");
    document.body.appendChild(root);

    const st = store.getState();
    const prevSelected = store.getState().selectedThreadId;
    const prevThreads = store.getState().threads;
    const prevThreadMessages = store.getState().threadMessages;
    // 전송(sendMessage→fetch)이 실서버로 나가지 않게 성공 응답으로 목킹.
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      st.setThreads([thread as never]);
      st.setThreadMessages("th-scroll", [msg("m1", "첫 보고"), msg("m2", "둘째 보고")] as never);
      renderThreadView(root);
      st.selectThread("th-scroll");

      const body = root.querySelector<HTMLElement>("#thread-msgs");
      expect(body).not.toBeNull();
      mockMetrics(body!);
      // 전제 확인: 메시지 2개 → scrollHeight 1000, 뷰포트 400 → 스크롤 가능.
      expect(body!.scrollHeight).toBe(1000);

      // ── 시나리오 1: 위로 스크롤해 읽는 중(120px 지점) + 새 메시지 폴링 도착 ──
      body!.scrollTop = 120;
      st.setThreadMessages("th-scroll", [
        msg("m1", "첫 보고"),
        msg("m2", "둘째 보고"),
        msg("m3", "새 보고"),
      ] as never);
      // 같은 스레드 재렌더 — 컨테이너 요소는 유지된다(#thread-msgs 재사용).
      const bodyAfter = root.querySelector<HTMLElement>("#thread-msgs");
      expect(bodyAfter).toBe(body); // 같은 요소여야 위치 보존이 의미 있다
      expect(body!.scrollHeight).toBe(1500); // 재렌더로 내용이 자람
      expect(body!.scrollTop).toBe(120); // ★핵심: 바닥으로 끌려가면 회귀★

      // ── 시나리오 2: 정확히 바닥(1500-400=1100)에서 새 메시지 → 새 바닥 따라감 ──
      body!.scrollTop = 1100;
      st.setThreadMessages("th-scroll", [
        msg("m1", "첫 보고"),
        msg("m2", "둘째 보고"),
        msg("m3", "새 보고"),
        msg("m4", "더 새 보고"),
      ] as never);
      expect(body!.scrollHeight).toBe(2000);
      expect(body!.scrollTop).toBe(2000); // stick: scrollTop=scrollHeight (브라우저가 최대로 클램프)

      // ── 시나리오 3: 내용 변화 없는 폴링 틱에서도 읽던 위치 보존 ──
      body!.scrollTop = 300;
      st.setThreadMessages("th-scroll", [
        msg("m1", "첫 보고"),
        msg("m2", "둘째 보고"),
        msg("m3", "새 보고"),
        msg("m4", "더 새 보고"),
      ] as never);
      expect(body!.scrollTop).toBe(300);

      // ── 시나리오 4(리뷰 #1 회귀 가드): 위에서 읽는 중이어도 ★내 전송★은 즉시 바닥으로 ──
      // 없으면 내 메시지가 뜰 자리가 안 보여 "전송이 조용히 실패한 것"처럼 보인다.
      body!.scrollTop = 300; // 위에서 읽는 중
      const input = root.querySelector<HTMLInputElement>("#thread-input")!;
      const form = root.querySelector<HTMLFormElement>("#thread-form")!;
      input.value = "내 답장";
      const EventCtor = (globalThis.window as unknown as { Event: typeof Event }).Event;
      form.dispatchEvent(new EventCtor("submit", { bubbles: true, cancelable: true }));
      // 핸들러 동기 구간에서 즉시 바닥으로 (4개 메시지 = scrollHeight 2000)
      expect(body!.scrollTop).toBe(2000);
      // 바닥에 머무는 동안 내 메시지 도착 → 별도 플래그 없이 일반 캡처 로직으로 자연히 stick
      st.setThreadMessages("th-scroll", [
        msg("m1", "첫 보고"),
        msg("m2", "둘째 보고"),
        msg("m3", "새 보고"),
        msg("m4", "더 새 보고"),
        msg("m5", "내 답장"),
      ] as never);
      expect(body!.scrollTop).toBe(2500);
      // 전송 후라도 사용자가 다시 위로 올라갔으면 보존 — Chat 과 동일한 의도 해석(스크롤 = 의도 신호)
      body!.scrollTop = 200;
      st.setThreadMessages("th-scroll", [
        msg("m1", "첫 보고"),
        msg("m2", "둘째 보고"),
        msg("m3", "새 보고"),
        msg("m4", "더 새 보고"),
        msg("m5", "내 답장"),
      ] as never);
      expect(body!.scrollTop).toBe(200);
    } finally {
      // 전역 store 오염 정리 — 뒤에 도는 테스트 파일 보호. ★저장해둔 원값을 그대로 복원★(대칭).
      // ★selectThread 를 먼저★: 선택 해제 후의 상태 복원 갱신은 update() 의 early-return(빈 화면)
      // 경로만 타서, 정리 중 재렌더가 본 테스트 대상 DOM 을 다시 만지지 않는다.
      st.selectThread(prevSelected);
      store.setState({ threads: prevThreads, threadMessages: prevThreadMessages });
      globalThis.fetch = prevFetch;
      root.remove();
    }
  });
});
