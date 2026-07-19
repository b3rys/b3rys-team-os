#!/usr/bin/env bun
// 06:20 visibility summary for the 06:00 task-review ping.
// This reports actual card changes without retrying, escalating, or forcing follow-up.
// With no active cards (public/new install), it is a quiet no-op.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const API_BASE = process.env.TEAM_API_BASE ?? "http://127.0.0.1:7878/team/api";
const API_TASKS = process.env.TEAM_TASKS_API ?? `${API_BASE}/tasks`;
const API_AGENTS = process.env.TEAM_AGENTS_API ?? `${API_BASE}/agents`;
const API_INBOX = process.env.TEAM_INBOX_API ?? `${API_BASE}/inbox`;
const REGISTRY_PATH = process.env.TEAM_AGENT_REGISTRY ?? join(ROOT, "agents.json");

interface Task {
  id: string;
  title: string;
  owner: string | null;
  description: string | null;
  column: "plan" | "doing" | "done";
  updated_at?: string;
}

interface Message {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  type: string;
  created_at: string;
  body: string;
}

export interface AgentRecord {
  id: string;
  team_official_member?: boolean;
  status?: {
    state?: string | null;
    last_log_line?: string | null;
    last_activity_at?: string | null;
    ctx_percent?: number | null;
    tmux_pid?: number | null;
  };
}

interface InboxPost {
  from_agent_id: string;
  to_agent_id: string;
  type: "dm" | "broadcast";
  source: "agent" | "system";
  thread_id: string;
  body: string;
  priority: "low" | "normal" | "high";
  hop_count: number;
}

interface RecoveryResult {
  attempted: boolean;
  sent: number;
  failed: string[];
}

function readEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf-8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // Environment variables can still provide values.
  }
  return env;
}

function kanbanUrl(): string {
  const env = readEnv();
  return process.env.KANBAN_URL ?? process.env.TEAM_KANBAN_URL ?? env.KANBAN_URL ?? env.TEAM_KANBAN_URL ?? "http://127.0.0.1:7878/team";
}

function kstDate(offsetDays = 0): string {
  const ms = Date.now() + 9 * 3600_000 + offsetDays * 86400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function kstReviewStartUtc(): string {
  const [y, m, d] = kstDate().split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d, 6 - 9, 0, 0));
  return utc.toISOString().slice(0, 19).replace("T", " ");
}

function localTimeLabel(raw?: string): string {
  if (!raw) return "-";
  const parsed = Date.parse(raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed)) return raw;
  return new Date(parsed + 9 * 3600_000).toISOString().slice(11, 16);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return (await res.json()) as T;
}

