#!/usr/bin/env bun
// 매일 03:00 KST 새 세션 재시작 잡(`sched_nightly_fresh_restart`)을 등록한다.
//   기본은 --dry-run: 무엇을 등록할지만 출력하고 team.db 는 읽기 전용으로만 연다. 등록은 --commit.
//   이미 있으면 아무것도 바꾸지 않고 현재 상태만 출력한다(덮어쓰지 않는다).
//   서버를 재시작하지 않아도 스케줄러가 다음 틱에 집어 간다. 등록은 운영자가 한다.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createCronJob, getScheduledJob } from "../src/server/scheduler/core";

export const JOB_ID = "sched_nightly_fresh_restart";
export const EXEC_KEY = "nightly-fresh-restart";
export const CRON = "0 3 * * *";
export const TITLE = "매일 03:00 쉬는 팀원 새 세션 재시작";

export function register(db: Database, commit: boolean, from?: Date): { action: "exists" | "would_create" | "created"; nextRunAt?: string } {
  const existing = getScheduledJob(db, JOB_ID);
  if (existing) return { action: "exists", nextRunAt: existing.next_run_at };
  if (!commit) return { action: "would_create" };
  const job = createCronJob(db, {
    id: JOB_ID,
    title: TITLE,
    cron: CRON,
    timezone: "Asia/Seoul",
    holidayPolicy: "run",
    createdBy: "system",
    payload: { type: "exec", execKey: EXEC_KEY },
    from,
  });
  return { action: "created", nextRunAt: job.next_run_at };
}

if (import.meta.main) {
  const commit = process.argv.includes("--commit");
  const db = new Database(process.env.TEAM_DB_PATH ?? join(import.meta.dir, "..", "team.db"), commit ? undefined : { readonly: true });
  const r = register(db, commit);
  console.log(`${commit ? "--commit" : "--dry-run"} · ${JOB_ID} · cron "${CRON}" Asia/Seoul · holidayPolicy run · execKey ${EXEC_KEY} → ${r.action}${r.nextRunAt ? ` (next_run_at ${r.nextRunAt} UTC)` : ""}`);
}
