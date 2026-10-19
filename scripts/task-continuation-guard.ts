#!/usr/bin/env bun
// 진행 지속 가드 (30분마다). 멈춘(stalled) doing 카드의 owner 를 버스 wake 로 핑해 재개/정리를 유도한다.
//   - task-review-ping(평일 06:00)의 30분 버전. 리뷰핑은 "평일 한 번 전체 점검", 이 가드는 "카드가 조용해지면 바로 nudge".
//   - 텔레그램 발신이 아니라 버스 wake(에이전트 깨우기) — 토큰 불필요.
//   - ★에피소드당 1회★: 한 번 핑한 카드는 owner 가 손댔다가(updated_at 갱신) 다시 stall 되기 전엔 재핑하지 않는다.
//     재핑 간격은 알림마다 2배씩 늘리며 24시간이 상한이다. lane/담당 변경 시 초기화한다.
//   - 실제로 멈춘 카드가 없으면 no-op(아무도 안 깨움). 신규/빈 칸반은 정상 no-op.
// 스케줄: scheduled_job `sched_task_continuation_guard` (cron */30, execKey task-continuation-guard). launchd 아님 → OS 무관.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const ROOT = join(import.meta.dir, "..");
const REGISTRY_PATH = process.env.TEAM_AGENT_REGISTRY ?? join(ROOT, "agents.json");

const API_TASKS = process.env.TEAM_TASKS_API ?? "http://127.0.0.1:7878/team/api/tasks";
const API_AGENTS = process.env.TEAM_AGENTS_API ?? "http://127.0.0.1:7878/team/api/agents";
const API_INBOX = process.env.TEAM_INBOX_API ?? "http://127.0.0.1:7878/team/api/inbox";
// Inbox 는 자동화 발신자로 예약어 "system" 만 받는다. "team-os" 는 agent id 가 아니라 unknown_from_agent 로 실패한다.
const FROM_AGENT = process.env.CONTINUATION_FROM_AGENT ?? "system";

// doing 카드가 이 시간(분) 이상 손대지 않았으면 "멈춤"으로 본다.
const STALL_MIN = Number(process.env.CONTINUATION_STALL_MIN ?? "60");
// 재핑은 에피소드당 1회(dueCards 참고) — 방치 카드는 최초 1회만 핑, owner 가 손댔다 다시 stall 되면 재핑.
const STATE_PATH = process.env.CONTINUATION_STATE_PATH ?? join(ROOT, "var", "continuation-guard-state.json");

const KST = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
const THREAD = "continuation-guard-" + KST(new Date());

interface Task {
  id: string;
  title: string;
  owner: string | null;
  column: "plan" | "doing" | "done";
  description: string | null;
  updated_at: string;
  held_at?: string | null;
}

interface Agent {
  id: string;
  team_official_member?: boolean;
}

interface NotificationState {
  notifiedAt: string;
  observedUpdatedAt: string;
  owner?: string | null;
  column?: Task["column"];
  notificationCount?: number;
}
type State = Record<string, string | NotificationState>;
const MAX_INTERVAL_MS = 24 * 3600_000;
const MAX_RESUME_DELAY_MS = 7 * 24 * 3600_000;

// 재개 시각은 ISO 날짜·시간 한 줄로 읽는다. 시간대 생략 시 실행 기계의 로컬 시각이다.
export function resumeAt(description: string | null): number {
  const value = description?.match(/^[ \t]*재개 시각:[ \t]*([^\r\n]+)\r?$/m)?.[1]?.trim();
  if (!value || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/i.test(value)) return NaN;
  const day = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10)) return NaN;
  return Date.parse(value.replace(" ", "T"));
}

// stall 여부와 무관하게 관측한 lane/담당 변경은 이전 알림 이력을 지운다.
export function reconcileState(tasks: Task[], state: State): void {
  for (const t of tasks) {
    const entry = state[t.id];
    if (t.column !== "doing" || (entry && typeof entry !== "string" &&
        ((entry.owner !== undefined && entry.owner !== t.owner) ||
         (entry.column !== undefined && entry.column !== t.column)))) delete state[t.id];
  }
}

export function recordNotification(t: Task, state: State, nowMs: number): void {
  const entry = state[t.id];
  const count = typeof entry === "object" ? entry.notificationCount ?? 1 : entry ? 1 : 0;
  state[t.id] = {
    notifiedAt: new Date(nowMs).toISOString(), observedUpdatedAt: t.updated_at,
    owner: t.owner, column: t.column, notificationCount: Math.min(count + 1, 32),
  };
}