function configuredOwners(): string[] {
  return (process.env.TASK_REVIEW_OWNER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function isReviewPing(m: Message): boolean {
  return m.type === "dm" && m.body.includes("[6am 과제 리뷰]");
}

function reviewOwnersFromRegistry(agents: AgentRecord[], tasks: Task[]): string[] {
  const activeOwnerSet = new Set(tasks.filter((t) => t.owner && t.column !== "done").map((t) => t.owner!));
  const configured = configuredOwners();
  if (configured.length) return configured.filter((owner) => activeOwnerSet.has(owner));

  try {
    const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")) as AgentRecord[];
    const regularMembers = registry
      .filter((a) => a.team_official_member !== false && activeOwnerSet.has(a.id))
      .map((a) => a.id);
    if (regularMembers.length) return regularMembers;
  } catch {
    // Compatibility fallback for deployments where the registry file is absent.
    const regularMembers = agents
      .filter((a) => a.team_official_member !== false && activeOwnerSet.has(a.id))
      .map((a) => a.id);
    if (regularMembers.length) return regularMembers;
  }

  return [...activeOwnerSet].sort();
}

function reviewOwnersFromThread(messages: Message[], agents: AgentRecord[], tasks: Task[]): string[] {
  const pingTargets = uniqueInOrder(messages.filter(isReviewPing).map((m) => m.to_agent_id));
  return pingTargets.length ? pingTargets : reviewOwnersFromRegistry(agents, tasks);
}

function compactTaskTitles(tasks: Task[], max = 3): string {
  if (!tasks.length) return "-";
  const titles = tasks.slice(0, max).map((t) => t.title);
  const more = tasks.length > max ? ` 외 ${tasks.length - max}` : "";
  return `${titles.join(" / ")}${more}`;
}

async function postInbox(message: InboxPost): Promise<boolean> {
  if (process.env.DRY_RUN) {
    console.log(`[DRY inbox] ${message.from_agent_id} → ${message.to_agent_id}: ${message.body.slice(0, 140)}`);
    return true;
  }
  const res = await fetch(API_INBOX, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
  const json = (await res.json()) as { ok?: boolean };
  return Boolean(json.ok);
}

function recoveryPingBody(owner: string, active: Task[]): string {
  const doing = active.filter((t) => t.column === "doing");
  const plan = active.filter((t) => t.column === "plan");
  const activeLine = active.length
    ? `현재 active ${active.length}건입니다. doing ${doing.length}, plan ${plan.length}. 핵심: ${compactTaskTitles(active, 4)}`
    : "현재 칸반 active 과제는 없습니다.";
  return (
    `[5am 과제 리뷰 자동복구] ${owner}님, 05:00 review ping 발송이 실패해 05:20 PM summary가 자동 재발송합니다.\n` +
    `${activeLine}\n` +
    `오늘 진행/계획이 바뀌었으면 /team → Tasks를 갱신해 주세요. 채팅 답장은 불필요하고, 필요한 카드 갱신이 이 ping에 대한 응답입니다.`
  );
}

async function recoverMissingReviewPings(
  reviewOwners: string[],
  activeByOwner: Map<string, Task[]>,
  threadId: string,
): Promise<RecoveryResult> {
  const failed: string[] = [];
  let sent = 0;
  for (const owner of reviewOwners) {
    const ok = await postInbox({
      from_agent_id: "system",
      to_agent_id: owner,
      type: "dm",
      source: "system",
      thread_id: threadId,
      body: recoveryPingBody(owner, activeByOwner.get(owner) ?? []),
      priority: "low",
      hop_count: 0,
    });
    if (ok) sent++;
    else failed.push(owner);
  }
  return { attempted: true, sent, failed };
}

async function notifyCodexPm(day: string, body: string): Promise<void> {
  const ok = await postInbox({
    from_agent_id: "system",
    to_agent_id: "codex",
    type: "dm",
    source: "system",
    thread_id: `task-review-pm-${day}`,
    body,
    priority: "normal",
    hop_count: 0,
  });
  if (!ok) console.error("task-review PM notify failed");
}

export function summarizeRuntime(agent: AgentRecord | undefined): { label: string; needsPm: boolean } {
  const state = agent?.status?.state ?? "unknown";
  const line = agent?.status?.last_log_line ?? "";
  if (state === "blocked") {
    if (/100% context/i.test(line)) return { label: "runtime blocked: context full", needsPm: true };
    if (/Enter to confirm|Esc to cancel|prompt/i.test(line)) {
      return { label: "runtime blocked: confirmation prompt", needsPm: true };
    }
    // Claude Code's normal idle footer contains `-- INSERT --` and `auto mode on`.
    // statusProbe marks a tmux session blocked after prolonged inactivity, so treating
    // that footer as a terminal-input blocker creates a false PM incident for every
    // healthy agent that finished the 05:00 review and is waiting at the prompt.
    if (agent?.status?.tmux_pid && /INSERT|auto mode|shift\+tab|← for agents/i.test(line)) {
      return { label: "idle", needsPm: false };
    }
    return { label: "runtime blocked", needsPm: true };
  }
  if (/100% context|Enter to confirm|Esc to cancel|prompt/i.test(line)) {
    return { label: "runtime attention needed", needsPm: true };
  }
  return { label: state, needsPm: false };
}

function readableReviewState(state: string): string {
  if (state.startsWith("responded ")) return state.replace("responded ", "응답 ");
  if (state.startsWith("updated ")) return state.replace("updated ", "작업 갱신 ");
  if (state === "no ack/update") return "응답/갱신 없음";
  if (state === "recovered ping sent") return "확인 요청 재전송";
  if (state === "not pinged") return "확인 요청 없음";
  return state;
}

function readableRuntime(label: string): string {
  if (label === "runtime blocked: terminal input mode") return "실행환경 막힘(터미널 입력 대기)";
  if (label === "runtime blocked: context full") return "실행환경 막힘(context full)";
  if (label === "runtime blocked: confirmation prompt") return "실행환경 막힘(확인 프롬프트 대기)";
  if (label === "runtime blocked") return "실행환경 막힘";
  if (label === "runtime attention needed") return "실행환경 확인 필요";
  if (label === "idle") return "정상(idle)";
  if (label === "unknown") return "상태 unknown";
  return label;
}

function runtimeBadge(label: string): string {
  const readable = readableRuntime(label);
  if (readable.startsWith("실행환경 막힘") || readable === "실행환경 확인 필요") return `⚠️ ${readable}`;
  if (readable.startsWith("정상")) return `✅ ${readable}`;
  return `• ${readable}`;
}

function formatOwnerBlock(row: {
  owner: string;
  active: Task[];
  updated: Task[];
  responseCount: number;
  runtime: { label: string; needsPm: boolean };
  state: string;
}): string {
  const lines = [
    `👤 ${row.owner}`,
    `  상태: ${readableReviewState(row.state)}`,
    `  작업: active ${row.active.length}개`,
    `  실행: ${runtimeBadge(row.runtime.label)}`,
  ];
  if (row.updated.length) lines.push(`  갱신: ${compactTaskTitles(row.updated, 2)}`);
  return lines.join("\n");
}

function pmReason(row: {
  state: string;
  runtime: { label: string; needsPm: boolean };
}): string | null {
  const reasons: string[] = [];
  if (row.state === "no ack/update") reasons.push("응답/갱신 없음");
  if (row.runtime.needsPm) reasons.push(readableRuntime(row.runtime.label));
  return reasons.length ? reasons.join(" + ") : null;
}

function formatPmFollowups(
  pingFailed: boolean,
  rows: {
    owner: string;
    state: string;
    runtime: { label: string; needsPm: boolean };
  }[],
): string {
  const lines: string[] = [];
  if (pingFailed) lines.push("• codex: 05:00 ping 실패 원인 확인");
  for (const row of rows) {
    const reason = pmReason(row);
    if (reason) lines.push(`• ${row.owner}: ${reason}`);
  }
  return lines.length ? lines.join("\n") : "✅ PM 추가 확인 없음";
}

/** op방(운영) 타겟 chat_id — ★단일 소스: setting `owner_chat_id`(팀장 텔레그램 chat_id) 동적 읽기★.
 *  우선순위: env override(TASK_REVIEW_SUMMARY_CHAT_ID) → setting(owner_chat_id, 동적) → 팀그룹 폴백 → undefined.
 *  ★퍼블릭: op 미셋업이면 owner_chat_id 비어있음→(팀그룹도 없으면)undefined→graceful skip★. op(팀장 DM) 나중
 *  셋업되면 owner_chat_id가 채워져 다음 실행이 자동으로 op방으로 라우팅(재시작·재배선 불필요 = GD가 원한 자동추가). */
async function opTargetChatId(): Promise<string | undefined> {
  if (process.env.TASK_REVIEW_SUMMARY_CHAT_ID) return process.env.TASK_REVIEW_SUMMARY_CHAT_ID;
  try {
    const s = await getJson<{ owner_chat_id?: string } & Record<string, unknown>>(`${API_BASE}/settings`);
    const opChat = s.owner_chat_id;
    if (opChat && String(opChat).trim()) return String(opChat).trim();
  } catch { /* setting API 실패 → 아래 폴백 */ }
  const env = readEnv();
  const grp = process.env.TEAM_GROUP_ID ?? env.TEAM_GROUP_ID;
  return grp && grp.trim() ? grp.trim() : undefined;
}

async function sendTelegram(text: string): Promise<boolean> {
  if (process.env.DRY_RUN) {
    console.log(text);
    return true;
  }
  const env = readEnv();
  const token = process.env.CAPTURE_BOT_TOKEN ?? env.CAPTURE_BOT_TOKEN;
  const chatId = await opTargetChatId();
  if (!token) { console.warn("task-review summary: CAPTURE_BOT_TOKEN 미설정 — 전송 보류"); return false; }
  if (!chatId) { console.log("task-review summary: op방(ops_chat_id)·팀그룹 미설정 — 요약 전송 보류(퍼블릭 op 미셋업). setting 채워지면 다음 실행에 자동 전송."); return false; }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const json = (await res.json()) as { ok?: boolean; description?: string; result?: { message_id?: number } };
  if (!json.ok) throw new Error(json.description ?? JSON.stringify(json));
  console.log(`✓ task-review summary sent (msg ${json.result?.message_id})`);
  return true;
}

async function sendBus(text: string, threadId: string): Promise<boolean> {
  if (process.env.DRY_RUN) {
    console.log(text);
    return true;
  }
  const target = process.env.TASK_REVIEW_SUMMARY_BUS_TARGET ?? "broadcast";
  const res = await fetch(API_INBOX, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from_agent_id: process.env.TASK_REVIEW_SUMMARY_FROM_AGENT ?? "codex",
      to_agent_id: target,
      type: target === "broadcast" ? "broadcast" : "dm",
      source: "agent",
      thread_id: threadId,
      body: text,
      priority: "normal",
      hop_count: 0,
    }),
  });
  const json = (await res.json()) as { ok?: boolean };
  if (!json.ok) throw new Error(`bus summary failed: ${JSON.stringify(json)}`);
  console.log(`✓ task-review summary posted to bus (${target})`);
  return true;
}

