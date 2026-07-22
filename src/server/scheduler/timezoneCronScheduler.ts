import { type HolidayPolicy, parseCron, type ParsedCron } from "./cron";

export interface TimezoneCronSchedulerOptions {
  timezone?: string;
  holidayPolicy?: HolidayPolicy;
  /** Predicate: is the given YYYY-MM-DD in the scheduler timezone a holiday? */
  isHoliday?: (dateStr: string) => boolean;
  /** Search horizon in years. Defaults to 4, matching the legacy cron engine. */
  horizonYears?: number;
}

interface LocalMinute {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ymd: string;
  wallKey: string;
  dow: number;
}

/**
 * DST-aware cron evaluator that is intentionally separate from the existing fixed-offset
 * `nextCronRun()` implementation. It evaluates cron fields against the target timezone's
 * wall clock on every candidate minute, so DST gaps are naturally skipped and repeated
 * wall-clock minutes can be de-duplicated.
 */
export class TimezoneCronScheduler {
  private readonly timezone: string;
  private readonly holidayPolicy: HolidayPolicy;
  private readonly isHoliday: (dateStr: string) => boolean;
  private readonly horizonMs: number;
  private readonly formatter: Intl.DateTimeFormat;

  constructor(opts: TimezoneCronSchedulerOptions = {}) {
    this.timezone = opts.timezone ?? "Asia/Seoul";
    this.holidayPolicy = opts.holidayPolicy ?? "run";
    this.isHoliday = opts.isHoliday ?? (() => false);
    this.horizonMs = (opts.horizonYears ?? 4) * 366 * 24 * 3600_000;
    this.formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: this.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });

    // Validate timezone early with Intl, without imposing the legacy fixed-offset guard.
    this.formatter.format(new Date(0));
  }

  nextRun(expr: string, after: Date, opts: Omit<TimezoneCronSchedulerOptions, "timezone" | "horizonYears"> = {}): Date {
    const cron = parseCron(expr);
    this.assertPossibleCalendarMatch(expr, cron, after);
    const policy = opts.holidayPolicy ?? this.holidayPolicy;
    const isHoliday = opts.isHoliday ?? this.isHoliday;
    const deadline = after.getTime() + this.horizonMs;
    const afterWallKey = this.localMinute(after).wallKey;

    for (const localDay of this.localDaysAfter(after, deadline)) {
      if (!cron.month.set.has(localDay.month)) continue;
      if (!this.dayMatches(cron, localDay)) continue;
      const ymd = `${localDay.year}-${pad2(localDay.month)}-${pad2(localDay.day)}`;
      if (policy === "skip" && isHoliday(ymd)) continue;

      for (const hour of sorted(cron.hour.set)) {
        for (const minute of sorted(cron.minute.set)) {
          const wallKey = `${ymd}T${pad2(hour)}:${pad2(minute)}`;
          if (wallKey <= afterWallKey) continue;

          const candidate = this.findWallMinute(ymd, hour, minute, localDay.noonUtcMs - 18 * 3600_000, localDay.noonUtcMs + 18 * 3600_000);
          if (!candidate || candidate.getTime() <= after.getTime() || candidate.getTime() > deadline) continue;

          if (policy === "shift" && isHoliday(ymd)) {
            return this.shiftToNextNonHoliday({ ...localDay, hour, minute, second: 0, ymd, wallKey }, isHoliday, deadline);
          }

          return candidate;
        }
      }
    }

    throw new Error(`cron '${expr}' produced no run within ${this.horizonMs / (366 * 24 * 3600_000)} years`);
  }

  private assertPossibleCalendarMatch(expr: string, cron: ParsedCron, after: Date): void {
    if (cron.dom.all) return;

    const startYear = this.localMinute(after).year;
    const yearsToCheck = Math.ceil(this.horizonMs / (366 * 24 * 3600_000));
    for (let year = startYear; year <= startYear + yearsToCheck; year++) {
      for (const month of cron.month.set) {
        const maxDay = daysInMonth(year, month);
        for (const day of cron.dom.set) {
          if (day <= maxDay) return;
        }
      }
    }

    throw new Error(`cron '${expr}' produced no run within ${this.horizonMs / (366 * 24 * 3600_000)} years`);
  }

  private localMinute(date: Date): LocalMinute {
    const parts = this.formatter.formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes): number => {
      const raw = parts.find((p) => p.type === type)?.value;
      if (raw === undefined) throw new Error(`timezone '${this.timezone}' did not render '${type}'`);
      return Number(raw);
    };
    const year = get("year");
    const month = get("month");
    const day = get("day");
    const hour = get("hour");
    const minute = get("minute");
    const second = get("second");
    const ymd = `${year}-${pad2(month)}-${pad2(day)}`;
    const wallKey = `${ymd}T${pad2(hour)}:${pad2(minute)}`;
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return { year, month, day, hour, minute, second, ymd, wallKey, dow };
  }

  private *localDaysAfter(after: Date, deadline: number): Generator<LocalMinute & { noonUtcMs: number }> {
    const start = this.localMinute(after);
    const startDay = Date.UTC(start.year, start.month - 1, start.day, 12, 0, 0);
    const days = Math.ceil((deadline - after.getTime()) / (24 * 3600_000)) + 2;
    for (let i = 0; i <= days; i++) {
      const noonUtcMs = startDay + i * 24 * 3600_000;
      const d = new Date(noonUtcMs);
      const year = d.getUTCFullYear();
      const month = d.getUTCMonth() + 1;
      const day = d.getUTCDate();
      const ymd = `${year}-${pad2(month)}-${pad2(day)}`;
      yield { year, month, day, hour: 0, minute: 0, second: 0, ymd, wallKey: `${ymd}T00:00`, dow: d.getUTCDay(), noonUtcMs };
    }
  }

  private matches(cron: ParsedCron, local: LocalMinute): boolean {
    if (local.second !== 0) return false;
    if (!cron.month.set.has(local.month)) return false;
    if (!this.dayMatches(cron, local)) return false;
    if (!cron.hour.set.has(local.hour)) return false;
    if (!cron.minute.set.has(local.minute)) return false;
    return true;
  }

  private dayMatches(cron: ParsedCron, local: LocalMinute): boolean {
    const domOk = cron.dom.set.has(local.day);
    const dowOk = cron.dow.set.has(local.dow);
    const domRestricted = !cron.dom.all;
    const dowRestricted = !cron.dow.all;
    if (domRestricted && dowRestricted) return domOk || dowOk;
    if (domRestricted) return domOk;
    if (dowRestricted) return dowOk;
    return true;
  }

  private shiftToNextNonHoliday(
    local: LocalMinute,
    isHoliday: (dateStr: string) => boolean,
    deadline: number,
  ): Date {
    const targetHour = local.hour;
    const targetMinute = local.minute;
    let t = Date.UTC(local.year, local.month - 1, local.day, 12, 0, 0) + 24 * 3600_000;
    const end = Math.min(deadline, t + 366 * 24 * 3600_000);

    while (t <= end) {
      const probe = this.localMinute(new Date(t));
      if (!isHoliday(probe.ymd)) {
        const shifted = this.findWallMinute(probe.ymd, targetHour, targetMinute, t - 18 * 3600_000, t + 18 * 3600_000);
        if (shifted) return shifted;
      }
      t += 24 * 3600_000;
    }
    throw new Error("holiday shift exceeded one year of consecutive holidays");
  }

  private findWallMinute(ymd: string, hour: number, minute: number, fromUtcMs: number, toUtcMs: number): Date | null {
    const start = Math.floor(fromUtcMs / 60_000) * 60_000;
    const end = Math.ceil(toUtcMs / 60_000) * 60_000;
    const target = `${ymd}T${pad2(hour)}:${pad2(minute)}`;
    for (let t = start; t <= end; t += 60_000) {
      if (this.localMinute(new Date(t)).wallKey === target) return new Date(t);
    }
    return null;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function sorted(values: Set<number>): number[] {
  return [...values].sort((a, b) => a - b);
}
