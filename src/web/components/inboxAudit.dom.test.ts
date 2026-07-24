/**
 * SLG cycle1 B/Phase2 — DOM render proof for Inbox/Audit/Proposal screens.
 * Renders InboxView + AuditView + ProposalsView with happy-dom and asserts Bill's live claims:
 *   ① 탭이 MainView로 존재       ② 상태/close_reason 정확   ③ 의심 close 하이라이트
 *   ④ 비완료 green 아님          ⑤ backfill_transport='미검증완료'
 */
import { describe, expect, test, beforeAll, beforeEach, afterEach } from "bun:test";
import { Window } from "happy-dom";

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  // 공유 global document 를 다른 DOM 테스트 파일(inboxRefined 등)이 먼저 설치했을 수 있다.
  // 그 파일은 document 만 세팅하고 localStorage 는 안 세팅 → 여기서 document 존재만 보고 전체를
  // 건너뛰면 localStorage 가 undefined 로 남아 beforeEach 의 localStorage.clear() 가 터진다.
  // 따라서 window 를 한 번 만들어 두고, 이 파일이 필요로 하는 각 global 을 '없을 때만' 개별 보강한다.
  const win = (g.window as Window | undefined) ?? new Window();
  if (!g.window) g.window = win;
  if (!g.document) g.document = win.document;
  if (!g.localStorage) g.localStorage = win.localStorage;
  if (!g.MutationObserver) g.MutationObserver = win.MutationObserver;
  if (!g.MouseEvent) g.MouseEvent = win.MouseEvent;
  if (!g.Response) g.Response = win.Response ?? globalThis.Response;
  (win as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
});

const COMPLETED_GREEN = "#22c55e";
const NEUTRAL = "#64748b";

describe("InboxView — recipient_state rendering (②④⑤)", () => {
  test("renders state badges + close_reason; completed=green, non-completed≠green, backfill='미검증완료'", async () => {
    const { store } = await import("../store");
    const { renderInboxView } = await import("./InboxView");

    store.getState().setBusFlow([
      {
        id: "m1", thread_id: "t1", from_agent_id: "bill", to_agent_id: "steve",
        type: "dm", source: "agent", priority: "normal", body: "처리해줘", created_at: "2026-06-13T01:00:00",
        recipients: [
          { agent_id: "steve", delivery_state: "wake_dispatched", recipient_state: "acknowledged", close_reason: "ack_only", last_error: null, updated_at: null },
          { agent_id: "demis", delivery_state: "wake_dispatched", recipient_state: "in_progress", close_reason: "reply_observed", last_error: null, updated_at: null },
          { agent_id: "dbak", delivery_state: "completed", recipient_state: "completed", close_reason: "explicit_done", last_error: null, updated_at: null },
          { agent_id: "hermes", delivery_state: "completed", recipient_state: "completed", close_reason: "backfill_transport", last_error: null, updated_at: null },
          // open recipient → message is action-required so it renders under the default filter (Inbox-refined)
          { agent_id: "nova", delivery_state: "wake_dispatched", recipient_state: "open", close_reason: null, last_error: null, updated_at: null },
        ],
      },
    ]);

    const root = document.createElement("div");
    renderInboxView(root);
    const html = root.innerHTML;

    // ② 상태 정확: 라벨 노출
    expect(html).toContain("받음"); // acknowledged
    expect(html).toContain("작업중"); // in_progress
    expect(html).toContain("완료"); // completed

    // ④ 비완료 green 아님: acknowledged/in_progress 배지는 neutral 색, green 아님
    const ackIdx = html.indexOf("steve · 받음");
    const ackBadge = html.slice(ackIdx - 220, ackIdx);
    expect(ackBadge).toContain(NEUTRAL);
    expect(ackBadge).not.toContain(COMPLETED_GREEN);

    // completed 배지에만 green
    const doneIdx = html.indexOf("dbak · 완료");
    const doneBadge = html.slice(doneIdx - 220, doneIdx);
    expect(doneBadge).toContain(COMPLETED_GREEN);
    // in_progress 배지도 green 아님 (neutral)
    const ipIdx = html.indexOf("demis · 작업중");
    expect(html.slice(ipIdx - 220, ipIdx)).not.toContain(COMPLETED_GREEN);

    // ⑤ backfill_transport → '미검증완료'
    expect(html).toContain("미검증완료");

    // 날짜: created_at(UTC 01:00) → KST 10:00, sender 줄 옆 인라인 + 'KST' 라벨
    expect(html).toContain("06-13 10:00 KST");
    // 본문: Mac-native 리디자인 — Tasks 카드 본문 크기(text-[14px], GD 승인 2026-06-20)·밝기 slate-200 유지
    expect(html).toContain("text-[14px] text-slate-200 leading-relaxed");
  });
});

