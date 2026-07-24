#!/usr/bin/env bun
// 진행 지속 가드 (30분마다). 멈춘(stalled) doing 카드의 owner 를 버스 wake 로 핑해 재개/정리를 유도한다.
//   - task-review-ping(매일 06:00)의 30분 버전. 리뷰핑은 "하루 한 번 전체 점검", 이 가드는 "카드가 조용해지면 바로 nudge".
//   - 텔레그램 발신이 아니라 버스 wake(에이전트 깨우기) — 토큰 불필요.
//   - ★이슈별 cooldown★: 같은 카드를 30분마다 다시 핑하지 않는다(기본 120분). var/ 상태파일로 마지막 핑시각 추적.
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
// 같은 카드를 이 시간(분) 안에 다시 핑하지 않는다(이슈별 cooldown). owner 가 카드를 갱신하면 updated_at 이 올라 멈춤이 풀린다.
const COOLDOWN_MIN = Number(process.env.CONTINUATION_COOLDOWN_MIN ?? "120");
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
}

interface Agent {
  id: string;
  team_official_member?: boolean;
}

type State = Record<string, string>; // cardId -> 마지막 핑 ISO(UTC)

// "2026-07-24 13:31:36"(UTC, TZ 없음) → epoch ms. 파싱 실패하면 0(=아주 오래됨으로 취급하지 않게 now 반환).
export function parseUtc(s: string | null | undefined, nowMs: number): number {
  if (!s) return nowMs;
  const iso = /[TZ]/.test(s) ? s : s.replace(" ", "T") + "Z";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? nowMs : t;
}

// 멈춘 doing 카드: column=doing · owner 존재 · owner 가 리뷰대상 · updated_at 이 stallMs 이상 지남.
export function stalledDoingCards(tasks: Task[], owners: Set<string>, nowMs: number, stallMs: number): Task[] {
  return tasks.filter(
    (t) =>
      t.column === "doing" &&
      t.owner != null &&
      owners.has(t.owner) &&
      nowMs - parseUtc(t.updated_at, nowMs) >= stallMs,
  );
}

// cooldown 이 지난(=핑 대상) 카드만. state 에 없거나 마지막 핑이 cooldownMs 이전이면 due.
export function dueCards(stalled: Task[], state: State, nowMs: number, cooldownMs: number): Task[] {
  return stalled.filter((t) => {
    const last = state[t.id] ? Date.parse(state[t.id]) : 0;
    return nowMs - last >= cooldownMs;
  });
}

export function guardBody(owner: string, cards: Task[], stallMin: number): string {
  const list = cards.map((t) => `• ${t.title}`).join("\n");
  return (
    `[진행 지속 가드] ${owner}님, ${stallMin}분+ 조용한 doing 카드가 ${cards.length}개 있습니다.\n${list}\n\n` +
    `각 카드의 실제 상태를 확인해 주세요 — 끝났으면 done 으로, 막혔으면 blocked 표시 + 다음 액션/재개 시각/fallback 을 description 에 남기고, ` +
    `계속 진행 중이면 다음 액션만 갱신하면 됩니다. 실제로 진행할 게 없는 카드는 plan 으로 내리거나 폐기하세요. ` +
    `정리할 게 없으면 억지로 수정·보고하지 마세요.`
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

// 현재 멈춘 카드 id 만 남겨 상태파일이 무한히 커지지 않게 정리한다(done/삭제된 카드 엔트리 제거).
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
  const cooldownMs = COOLDOWN_MIN * 60_000;

  const res = await fetch(API_TASKS);
  if (!res.ok) throw new Error(`tasks API ${res.status}`);
  const { tasks } = (await res.json()) as { tasks: Task[] };

  const owners = new Set(await loadOwners(tasks));
  const stalled = stalledDoingCards(tasks, owners, nowMs, stallMs);
  const state = loadState();
  const due = dueCards(stalled, state, nowMs, cooldownMs);

  // owner 별로 due 카드 묶기
  const byOwner = new Map<string, Task[]>();
  for (const t of due) {
    const arr = byOwner.get(t.owner!) ?? [];
    arr.push(t);
    byOwner.set(t.owner!, arr);
  }

  let sent = 0;
  const nowIso = new Date(nowMs).toISOString();
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
    if (!process.env.DRY_RUN) for (const c of cards) state[c.id] = nowIso;
    sent++;
  }

  if (!process.env.DRY_RUN) saveState(state, new Set(stalled.map((t) => t.id)));
  console.log(
    `done: ${sent} owner(s) pinged · stalled=${stalled.length} due=${due.length} ` +
      `(stall>${STALL_MIN}m, cooldown ${COOLDOWN_MIN}m)`,
  );
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("continuation-guard error:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
