#!/usr/bin/env bun
// 진행 지속 가드 (30분마다). 멈춘(stalled) doing 카드의 owner 를 버스 wake 로 핑해 재개/정리를 유도한다.
//   - task-review-ping(매일 06:00)의 30분 버전. 리뷰핑은 "하루 한 번 전체 점검", 이 가드는 "카드가 조용해지면 바로 nudge".
//   - 텔레그램 발신이 아니라 버스 wake(에이전트 깨우기) — 토큰 불필요.
//   - ★에피소드당 1회★: 한 번 핑한 카드는 owner 가 손댔다가(updated_at 갱신) 다시 stall 되기 전엔 재핑하지 않는다.
//     방치 카드를 30분마다 영구 나그하지 않기 위함(상시 리마인드는 일일 review-ping 이 담당). var/ 상태파일로 마지막 핑시각 추적.
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

// ★가드가 시킨 표시를 가드가 읽어야 한다★
//   guardBody() 는 "막혔으면 blocked 표시 + 다음 액션/재개 시각/fallback 을 description 에 남기라" 고
//   시킨다. 그런데 판정부는 column/owner/updated_at 만 봤다 — description 을 아예 읽지 않았다.
//   시킨 대로 해도 판정에 반영되는 경로가 없으니, 그 안내는 지킬 수 없는 약속이었다.
//
//   게다가 재핑이 에피소드 기준(dueCards)이라 유인이 거꾸로 섰다:
//     · 성실히 상태를 갱신하는 blocked 카드 → 갱신할 때마다 새 에피소드 → 60분 뒤 또 핑(영구 나그)
//     · 손 놓고 방치한 카드            → 최초 1회만 핑하고 조용
//   "방치 카드 영구 나그" 를 막으려던 장치가, 방치가 아니라 ★관리 중인 카드★ 에서 재현됐다.
//
//   그래서 blocked 로 표시된 카드에는 훨씬 긴 임계를 준다. ★면제가 아니라 완화★ 다 —
//   완전히 빼면 "blocked" 라고 적어두고 잊은 카드가 영원히 안 걸린다.
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
    if (t.column !== "doing" || t.owner == null || !owners.has(t.owner)) return false;
    const threshold = isBlockedCard(t) ? stallMs * BLOCKED_STALL_MULTIPLIER : stallMs;
    return nowMs - parseUtc(t.updated_at, nowMs) >= threshold;
  });
}

// 재핑 정책 = ★에피소드당 1회★. 방치 카드를 주기마다 영구 나그하지 않는다 — continuation-guard 는 "카드가 막
// 조용해진 순간"만 잡고, 상시 리마인드는 일일 task-review-ping 이 담당(중복 나그 방지). 핑 대상:
//   ① 이번 실행서 처음 stall 로 관측된 카드(state 에 없음), 또는
//   ② 마지막 핑 이후 owner 가 손댔다가(updated_at 갱신) 다시 stall 된 카드(새 에피소드).
// 손 안 댄 방치 카드는 최초 1회만 핑하고 조용해진다(updated_at ≤ 마지막 핑시각).
export function dueCards(stalled: Task[], state: State): Task[] {
  return stalled.filter((t) => {
    const last = state[t.id] ? Date.parse(state[t.id]) : 0;
    if (!last) return true;                     // 이번 실행서 처음 stall 로 관측된 카드
    return parseUtc(t.updated_at, 0) > last;    // 마지막 핑 이후 손댔다 다시 stall = 새 에피소드(파싱실패=0=재핑 안 함)
  });
}

export function guardBody(owner: string, cards: Task[], stallMin: number): string {
  const list = cards.map((t) => `• ${t.title}`).join("\n");
  return (
    `[진행 지속 가드] ${owner}님, ${stallMin}분+ 조용한 doing 카드가 ${cards.length}개 있습니다.\n${list}\n\n` +
    `각 카드의 실제 상태를 확인해 주세요 — 끝났으면 done 으로, 막혔으면 blocked 표시 + 다음 액션/재개 시각/fallback 을 description 에 남기고, ` +
    `계속 진행 중이면 다음 액션만 갱신하면 됩니다. 실제로 진행할 게 없는 카드는 plan 으로 내리거나 폐기하세요. ` +
    `정리할 게 없으면 억지로 수정·보고하지 마세요.\n` +
    `(description 에 blocked 표시가 있으면 이 가드는 훨씬 뜸하게 확인합니다 — 표시해 두면 관리 중인 카드가 계속 알림을 받지 않습니다.)`
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

  const res = await fetch(API_TASKS);
  if (!res.ok) throw new Error(`tasks API ${res.status}`);
  const { tasks } = (await res.json()) as { tasks: Task[] };

  const owners = new Set(await loadOwners(tasks));
  const stalled = stalledDoingCards(tasks, owners, nowMs, stallMs);
  const state = loadState();
  const due = dueCards(stalled, state);

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
      `(stall>${STALL_MIN}m, 에피소드당 1회)`,
  );
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("continuation-guard error:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