describe("AuditView — suspicious-close highlight (③⑤)", () => {
  test("suspicious rows flagged; backfill labelled 미검증완료", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          events: [
            { id: 3, actor: "steve", action: "recipient_state_change", target: "m1", at: "2026-06-13T01:00:00",
              detail: { from_state: "open", to_state: "acknowledged", close_reason: "ack_only", agent_id: "steve" }, suspicious_close: true },
            { id: 2, actor: "demis", action: "recipient_state_change", target: "m2", at: "2026-06-13T00:59:00",
              detail: { from_state: "in_progress", to_state: "completed", close_reason: "explicit_done", agent_id: "demis" }, suspicious_close: false },
            { id: 1, actor: "system", action: "recipient_state_change", target: "m3", at: "2026-06-13T00:58:00",
              detail: { from_state: "open", to_state: "completed", close_reason: "backfill_transport", agent_id: "hermes" }, suspicious_close: true },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    try {
      const { renderAuditView } = await import("./AuditView");
      const root = document.createElement("div");
      const host = document.createElement("div");
      host.appendChild(root);
      renderAuditView(root);
      await new Promise((r) => setTimeout(r, 30)); // let the async load resolve

      const html = root.innerHTML;
      // ③ 의심 close 하이라이트
      expect(html).toContain("⚠ 의심 close");
      // explicit_done 행은 의심 아님 → 하이라이트 1개 이상이지만 모든 행은 아님
      expect((html.match(/의심 close/g) ?? []).length).toBeGreaterThanOrEqual(2); // ack_only + backfill
      // ⑤ backfill → 미검증완료
      expect(html).toContain("미검증완료");
      // 전이 방향 표시
      expect(html).toContain("completed");
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("ProposalsView — read-only list/detail", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("renders status columns, proposal rows, reviews, and decision_log", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/proposals")) {
        return new Response(
          JSON.stringify({
            proposals: [
              {
                id: "prop_A",
                title: "[A] ack-close",
                summary: "directed 응답 시 원본 completed 처리",
                source: "loop",
                proposer_agent: "bill",
                status: "accepted",
                priority: "high",
                effort_minutes: 20,
                expected_value: "pending/red 제거",
                risk_level: "medium",
                evidence_refs: "audit",
                north_star_alignment: "trust backbone",
                duplicate_of: null,
                created_at: "2026-06-13 01:00:00",
                updated_at: "2026-06-13 02:00:00",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          proposal: {
            id: "prop_A",
            title: "[A] ack-close",
            summary: "directed 응답 시 원본 completed 처리",
            source: "loop",
            proposer_agent: "bill",
            status: "accepted",
            priority: "high",
            effort_minutes: 20,
            expected_value: "pending/red 제거",
            risk_level: "medium",
            evidence_refs: "audit",
            north_star_alignment: "trust backbone",
            duplicate_of: null,
            created_at: "2026-06-13 01:00:00",
            updated_at: "2026-06-13 02:00:00",
          },
          reviews: [
            {
              id: "rev_1",
              proposal_id: "prop_A",
              reviewer_agent: "steve",
              stage: "peer",
              verdict: "approve",
              is_adversarial: 0,
              comments: "좋음",
              required_changes: null,
              created_at: "2026-06-13 02:30:00",
            },
          ],
          decision_log: [
            {
              id: 1,
              proposal_id: "prop_A",
              actor: "gd",
              action: "transition",
              from_status: "gd_report",
              to_status: "accepted",
              reason: "GD 승인",
              created_at: "2026-06-13 03:00:00",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      const { renderProposalsView } = await import("./ProposalsView");
      const root = document.createElement("div");
      renderProposalsView(root);
      await new Promise((r) => setTimeout(r, 40));

      const html = root.innerHTML;
      expect(html).toContain("Proposals · SLG(자가학습 거버넌스) 제안");
      expect(html).toContain("Accepted");
      expect(html).toContain("[A] ack-close");
      expect(html).toContain("Review Timeline");
      expect(html).toContain("steve");
      expect(html).toContain("Decision Log");
      expect(html).toContain("GD 승인");
      expect(html).toContain("06-13 11:00 KST");
      const boardScroll = root.querySelector("[data-proposals-board-scroll]");
      const boardPane = boardScroll?.parentElement;
      const split = root.querySelector<HTMLElement>("[data-proposals-split]");
      const resizeHandle = root.querySelector<HTMLElement>("[data-proposals-resize-detail]");
      expect(boardScroll?.className).toContain("h-full");
      expect(boardScroll?.className).toContain("min-h-0");
      expect(boardScroll?.className).toContain("overflow-y-auto");
      expect(boardPane?.className).toContain("flex");
      expect(boardPane?.className).toContain("min-h-0");
      expect(boardPane?.className).toContain("overflow-hidden");
      expect(split?.style.gridTemplateColumns).toBe("minmax(0, 1fr) 6px 448px");
      expect(resizeHandle).toBeTruthy();
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("keeps board scroll when an accepted card is selected and resizes detail pane", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/proposals")) {
        return new Response(
          JSON.stringify({
            proposals: Array.from({ length: 12 }, (_, i) => ({
              id: `prop_${i}`,
              title: `[${i}] accepted proposal`,
              summary: "스크롤 보존 검증",
              source: "loop",
              proposer_agent: "bill",
              status: "accepted",
              priority: "high",
              effort_minutes: 20,
              expected_value: "accepted 카드 클릭에도 보드 위치 유지",
              risk_level: "low",
              evidence_refs: "live",
              north_star_alignment: "trust backbone",
              duplicate_of: null,
              created_at: "2026-06-13 01:00:00",
              updated_at: "2026-06-13 02:00:00",
            })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const id = decodeURIComponent(url.split("/api/proposals/")[1] ?? "prop_0");
      return new Response(
        JSON.stringify({
          proposal: {
            id,
            title: `[detail] ${id}`,
            summary: "detail",
            source: "loop",
            proposer_agent: "bill",
            status: "accepted",
            priority: "high",
            effort_minutes: 20,
            expected_value: "value",
            risk_level: "low",
            evidence_refs: "live",
            north_star_alignment: "trust backbone",
            duplicate_of: null,
            created_at: "2026-06-13 01:00:00",
            updated_at: "2026-06-13 02:00:00",
          },
          reviews: [],
          decision_log: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      const { renderProposalsView } = await import("./ProposalsView");
      const root = document.createElement("div");
      renderProposalsView(root);
      await new Promise((r) => setTimeout(r, 40));

      let boardScroll = root.querySelector<HTMLElement>("[data-proposals-board-scroll]");
      expect(boardScroll).toBeTruthy();
      boardScroll!.scrollTop = 180;

      const acceptedCard = root.querySelector<HTMLButtonElement>('[data-proposal-id="prop_8"]');
      acceptedCard?.click();
      boardScroll = root.querySelector<HTMLElement>("[data-proposals-board-scroll]");
      expect(boardScroll?.scrollTop).toBe(180);
      await new Promise((r) => setTimeout(r, 40));
      boardScroll = root.querySelector<HTMLElement>("[data-proposals-board-scroll]");
      expect(boardScroll?.scrollTop).toBe(180);

      const split = root.querySelector<HTMLElement>("[data-proposals-split]")!;
      split.getBoundingClientRect = () => ({ left: 0, right: 900, top: 0, bottom: 500, width: 900, height: 500, x: 0, y: 0, toJSON: () => ({}) });
      const handle = root.querySelector<HTMLElement>("[data-proposals-resize-detail]")!;
      handle.dispatchEvent(new MouseEvent("mousedown", { clientX: 452, bubbles: true }));
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 500 }));
      expect(split.style.gridTemplateColumns).toBe("minmax(0, 1fr) 6px 400px");
      window.dispatchEvent(new MouseEvent("mouseup", { clientX: 500 }));
      expect(localStorage.getItem("bill-dash-proposals-detail-w")).toBe("400");
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("archives a proposal from the detail pane and removes it from the visible list", async () => {
    const origFetch = globalThis.fetch;
    let archived = false;
    const methods: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      methods.push(init?.method ?? "GET");
      if (url.endsWith("/api/proposals")) {
        return new Response(
          JSON.stringify({
            proposals: archived
              ? []
              : [
                  {
                    id: "prop_delete",
                    title: "[test] delete me",
                    summary: "삭제 후 보관",
                    source: "loop",
                    proposer_agent: "bill",
                    status: "accepted",
                    priority: "low",
                    effort_minutes: 10,
                    expected_value: "목록 정리",
                    risk_level: "low",
                    evidence_refs: "test",
                    north_star_alignment: "ops",
                    duplicate_of: null,
                    created_at: "2026-06-26 01:00:00",
                    updated_at: "2026-06-26 02:00:00",
                  },
                ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (init?.method === "DELETE" && url.includes("/api/proposals/prop_delete")) {
        archived = true;
        return new Response(JSON.stringify({ ok: true, archived: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          proposal: {
            id: "prop_delete",
            title: "[test] delete me",
            summary: "삭제 후 보관",
            source: "loop",
            proposer_agent: "bill",
            status: "accepted",
            priority: "low",
            effort_minutes: 10,
            expected_value: "목록 정리",
            risk_level: "low",
            evidence_refs: "test",
            north_star_alignment: "ops",
            duplicate_of: null,
            created_at: "2026-06-26 01:00:00",
            updated_at: "2026-06-26 02:00:00",
          },
          reviews: [],
          decision_log: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      const { renderProposalsView } = await import("./ProposalsView");
      const root = document.createElement("div");
      renderProposalsView(root);
      await new Promise((r) => setTimeout(r, 40));

      const archive = root.querySelector<HTMLButtonElement>("[data-archive-proposal='prop_delete']");
      expect(archive).toBeTruthy();
      archive?.click();

      expect(root.querySelector("[data-proposal-action-modal]")?.textContent).toContain("proposal 보관 확인");
      const form = root.querySelector<HTMLFormElement>("[data-proposal-action-form]");
      expect(form).toBeTruthy();
      form?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 40));

      expect(methods).toContain("DELETE");
      expect(archived).toBe(true);
      expect(root.textContent).toContain("등록된 proposal이 없습니다.");
      expect(root.querySelector("[data-proposal-id='prop_delete']")).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("opens an in-page modal for GD decisions and sends the typed comment", async () => {
    const origFetch = globalThis.fetch;
    let transitionPayload: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/proposals")) {
        return new Response(
          JSON.stringify({
            proposals: [
              {
                id: "prop_decide",
                title: "[test] decide me",
                summary: "팀장 결정 대기",
                source: "loop",
                proposer_agent: "bill",
                status: transitionPayload ? "accepted" : "gd_report",
                priority: "high",
                effort_minutes: 10,
                expected_value: "승인 테스트",
                risk_level: "low",
                evidence_refs: "test",
                north_star_alignment: "ops",
                duplicate_of: null,
                created_at: "2026-06-26 01:00:00",
                updated_at: "2026-06-26 02:00:00",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (init?.method === "POST" && url.includes("/api/proposals/prop_decide/transition")) {
        transitionPayload = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          proposal: {
            id: "prop_decide",
            title: "[test] decide me",
            summary: "팀장 결정 대기",
            source: "loop",
            proposer_agent: "bill",
            status: transitionPayload ? "accepted" : "gd_report",
            priority: "high",
            effort_minutes: 10,
            expected_value: "승인 테스트",
            risk_level: "low",
            evidence_refs: "test",
            north_star_alignment: "ops",
            duplicate_of: null,
            created_at: "2026-06-26 01:00:00",
            updated_at: "2026-06-26 02:00:00",
          },
          reviews: [],
          decision_log: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      const { renderProposalsView } = await import("./ProposalsView");
      const root = document.createElement("div");
      renderProposalsView(root);
      await new Promise((r) => setTimeout(r, 40));

      const approve = root.querySelector<HTMLButtonElement>("[data-gd-decision='accepted']");
      expect(approve).toBeTruthy();
      approve?.click();

      const modal = root.querySelector("[data-proposal-action-modal]");
      expect(modal?.textContent).toContain("승인 사유/코멘트");
      const textarea = root.querySelector<HTMLTextAreaElement>("[data-proposal-action-comment]");
      expect(textarea).toBeTruthy();
      textarea!.value = "승인합니다. 실행하세요.";
      root.querySelector<HTMLFormElement>("[data-proposal-action-form]")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 40));

      expect(transitionPayload as Record<string, unknown> | null).toEqual({
        to: "accepted",
        actor: "gd",
        reason: "승인합니다. 실행하세요.",
        comment: "승인합니다. 실행하세요.",
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("shows GD decision failures inside the modal without native alert", async () => {
    const origFetch = globalThis.fetch;
    const origAlert = window.alert;
    let alertCalled = false;
    window.alert = () => { alertCalled = true; };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/proposals")) {
        return new Response(
          JSON.stringify({
            proposals: [
              {
                id: "prop_fail",
                title: "[test] fail me",
                summary: "팀장 결정 실패",
                source: "loop",
                proposer_agent: "bill",
                status: "gd_report",
                priority: "high",
                effort_minutes: 10,
                expected_value: "실패 테스트",
                risk_level: "low",
                evidence_refs: "test",
                north_star_alignment: "ops",
                duplicate_of: null,
                created_at: "2026-06-26 01:00:00",
                updated_at: "2026-06-26 02:00:00",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (init?.method === "POST" && url.includes("/api/proposals/prop_fail/transition")) {
        return new Response(JSON.stringify({ error: "comment required" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          proposal: {
            id: "prop_fail",
            title: "[test] fail me",
            summary: "팀장 결정 실패",
            source: "loop",
            proposer_agent: "bill",
            status: "gd_report",
            priority: "high",
            effort_minutes: 10,
            expected_value: "실패 테스트",
            risk_level: "low",
            evidence_refs: "test",
            north_star_alignment: "ops",
            duplicate_of: null,
            created_at: "2026-06-26 01:00:00",
            updated_at: "2026-06-26 02:00:00",
          },
          reviews: [],
          decision_log: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      const { renderProposalsView } = await import("./ProposalsView");
      const root = document.createElement("div");
      renderProposalsView(root);
      await new Promise((r) => setTimeout(r, 40));

      root.querySelector<HTMLButtonElement>("[data-gd-decision='accepted']")?.click();
      root.querySelector<HTMLFormElement>("[data-proposal-action-form]")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 40));

      expect(alertCalled).toBe(false);
      expect(root.querySelector("[data-proposal-action-modal]")).toBeTruthy();
      expect(root.querySelector("[data-proposal-action-error]")?.textContent).toContain("comment required");
    } finally {
      globalThis.fetch = origFetch;
      window.alert = origAlert;
    }
  });

  test("shows revise_requested inside Draft instead of a separate stage", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/proposals")) {
        return new Response(
          JSON.stringify({
            proposals: [
              {
                id: "prop_revise",
                title: "[skill] needs revision",
                summary: "수정 요청 상태",
                source: "loop",
                proposer_agent: "steve",
                status: "revise_requested",
                priority: "medium",
                effort_minutes: 30,
                expected_value: "검증",
                risk_level: "low",
                evidence_refs: "review",
                north_star_alignment: "learning",
                duplicate_of: null,
                created_at: "2026-06-24 01:00:00",
                updated_at: "2026-06-24 02:00:00",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          proposal: {
            id: "prop_revise",
            title: "[skill] needs revision",
            summary: "수정 요청 상태",
            source: "loop",
            proposer_agent: "steve",
            status: "revise_requested",
            priority: "medium",
            effort_minutes: 30,
            expected_value: "검증",
            risk_level: "low",
            evidence_refs: "review",
            north_star_alignment: "learning",
            duplicate_of: null,
            created_at: "2026-06-24 01:00:00",
            updated_at: "2026-06-24 02:00:00",
          },
          reviews: [],
          decision_log: [
            {
              id: 1,
              proposal_id: "prop_revise",
              actor: "codex",
              action: "transition",
              from_status: "peer_review",
              to_status: "revise_requested",
              reason: "수정 요청",
              created_at: "2026-06-24 02:00:00",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      const { renderProposalsView } = await import("./ProposalsView");
      const root = document.createElement("div");
      renderProposalsView(root);
      await new Promise((r) => setTimeout(r, 40));

      const columns = Array.from(root.querySelectorAll("section"));
      const draftColumn = columns.find((el) => el.textContent?.includes("Draft"));
      const peerColumn = columns.find((el) => el.textContent?.includes("Review"));
      expect(draftColumn?.textContent).toContain("[skill] needs revision");
      expect(draftColumn?.textContent).toContain("수정 요청 반영 대기");
      expect(peerColumn?.textContent).not.toContain("[skill] needs revision");
      const card = root.querySelector<HTMLButtonElement>('[data-proposal-id="prop_revise"]');
      expect(card?.className).toContain("bg-status-idle/8");
      expect(card?.className).not.toContain("bg-accent-green/10");
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("① 화면이 MainView로 존재", () => {
  test("store accepts inbox/audit/proposals views", async () => {
    const { store } = await import("../store");
    store.getState().setMainView("inbox");
    expect(store.getState().mainView).toBe("inbox");
    store.getState().setMainView("audit");
    expect(store.getState().mainView).toBe("audit");
    store.getState().setMainView("proposals");
    expect(store.getState().mainView).toBe("proposals");
  });
});

afterEach(() => {
  // nothing persistent to clean; store is module-singleton
});
