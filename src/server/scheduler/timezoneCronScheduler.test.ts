import { describe, expect, test } from "bun:test";
import { TimezoneCronScheduler } from "./timezoneCronScheduler";

function iso(d: Date): string {
  return d.toISOString();
}

describe("TimezoneCronScheduler", () => {
  test("keeps Asia/Seoul wall-clock schedules without touching the legacy cron engine", () => {
    const scheduler = new TimezoneCronScheduler({ timezone: "Asia/Seoul" });

    const next = scheduler.nextRun("0 9 * * *", new Date("2026-07-20T23:00:00.000Z"));

    expect(iso(next)).toBe("2026-07-21T00:00:00.000Z"); // 09:00 KST
  });

  test("supports America/New_York daily jobs across DST with stable local wall-clock time", () => {
    const scheduler = new TimezoneCronScheduler({ timezone: "America/New_York" });

    const beforeDst = scheduler.nextRun("0 6 * * *", new Date("2026-03-07T12:00:00.000Z"));
    const afterDst = scheduler.nextRun("0 6 * * *", beforeDst);

    expect(iso(beforeDst)).toBe("2026-03-08T10:00:00.000Z"); // 06:00 EDT after spring-forward
    expect(iso(afterDst)).toBe("2026-03-09T10:00:00.000Z"); // still 06:00 EDT
  });

  test("skips nonexistent spring-forward local times", () => {
    const scheduler = new TimezoneCronScheduler({ timezone: "America/New_York" });

    const next = scheduler.nextRun("30 2 * * *", new Date("2026-03-08T00:00:00.000Z"));

    expect(iso(next)).toBe("2026-03-09T06:30:00.000Z"); // 02:30 local does not exist on 2026-03-08
  });

  test("uses only the first occurrence of duplicated fall-back local times", () => {
    const scheduler = new TimezoneCronScheduler({ timezone: "America/New_York" });

    const first = scheduler.nextRun("30 1 * * *", new Date("2026-11-01T00:00:00.000Z"));
    const second = scheduler.nextRun("30 1 * * *", first);

    expect(iso(first)).toBe("2026-11-01T05:30:00.000Z"); // first 01:30, EDT
    expect(iso(second)).toBe("2026-11-02T06:30:00.000Z"); // skip duplicate 01:30 EST on the same local day
  });

  test("applies holiday skip policy in a DST timezone", () => {
    const scheduler = new TimezoneCronScheduler({
      timezone: "America/New_York",
      holidayPolicy: "skip",
      isHoliday: (dateStr) => dateStr === "2026-07-04",
    });

    const next = scheduler.nextRun("0 9 * * *", new Date("2026-07-03T14:00:00.000Z"));

    expect(iso(next)).toBe("2026-07-05T13:00:00.000Z"); // 09:00 EDT, skips July 4
  });

  test("applies holiday shift policy in a DST timezone", () => {
    const scheduler = new TimezoneCronScheduler({
      timezone: "America/New_York",
      holidayPolicy: "shift",
      isHoliday: (dateStr) => dateStr === "2026-03-08",
    });

    const next = scheduler.nextRun("0 6 * * *", new Date("2026-03-07T12:00:00.000Z"));

    expect(iso(next)).toBe("2026-03-09T10:00:00.000Z"); // shifted day keeps 06:00 EDT wall-clock
  });

  test("throws quickly for unsatisfiable sparse cron expressions", () => {
    const scheduler = new TimezoneCronScheduler({ timezone: "America/New_York" });
    const started = performance.now();

    expect(() => scheduler.nextRun("0 0 30 2 *", new Date("2026-01-01T00:00:00.000Z"))).toThrow(/no run/);

    expect(performance.now() - started).toBeLessThan(500);
  });

  test("rejects invalid IANA timezone names", () => {
    expect(() => new TimezoneCronScheduler({ timezone: "No/Such_Zone" })).toThrow(RangeError);
  });
});
