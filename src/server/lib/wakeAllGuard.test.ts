import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkUsage, kstDay, reserveWakeAll, wakeAllCountToday } from "./wakeAllGuard";

// 2026-10-26 10:00 KST (= 01:00 UTC). 주간 창은 10-24 10:00 KST 에 시작해 2일이 지난 상태.
const NOW = new Date("2026-10-26T01:00:00Z");
const nowSec = NOW.getTime() / 1000;
const WEEK_START = nowSec - 2 * 86400;

let dir: string;
let file: string;
let db: Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wake-all-guard-"));
  file = join(dir, "usage-limits.json");
  db = new Database(":memory:");
  db.exec("CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function usage(over: Record<string, unknown> = {}) {
  const base = {
    ts: nowSec - 30,
    five_hour: { used_percentage: 20, resets_at: nowSec + 3600 },
    seven_day: { used_percentage: 20, resets_at: WEEK_START + 7 * 86400 },
  };
  writeFileSync(file, JSON.stringify({ ...base, ...over }));
}
const blocked = (r: ReturnType<typeof checkUsage>) => (r.ok ? "ok" : r.reason);

describe("usage file checks", () => {
  test("normal values pass", () => {
    usage();
    expect(checkUsage(NOW, file)).toEqual({ ok: true });
  });
  test("missing file / invalid JSON block", () => {
    expect(checkUsage(NOW, file).ok).toBe(false);
    writeFileSync(file, "{not json");
    expect(checkUsage(NOW, file).ok).toBe(false);
  });
  test("stale ts (>10 min) blocks, exactly 10 min passes", () => {
    usage({ ts: nowSec - 601 });
    expect(blocked(checkUsage(NOW, file))).toContain("10분");
    usage({ ts: nowSec - 600 });
    expect(checkUsage(NOW, file).ok).toBe(true);
  });
  test("missing / non-numeric ts blocks", () => {
    usage({ ts: undefined });
    expect(checkUsage(NOW, file).ok).toBe(false);
    usage({ ts: "now" });
    expect(checkUsage(NOW, file).ok).toBe(false);
  });
  test("five-hour: null blocks, 70 blocks, 69.9 passes", () => {
    usage({ five_hour: { used_percentage: null, resets_at: nowSec } });
    expect(blocked(checkUsage(NOW, file))).toContain("5시간");
    usage({ five_hour: {} });
    expect(checkUsage(NOW, file).ok).toBe(false);
    usage({ five_hour: { used_percentage: 70 } });
    expect(blocked(checkUsage(NOW, file))).toContain("70%");
    usage({ five_hour: { used_percentage: 69.9 } });
    expect(checkUsage(NOW, file).ok).toBe(true);
  });
  test("weekly pace: >15 %p/day blocks, exactly 15 passes (2 days elapsed → 30%)", () => {
    usage({ seven_day: { used_percentage: 30.5, resets_at: WEEK_START + 7 * 86400 } });
    expect(blocked(checkUsage(NOW, file))).toContain("주간");
    usage({ seven_day: { used_percentage: 30, resets_at: WEEK_START + 7 * 86400 } });
    expect(checkUsage(NOW, file).ok).toBe(true);
  });
  test("weekly values null / window inconsistent block", () => {
    usage({ seven_day: { used_percentage: null, resets_at: WEEK_START + 7 * 86400 } });
    expect(checkUsage(NOW, file).ok).toBe(false);
    usage({ seven_day: { used_percentage: 1 } });
    expect(checkUsage(NOW, file).ok).toBe(false);
    usage({ seven_day: { used_percentage: 1, resets_at: nowSec + 8 * 86400 } }); // 창이 아직 시작 전
    expect(checkUsage(NOW, file).ok).toBe(false);
    usage({ seven_day: { used_percentage: 1, resets_at: nowSec - 10 } }); // 창이 이미 끝남
    expect(checkUsage(NOW, file).ok).toBe(false);
  });
});

describe("daily count", () => {
  test("two wake-alls pass, the third is blocked even with good usage", () => {
    usage();
    expect(reserveWakeAll(db, NOW, file).ok).toBe(true);
    expect(reserveWakeAll(db, NOW, file).ok).toBe(true);
    const third = reserveWakeAll(db, NOW, file);
    expect(third.ok).toBe(false);
    expect(wakeAllCountToday(db, NOW)).toBe(2);
  });
  test("a blocked attempt does not use up a slot", () => {
    expect(reserveWakeAll(db, NOW, file).ok).toBe(false); // no file
    expect(wakeAllCountToday(db, NOW)).toBe(0);
    usage();
    expect(reserveWakeAll(db, NOW, file).ok).toBe(true);
    expect(wakeAllCountToday(db, NOW)).toBe(1);
  });
  test("the count lives in the DB: a new connection to the same data continues it", () => {
    usage();
    reserveWakeAll(db, NOW, file);
    reserveWakeAll(db, NOW, file);
    expect(reserveWakeAll(db, new Date(NOW.getTime() + 60_000), file).ok).toBe(false);
  });
  test("the day rolls over at KST midnight (not UTC)", () => {
    usage({ ts: undefined });
    const beforeMidnight = new Date("2026-10-26T14:59:00Z"); // 23:59 KST
    const afterMidnight = new Date("2026-10-26T15:01:00Z"); // 00:01 KST next day
    expect(kstDay(beforeMidnight)).toBe("2026-10-26");
    expect(kstDay(afterMidnight)).toBe("2026-10-27");
    const at = (d: Date) => {
      const s = d.getTime() / 1000;
      writeFileSync(file, JSON.stringify({
        ts: s - 5,
        five_hour: { used_percentage: 10 },
        seven_day: { used_percentage: 10, resets_at: s - 2 * 86400 + 7 * 86400 },
      }));
      return reserveWakeAll(db, d, file).ok;
    };
    expect(at(beforeMidnight)).toBe(true);
    expect(at(beforeMidnight)).toBe(true);
    expect(at(beforeMidnight)).toBe(false);
    expect(at(afterMidnight)).toBe(true);
  });
  test("a DB error blocks instead of waking", () => {
    usage();
    db.exec("DROP TABLE setting");
    expect(reserveWakeAll(db, NOW, file).ok).toBe(false);
  });
});
