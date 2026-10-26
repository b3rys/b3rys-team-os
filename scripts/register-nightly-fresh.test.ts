import { describe, expect, test } from "bun:test";
import { openDb, migrate } from "../src/server/db/migrate";
import { getScheduledJob, EXEC_ALLOWLIST } from "../src/server/scheduler/core";
import { CRON, EXEC_KEY, JOB_ID, register } from "./register-nightly-fresh";

function db() {
  const d = openDb(":memory:");
  migrate(d);
  return d;
}

describe("register-nightly-fresh", () => {
  test("dry-run 은 아무것도 만들지 않는다", () => {
    const d = db();
    expect(register(d, false)).toEqual({ action: "would_create" });
    expect(getScheduledJob(d, JOB_ID)).toBeNull();
  });

  test("--commit 은 고정 id·03:00 KST cron·exec 페이로드로 만든다", () => {
    const d = db();
    const r = register(d, true, new Date("2026-10-27T10:00:00Z"));
    expect(r.action).toBe("created");
    const job = getScheduledJob(d, JOB_ID)!;
    expect(job.id).toBe("sched_nightly_fresh_restart");
    expect(job.timezone).toBe("Asia/Seoul");
    expect(JSON.parse(job.schedule_expr!)).toMatchObject({ cron: "0 3 * * *", holidayPolicy: "run" });
    expect(JSON.parse(job.payload_json)).toEqual({ type: "exec", execKey: "nightly-fresh-restart" });
    expect(job.next_run_at).toBe("2026-10-27 18:00:00"); // 10/28 03:00 KST
    expect(CRON).toBe("0 3 * * *");
  });

  test("이미 있으면 바꾸지 않는다(두 번 눌러도 한 개)", () => {
    const d = db();
    register(d, true);
    d.prepare("UPDATE scheduled_job SET enabled = 0 WHERE id = ?").run(JOB_ID);
    expect(register(d, true).action).toBe("exists");
    expect((d.prepare("SELECT COUNT(*) AS n FROM scheduled_job WHERE id = ?").get(JOB_ID) as { n: number }).n).toBe(1);
    expect(getScheduledJob(d, JOB_ID)!.enabled).toBe(0);
  });

  test("등록하는 execKey 는 허용 목록에 있고 --commit 으로 돈다", () => {
    expect(EXEC_ALLOWLIST[EXEC_KEY]!.command).toEqual(["bun", "run", "scripts/nightly-fresh-restart.ts", "--commit"]);
  });
});
