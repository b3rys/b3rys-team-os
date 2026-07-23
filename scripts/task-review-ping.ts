#!/usr/bin/env bun
// 6am 일일 과제 리뷰 핑.
// 실행중(doing)/계획(plan) 과제가 있는 오너에게만 버스 directed 메시지를 보내 칸반 점검을 유도한다.
// 기본모드 continuation guard: 실행중 과제는 다음 액션/재개 시각/fallback/stop_rule을 description에 남긴다.
// 실제 정리할 항목이 없으면 수정·보고하지 않는다(강제 X).
// 텔레그램 발신이 아니라 버스 wake(에이전트 깨우기) — 토큰 불필요. 스케줄: launchd com.you.team-task-review, 매일 05:00 KST.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const REGISTRY_PATH = process.env.TEAM_AGENT_REGISTRY ?? join(ROOT, "agents.json");

const API_TASKS = process.env.TEAM_TASKS_API ?? "http://127.0.0.1:7878/team/api/tasks";
const API_AGENTS = process.env.TEAM_AGENTS_API ?? "http://127.0.0.1:7878/team/api/agents";
const API_INBOX = process.env.TEAM_INBOX_API ?? "http://127.0.0.1:7878/team/api/inbox";
// Inbox accepts "system" as the reserved automation sender. "team-os" is not
// an agent id and causes unknown_from_agent failures.
const FROM_AGENT = process.env.TASK_REVIEW_FROM_AGENT ?? "system";
const THREAD = "task-review-" + new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

interface Task {
  id: string;
  title: string;
  owner: string | null;
  column: "plan" | "doing" | "done";
  description: string | null;
}

interface Agent {
  id: string;
  team_official_member?: boolean;
}

export function activeReviewOwners(tasks: Task[], reviewOwners: string[]): string[] {
  const allowed = new Set(reviewOwners);
  return [...new Set(
    tasks
      .filter((t) => t.column !== "done" && t.owner && allowed.has(t.owner))
      .map((t) => t.owner!),
  )];
}

export function reviewBody(owner: string, g: { doing: Task[]; plan: Task[] }): string {
  const doingLine = g.doing.length ? `\n실행중: ${g.doing.map((t) => `• ${t.title}`).join("  ")}` : "";
  const planLine = g.plan.length ? `\n계획: ${g.plan.map((t) => `• ${t.title}`).join("  ")}` : "";
  const missing = g.doing
    .map((t) => ({ title: t.title, fields: missingDoingFields(t) }))
    .filter((x) => x.fields.length > 0);
  const missingLine = missing.length
    ? `\n형식 보강 필요: ${missing.map((x) => `• ${x.title} (${x.fields.join(", ")})`).join("  ")}`
    : "";
  return `[6am 과제 리뷰] ${owner}님 active 과제입니다.${doingLine}${planLine}${missingLine}\n` +
    `내 plan/doing 카드를 실제 상태 기준으로 한 번 확인해 주세요. ` +
    `이미 끝난 doing은 done으로 옮기고, 오래된 plan은 실제로 하지 않을 과제일 때만 폐기하세요. 유지할 이유가 있으면 그대로 두면 됩니다. ` +
    `남은 doing의 다음 액션이 바뀌었으면 description을 갱신해 주세요. ` +
    `정리할 것이 없으면 억지로 수정하거나 보고하지 마세요. 실제로 카드를 정리했다면 팀 텔레그램 그룹에 결과를 한 번만 보고해 주세요.`;
}

async function loadReviewOwners(tasks: Task[]): Promise<string[]> {
  const configured = process.env.TASK_REVIEW_OWNER_IDS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
    // Compatibility fallback for deployments where only the API is available.
    const owners = agents.filter((a) => a.team_official_member !== false).map((a) => a.id);
    if (owners.length) return owners;
  } catch (e) {
    console.error("owner registry fallback:", e instanceof Error ? e.message : String(e));
  }

  return [...new Set(tasks.map((t) => t.owner).filter((o): o is string => Boolean(o)))].sort();
}

function missingDoingFields(t: Task): string[] {
  const desc = t.description ?? "";
  return [
    ["다음 액션", /(^|\n)\s*다음 액션\s*:/],
    ["재개 시각", /(^|\n)\s*재개 시각\s*:/],
    ["fallback", /(^|\n)\s*fallback\s*:/i],
    ["stop_rule", /(^|\n)\s*stop_rule\s*:/i],
  ]
    .filter(([, re]) => !(re as RegExp).test(desc))
    .map(([label]) => label as string);
}

async function main(): Promise<void> {
  const res = await fetch(API_TASKS);
  if (!res.ok) throw new Error(`tasks API ${res.status}`);
  const { tasks } = (await res.json()) as { tasks: Task[] };
  const reviewOwners = await loadReviewOwners(tasks);
  const reviewOwnerSet = new Set(reviewOwners);

  // owner별 active(doing/plan) 과제 모으기
  const byOwner = new Map<string, { doing: Task[]; plan: Task[] }>();
  for (const t of tasks) {
    if (t.column === "done") continue;
    if (!t.owner || !reviewOwnerSet.has(t.owner)) continue;
    const g = byOwner.get(t.owner) ?? { doing: [], plan: [] };
    (t.column === "doing" ? g.doing : g.plan).push(t);
    byOwner.set(t.owner, g);
  }

  // active(plan/doing) 카드가 있는 owner만 핑한다. 신규/빈 칸반은 정상 no-op이다.
  // owner 없는 카드는 누구에게도 핑하지 않는다. blocked badge는 lane이 plan/doing이면 active다.
  let sent = 0;
  const activeOwners = activeReviewOwners(tasks, reviewOwners);
  for (const owner of activeOwners) {
    const g = byOwner.get(owner)!;
    const body = reviewBody(owner, g);
    if (process.env.DRY_RUN) {
      console.log(`[DRY] → ${owner} (doing ${g.doing.length}, plan ${g.plan.length}): ${body.replace(/\n/g, " ").slice(0, 90)}…`);
      sent++;
      continue;
    }
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
    if (j.ok) {
      sent++;
      console.log(`✓ review ping → ${owner} (doing ${g.doing.length}, plan ${g.plan.length})`);
    } else {
      console.error(`✗ ping failed → ${owner}: ${JSON.stringify(j)}`);
    }
  }
  console.log(`done: ${sent}/${activeOwners.length} active owners pinged (${reviewOwners.length - activeOwners.length} inactive skipped)`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("task-review error:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