async function deliverSummary(text: string, threadId: string): Promise<void> {
  const delivery = process.env.TASK_REVIEW_SUMMARY_DELIVERY ?? "auto";
  if (delivery === "stdout" || process.env.DRY_RUN) {
    console.log(text);
    return;
  }
  if (delivery === "telegram") {
    if (!(await sendTelegram(text))) throw new Error("telegram delivery requested but token/chat is missing");
    return;
  }
  if (delivery === "bus") {
    await sendBus(text, threadId);
    return;
  }
  if (await sendTelegram(text)) return;
  console.log(text);
  console.log("ℹ task-review summary printed to stdout; configure TASK_REVIEW_SUMMARY_DELIVERY for posting");
}

async function main(): Promise<void> {
  const day = kstDate();
  const threadId = `task-review-${day}`;
  const reviewStartUtc = kstReviewStartUtc();

  const [{ tasks }, { agents }, thread] = await Promise.all([
    getJson<{ tasks: Task[] }>(API_TASKS),
    getJson<{ agents: AgentRecord[] }>(API_AGENTS),
    getJson<{ messages: Message[] }>(`${API_BASE}/threads/${threadId}`).catch(() => ({ messages: [] })),
  ]);

  const agentById = new Map(agents.map((a) => [a.id, a]));
  const messages = thread.messages ?? [];
  const reviewOwners = reviewOwnersFromThread(messages, agents, tasks);
  if (reviewOwners.length === 0) {
    console.log("task-review summary: no active owners — no-op");
    return;
  }
  const reviewOwnerSet = new Set(reviewOwners);
  const reviewPings = messages.filter((m) => isReviewPing(m) && reviewOwnerSet.has(m.to_agent_id));
  const responses = new Map<string, Message[]>();
  for (const owner of reviewOwners) responses.set(owner, []);
  for (const m of messages) {
    if (reviewOwnerSet.has(m.from_agent_id) && !isReviewPing(m)) {
      responses.get(m.from_agent_id)?.push(m);
    }
  }

  const activeByOwner = new Map<string, Task[]>();
  const updatedByOwner = new Map<string, Task[]>();
  for (const owner of reviewOwners) {
    activeByOwner.set(owner, tasks.filter((t) => t.owner === owner && t.column !== "done"));
    updatedByOwner.set(
      owner,
      tasks.filter((t) => t.owner === owner && (t.updated_at ?? "") >= reviewStartUtc),
    );
  }

  const rows = reviewOwners.map((owner) => {
    const active = activeByOwner.get(owner) ?? [];
    const updated = updatedByOwner.get(owner) ?? [];
    const responseCount = responses.get(owner)?.length ?? 0;
    const pinged = reviewPings.some((m) => m.to_agent_id === owner);
    const runtime = summarizeRuntime(agentById.get(owner));
    const state =
      responseCount > 0
        ? `responded ${localTimeLabel(responses.get(owner)?.at(-1)?.created_at)}`
        : updated.length > 0
          ? `updated ${localTimeLabel(updated[0]?.updated_at)}`
          : pinged
            ? "no ack/update"
            : "not pinged";
    return { owner, active, updated, responseCount, runtime, state };
  });

  const changed = rows.filter((r) => r.responseCount > 0 || r.updated.length > 0);
  const doneSinceReview = tasks.filter((t) => t.column === "done" && (t.updated_at ?? "") >= reviewStartUtc);
  const runtimeBlocked = rows.filter((r) => r.runtime.needsPm).map((r) => r.owner);
  const pingCount = reviewPings.length;

  const text =
    `📋 06:20 팀 작업판 상태 점검 · ${day}\n` +
    `한 줄 요약: active 카드가 있는 팀원 ${reviewOwners.length}명 중 ${changed.length}명이 실제 반응/카드 갱신을 남겼습니다.\n\n` +
    `숫자 뜻\n` +
    `• 확인 보냄: ${pingCount}/${reviewOwners.length}\n` +
    `• 반응/갱신: ${changed.length}/${reviewOwners.length}\n` +
    `팀원별 상태\n` +
    `━━━━━━━━━━━━\n` +
    rows.map(formatOwnerBlock).join("\n\n") +
    (doneSinceReview.length
      ? `\n\n✅ done 전환/갱신: ${compactTaskTitles(doneSinceReview, 4)}`
      : "") +
    (runtimeBlocked.length ? `\n\n⚠️ 실행환경 상태 참고\n• ${runtimeBlocked.join("\n• ")}` : "") +
    `\n\n칸반: ${kanbanUrl()}`;

  await deliverSummary(text, `${threadId}-summary`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("task-review-summary error:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
