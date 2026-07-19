// ProposalsView — SLG proposal board backed by /api/proposals.

import { formatKST } from "../../shared/timeKST";
import { pick } from "../i18n";
import { apiBase } from "../ws";

type ProposalStatus =
  | "draft"
  | "peer_review"
  | "pm_review"
  | "gd_report"
  | "accepted"
  | "rejected"
  | "revise_requested"
  | "archived_duplicate";

interface ProposalRow {
  id: string;
  title: string;
  summary: string;
  source: string;
  proposer_agent: string;
  status: ProposalStatus;
  priority?: string | null;
  effort_minutes?: number | null;
  expected_value?: string | null;
  risk_level?: string | null;
  evidence_refs?: string | null;
  north_star_alignment?: string | null;
  duplicate_of?: string | null;
  created_at: string;
  updated_at: string;
}

interface ProposalReview {
  id: string;
  proposal_id: string;
  reviewer_agent: string;
  stage: "peer" | "pm" | "owner";
  verdict?: "approve" | "reject" | "concern" | "revise" | null;
  is_adversarial: number;
  comments?: string | null;
  required_changes?: string | null;
  created_at: string;
}

interface DecisionLog {
  id: number;
  proposal_id: string;
  actor: string;
  action: string;
  from_status?: string | null;
  to_status?: string | null;
  reason?: string | null;
  created_at: string;
}

interface ProposalDetail {
  proposal: ProposalRow;
  reviews: ProposalReview[];
  decision_log: DecisionLog[];
}

interface StatusGroup {
  key: ProposalStatus;
  label: string;
  description: string;
}

const STATUS_GROUPS: StatusGroup[] = [
  { key: "draft", label: "Draft", description: pick("초기 등록 · 수정", "New · editing") },
  { key: "peer_review", label: pick("Review", "Review"), description: pick("단일 동료 리뷰", "Single peer review") },
  { key: "gd_report", label: pick("팀장 보고", "Lead report"), description: pick("팀장 결정 대기", "Awaiting lead decision") },
  { key: "accepted", label: "Accepted", description: pick("승인", "Approved") },
  { key: "rejected", label: "Rejected", description: pick("반려", "Rejected") },
];

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shortText(s: string | null | undefined, fallback = "—"): string {
  const trimmed = s?.trim();
  return trimmed ? escape(trimmed) : fallback;
}

function statusLabel(status: string): string {
  if (status === "revise_requested") return pick("수정 요청 반영 대기", "Awaiting revision");
  if (status === "pm_review") return pick("Legacy PM", "Legacy PM");
  if (status === "peer") return pick("Review", "Review");
  if (status === "pm") return pick("Legacy PM", "Legacy PM");
  if (status === "owner") return pick("팀장", "Lead");
  return STATUS_GROUPS.find((g) => g.key === status)?.label ?? status.replace(/_/g, " ");
}

function boardColumnKey(p: ProposalRow): ProposalStatus {
  // revise_requested를 별도 단계/컬럼으로 만들지 않는다. OWNER 피드백(2026-06-24):
  // 수정 요청은 새 단계가 아니라 Draft 안에서 "수정 요청"으로 표시한다.
  if (p.status === "revise_requested") return "draft";
  // pm_review는 2단계 review 시절의 legacy drain 상태다. 새 보드는 별도 PM 컬럼을 만들지 않고
  // 팀장 보고 전 review 대기열 안에서 "legacy" 배지로만 드러낸다.
  if (p.status === "pm_review") return "peer_review";
  return p.status;
}

function statusBadge(status: string): string {
  // 색은 var 백킹 상태토큰(라이트/다크 자동·또렷). 라벨 텍스트가 상태도 함께 전달.
  const cls: Record<string, string> = {
    draft: "border-surface-3 bg-status-offline/12 text-slate-300",
    peer_review: "border-surface-3 bg-status-info/12 text-txt-blue",
    pm_review: "border-surface-3 bg-violet-500/12 text-txt-violet",
    gd_report: "border-surface-3 bg-status-idle/14 text-txt-amber",
    accepted: "border-surface-3 bg-status-running/14 text-txt-green",
    rejected: "border-surface-3 bg-status-blocked/14 text-txt-red",
    revise_requested: "border-surface-3 bg-orange-500/12 text-txt-orange",
    archived_duplicate: "border-surface-3 bg-status-offline/12 text-slate-400",
  };
  return `<span class="rounded border px-2 py-0.5 text-[11px] font-semibold ${cls[status] ?? cls.draft}">${escape(statusLabel(status))}</span>`;
}

