// b3os scheduler — cron next-run engine (min·hour·day-of-month·month·day-of-week)
// + timezone-aware evaluation + holiday policy.
//
// Design notes:
// - Standard 5-field cron: `minute hour day-of-month month day-of-week`.
//   Each field supports `*`, `a`, `a,b,c`, `a-b`, `*/n`, `a-b/n`. dow 0-7 (0 and 7 = Sunday).
// - day-of-month / day-of-week follow Vixie semantics: when BOTH are restricted
//   (neither is `*`), a match on EITHER field fires; when only one is restricted,
//   only that one gates.
// - Timezone: cron fields are evaluated in the job's timezone (default Asia/Seoul).
//   KST has no DST, so a constant UTC offset is exact. The offset is sampled once
//   from `after` via Intl; for fixed-offset zones (KST) this is stable. Zones WITH
//   DST are approximated at the sampled offset — acceptable for this team (KST-only)
//   and documented so a future change can swap in a DST-aware library if needed.
// - Holiday policy is injected as an `isHoliday(dateStr)` predicate so this module
//   stays DB-agnostic and unit-testable.

export type HolidayPolicy = "run" | "skip" | "shift";

export interface CronSchedule {
  /** 5-field cron expression, e.g. "4 3 * * *" (03:04 daily). */
  cron: string;
  /** Holiday handling for computed occurrences. Default "run" (fire regardless). */
  holidayPolicy?: HolidayPolicy;
}

interface CronField {
  /** true when the field is `*` (unrestricted). */
  all: boolean;
  /** allowed values (always populated, even when `all`). */
  set: Set<number>;
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dom: CronField; // day of month 1-31
  month: CronField; // 1-12
  dow: CronField; // day of week 0-6 (Sunday=0)
}

const FIELD_BOUNDS: Array<{ name: keyof ParsedCron; min: number; max: number }> = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dom", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dow", min: 0, max: 7 },
];

function parseField(raw: string, min: number, max: number, fieldName: string): CronField {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error(`cron field '${fieldName}' is empty`);
  const all = trimmed === "*";
  const set = new Set<number>();

  for (const part of trimmed.split(",")) {
    const token = part.trim();
    if (token === "") throw new Error(`cron field '${fieldName}' has an empty list item`);

    // step form: <range>/<step>  where <range> is '*' | 'a' | 'a-b'
    let rangeSpec = token;
    let step = 1;
    const slash = token.indexOf("/");
    if (slash !== -1) {
      rangeSpec = token.slice(0, slash);
      const stepStr = token.slice(slash + 1);
      step = Number(stepStr);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`cron field '${fieldName}' has an invalid step: '${token}'`);
      }
    }

    const hasStep = slash !== -1;
    let lo: number;
    let hi: number;
    if (rangeSpec === "*") {
      lo = min;
      hi = max;
    } else if (rangeSpec.includes("-")) {
      const bounds = rangeSpec.split("-");
      if (bounds.length !== 2) {
        // Reject malformed ranges like "1-2-3" instead of silently taking [1,2].
        throw new Error(`cron field '${fieldName}' has a malformed range: '${token}'`);
      }
      lo = Number(bounds[0]);
      hi = Number(bounds[1]);
    } else {
      lo = Number(rangeSpec);
      // Vixie semantics: a bare number WITH a step (`N/M`) means N..max step M
      // (e.g. "5/15" → 5,20,35,50). Without a step it is the single value N.
      hi = hasStep ? max : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new Error(`cron field '${fieldName}' has a non-integer value: '${token}'`);
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`cron field '${fieldName}' value out of range [${min}-${max}]: '${token}'`);
    }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }

  if (set.size === 0) throw new Error(`cron field '${fieldName}' matched no values`);
  return { all, set };
}

