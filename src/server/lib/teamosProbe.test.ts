import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { createCronJob } from "../scheduler/core";
import { teamOsSnapshot, judgeScheduledJob, __resetTeamOsSnapshotCacheForTest } from "./teamosProbe";

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

// ─────────────────────────────────────────────────────────────────────────────
// 죽은 잡을 초록불로 보여주던 판정 (2026-07-30 사고)
//   실패로 정지한 잡이 "next=9시간 전" 이라고 적힌 채 running=true 로 떴다. 화면이 고장을 정상이라 말했다.
//   ★시각을 인자로 받아 고정한다★ — "지금"에 의존하면 이 판정을 검증할 수 없다.
// ─────────────────────────────────────────────────────────────────────────────
describe("judgeScheduledJob — 초록불을 줄지 판정", () => {
  const NOW = Date.parse("2026-07-30T01:00:00Z"); // 10:00 KST
  const at = (iso: string) => ({ enabled: 1, status: "pending" as string | null, next_run_at: iso });

  test("정상: 다음 실행이 미래 → 초록불", () => {
    const v = judgeScheduledJob(at("2026-07-30 01:30:00"), NOW);
    expect(v.running).toBe(true);
    expect(v.problem).toBeNull();
  });

  test("★실패로 정지한 잡은 초록불이 아니다★ (사고 회귀)", () => {
    // 사고 그대로의 행: 실패 상태인데 next_run_at 은 9시간 전에 멈춰 있다.
    const v = judgeScheduledJob({ enabled: 1, status: "failed", next_run_at: "2026-07-29 15:30:00" }, NOW);
    expect(v.running).toBe(false);
    expect(v.problem).toBe("failed");
  });

  test("★status 가 pending 이어도 시각이 한참 지났으면 밀림★ — 값이 있다는 것만으로 통과시키지 않는다", () => {
    const v = judgeScheduledJob(at("2026-07-29 15:30:00"), NOW);
    expect(v.running).toBe(false);
    expect(v.problem).toBe("overdue");
    expect(v.overdueMin).toBe(570); // 9시간 30분
  });

  test("유예(5분) 안쪽으로 지난 건 밀림이 아니다 — tick 간격의 정상적인 찰나까지 잡으면 거짓 경보", () => {
    const v = judgeScheduledJob(at("2026-07-30 00:58:00"), NOW); // 2분 지남
    expect(v.running).toBe(true);
    expect(v.problem).toBeNull();
  });

  test("유예를 넘긴 순간부터 밀림", () => {
    expect(judgeScheduledJob(at("2026-07-30 00:54:00"), NOW).problem).toBe("overdue"); // 6분
  });

  test("다음 시각이 없으면 초록불도 아니고 밀림도 아니다 — 모르는 것은 모른다고 둔다", () => {
    const v = judgeScheduledJob({ enabled: 1, status: "pending", next_run_at: null }, NOW);
    expect(v.running).toBe(false);
    expect(v.problem).toBeNull();
  });

  test("시각 문자열이 깨졌으면 밀림으로 단정하지 않는다", () => {
    const v = judgeScheduledJob(at("not-a-date"), NOW);
    expect(v.problem).toBeNull();
  });

  test("꺼둔 잡은 고장이 아니다 — disabled 와 죽음을 구분한다", () => {
    const v = judgeScheduledJob({ enabled: 0, status: "pending", next_run_at: "2026-07-30 01:30:00" }, NOW);
    expect(v.running).toBe(false);
    expect(v.problem).toBeNull();
  });
});

describe("teamOsSnapshot 이 문제를 화면 데이터에 실어 보낸다", () => {
  test("★실패한 잡은 detail 에 이유가 찍히고 running=false★", () => {
    const db = new Database(":memory:");
    migrate(db);
    createCronJob(db, {
      id: "guard-job",
      title: "진행 지속 가드",
      cron: "*/30 * * * *",
      timezone: "Asia/Seoul",
      createdBy: "test",
      payload: { type: "exec", execKey: "task-continuation-guard" },
    });
    db.prepare("UPDATE scheduled_job SET status='failed', next_run_at='2026-07-29 15:30:00' WHERE id='guard-job'").run();
    __resetTeamOsSnapshotCacheForTest();

    const row = teamOsSnapshot(db).scheduled.find((j) => j.label === "guard-job");
    expect(row?.running).toBe(false);
    expect(row?.problem).toBe("failed");
    expect(row?.detail).toContain("실패로 정지");
  });
});

// steve 리뷰의 블로커성 지적: A(실패 시 재예약)가 들어오면 ★방금 실패한 잡이 화면상 초록불★ 이 된다.
//   연속 3회를 채워야 빨개지는데 일간 잡은 그게 3일이다. 이 화면이 고치려던 문제를 작게 다시 만드는 것.
describe("judgeScheduledJob — 재시도 대기와 실행 중을 구분한다", () => {
  const NOW = Date.parse("2026-07-30T01:00:00Z"); // 10:00 KST

  test("★직전 시도가 실패했으면 초록불이 아니다★ — 재예약됐어도 amber", () => {
    const v = judgeScheduledJob(
      { enabled: 1, status: "pending", next_run_at: "2026-07-30 01:30:00", last_error: "exec_failed:..." },
      NOW,
    );
    expect(v.running).toBe(false);
    expect(v.problem).toBe("retrying");
  });

  test("성공해서 에러가 지워졌으면 초록불", () => {
    const v = judgeScheduledJob(
      { enabled: 1, status: "pending", next_run_at: "2026-07-30 01:30:00", last_error: null },
      NOW,
    );
    expect(v.running).toBe(true);
    expect(v.problem).toBeNull();
  });

  test("정지(failed)가 재시도보다 우선한다 — 더 나쁜 쪽을 보여준다", () => {
    const v = judgeScheduledJob(
      { enabled: 1, status: "failed", next_run_at: "2026-07-30 01:30:00", last_error: "boom" },
      NOW,
    );
    expect(v.problem).toBe("failed");
  });

  test("★실행 중인 잡을 밀림으로 잡지 않는다★ — claim 은 next_run_at 을 안 옮긴다", () => {
    // 긴 exec 가 도는 중: 예정 시각은 이미 지났지만 리스가 살아 있다.
    const v = judgeScheduledJob(
      { enabled: 1, status: "running", next_run_at: "2026-07-30 00:50:00", lock_until: "2026-07-30 01:05:00" },
      NOW,
    );
    expect(v.problem).toBeNull();
  });

  test("리스가 만료된 채 running 이면 밀림이 맞다 — 죽은 워커가 물고 있는 것", () => {
    const v = judgeScheduledJob(
      { enabled: 1, status: "running", next_run_at: "2026-07-30 00:00:00", lock_until: "2026-07-30 00:10:00" },
      NOW,
    );
    expect(v.problem).toBe("overdue");
  });
});
