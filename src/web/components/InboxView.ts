// SLG cycle1 B — Inbox standard-interface screen (read-only).
//
// Shows recent bus messages and, per recipient, the SEMANTIC closure state (recipient_state)
// + why it closed (close_reason). Colors come from the shared RECIPIENT_STATE_STYLE contract
// (src/shared) so this screen and the topology agree — and "completed" is the ONLY green.
// Data source: store.busFlow (GET /api/bus/flow), polled while this view is active.
import { store, type BusFlowRecipient, type BusFlowMessage } from "../store";
import {
  RECIPIENT_STATE_STYLE,
  closeReasonCategory,
  type RecipientState,
  type SemanticColorKind,
  type CloseReason,
} from "../../shared/recipientState";
import { formatKST } from "../../shared/timeKST";
import { pick } from "../i18n";

// Inbox default view = action-required only. A message is "action-required" if ANY of its
// recipients is still 'open', 'needs_match_review', or 'blocked'. blocked=막힘도 누군가 풀어줘야
// 진행되는 비종료 상태라 행동필요에 띄운다(OWNER 2026-07-02: "blocked도 행동 필요"). completed/expired/
// acknowledged(activity_assumed 포함)만 기본에서 접힘 — toggle 로 전체.
let showAll = false;
function isActionRequired(m: BusFlowMessage): boolean {
  return m.recipients.some((r) => {
    const s = (r.recipient_state ?? "open") as RecipientState;
    return s === "open" || s === "needs_match_review" || s === "blocked";
  });
}

// kind → theme hex. 'green' is reserved for 'completed' (done). Everything engaged-but-
// unfinished is neutral so "받았다/하는중" can never read as "끝났다".
const KIND_HEX: Record<SemanticColorKind, string> = {
  red: "#ef4444",
  neutral: "#64748b", // slate — engaged, not done
  green: "#22c55e",
  amber: "#f59e0b",
  blocked: "#a855f7",
  muted: "#475569",
};