function proposalCardTone(p: ProposalRow, selected: boolean): string {
  if (p.status === "revise_requested") {
    return selected
      ? "border-accent-green bg-status-idle/8 ring-1 ring-accent-green/35"
      : "border-status-idle/45 bg-status-idle/8 hover:bg-status-idle/12";
  }
  if (selected) return "border-accent-green bg-accent-green/10";
  return "border-surface-3 bg-surface-2 hover:bg-surface-3";
}

function metaPill(label: string, value: string | number | null | undefined): string {
  if (value == null || value === "") return "";
  return `<span class="rounded border border-surface-3 bg-surface-0/60 px-2 py-0.5 text-[11px] text-slate-400"><span class="text-slate-500">${escape(label)}</span> ${escape(String(value))}</span>`;
}

// ── Next-action 파생 (읽기전용) — peer_review/pm_review/gd_report가 조용히 멈추지 않게 ──
// 현 상태 진입시각: entered_at 컬럼이 없어 decision_log의 마지막 to_status===현재상태 전이시각을 쓰고,
// 없으면 updated_at으로 파생(Codex 합의 2026-06-22). 정체/액션필요는 이 시각 기준 경과로 판정.
const ACTIVE_STATUSES = ["draft", "revise_requested", "peer_review", "pm_review", "gd_report"];
const STALE_HOURS: Record<string, number> = { draft: 24, revise_requested: 24, peer_review: 12, pm_review: 12, gd_report: 24 };
const NO_STORE_FETCH: RequestInit = { cache: "no-store" };

function hoursSince(s: string): number {
  // SQLite datetime('now')은 타임존 없는 UTC 문자열("YYYY-MM-DD HH:MM:SS"). "Z"를 붙여 UTC로 명시 파싱한다.
  // (없으면 new Date가 로컬 타임존(KST)으로 해석 → 정체 경과가 9시간 부풀려짐, OWNER 발견 2026-07-04.)
  const t = new Date(String(s).replace(" ", "T") + "Z").getTime();
  return Number.isNaN(t) ? 0 : Math.max(0, (Date.now() - t) / 3_600_000);
}
function elapsedLabel(h: number): string {
  if (h < 1) return pick(`${Math.round(h * 60)}분`, `${Math.round(h * 60)}m`);
  if (h < 48) return pick(`${Math.round(h)}시간`, `${Math.round(h)}h`);
  return pick(`${Math.round(h / 24)}일`, `${Math.round(h / 24)}d`);
}
function statusEnteredAt(detail: ProposalDetail): string {
  const cur = detail.proposal.status;
  const hits = detail.decision_log.filter((e) => e.to_status === cur);
  return hits.length ? hits[hits.length - 1]!.created_at : detail.proposal.updated_at;
}

