import { describe, expect, test } from "bun:test";
import { nextCronRun, parseCron, tzOffsetMs } from "./cron";

const KST = "Asia/Seoul";

// A UTC instant for a given KST wall clock (KST = UTC+9, no DST).
function kst(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(Date.UTC(y, mo - 1, d, h - 9, mi, 0));
}

describe("parseCron", () => {
  test("parses a 5-field expression", () => {
    const c = parseCron("4 3 * * *");
    expect([...c.minute.set]).toEqual([4]);
    expect([...c.hour.set]).toEqual([3]);
    expect(c.dom.all).toBe(true);
    expect(c.month.all).toBe(true);
    expect(c.dow.all).toBe(true);
  });

  test("parses lists, ranges, and steps", () => {
    const c = parseCron("0,30 9-17 * * 1-5");
    expect([...c.minute.set].sort((a, b) => a - b)).toEqual([0, 30]);
    expect([...c.hour.set].sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...c.dow.set].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    const step = parseCron("*/15 * * * *");
    expect([...step.minute.set].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect(step.minute.all).toBe(false);
  });

  test("normalizes Sunday 7 → 0", () => {
    const c = parseCron("0 0 * * 7");
    expect([...c.dow.set]).toEqual([0]);
  });

  test("Vixie N/step expands N..max (not just N)", () => {
    // "5/15" = every 15 min starting at :05 → 5,20,35,50 (NOT just [5]).
    expect([...parseCron("5/15 * * * *").minute.set].sort((a, b) => a - b)).toEqual([5, 20, 35, 50]);
    // hour "2/6" → 2,8,14,20
    expect([...parseCron("0 2/6 * * *").hour.set].sort((a, b) => a - b)).toEqual([2, 8, 14, 20]);
  });

  test("rejects malformed expressions", () => {
    expect(() => parseCron("* * * *")).toThrow(); // 4 fields
    expect(() => parseCron("60 * * * *")).toThrow(); // minute out of range
    expect(() => parseCron("* 24 * * *")).toThrow(); // hour out of range
    expect(() => parseCron("* * * * 8")).toThrow(); // dow out of range
    expect(() => parseCron("*/0 * * * *")).toThrow(); // zero step
    expect(() => parseCron("5-1 * * * *")).toThrow(); // inverted range
    expect(() => parseCron("1-2-3 * * * *")).toThrow(); // multi-hyphen (Steve F-B)
  });
});

describe("tzOffsetMs", () => {
  test("Asia/Seoul is a constant +9h", () => {
    expect(tzOffsetMs(new Date("2026-01-15T00:00:00Z"), KST)).toBe(9 * 3600_000);
    expect(tzOffsetMs(new Date("2026-07-15T00:00:00Z"), KST)).toBe(9 * 3600_000);
  });
});

describe("DST timezone rejection", () => {
  test("nextCronRun throws on a DST zone (offset assumption is fixed-offset only)", () => {
    expect(() => nextCronRun("0 9 * * *", new Date("2027-03-13T20:00:00Z"), { timezone: "America/New_York" })).toThrow(
      /DST|fixed-offset/,
    );
  });
  test("nextCronRun accepts a fixed-offset zone (KST, India +5:30)", () => {
    expect(() => nextCronRun("0 9 * * *", new Date("2026-07-06T00:00:00Z"), { timezone: KST })).not.toThrow();
    expect(() => nextCronRun("30 9 * * *", new Date("2026-07-06T00:00:00Z"), { timezone: "Asia/Kolkata" })).not.toThrow();
  });
});

describe("nextCronRun (KST)", () => {
  test("daily 03:04 — next fire after a time earlier that day", () => {
    const after = kst(2026, 7, 6, 1, 0); // 01:00 KST
    const next = nextCronRun("4 3 * * *", after, { timezone: KST });
    expect(next.getTime()).toBe(kst(2026, 7, 6, 3, 4).getTime());
  });

  test("daily 03:04 — rolls to next day when already past", () => {
    const after = kst(2026, 7, 6, 3, 4); // exactly at fire time → strictly after
    const next = nextCronRun("4 3 * * *", after, { timezone: KST });
    expect(next.getTime()).toBe(kst(2026, 7, 7, 3, 4).getTime());
  });

  test("wildcard '* * * * *' returns the NEXT whole minute (sub-minute now, ms-clean)", () => {
    // Real wall-clock `now` carries seconds+ms — regression for an offset that leaked
    // the ms remainder and floored the candidate a minute early (found via live smoke).
    const now = new Date("2026-07-06T00:35:09.300Z");
    const next = nextCronRun("* * * * *", now, { timezone: KST });
    expect(next.toISOString()).toBe("2026-07-06T00:36:00.000Z");
    expect(next.getUTCSeconds()).toBe(0);
    expect(next.getUTCMilliseconds()).toBe(0);
    // at :59.9 of a minute → next minute, not the same one
    const late = nextCronRun("* * * * *", new Date("2026-07-06T00:35:59.900Z"), { timezone: KST });
    expect(late.toISOString()).toBe("2026-07-06T00:36:00.000Z");
  });

  test("daily 03:04 from a sub-minute now still lands exactly on :04:00", () => {
    const now = new Date("2026-07-05T15:35:09.300Z"); // 00:35:09 KST
    const next = nextCronRun("4 3 * * *", now, { timezone: KST });
    expect(next.getUTCSeconds()).toBe(0);
    expect(next.getUTCMilliseconds()).toBe(0);
    expect(next.getTime()).toBe(kst(2026, 7, 6, 3, 4).getTime());
  });

  test("every 15 minutes advances to the next quarter", () => {
    const after = kst(2026, 7, 6, 10, 7);
    const next = nextCronRun("*/15 * * * *", after, { timezone: KST });
    expect(next.getTime()).toBe(kst(2026, 7, 6, 10, 15).getTime());
  });

  test("specific weekday (Mon 09:00) skips forward to Monday", () => {
    // 2026-07-06 is a Monday. From Tue, next Monday is 2026-07-13.
    const afterTue = kst(2026, 7, 7, 12, 0);
    const next = nextCronRun("0 9 * * 1", afterTue, { timezone: KST });
    expect(next.getTime()).toBe(kst(2026, 7, 13, 9, 0).getTime());
  });

  test("month rollover — Jan 31 23:59 → Feb 1 00:00 for a daily job", () => {
    const after = kst(2026, 1, 31, 23, 59);
    const next = nextCronRun("0 0 * * *", after, { timezone: KST });
    expect(next.getTime()).toBe(kst(2026, 2, 1, 0, 0).getTime());
  });

  test("day-of-month schedule crosses months (1st of month)", () => {
    const after = kst(2026, 2, 15, 0, 0);
    const next = nextCronRun("0 0 1 * *", after, { timezone: KST });
    expect(next.getTime()).toBe(kst(2026, 3, 1, 0, 0).getTime());
  });

  test("Vixie: DOM and DOW both restricted → OR semantics", () => {
    // Fire on the 15th OR any Sunday. From 2026-07-06 (Mon), next is Sun 2026-07-12,
    // which comes before the 15th.
    const after = kst(2026, 7, 6, 12, 0);
    const next = nextCronRun("0 0 15 * 0", after, { timezone: KST });
    expect(next.getTime()).toBe(kst(2026, 7, 12, 0, 0).getTime());
  });

  test("unsatisfiable schedule throws (Feb 30)", () => {
    const after = kst(2026, 1, 1, 0, 0);
    expect(() => nextCronRun("0 0 30 2 *", after, { timezone: KST })).toThrow();
  });
});

describe("nextCronRun holiday policy", () => {
  // 2026-08-15 (광복절, Sat) and its substitute 2026-08-17 (Mon) are holidays.
  const isHoliday = (d: string) => d === "2026-08-15" || d === "2026-08-17";

  test("run: fires on the holiday regardless", () => {
    const after = kst(2026, 8, 14, 12, 0); // past 09:00 → next candidate is the 15th (holiday)
    const next = nextCronRun("0 9 * * *", after, { timezone: KST, holidayPolicy: "run", isHoliday });
    expect(next.getTime()).toBe(kst(2026, 8, 15, 9, 0).getTime());
  });

  test("skip: jumps over the holiday to the next non-holiday cron match", () => {
    const after = kst(2026, 8, 14, 12, 0); // after 09:00, so next candidate is the 15th
    const next = nextCronRun("0 9 * * *", after, { timezone: KST, holidayPolicy: "skip", isHoliday });
    // 15th holiday → skip; 16th is not a holiday.
    expect(next.getTime()).toBe(kst(2026, 8, 16, 9, 0).getTime());
  });

  test("shift: moves to the next non-holiday day at the same time", () => {
    // A weekly Saturday 09:00 job. 2026-08-15 is Saturday AND a holiday → shift.
    const after = kst(2026, 8, 14, 0, 0);
    const next = nextCronRun("0 9 * * 6", after, { timezone: KST, holidayPolicy: "shift", isHoliday });
    // Sat 15th holiday → shift to Sun 16th (not a holiday) at 09:00.
    expect(next.getTime()).toBe(kst(2026, 8, 16, 9, 0).getTime());
  });
});
