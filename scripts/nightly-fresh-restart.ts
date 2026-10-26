#!/usr/bin/env bun
// 매일 03:00 KST: 쉬고 있는 claude 팀원만 새 세션(fresh)으로 재시작한다.
//   목적: 대화 기록이 며칠씩 쌓여 느려지고 토큰을 많이 쓰는 것을 막는다. 새 세션은 session-handoff.ts 가
//        지난 세션 요약을 넘겨주므로 맥락은 이어진다.
//   기본은 --dry-run: 누구를 재시작/건너뛸지와 사유만 출력하고 아무것도 하지 않는다(DB 쓰기 없음). 실행은 --commit.
//   건너뛰기(하나라도 해당하면 오늘은 skip, 판단 못 하면 skip = fail-closed):
//     status.state !== "idle" · last_activity_at 이 15분 이내(또는 읽을 수 없음) · 읽지 않았거나 처리 중인 버스 메시지 있음
//     · 의도적 정지(off) · b3chat 채널(claude 가 아님) · claude 런타임이 아님
//   재시작: restartAgent(id, runtime, true) 를 한 명씩, 사이 30초. 코디네이터는 맨 마지막. 한 명이 실패해도 나머지는 계속.
//   기록: 팀원별 audit_event 한 줄(actor=nightly-fresh) + 끝에 요약 1줄. 실패·skip 이 있으면 Jensen 에게 버스 알림 1건.
// 스케줄: scheduled_job `sched_nightly_fresh_restart` (scripts/register-nightly-fresh.ts 로 등록, execKey nightly-fresh-restart).

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const REGISTRY_PATH = process.env.TEAM_AGENT_REGISTRY ?? join(ROOT, "agents.json");
const DB_PATH = process.env.TEAM_DB_PATH ?? join(ROOT, "team.db");
const API_INBOX = process.env.TEAM_INBOX_API ?? "http://127.0.0.1:7878/team/api/inbox";
const NOTIFY_AGENT = process.env.NIGHTLY_FRESH_NOTIFY_AGENT ?? "jensen";

export const IDLE_MIN = Number(process.env.NIGHTLY_FRESH_IDLE_MIN ?? "15");
// 0 = 시각과 상관없이 읽지 않은 메시지 전부(승인된 설계, 기본). 양수 = 최근 N시간 안에 온 것만 센다.
//   read_at 은 inbox/ack 를 거쳐야 찍히므로 답은 했는데 표시가 안 남은 옛 메시지가 쌓여 있으면 그 팀원은 영영 skip 된다(실측: 2026-10-27 warren 69건·james 32건).
export const PENDING_WINDOW_H = Number(process.env.NIGHTLY_FRESH_PENDING_WINDOW_H ?? "0");
export const GAP_MS = Number(process.env.NIGHTLY_FRESH_GAP_MS ?? "30000");
export const ACTOR = "nightly-fresh";

export interface Member {
  id: string;
  runtime: string;
  capabilities?: string[];
}

export type Decision = { id: string; action: "restart" | "skip"; reason: string };
export type Outcome = { id: string; result: "restarted" | "skipped" | "failed"; reason: string };

/** What the decision needs to know about one member; a field that could not be read is `undefined`/`null`. */
export interface Facts {
  state: string | null | undefined;
  lastActivityAt: string | null | undefined;
  off: boolean;
  bridged: boolean;
  /** unread or still-being-delivered bus messages addressed to the member; `null` = could not be counted. */
  pending: number | null;
}

// "YYYY-MM-DD HH:MM:SS" (UTC, no zone) as written by the status probe; anything else is unreadable.
export function parseUtc(s: string | null | undefined): number {
  if (!s || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/.test(s)) return NaN;
  return Date.parse(s.replace(" ", "T").replace(/Z?$/, "Z"));
}

export function decide(m: Member, f: Facts, nowMs: number, idleMin = IDLE_MIN): Decision {
  const skip = (reason: string): Decision => ({ id: m.id, action: "skip", reason });
  if (m.runtime !== "claude_channel") return skip(`claude 런타임이 아님(${m.runtime})`);
  if (f.bridged) return skip("b3chat 채널(claude 세션이 아님)");
  if (f.off) return skip("의도적 정지(off) 상태");
  if (f.state == null) return skip("상태를 알 수 없음");
  if (f.state !== "idle") return skip(`상태가 idle 이 아님(${f.state})`);
  const last = parseUtc(f.lastActivityAt);
  if (!Number.isFinite(last)) return skip("마지막 활동 시각을 읽을 수 없음");
  const ageMin = (nowMs - last) / 60_000;
  if (ageMin < idleMin) return skip(`마지막 활동이 ${idleMin}분 이내(${Math.max(0, Math.floor(ageMin))}분 전)`);
  if (f.pending == null) return skip("버스 메시지 수를 알 수 없음");
  if (f.pending > 0) return skip(`읽지 않았거나 처리 중인 버스 메시지 ${f.pending}건`);
  return { id: m.id, action: "restart", reason: `idle · 마지막 활동 ${Math.floor(ageMin)}분 전 · 대기 메시지 없음` };
}