interface NextAction { who: string; what: string; why?: string; need: boolean }
function deriveNextAction(detail: ProposalDetail, hrs: number): NextAction {
  const p = detail.proposal;
  const n = detail.reviews.length;
  const stale = (st: string) => hrs > (STALE_HOURS[st] ?? 12);
  switch (p.status) {
    case "draft":
      return { who: p.proposer_agent, what: pick("초안 완성 후 단일 Review 단계로 상정", "Finish draft, then submit to single Review"), need: stale("draft") };
    case "revise_requested":
      return { who: p.proposer_agent, what: pick("수정 반영 후 단일 Review 재요청", "Apply revisions, then re-request single Review"), need: stale("revise_requested") };
    case "peer_review":
      return n === 0
        ? { who: pick("리뷰어(팀원)", "Reviewer (member)"), what: pick("단일 리뷰 필요 — 아직 리뷰 0건", "Single review needed — 0 reviews so far"), why: pick("리뷰어 배정/요청 확인 필요", "Reviewer assignment/request needs checking"), need: true }
        : { who: pick("시스템/담당자", "System/owner"), what: pick("리뷰 1건 확인 후 gd_report로 전이", "Move to gd_report after one review"), why: pick(`리뷰 ${n}건`, `${n} reviews`), need: stale("peer_review") };
    case "pm_review":
      return { who: "PM", what: pick("Legacy PM review 상태 — gd_report/revise/reject로 drain", "Legacy PM review — drain to gd_report/revise/reject"), need: true };
    case "gd_report":
      return { who: pick("팀장", "the team lead"), what: pick("검토 후 승인 / 반려", "Review, then Approve / Reject"), why: pick("팀장 결정 대기열", "Lead decision queue"), need: stale("gd_report") };
    case "accepted":
      return { who: "—", what: pick("승인됨 — 실행/배포 트랙으로 (이 화면 read-only)", "Approved — moves to execution/deploy track (this view is read-only)"), need: false };
    case "rejected":
      return { who: "—", what: pick("반려됨 — 추가 액션 없음", "Rejected — no further action"), need: false };
    default:
      return { who: "—", what: pick("보관/중복 — 추가 액션 없음", "Archived/duplicate — no further action"), need: false };
  }
}
function nextActionPanel(detail: ProposalDetail): string {
  const p = detail.proposal;
  const hrs = hoursSince(statusEnteredAt(detail));
  const elapsed = elapsedLabel(hrs);
  const na = deriveNextAction(detail, hrs);
  const zeroReview = p.status === "peer_review" && detail.reviews.length === 0;
  const isStale = na.need && ACTIVE_STATUSES.includes(p.status) && hrs > (STALE_HOURS[p.status] ?? 12);
  const badge = !na.need
    ? `<span class="rounded border border-surface-3 bg-surface-0 px-2 py-0.5 text-[11px] font-medium text-slate-400">${pick("진행 정상", "On track")}</span>`
    : zeroReview
      ? `<span class="rounded border border-status-blocked/40 bg-status-blocked/14 px-2 py-0.5 text-[11px] font-semibold text-txt-red">${pick("리뷰 0건 · 액션 필요", "0 reviews · action needed")}</span>`
      : isStale
        ? `<span class="rounded border border-status-idle/40 bg-status-idle/14 px-2 py-0.5 text-[11px] font-semibold text-txt-amber">${pick(`정체 ${escape(elapsed)} · 액션 필요`, `Stalled ${escape(elapsed)} · action needed`)}</span>`
        : `<span class="rounded border border-accent-green/40 bg-accent-green/12 px-2 py-0.5 text-[11px] font-semibold text-txt-green">${pick("액션 필요", "Action needed")}</span>`;
  const tone = na.need ? "border-accent-green/40 bg-accent-green/8" : "border-surface-3 bg-surface-2";
  return `
    <div class="mb-4 rounded-md border ${tone} px-4 py-3">
      <div class="mb-1.5 flex items-center justify-between gap-2">
        <h3 class="text-sm font-semibold text-slate-100">${pick("다음 액션 (Next action)", "Next action")}</h3>
        ${badge}
      </div>
      <div class="text-sm leading-6 text-slate-200">
        <span class="font-semibold text-txt-green">${escape(na.who)}</span> — ${escape(na.what)}${na.why ? ` <span class="text-slate-400">· ${escape(na.why)}</span>` : ""}
      </div>
      <div class="mt-1 text-[11px] text-slate-500">${pick(`현 상태(${escape(statusLabel(p.status))}) ${escape(elapsed)}째 · 마지막 변경 ${escape(formatKST(p.updated_at))} KST`, `Current status (${escape(statusLabel(p.status))}) for ${escape(elapsed)} · last change ${escape(formatKST(p.updated_at))} KST`)}</div>
    </div>`;
}

function gdDecisionPanel(p: ProposalRow): string {
  if (p.status !== "gd_report") return "";
  return `
    <div class="mb-4 rounded-md border border-status-idle/40 bg-status-idle/10 px-4 py-3">
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 class="text-sm font-semibold text-slate-100">${pick("팀장 결정", "Lead decision")}</h3>
          <div class="mt-0.5 text-[11px] text-slate-500">${pick("최종 승인/반려는 actor=owner로만 기록됩니다.", "Final approve/reject is recorded only as actor=owner.")}</div>
        </div>
        <div class="flex flex-wrap gap-2">
          <button data-owner-decision="accepted" class="rounded-md border border-accent-green/40 bg-accent-green/15 px-3 py-1.5 text-xs font-semibold text-txt-green hover:bg-accent-green/25">${pick("승인", "Approve")}</button>
          <button data-owner-decision="rejected" class="rounded-md border border-status-blocked/40 bg-status-blocked/14 px-3 py-1.5 text-xs font-semibold text-txt-red hover:bg-status-blocked/24">${pick("반려", "Reject")}</button>
        </div>
      </div>
      <div class="text-xs leading-5 text-slate-400">${pick("결정 후 decision_log와 관련 follow-up 알림이 자동으로 생성됩니다.", "After the decision, decision_log and related follow-up notifications are generated automatically.")}</div>
    </div>`;
}
// 카드(목록)용 — 활성 상태가 정체 임계 넘으면 한눈에 보이는 작은 배지(리뷰 수는 list에 없어 시간 기준).
function cardStaleBadge(p: ProposalRow): string {
  if (!ACTIVE_STATUSES.includes(p.status)) return "";
  const hrs = hoursSince(p.updated_at);
  if (hrs <= (STALE_HOURS[p.status] ?? 12)) return "";
  return `<span class="rounded border border-status-idle/40 bg-status-idle/14 px-1.5 py-0.5 text-[10px] font-semibold text-txt-amber">${pick(`정체 ${escape(elapsedLabel(hrs))}`, `Stalled ${escape(elapsedLabel(hrs))}`)}</span>`;
}