export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields (min hour dom month dow), got ${fields.length}: '${expr}'`);
  }
  const parsed = {} as Record<keyof ParsedCron, CronField>;
  FIELD_BOUNDS.forEach((bound, i) => {
    const field = parseField(fields[i]!, bound.min, bound.max, bound.name);
    if (bound.name === "dow") {
      // Normalize Sunday: 7 → 0.
      if (field.set.has(7)) {
        field.set.delete(7);
        field.set.add(0);
      }
    }
    parsed[bound.name] = field;
  });
  return parsed as ParsedCron;
}

/**
 * Offset (ms) to add to a UTC instant to get the wall-clock reading in `tz`.
 * For Asia/Seoul this is a constant +9h. Sampled via Intl so it works for any
 * fixed-offset zone without hardcoding.
 */
export function tzOffsetMs(date: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23", // guarantees hour 0-23 (never renders midnight as 24)
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - date.getTime();
}

/**
 * Throw if `tz` observes DST (a non-constant UTC offset). The nextCronRun algorithm
 * samples the offset once and treats it as constant, which is exact only for
 * fixed-offset zones (e.g. Asia/Seoul). This enforces that documented assumption in
 * code so a caller can't silently get wrong wall-clock times in a DST zone.
 */
export function assertFixedOffsetTimezone(tz: string): void {
  const year = new Date().getUTCFullYear();
  const jan = tzOffsetMs(new Date(Date.UTC(year, 0, 1, 12, 0, 0)), tz);
  const jul = tzOffsetMs(new Date(Date.UTC(year, 6, 1, 12, 0, 0)), tz);
  if (jan !== jul) {
    throw new Error(
      `timezone '${tz}' observes DST (offset ${jan / 3600_000}h vs ${jul / 3600_000}h); the cron engine only supports fixed-offset zones (e.g. Asia/Seoul)`,
    );
  }
}

function ymd(local: Date): string {
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const d = String(local.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dayMatches(cron: ParsedCron, local: Date): boolean {
  const domOk = cron.dom.set.has(local.getUTCDate());
  const dowOk = cron.dow.set.has(local.getUTCDay());
  const domRestricted = !cron.dom.all;
  const dowRestricted = !cron.dow.all;
  if (domRestricted && dowRestricted) return domOk || dowOk; // Vixie: either matches
  if (domRestricted) return domOk;
  if (dowRestricted) return dowOk;
  return true; // both '*'
}

export interface NextCronRunOptions {
  timezone?: string;
  holidayPolicy?: HolidayPolicy;
  /** Predicate: is the given YYYY-MM-DD (in the job timezone) a holiday? */
  isHoliday?: (dateStr: string) => boolean;
}

// Wall-clock search horizon: a cron with no match within 4 years is treated as
// unsatisfiable (e.g. Feb 30) and throws instead of scanning unboundedly. The field-
// level advance converges in well under a few hundred jumps for real schedules; this
// is only the pathological-input backstop. A hard iteration cap guards against a
// logic error letting the horizon check never trip.
const HORIZON_MS = 4 * 366 * 24 * 3600_000;
const HARD_ITER_CAP = 200_000;

/**
 * Compute the next fire instant strictly after `after` for a cron expression,
 * evaluated in `timezone`. Returns a UTC Date. Throws if no match within ~4 years
 * (unsatisfiable schedule), on an invalid expression, or on a DST timezone.
 */
export function nextCronRun(expr: string, after: Date, opts: NextCronRunOptions = {}): Date {
  const cron = parseCron(expr);
  const tz = opts.timezone ?? "Asia/Seoul";
  assertFixedOffsetTimezone(tz);
  const policy = opts.holidayPolicy ?? "run";
  const isHoliday = opts.isHoliday ?? (() => false);
  // Compute the offset from a whole-minute instant. Sampling it from a `after` that
  // carries seconds/ms would leak that sub-minute remainder into `offset` (asUtc is
  // whole-second), which then makes setUTCSeconds(0,0) floor the candidate a minute
  // early. For fixed-offset zones the offset is whole-minute, so this is exact.
  const offset = tzOffsetMs(new Date(Math.floor(after.getTime() / 60_000) * 60_000), tz);
  const deadline = after.getTime() + HORIZON_MS;

  const fromLocal = (l: Date) => new Date(l.getTime() - offset);

  // Candidate in "local" time: a Date whose UTC getters read the tz wall clock.
  // Start at the next whole minute strictly after `after`.
  const startUtcMinute = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const local = new Date(startUtcMinute + offset);
  local.setUTCSeconds(0, 0);

  for (let i = 0; i < HARD_ITER_CAP; i++) {
    if (local.getTime() - offset > deadline) {
      throw new Error(`cron '${expr}' produced no run within 4 years (unsatisfiable?)`);
    }
    if (!cron.month.set.has(local.getUTCMonth() + 1)) {
      // Jump to the 1st of the next month at 00:00.
      local.setUTCMonth(local.getUTCMonth() + 1, 1);
      local.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(cron, local)) {
      local.setUTCDate(local.getUTCDate() + 1);
      local.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hour.set.has(local.getUTCHours())) {
      local.setUTCHours(local.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!cron.minute.set.has(local.getUTCMinutes())) {
      local.setUTCMinutes(local.getUTCMinutes() + 1, 0, 0);
      continue;
    }

    // Cron match. Apply holiday policy.
    if (policy !== "run" && isHoliday(ymd(local))) {
      if (policy === "skip") {
        // This occurrence lands on a holiday — advance to the next cron match.
        local.setUTCDate(local.getUTCDate() + 1);
        local.setUTCHours(0, 0, 0, 0);
        continue;
      }
      // shift: fire on the next non-holiday day at the same hour:minute.
      // NOTE (Steve review F-A): the shifted day is NOT re-validated against the cron's
      // month/dom/dow fields — "shift" means "business-day bump," so a restricted-pattern
      // job (e.g. weekday-only or day-31-only) can land off its pattern after a shift.
      // Intended for daily-style jobs; use holidayPolicy=skip when the pattern must hold.
      let guard = 0;
      do {
        local.setUTCDate(local.getUTCDate() + 1);
        if (++guard > 366) throw new Error("holiday shift exceeded one year of consecutive holidays");
      } while (isHoliday(ymd(local)));
      return fromLocal(local);
    }
    return fromLocal(local);
  }
  // Backstop: the wall-clock deadline check above should always trip first; reaching
  // the iteration cap means a field-advance logic error, not a normal unsatisfiable cron.
  throw new Error(`cron '${expr}' exceeded the iteration cap (${HARD_ITER_CAP}) — internal error`);
}