/** Coordinators go last (the same order restartAll uses), the rest keep registry order. */
export function restartOrder<T extends Member>(members: readonly T[]): T[] {
  const coord = (m: Member) => (m.capabilities ?? []).includes("coordinator");
  return [...members.filter((m) => !coord(m)), ...members.filter(coord)];
}

export interface Deps {
  now: () => number;
  members: () => Member[];
  facts: (m: Member) => Facts;
  restart: (id: string, runtime: string, fresh: boolean) => Promise<{ ok: boolean; detail: string }>;
  sleep: (ms: number) => Promise<void>;
  audit: (action: string, target: string | null, detail: unknown) => void;
  notify: (body: string) => Promise<void>;
  log: (line: string) => void;
}

function recheckDecision(m: Member, d: Deps): Decision {
  try {
    return decide(m, d.facts(m), d.now());
  } catch (e) {
    return { id: m.id, action: "skip", reason: `판단 실패: ${(e as Error).message}` };
  }
}

export function summaryLine(outcomes: Outcome[], commit: boolean): string {
  const n = (r: Outcome["result"]) => outcomes.filter((o) => o.result === r).length;
  return `${commit ? "실행" : "dry-run"}: 재시작 ${n("restarted")} · 건너뜀 ${n("skipped")} · 실패 ${n("failed")} (대상 ${outcomes.length})`;
}

export async function runNightly(commit: boolean, d: Deps): Promise<Outcome[]> {
  const members = restartOrder(d.members());
  const decisions = members.map((m) => {
    try {
      return decide(m, d.facts(m), d.now());
    } catch (e) {
      return { id: m.id, action: "skip", reason: `판단 실패: ${(e as Error).message}` } as Decision;
    }
  });
  const outcomes: Outcome[] = [];
  let restartedAny = false;
  for (let i = 0; i < members.length; i++) {
    const m = members[i]!;
    const dec = decisions[i]!;
    if (dec.action === "skip") {
      outcomes.push({ id: m.id, result: "skipped", reason: dec.reason });
      d.log(`- ${m.id}: 건너뜀 — ${dec.reason}`);
      if (commit) d.audit("nightly_fresh_skipped", m.id, { reason: dec.reason });
      continue;
    }
    if (!commit) {
      outcomes.push({ id: m.id, result: "restarted", reason: dec.reason });
      d.log(`- ${m.id}: 재시작 예정 — ${dec.reason}`);
      continue;
    }
    if (restartedAny) await d.sleep(GAP_MS);
    // 앞선 재시작과 30초 대기 사이에 상태가 바뀌었을 수 있다: 재시작 직전에 다시 판단한다(처음에 정한 대로 두지 않는다).
    const recheck = recheckDecision(m, d);
    if (recheck.action === "skip") {
      outcomes.push({ id: m.id, result: "skipped", reason: `재확인: ${recheck.reason}` });
      d.log(`- ${m.id}: 건너뜀 — 재확인: ${recheck.reason}`);
      d.audit("nightly_fresh_skipped", m.id, { reason: `재확인: ${recheck.reason}` });
      continue;
    }
    restartedAny = true;
    try {
      const r = await d.restart(m.id, m.runtime, true);
      outcomes.push({ id: m.id, result: r.ok ? "restarted" : "failed", reason: r.detail });
      d.log(`- ${m.id}: ${r.ok ? "재시작" : "실패"} — ${r.detail}`);
      d.audit(r.ok ? "nightly_fresh_restarted" : "nightly_fresh_failed", m.id, { detail: r.detail });
    } catch (e) {
      const msg = (e as Error).message;
      outcomes.push({ id: m.id, result: "failed", reason: msg });
      d.log(`- ${m.id}: 실패 — ${msg}`);
      d.audit("nightly_fresh_failed", m.id, { detail: msg });
    }
  }
  const summary = summaryLine(outcomes, commit);
  d.log(summary);
  if (commit) {
    d.audit("nightly_fresh_summary", null, { summary, outcomes });
    const bad = outcomes.filter((o) => o.result !== "restarted");
    if (bad.length) {
      try {
        await d.notify([`[nightly-fresh] ${summary}`, ...bad.map((o) => `- ${o.id}: ${o.result === "failed" ? "실패" : "건너뜀"} — ${o.reason}`)].join("\n"));
      } catch (e) {
        d.log(`알림 전송 실패: ${(e as Error).message}`);
      }
    }
  }
  return outcomes;
}