function proposalCard(p: ProposalRow, selectedId: string | null): string {
  const selected = p.id === selectedId;
  return `
    <button data-proposal-id="${escape(p.id)}"
      class="w-full rounded-md border px-3 py-3 text-left transition-colors ${proposalCardTone(p, selected)}">
      <div class="flex flex-col items-start gap-2">
        <div class="min-w-0">
          <div class="text-sm font-semibold text-slate-100 break-words">${escape(p.title)}</div>
          <div class="mt-1 text-xs text-slate-500">
            ${escape(statusLabel(p.status))} · <span class="font-semibold text-accent-green">proposer: ${escape(p.proposer_agent)}</span> · ${escape(formatKST(p.updated_at))} KST
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">${cardStaleBadge(p)}${statusBadge(p.status)}</div>
      </div>
      <div class="mt-2 line-clamp-3 text-sm leading-5 text-slate-400 break-words">${shortText(p.summary, pick("요약 없음", "No summary"))}</div>
      <div class="mt-2 flex flex-wrap gap-1.5">
        ${metaPill("priority", p.priority)}
        ${metaPill("risk", p.risk_level)}
        ${metaPill("effort", p.effort_minutes != null ? `${p.effort_minutes}m` : null)}
      </div>
    </button>`;
}

function statusColumn(g: StatusGroup, proposals: ProposalRow[], selectedId: string | null): string {
  const rows = proposals.filter((p) => boardColumnKey(p) === g.key);
  return `
    <section class="min-w-0 rounded-md border border-surface-3 bg-surface-1/60">
      <div class="border-b border-surface-3 px-3 py-2">
        <div class="flex items-baseline justify-between gap-2">
          <h3 class="text-sm font-semibold text-slate-100">${escape(g.label)}</h3>
          <span class="text-xs text-slate-500">${rows.length}</span>
        </div>
        <div class="mt-0.5 text-xs text-slate-500">${escape(g.description)}</div>
      </div>
      <div class="space-y-2 p-2">
        ${rows.length ? rows.map((p) => proposalCard(p, selectedId)).join("") : `<div class="px-2 py-8 text-center text-xs text-slate-600">${pick("비어 있음", "Empty")}</div>`}
      </div>
    </section>`;
}

function reviewItem(r: ProposalReview): string {
  const flags = [
    statusBadge(r.stage),
    r.verdict ? metaPill("verdict", r.verdict) : "",
    r.is_adversarial ? `<span class="rounded border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-txt-amber">adversarial</span>` : "",
  ].join("");
  const changes = r.required_changes?.trim()
    ? `<div class="mt-2 rounded bg-surface-0/60 px-2 py-1 text-xs leading-5 text-slate-400"><span class="text-slate-500">required</span> ${escape(r.required_changes)}</div>`
    : "";
  return `
    <div class="rounded-md border border-surface-3 bg-surface-2 px-3 py-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="text-sm font-semibold text-slate-200">${escape(r.reviewer_agent)}</div>
        <div class="flex flex-wrap items-center gap-1.5">${flags}</div>
      </div>
      <div class="mt-1 text-xs text-slate-500">${escape(formatKST(r.created_at, { seconds: true }))} KST</div>
      <div class="mt-2 text-sm leading-6 text-slate-300 break-words">${shortText(r.comments, pick("코멘트 없음", "No comments"))}</div>
      ${changes}
    </div>`;
}

