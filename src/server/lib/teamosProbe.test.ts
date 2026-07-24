import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { createCronJob } from "../scheduler/core";
import { teamOsSnapshot, __resetTeamOsSnapshotCacheForTest } from "./teamosProbe";

describe("teamOsSnapshot scheduled_job rows", () => {
  test("labels DB scheduled jobs separately and renders next/last in KST", () => {
    const db = new Database(":memory:");
    migrate(db);
    createCronJob(db, {
      id: "daily-review",
      title: "Daily review",
      cron: "0 21 * * *",
      timezone: "Asia/Seoul",
      createdBy: "test",
      payload: { type: "exec", execKey: "task-review-ping" },
    });
    db.prepare("UPDATE scheduled_job SET next_run_at = ?, last_run_at = ? WHERE id = ?")
      .run("2026-07-21 00:30:00", "2026-07-20 23:15:00", "daily-review");
    __resetTeamOsSnapshotCacheForTest();

    const row = teamOsSnapshot(db).scheduled.find((j) => j.label === "daily-review");
    expect(row?.source).toBe("scheduled_job");
    expect(row?.detail).toContain("next=07-21 09:30 KST");
    expect(row?.detail).toContain("last=07-21 08:15 KST");
  });

  test("excludes disabled cancelled jobs retired from the OS tab", () => {
    const db = new Database(":memory:");
    migrate(db);
    createCronJob(db, {
      id: "retired-job",
      title: "Retired job",
      cron: "0 21 * * *",
      timezone: "Asia/Seoul",
      createdBy: "test",
      payload: { type: "exec", execKey: "task-review-ping" },
    });
    db.prepare("UPDATE scheduled_job SET enabled = 0, status = 'cancelled' WHERE id = 'retired-job'").run();
    __resetTeamOsSnapshotCacheForTest();

    expect(teamOsSnapshot(db).scheduled.some((job) => job.label === "retired-job")).toBe(false);
  });
});
