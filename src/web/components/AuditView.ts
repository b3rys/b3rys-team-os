// SLG cycle1 B — Audit standard-interface screen (read-only).
//
// Time-ordered feed of recipient_state_change events (GET /api/audit?action=...). Rows whose
// close looks heuristic (suspicious_close: ack_only / reply_observed / backfill_transport) are
// highlighted so a human can spot a possibly-premature close at a glance — "바로 찾기" without
// building a query. backfill_transport is labelled '미검증완료'. No writes, no bulk, no filters.
import { apiBase } from "../ws";
import { formatKST } from "../../shared/timeKST";
import { pick } from "../i18n";

interface AuditEvent {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  detail: { from_state?: string; to_state?: string; close_reason?: string; agent_id?: string; match_tier?: string } | null;
  at: string;
  suspicious_close: boolean;
}

function escape(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

function reasonLabel(reason: string | undefined): { text: string; cls: string } {
  // 색은 var 백킹 시맨틱 토큰(라이트/다크 자동 적응). 카테고리 구분은 라벨 텍스트가 함께 전달.
  if (!reason) return { text: "—", cls: "text-slate-500" };
  if (reason === "backfill_transport") return { text: pick("미검증완료", "Unverified done"), cls: "text-status-idle" };
  if (reason === "ack_only" || reason === "reply_observed") return { text: reason, cls: "text-status-idle" };
  if (reason === "explicit_done") return { text: reason, cls: "text-accent-green" };
  return { text: reason, cls: "text-slate-400" };
}

function row(e: AuditEvent): string {
  const d = e.detail ?? {};
  const reason = reasonLabel(d.close_reason);
  const time = escape(formatKST(e.at, { seconds: true }) + " KST");
  const flag = e.suspicious_close
    ? `<span class="px-1.5 py-0.5 rounded text-[10.5px] font-semibold bg-status-idle/15 text-status-idle border border-status-idle/40">${pick("⚠ 의심 close", "⚠ Suspicious close")}</span>`
    : "";
  // 의심 close = 따뜻한 amber 틴트 + 좌측 3px 바(프로토 03_audit). 정상 행은 좌측바 자리만 투명 확보(정렬).
  const rowBg = e.suspicious_close
    ? "bg-status-idle/[0.08] border-l-[3px] border-l-status-idle"
    : "border-l-[3px] border-l-transparent";
  return `
    <div class="px-4 py-2.5 ${rowBg}">
      <div class="flex items-center justify-between gap-2">
        <div class="text-[14px] text-slate-200 truncate">
          <span class="text-accent-green font-medium">${escape(d.agent_id ?? e.actor)}</span>
          <span class="text-slate-600"> · </span>
          <span class="text-slate-400">${escape(d.from_state ?? "?")}</span>
          <span class="text-slate-600 mx-0.5">→</span>
          <span class="text-slate-100 font-medium">${escape(d.to_state ?? "?")}</span>
        </div>
        <span class="text-[12px] text-slate-500 shrink-0 tabular-nums">${time}</span>
      </div>
      <div class="flex items-center gap-2.5 flex-wrap mt-1.5">
        <span class="text-[12px] ${reason.cls}">reason: ${escape(reason.text)}</span>
        ${d.match_tier ? `<span class="text-[11px] text-slate-500">tier:${escape(d.match_tier)}</span>` : ""}
        ${e.target ? `<span class="text-[11px] text-slate-500">msg:${escape(e.target)}</span>` : ""}
        ${flag}
      </div>
    </div>`;
}

export function renderAuditView(root: HTMLElement): void {
  let timer: ReturnType<typeof setInterval> | null = null;

  const draw = (inner: string, sub: string) => {
    root.innerHTML = `
      <div class="h-full flex flex-col min-h-0">
        <div class="flex items-baseline gap-3 px-6 pt-6 pb-0.5 shrink-0">
          <h1 class="text-[22px] font-bold tracking-tight text-slate-100">Audit</h1>
          <span class="text-[13px] text-slate-500">${pick(`recipient_state 전이 · ${sub}`, `recipient_state transitions · ${sub}`)}</span>
        </div>
        <div class="flex-1 overflow-y-auto px-6 pt-4 pb-6">
          <div class="rounded-[14px] bg-surface-3 border border-surface-3 overflow-hidden shadow-[0_1px_2px_rgba(0,0,0,.05)] divide-y divide-surface-3">${inner}</div>
        </div>
      </div>`;
  };

  const load = async () => {
    try {
      const res = await fetch(`${apiBase()}/api/audit?action=recipient_state_change&limit=200`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { events: AuditEvent[] };
      const events = data.events ?? [];
      const suspicious = events.filter((e) => e.suspicious_close).length;
      draw(
        events.length
          ? events.map(row).join("")
          : `<div class="text-center text-slate-600 py-16 text-sm">${pick("전이 이력 없음", "No transition history")}</div>`,
        pick(`read-only · ${events.length}건 · ⚠ 의심 ${suspicious}`, `read-only · ${events.length} · ⚠ suspicious ${suspicious}`),
      );
    } catch (e) {
      draw(
        `<div class="text-center text-txt-red py-16 text-sm">${pick(`불러오기 실패 (${escape(String(e))})`, `Load failed (${escape(String(e))})`)}</div>`,
        pick("오프라인", "Offline"),
      );
    }
  };

  void load();
  timer = setInterval(() => void load(), 5000);
  // best-effort cleanup if the node is detached
  const obs = new MutationObserver(() => {
    if (!root.isConnected && timer) {
      clearInterval(timer);
      timer = null;
      obs.disconnect();
    }
  });
  if (root.parentElement) obs.observe(root.parentElement, { childList: true });
}