function decisionItem(d: DecisionLog): string {
  const fromTo = d.from_status || d.to_status
    ? `<span class="text-slate-500">${escape(d.from_status ?? "—")} -> ${escape(d.to_status ?? "—")}</span>`
    : "";
  return `
    <div class="rounded-md border border-surface-3 bg-surface-2 px-3 py-2">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <div class="text-sm font-semibold text-slate-200">${escape(d.action)}</div>
        <div class="text-xs text-slate-500">${escape(formatKST(d.created_at, { seconds: true }))} KST</div>
      </div>
      <div class="mt-1 flex flex-wrap items-center gap-2 text-xs">
        <span class="text-slate-400">${escape(d.actor)}</span>
        ${fromTo}
      </div>
      ${d.reason?.trim() ? `<div class="mt-2 text-sm leading-5 text-slate-400 break-words">${escape(d.reason)}</div>` : ""}
    </div>`;
}

function detailHtml(detail: ProposalDetail | null, loading: boolean, error: boolean): string {
  if (loading) {
    return `<div class="flex-1 flex items-center justify-center text-sm text-slate-500">${pick("proposal 상세를 불러오는 중...", "Loading proposal detail...")}</div>`;
  }
  if (error) {
    return `<div class="flex-1 flex items-center justify-center text-sm text-status-blocked">${pick("proposal 상세를 불러오지 못했습니다.", "Failed to load proposal detail.")}</div>`;
  }
  if (!detail) {
    return `<div class="flex-1 flex items-center justify-center px-4 text-center text-sm text-slate-500">${pick("왼쪽 목록에서 proposal을 선택하세요.", "Select a proposal from the list on the left.")}</div>`;
  }
  const p = detail.proposal;
  const archiveButton = p.status === "archived_duplicate"
    ? `<span class="rounded border border-surface-3 bg-surface-0 px-2 py-0.5 text-[11px] font-semibold text-slate-400">${pick("보관됨", "Archived")}</span>`
    : `<button data-archive-proposal="${escape(p.id)}" class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-status-blocked/30 bg-surface-0/70 text-txt-red hover:bg-status-blocked/12" title="${pick("목록에서 숨기고 보관", "Hide from list and archive")}" aria-label="${pick("proposal 보관", "Archive proposal")}">
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>
      </button>`;
  return `
    <div data-proposals-detail-scroll class="flex-1 overflow-y-auto p-4">
      <div class="mb-4 rounded-md border border-surface-3 bg-surface-2 px-4 py-4">
        <div class="min-w-0">
          <div class="flex min-w-0 items-start justify-between gap-3">
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <h2 class="min-w-0 break-words text-lg font-semibold text-slate-100">${escape(p.title)}</h2>
              ${statusBadge(p.status)}
            </div>
            ${archiveButton}
          </div>
          <div class="mt-1 text-xs text-slate-500">${escape(p.id)} · <span class="font-semibold text-accent-green">proposer: ${escape(p.proposer_agent)}</span> · updated ${escape(formatKST(p.updated_at))} KST</div>
        </div>
        <p class="mt-3 text-sm leading-6 text-slate-300 break-words">${shortText(p.summary, pick("요약 없음", "No summary"))}</p>
        <div class="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div class="rounded bg-surface-0/60 px-3 py-2">
            <div class="text-[11px] font-semibold uppercase tracking-widest text-slate-500">Expected Value</div>
            <div class="mt-1 text-sm leading-6 text-slate-300 break-words">${shortText(p.expected_value)}</div>
          </div>
          <div class="rounded bg-surface-0/60 px-3 py-2">
            <div class="text-[11px] font-semibold uppercase tracking-widest text-slate-500">Evidence</div>
            <div class="mt-1 text-sm leading-6 text-slate-300 break-words">${shortText(p.evidence_refs)}</div>
          </div>
          <div class="rounded bg-surface-0/60 px-3 py-2">
            <div class="text-[11px] font-semibold uppercase tracking-widest text-slate-500">North Star</div>
            <div class="mt-1 text-sm leading-6 text-slate-300 break-words">${shortText(p.north_star_alignment)}</div>
          </div>
          <div class="rounded bg-surface-0/60 px-3 py-2">
            <div class="text-[11px] font-semibold uppercase tracking-widest text-slate-500">Meta</div>
            <div class="mt-1 flex flex-wrap gap-1.5">
              ${metaPill("source", p.source)}
              ${metaPill("priority", p.priority)}
              ${metaPill("risk", p.risk_level)}
              ${metaPill("effort", p.effort_minutes != null ? `${p.effort_minutes}m` : null)}
              ${metaPill("duplicate", p.duplicate_of)}
            </div>
          </div>
        </div>
      </div>
      ${nextActionPanel(detail)}
      ${gdDecisionPanel(p)}
      <section class="mb-4">
        <div class="mb-2 flex items-center justify-between gap-2">
          <h3 class="text-sm font-semibold text-slate-100">Review Timeline</h3>
          <span class="text-xs text-slate-500">${detail.reviews.length} reviews</span>
        </div>
        <div class="space-y-2">
          ${detail.reviews.length ? detail.reviews.map(reviewItem).join("") : `<div class="rounded-md border border-surface-3 bg-surface-2 px-3 py-6 text-center text-sm text-slate-500">${pick("리뷰 없음", "No reviews")}</div>`}
        </div>
      </section>
      <section>
        <div class="mb-2 flex items-center justify-between gap-2">
          <h3 class="text-sm font-semibold text-slate-100">Decision Log</h3>
          <span class="text-xs text-slate-500">${detail.decision_log.length} events</span>
        </div>
        <div class="space-y-2">
          ${detail.decision_log.length ? detail.decision_log.map(decisionItem).join("") : `<div class="rounded-md border border-surface-3 bg-surface-2 px-3 py-6 text-center text-sm text-slate-500">${pick("decision_log 없음", "No decision_log")}</div>`}
        </div>
      </section>
    </div>`;
}