// 저장소 관행은 "2026-07-24 13:31:36" (UTC, 표시자 없음) 이다.
//
// 판정 기준은 시간대 표시자(`Z` 또는 `±HH:MM`)의 유무다. 구분자(공백/`T`)가 아니다.
// 표시자가 없는 ISO 문자열은 `Date.parse` 가 로컬 시각으로 읽는다. `2026-07-30T18:10:00` 은
// `Asia/Seoul` 머신에서 `2026-07-30T09:10:00Z` 가 되어 9시간 이르게 잡히고, 카드가 실제보다
// 오래된 것으로 보여 임계를 넘긴다.
//
// 문자열 정규화를 따로 내보낸다. `Date.parse` 결과로 단정하면 프로세스 시간대에 따라
// 결과가 달라져서(테스트 러너는 UTC 로 돈다) 이 판정을 검사할 수 없다.
export function toUtcIso(s: string): string {
  const trimmed = s.trim();
  const iso = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  // 대소문자를 가리지 않는다. `18:10:00z` 를 놓치면 `z` 뒤에 `Z` 가 더 붙어 파싱이 실패한다.
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`;
}

// → epoch ms. 파싱 실패하면 now 를 돌려준다(아주 오래된 것으로 취급하지 않게).
export function parseUtc(s: string | null | undefined, nowMs: number): number {
  if (!s) return nowMs;
  const t = Date.parse(toUtcIso(s));
  return Number.isNaN(t) ? nowMs : t;
}

// blocked 카드는 기본 멈춤 임계를 6배로 늘리되 알림 대상에서 제외하지 않는다.
const BLOCKED_STALL_MULTIPLIER = 6;

// description 에 남긴 '막힘' 표시를 인정한다. 한국어/영어 둘 다 실제로 쓰인다.
export function isBlockedCard(t: Task): boolean {
  const d = t.description ?? "";
  return /\bblocked\b/i.test(d) || /waiting[_\s-]?on/i.test(d) || /(대기|차단|보류)\s*중/.test(d);
}

// 멈춘 doing 카드: column=doing · owner 존재 · owner 가 리뷰대상 · updated_at 이 임계 이상 지남.
//   임계 = 일반 stallMs, blocked 표시가 있으면 그 6배.
export function stalledDoingCards(tasks: Task[], owners: Set<string>, nowMs: number, stallMs: number): Task[] {
  return tasks.filter((t) => {
    if (t.held_at || t.column !== "doing" || t.owner == null || !owners.has(t.owner)) return false;
    const updatedAt = parseUtc(t.updated_at, nowMs);
    // 실행할 때마다 유예가 연장되지 않도록 카드 갱신 시각에 7일 상한을 고정한다.
    const resumeUntil = Math.min(resumeAt(t.description), updatedAt + MAX_RESUME_DELAY_MS);
    if (resumeUntil > nowMs) return false;
    const threshold = isBlockedCard(t) ? stallMs * BLOCKED_STALL_MULTIPLIER : stallMs;
    return nowMs - updatedAt >= threshold;
  });
}

// A changed card skips one observation cycle before it can start another stalled episode.
// String entries from older state files remain valid last-notification timestamps.
export function dueCards(stalled: Task[], state: State, nowMs = Date.now(), stallMs = STALL_MIN * 60_000): Task[] {
  reconcileState(stalled, state);
  return stalled.filter((t) => {
    const entry = state[t.id];
    const last = entry ? Date.parse(typeof entry === "string" ? entry : entry.notifiedAt) : 0;
    if (!entry || !last) return true;
    if (parseUtc(t.updated_at, 0) <= last) return false;
    if (typeof entry === "string" || entry.observedUpdatedAt !== t.updated_at) {
      state[t.id] = { ...(typeof entry === "object" ? entry : {}), notifiedAt: new Date(last).toISOString(), observedUpdatedAt: t.updated_at, owner: t.owner, column: t.column };
      return false;
    }
    const count = entry.notificationCount ?? 1;
    const base = stallMs * (isBlockedCard(t) ? BLOCKED_STALL_MULTIPLIER : 1);
    const interval = Math.min(MAX_INTERVAL_MS, base * 2 ** Math.min(count, 32));
    return nowMs - last >= interval;
  });
}

export function guardBody(owner: string, cards: Task[], stallMin: number): string {
  const list = cards.map((t) => `• ${t.title}`).join("\n");
  return (
    `[진행 지속 가드] ${owner}님, ${stallMin}분+ 조용한 doing 카드가 ${cards.length}개 있습니다.\n${list}\n\n` +
    `각 카드의 실제 상태를 확인해 주세요 — 끝났으면 done 으로, 막혔으면 blocked 표시 + 다음 액션/재개 시각/fallback 을 description 에 남기고, ` +
    `계속 진행 중이면 다음 액션만 갱신하면 됩니다. 실제로 진행할 게 없는 카드는 plan 으로 내리거나 폐기하세요. ` +
    `정리할 게 없으면 억지로 수정·보고하지 마세요.\n` +
    `description 에 아래 형식으로 한 줄 적으면 그 시각까지 알리지 않습니다(카드 갱신 후 최대 7일).\n재개 시각: 2026-10-20T09:00:00+09:00\n` +
    `(blocked 카드는 훨씬 뜸하게 확인하며, 재알림 간격은 2배씩 늘어 최대 24시간입니다.)`
  );
}

async function loadOwners(tasks: Task[]): Promise<string[]> {
  const configured = process.env.CONTINUATION_OWNER_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (configured?.length) return configured;
  try {
    const agents = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")) as Agent[];
    const owners = agents.filter((a) => a.team_official_member !== false).map((a) => a.id);
    if (owners.length) return owners;
  } catch (e) {
    console.error("owner registry file fallback:", e instanceof Error ? e.message : String(e));
  }
  try {
    const res = await fetch(API_AGENTS);
    if (!res.ok) throw new Error(`agents API ${res.status}`);
    const { agents } = (await res.json()) as { agents: Agent[] };
    const owners = agents.filter((a) => a.team_official_member !== false).map((a) => a.id);
    if (owners.length) return owners;
  } catch (e) {
    console.error("owner registry fallback:", e instanceof Error ? e.message : String(e));
  }
  return [...new Set(tasks.map((t) => t.owner).filter((o): o is string => Boolean(o)))].sort();
}

function loadState(): State {
  try {
    if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as State;
  } catch (e) {
    console.error("state read fallback:", e instanceof Error ? e.message : String(e));
  }
  return {};
}

// Keep doing-card history across recent updates; drop completed, held, or removed cards.
function saveState(state: State, liveIds: Set<string>): void {
  const pruned: State = {};
  for (const [id, ts] of Object.entries(state)) if (liveIds.has(id)) pruned[id] = ts;
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(pruned, null, 2));
  } catch (e) {
    console.error("state write failed:", e instanceof Error ? e.message : String(e));
  }
}

async function main(): Promise<void> {
  const nowMs = Date.now();
  const stallMs = STALL_MIN * 60_000;

  const res = await fetch(API_TASKS);
  if (!res.ok) throw new Error(`tasks API ${res.status}`);
  const { tasks } = (await res.json()) as { tasks: Task[] };

  const owners = new Set(await loadOwners(tasks));
  const stalled = stalledDoingCards(tasks, owners, nowMs, stallMs);
  const state = loadState();
  reconcileState(tasks, state);
  const due = dueCards(stalled, state, nowMs, stallMs);

  // owner 별로 due 카드 묶기
  const byOwner = new Map<string, Task[]>();
  for (const t of due) {
    const arr = byOwner.get(t.owner!) ?? [];
    arr.push(t);
    byOwner.set(t.owner!, arr);
  }

  let sent = 0;
  for (const [owner, cards] of byOwner) {
    const body = guardBody(owner, cards, STALL_MIN);
    if (process.env.DRY_RUN) {
      console.log(`[DRY] → ${owner} (${cards.length} stalled): ${cards.map((c) => c.title).join(" | ").slice(0, 100)}…`);
    } else {
      const r = await fetch(API_INBOX, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_agent_id: FROM_AGENT,
          to_agent_id: owner,
          type: "dm",
          source: "agent",
          thread_id: THREAD,
          body,
          priority: "low",
          hop_count: 0,
        }),
      });
      const j = (await r.json()) as { ok?: boolean };
      if (!j.ok) {
        console.error(`✗ guard ping failed → ${owner}: ${JSON.stringify(j)}`);
        continue;
      }
      console.log(`✓ continuation guard → ${owner} (${cards.length} stalled)`);
    }
    // 핑한 카드만 cooldown 기록 갱신(DRY_RUN 은 상태 안 건드림)
    if (!process.env.DRY_RUN) for (const c of cards) recordNotification(c, state, nowMs);
    sent++;
  }

  if (!process.env.DRY_RUN) saveState(state, new Set(tasks.filter((t) => t.column === "doing" && !t.held_at).map((t) => t.id)));
  console.log(
    `done: ${sent} owner(s) pinged · stalled=${stalled.length} due=${due.length} ` +
      `(stall>${STALL_MIN}m, 재알림 간격 최대 24h)`,
  );
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("continuation-guard error:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