// ── 실제 환경 ─────────────────────────────────────────────────────────────

/** Unread or still-being-delivered bus messages for one member. A read is recorded on the member's
 *  message_recipient row (markRead), so that row decides whenever it exists; message.read_at only decides
 *  for a direct message that has no recipient row. A recipient row still being delivered
 *  (pending/dispatching/wake_dispatched) counts even when it is marked read. expires_at may be ISO
 *  ("...T...Z") or SQL form; datetime() puts both in SQL form before comparing. */
export function countPending(db: Database, id: string, nowSql: string, sinceSql: string | null = null): number {
  const since = sinceSql ?? "0000-00-00 00:00:00";
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM message m
        LEFT JOIN message_recipient r ON r.message_id = m.id AND r.agent_id = ?1
        WHERE m.delivery_status IN ('pending','delivered')
          AND (m.expires_at IS NULL OR COALESCE(datetime(m.expires_at) > ?2, 1)) AND m.created_at >= ?3
          AND ((r.message_id IS NOT NULL AND (r.read_at IS NULL OR r.delivery_state IN ('pending','dispatching','wake_dispatched')))
            OR (r.message_id IS NULL AND m.to_agent_id = ?1 AND m.read_at IS NULL))`,
    )
    .get(id, nowSql, since) as { n: number };
  return row.n;
}

const sqlTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

async function main(): Promise<void> {
  const commit = process.argv.includes("--commit");
  const reg = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")) as Array<Member & { id: string }>;
  const members = reg.map((m) => ({ id: m.id, runtime: m.runtime, capabilities: m.capabilities }));
  const db = new Database(DB_PATH, commit ? undefined : { readonly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  const control = await import("../src/server/lib/agentControl");
  const memberChannel = await import("../src/server/lib/memberChannel");
  const { appendAudit } = await import("../src/server/db/queries");

  const deps: Deps = {
    now: () => Date.now(),
    members: () => members,
    facts: (m) => {
      const st = db.prepare("SELECT state, last_activity_at FROM agent_status WHERE agent_id = ?").get(m.id) as
        | { state: string; last_activity_at: string | null }
        | null;
      let pending: number | null = null;
      try {
        pending = countPending(db, m.id, sqlTime(Date.now()), PENDING_WINDOW_H > 0 ? sqlTime(Date.now() - PENDING_WINDOW_H * 3600_000) : null);
      } catch {
        pending = null;
      }
      let bridged = false;
      try {
        bridged = m.runtime === "claude_channel" && memberChannel.readMemberChannel(m.id, REGISTRY_PATH).kind === "b3chat";
      } catch {
        bridged = true; // 채널 종류를 못 읽으면 건드리지 않는다
      }
      return { state: st?.state, lastActivityAt: st?.last_activity_at, off: control.isAgentOff(m.id), bridged, pending };
    },
    restart: (id, runtime, fresh) => {
      if (!commit) throw new Error("dry-run 은 재시작하지 않는다"); // runNightly 가 dry-run 에서 부르지 않지만 한 번 더 막는다
      return control.restartAgent(id, runtime, fresh);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    audit: (action, target, detail) => appendAudit(db, ACTOR, action, target, detail),
    notify: async (body) => {
      const r = await fetch(API_INBOX, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_agent_id: "system",
          to_agent_id: NOTIFY_AGENT,
          type: "dm",
          source: "agent",
          thread_id: `nightly-fresh-${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)}`,
          body,
          priority: "normal",
          hop_count: 0,
        }),
      });
      const j = (await r.json()) as { ok?: boolean };
      if (!j.ok) throw new Error(`inbox ${JSON.stringify(j)}`);
    },
    log: (line) => console.log(line),
  };
  console.log(`nightly-fresh ${commit ? "--commit" : "--dry-run (아무것도 바꾸지 않음)"} · 대상 ${members.length}명`);
  const outcomes = await runNightly(commit, deps);
  if (commit && outcomes.some((o) => o.result === "failed")) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("nightly-fresh error:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