function escape(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

function semanticOf(r: BusFlowRecipient): RecipientState {
  // older rows or non-semantic recipients may lack recipient_state — treat as 'open'
  const s = (r.recipient_state ?? "open") as RecipientState;
  return RECIPIENT_STATE_STYLE[s] ? s : "open";
}

function stateBadge(r: BusFlowRecipient): string {
  const s = semanticOf(r);
  const style = RECIPIENT_STATE_STYLE[s];
  const hex = KIND_HEX[style.kind];
  return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11.5px] font-semibold"
            style="background:${hex}22;color:${hex};border:1px solid ${hex}55">
            ${escape(r.agent_id)} · ${escape(style.label)}
          </span>`;
}

// close_reason 을 4범주(closeReasonCategory)로 표시 — 실제 답장(explicit_reply)과
// 운영 close(activity_assumed)·미검증(transport_backfill)을 색·라벨로 절대 안 섞는다.
function closeReasonChip(r: BusFlowRecipient): string {
  if (!r.close_reason) return "";
  const cat = closeReasonCategory(r.close_reason as CloseReason);
  const map: Record<string, { label: string; cls: string }> = {
    explicit_reply: { label: r.close_reason, cls: "text-slate-400 border-slate-600/40" },
    activity_assumed: { label: pick("활동추정", "Activity assumed"), cls: "text-txt-blue border-sky-500/40" },
    transport_backfill: { label: pick("미검증완료", "Unverified done"), cls: "text-txt-amber border-amber-500/40" },
    expired: { label: pick("만료", "Expired"), cls: "text-slate-500 border-slate-700/40" },
    other: { label: r.close_reason, cls: "text-slate-400 border-slate-600/40" },
  };
  const { label, cls } = map[cat]!;
  return `<span class="px-1.5 py-0.5 rounded text-[10.5px] border ${cls}" title="${escape(r.close_reason)}">${escape(label)}</span>`;
}

function row(m: BusFlowMessage): string {
  const recips = m.recipients.length
    ? m.recipients
        .map((r) => `<div class="flex items-center gap-1.5 flex-wrap">${stateBadge(r)}${closeReasonChip(r)}</div>`)
        .join("")
    : `<span class="text-[12px] text-slate-500">${pick("— 수신자 없음", "— No recipients")}</span>`;
  // 날짜는 KST 고정(formatKST) + sender→recipient 줄 바로 옆 인라인 (OWNER: 날짜가 중요)
  const time = escape(formatKST(m.created_at));
  return `
    <div class="rounded-[14px] bg-surface-3 border border-surface-3 p-4 mb-3 shadow-[0_1px_2px_rgba(0,0,0,.05)] hover:shadow-[0_4px_16px_rgba(0,0,0,.08)] transition-shadow">
      <div class="flex items-baseline gap-2.5 flex-wrap">
        <div class="text-[14px] font-semibold">
          <span class="text-accent-green">${escape(m.from_agent_id)}</span>
          <span class="text-slate-500 mx-0.5">→</span>
          <span class="text-slate-100">${escape(m.to_agent_id)}</span>
        </div>
        <span class="text-[13px] text-slate-500 tabular-nums">${time} KST</span>
      </div>
      <div class="text-[14px] text-slate-200 leading-relaxed mt-2 break-words">${escape(m.body ?? "")}</div>
      <div class="flex items-center gap-2 flex-wrap mt-3">${recips}</div>
    </div>`;
}

export function renderInboxView(root: HTMLElement): void {
  const update = () => {
    const all = store.getState().busFlow;
    const actionCount = all.filter(isActionRequired).length;
    const msgs = showAll ? all : all.filter(isActionRequired);

    const legend = (Object.keys(RECIPIENT_STATE_STYLE) as RecipientState[])
      .map((s) => {
        const st = RECIPIENT_STATE_STYLE[s];
        const hex = KIND_HEX[st.kind];
        return `<span class="inline-flex items-center gap-1.5 text-[12px] text-slate-400">
                  <span class="w-2 h-2 rounded-full" style="background:${hex}"></span>${escape(st.label)}</span>`;
      })
      .join("");

    // 기본필터(action_required) ↔ 전체 토글 (view-only; 데이터 안 건드림)
    const filterToggle = `
      <button id="inbox-filter-toggle"
        class="px-3.5 py-1.5 rounded-full text-[13px] font-medium border transition-colors ${showAll ? "text-slate-400 border-surface-3 bg-surface-3 hover:text-slate-200" : "text-accent-green border-accent-green/50 bg-accent-green/10"}">
        ${showAll ? pick(`전체 (${all.length})`, `All (${all.length})`) : pick(`행동필요만 (${actionCount})`, `Action required only (${actionCount})`)}
      </button>`;

    const emptyMsg = showAll
      ? pick("메시지 없음", "No messages")
      : pick("행동필요 메시지 없음 — 모두 처리됨 ✓", "No action-required messages — all handled ✓");
    // 주기 re-render(store.subscribe)가 innerHTML을 통째로 다시 그려 스크롤이 맨 위로 튀던 문제
    // (tmux pause와 동류, OWNER R6) → 재생성 전 scrollTop 저장 → 후 복원. 스크롤 div는 wrapper의
    // 마지막 자식이라 element traversal로 잡는다(이 파일은 happy-dom selector 파싱 회피 정책 — 위 click도 동일).
    const _scroller = (el: HTMLElement | null): HTMLElement | null =>
      (el?.firstElementChild?.lastElementChild as HTMLElement | null) ?? null;
    const _prevScroll = _scroller(root)?.scrollTop ?? 0;
    root.innerHTML = `
      <div class="h-full flex flex-col min-h-0">
        <div class="flex items-baseline gap-3 px-6 pt-6 pb-0.5 shrink-0">
          <h1 class="text-[22px] font-bold tracking-tight text-slate-100">Inbox</h1>
          <span class="text-[13px] text-slate-500">${pick("팀 메시지 · read-only", "Team messages · read-only")}</span>
        </div>
        <div class="px-6 pt-3 pb-4 flex items-center justify-between gap-3 flex-wrap shrink-0">
          ${filterToggle}
          <div class="flex items-center gap-3 flex-wrap">${legend}</div>
        </div>
        <div id="inbox-scroll" class="flex-1 overflow-y-auto px-6 pb-6">
          ${msgs.length ? msgs.map(row).join("") : `<div class="text-center text-slate-500 py-16 text-[15px]">${emptyMsg}</div>`}
        </div>
      </div>`;
    const _next = _scroller(root);
    if (_next) _next.scrollTop = _prevScroll;
  };

  // One delegated click listener (survives innerHTML re-renders; no per-render querySelector).
  // Match by id walk (no CSS-selector parse) so it's robust across DOM impls.
  root.addEventListener("click", (e) => {
    let n = e.target as HTMLElement | null;
    while (n && n !== root) {
      if (n.id === "inbox-filter-toggle") {
        showAll = !showAll;
        update();
        return;
      }
      n = n.parentElement;
    }
  });

  update();
  store.subscribe(update);
}