export function renderProposalsView(root: HTMLElement): void {
  let proposals: ProposalRow[] = [];
  const search = typeof location === "undefined" ? "" : location.search;
  let selectedId: string | null = new URLSearchParams(search).get("proposal");
  let detail: ProposalDetail | null = null;
  let listLoaded = false;
  let listError = false;
  let detailLoading = false;
  let detailError = false;
  let detailScroll = 0; // 상세 패널 스크롤 보존(폴링 full-render 시 위로 튐 방지, OWNER 2026-06-25)
  let pollInFlight = false;
  const detailWidthKey = "bill-dash-proposals-detail-w";
  const detailWidthDefault = 448;
  const detailWidthClamp = [320, 760] as const;
  let detailWidth = readDetailWidth();

  function clampDetailWidth(px: number): number {
    const [min, max] = detailWidthClamp;
    return Math.max(min, Math.min(max, Math.round(px)));
  }

  function readDetailWidth(): number {
    const saved = Number(localStorage.getItem(detailWidthKey));
    return clampDetailWidth(Number.isFinite(saved) && saved > 0 ? saved : detailWidthDefault);
  }

  function boardScrollTop(): number {
    return root.querySelector<HTMLElement>("[data-proposals-board-scroll]")?.scrollTop ?? 0;
  }

  async function loadList() {
    try {
      const res = await fetch(`${apiBase()}/api/proposals`, NO_STORE_FETCH);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { proposals: ProposalRow[] };
      proposals = body.proposals ?? [];
      if (selectedId && !proposals.some((p) => p.id === selectedId)) selectedId = null;
      if (!selectedId && proposals[0]) selectedId = proposals[0].id;
      listError = false;
    } catch (e) {
      console.error("[loadProposals]", e);
      listError = true;
    }
    listLoaded = true;
    render();
    if (selectedId) void loadDetail(selectedId, true); // silent — 폴링·목록갱신 시 상세 스크롤 보존
  }

  async function refreshCurrent() {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      await loadList(); // loadList가 selectedId 상세를 silent 갱신까지 처리(플래시·스크롤튐 없음)
    } finally {
      pollInFlight = false;
    }
  }

  // silent=true(폴링): 로딩 플래시 없이 데이터만 교체 → 상세 스크롤 보존.
  async function loadDetail(id: string, silent = false) {
    selectedId = id;
    detailError = false;
    if (!silent) { detailLoading = true; render(); }
    try {
      const res = await fetch(`${apiBase()}/api/proposals/${encodeURIComponent(id)}`, NO_STORE_FETCH);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      detail = (await res.json()) as ProposalDetail;
      detailError = false;
    } catch (e) {
      console.error("[loadProposalDetail]", e);
      detail = null;
      detailError = true;
    }
    detailLoading = false;
    render();
  }

  function listHtml(): string {
    if (!listLoaded) {
      return `<div class="flex-1 flex items-center justify-center text-sm text-slate-500">${pick("proposal 목록을 불러오는 중...", "Loading proposal list...")}</div>`;
    }
    if (listError) {
      return `<div class="flex-1 flex flex-col items-center justify-center gap-2 text-sm text-slate-500">
        <div>${pick("proposal 목록을 불러오지 못했습니다.", "Failed to load proposal list.")}</div>
        <button data-refresh-proposals class="rounded bg-surface-3 px-3 py-1 text-xs text-slate-200 hover:bg-surface-0">${pick("다시 시도", "Retry")}</button>
      </div>`;
    }
    if (proposals.length === 0) {
      return `<div class="flex-1 flex items-center justify-center text-sm text-slate-500">${pick("등록된 proposal이 없습니다.", "No proposals registered.")}</div>`;
    }
    const primary = STATUS_GROUPS.map((g) => statusColumn(g, proposals, selectedId)).join("");
    const extra = proposals.filter((p) => !STATUS_GROUPS.some((g) => g.key === p.status));
    const extraSection = extra.length
      ? `<section class="mt-3 rounded-md border border-surface-3 bg-surface-1/60 p-2">
           <div class="mb-2 px-1">
             <div class="text-sm font-semibold text-slate-100">${pick("기타 (보관·중복)", "Other (archived · duplicate)")}</div>
             <div class="text-[11px] text-slate-500">${pick("Draft·Review·팀장 보고·Accepted·Rejected 외 상태 모음", "Statuses other than Draft · Review · Lead report · Accepted · Rejected")}</div>
           </div>
           <div class="grid grid-cols-1 gap-2 lg:grid-cols-2 xl:grid-cols-3">${extra.map((p) => proposalCard(p, selectedId)).join("")}</div>
         </section>`
      : "";
    return `<div data-proposals-board-scroll class="flex-1 h-full min-h-0 min-w-0 overflow-y-auto overflow-x-hidden p-3">
      <div class="grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-3">${primary}</div>
      ${extraSection}
    </div>`;
  }

  function render() {
    const scrollTop = boardScrollTop();
    const counts = STATUS_GROUPS
      .map((g) => `${g.label} ${proposals.filter((p) => boardColumnKey(p) === g.key).length}`)
      .join(" · ");
    root.innerHTML = `
      <div class="flex-1 flex flex-col min-h-0">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-surface-3 bg-surface-1 px-4 py-2 shrink-0">
          <div>
            <div class="text-sm font-semibold">${pick("Proposals · SLG(자가학습 거버넌스) 제안", "Proposals · SLG (self-learning governance)")}</div>
            <div class="mt-0.5 text-[11px] text-slate-500">${listError ? pick("오프라인", "Offline") : `workflow — /api/proposals · ${escape(counts)}`}</div>
          </div>
          <button data-refresh-proposals class="rounded bg-surface-3 px-3 py-1.5 text-xs text-slate-200 hover:bg-surface-0">${pick("새로고침", "Refresh")}</button>
        </div>
        <div data-proposals-split class="grid flex-1 min-h-0 min-w-0 overflow-hidden" style="grid-template-columns: minmax(0, 1fr) 6px ${detailWidth}px;">
          <div class="flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-surface-3">${listHtml()}</div>
          <div class="proposal-resize-handle" data-proposals-resize-detail title="${pick("드래그하여 상세 패널 너비 조절", "Drag to resize detail panel")}" aria-label="${pick("Proposal 상세 패널 너비 조절", "Resize proposal detail panel")}" role="separator"></div>
          <div id="proposals-detail" class="min-h-0 min-w-0 flex flex-col">${detailHtml(detail, detailLoading, detailError)}</div>
        </div>
      </div>`;

    const board = root.querySelector<HTMLElement>("[data-proposals-board-scroll]");
    if (board) board.scrollTop = scrollTop;

    // 상세 패널 스크롤 보존 — 폴링 full-render에도 위로 안 튀게(OWNER 2026-06-25). 스크롤 시 위치 기억.
    const detailEl = root.querySelector<HTMLElement>("[data-proposals-detail-scroll]");
    if (detailEl) {
      detailEl.scrollTop = detailScroll;
      detailEl.addEventListener("scroll", () => { detailScroll = detailEl.scrollTop; }, { passive: true });
    }

    root.querySelectorAll<HTMLButtonElement>("[data-refresh-proposals]").forEach((b) =>
      b.addEventListener("click", () => void loadList()));
    root.querySelectorAll<HTMLButtonElement>("[data-proposal-id]").forEach((b) =>
      b.addEventListener("click", () => {
        const url = new URL(window.location.href);
        url.searchParams.set("view", "proposals");
        url.searchParams.set("proposal", b.dataset.proposalId!);
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
        if (b.dataset.proposalId !== selectedId) detailScroll = 0; // 다른 제안 선택 → 상세 맨 위부터
        // 모바일에선 상세가 board(칸반) 한참 밑에 스택돼 '눌러도 안 보이던' 문제(OWNER 2026-06-23)
        // → 카드 탭하면 상세를 화면에 스크롤해 바로 보이게.
        void loadDetail(b.dataset.proposalId!).then(() => {
          if (window.innerWidth < 768) {
            (root.querySelector("#proposals-detail") as HTMLElement | null)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
          }
        });
      }));
    root.querySelectorAll<HTMLButtonElement>("[data-owner-decision]").forEach((b) =>
      b.addEventListener("click", () => {
        if (!detail) return;
        const to = b.dataset.gdDecision;
        if (!to) return;
        const label = to === "accepted" ? pick("승인", "Approve") : to === "rejected" ? pick("반려", "Reject") : pick("수정요청", "Revise");
        const comment = window.prompt(pick(`${label} 사유/코멘트를 입력하세요.`, `Enter a reason/comment for ${label}.`), "");
        if (comment === null) return;
        b.disabled = true;
        void fetch(`${apiBase()}/api/proposals/${encodeURIComponent(detail.proposal.id)}/transition`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to,
            actor: "owner",
            reason: comment.trim() || label, // reason = 감사 로그용(라벨 fallback 유지)
            comment: comment.trim(), // 지시 코멘트: 빈이면 빈 전송 → 서버 '지시 필수' 가드가 거부(OWNER 승인 시 지시 필수)
          }),
        })
          .then(async (res) => {
            if (!res.ok) {
              const body = (await res.json().catch(() => ({}))) as { error?: string };
              throw new Error(body.error ?? `HTTP ${res.status}`);
            }
            await loadList();
            if (selectedId) await loadDetail(selectedId);
          })
          .catch((e) => {
            window.alert(pick(`결정 처리 실패: ${e instanceof Error ? e.message : String(e)}`, `Decision failed: ${e instanceof Error ? e.message : String(e)}`));
          })
          .finally(() => {
            b.disabled = false;
          });
      }));
    root.querySelectorAll<HTMLButtonElement>("[data-archive-proposal]").forEach((b) =>
      b.addEventListener("click", () => {
        if (!detail) return;
        const id = b.dataset.archiveProposal;
        if (!id) return;
        const ok = window.confirm(pick(`이 proposal을 목록에서 숨기고 보관할까요?\n\n${detail.proposal.title}`, `Hide and archive this proposal from the list?\n\n${detail.proposal.title}`));
        if (!ok) return;
        b.disabled = true;
        void fetch(`${apiBase()}/api/proposals/${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actor: "owner",
            reason: "proposal tab delete/archive",
          }),
        })
          .then(async (res) => {
            if (!res.ok) {
              const body = (await res.json().catch(() => ({}))) as { error?: string };
              throw new Error(body.error ?? `HTTP ${res.status}`);
            }
            selectedId = null;
            detail = null;
            detailScroll = 0;
            const url = new URL(window.location.href);
            url.searchParams.delete("proposal");
            window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
            await loadList();
          })
          .catch((e) => {
            window.alert?.(pick(`proposal 보관 실패: ${e instanceof Error ? e.message : String(e)}`, `Failed to archive proposal: ${e instanceof Error ? e.message : String(e)}`));
          })
          .finally(() => {
            b.disabled = false;
          });
      }));
    const resizeHandle = root.querySelector<HTMLElement>("[data-proposals-resize-detail]");
    resizeHandle?.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const split = root.querySelector<HTMLElement>("[data-proposals-split]");
      if (!split) return;
      const row = split.getBoundingClientRect();
      resizeHandle.classList.add("dragging");
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      const widthAt = (clientX: number) => clampDetailWidth(row.right - clientX);
      const apply = (px: number) => {
        detailWidth = clampDetailWidth(px);
        split.style.gridTemplateColumns = `minmax(0, 1fr) 6px ${detailWidth}px`;
      };
      const onMove = (ev: MouseEvent) => apply(widthAt(ev.clientX));
      const onUp = (ev: MouseEvent) => {
        apply(widthAt(ev.clientX));
        localStorage.setItem(detailWidthKey, String(detailWidth));
        resizeHandle.classList.remove("dragging");
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  }

  render();
  void loadList();
  const poll = setInterval(() => {
    if (!root.isConnected || !root.querySelector("[data-proposals-split]")) {
      clearInterval(poll);
      return;
    }
    void refreshCurrent();
  }, 5000);
  const observer = new MutationObserver(() => {
    if (root.isConnected && root.querySelector("[data-proposals-split]")) return;
    clearInterval(poll);
    observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
