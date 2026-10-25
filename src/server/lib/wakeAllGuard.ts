import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { REPO_ROOT } from "./personaTemplates";

// 전원 깨우기(@all·/all 버튼·첫머리 "모두/전체…")는 모든 팀원 세션을 동시에 읽히므로 사용량 검사를 통과해야 한다.
// 검사가 하나라도 걸리거나 입력을 읽지 못하면 깨우지 않는다(fail-closed).
export const WAKE_ALL_DAILY_LIMIT = 2;
export const FIVE_HOUR_MAX_PERCENT = 70;
export const USAGE_MAX_AGE_SEC = 600;
export const WEEKLY_PACE_MAX_PERCENT_PER_DAY = 15;
const WEEK_SEC = 7 * 86400;

export function usageLimitsPath(): string {
  return process.env.USAGE_LIMITS_FILE ?? join(REPO_ROOT, "var", "usage-limits.json");
}

export type WakeAllCheck = { ok: true } | { ok: false; reason: string };

/** KST 달력 날짜(YYYY-MM-DD). 하루 횟수는 KST 자정 기준으로 센다. */
export function kstDay(now: Date): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

function dayKey(now: Date): string {
  return `wake_all_count:${kstDay(now)}`;
}

export function wakeAllCountToday(db: Database, now: Date): number {
  const row = db.query("SELECT value FROM setting WHERE key = ?").get(dayKey(now)) as { value: string } | null;
  const n = Number(row?.value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 사용량 파일 검사(횟수는 보지 않는다). 사유는 그룹방에 그대로 올라가는 한 줄이다. */
export function checkUsage(now: Date, path: string = usageLimitsPath()): WakeAllCheck {
  let data: any;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, reason: "사용량 파일을 읽지 못해 깨우지 않았습니다" };
  }
  const nowSec = now.getTime() / 1000;
  const ts = num(data?.ts);
  if (ts === null || nowSec - ts > USAGE_MAX_AGE_SEC || ts - nowSec > 60) {
    return { ok: false, reason: "사용량 정보가 10분 넘게 갱신되지 않아 깨우지 않았습니다" };
  }
  const five = num(data?.five_hour?.used_percentage);
  if (five === null) return { ok: false, reason: "5시간 사용률을 알 수 없어 깨우지 않았습니다" };
  if (five >= FIVE_HOUR_MAX_PERCENT) {
    return { ok: false, reason: `5시간 사용률 ${Math.round(five)}% (기준 ${FIVE_HOUR_MAX_PERCENT}% 미만)라 깨우지 않았습니다` };
  }
  const week = num(data?.seven_day?.used_percentage);
  const resets = num(data?.seven_day?.resets_at);
  if (week === null || resets === null) return { ok: false, reason: "주간 사용률을 알 수 없어 깨우지 않았습니다" };
  const elapsedDays = (nowSec - (resets - WEEK_SEC)) / 86400;
  if (!(elapsedDays > 0) || elapsedDays > 7) return { ok: false, reason: "주간 기간 정보가 맞지 않아 깨우지 않았습니다" };
  const pace = week / elapsedDays;
  if (pace > WEEKLY_PACE_MAX_PERCENT_PER_DAY) {
    return { ok: false, reason: `주간 사용 속도가 하루 ${pace.toFixed(1)}%p (기준 ${WEEKLY_PACE_MAX_PERCENT_PER_DAY}%p 이하)라 깨우지 않았습니다` };
  }
  return { ok: true };
}

/**
 * 전원 깨우기 허용 여부를 판정하고, 허용이면 오늘 횟수를 1 올린다(판정과 증가가 한 트랜잭션).
 * 횟수는 DB에 있어 재시작 후에도 이어진다.
 */
export function reserveWakeAll(db: Database, now: Date, usagePath?: string): WakeAllCheck {
  try {
    const tx = db.transaction((): WakeAllCheck => {
      const used = wakeAllCountToday(db, now);
      if (used >= WAKE_ALL_DAILY_LIMIT) {
        return { ok: false, reason: `오늘 전원 깨우기를 ${WAKE_ALL_DAILY_LIMIT}번 모두 써서 깨우지 않았습니다` };
      }
      const usage = checkUsage(now, usagePath);
      if (!usage.ok) return usage;
      db.query(
        "INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
      ).run(dayKey(now), String(used + 1));
      return { ok: true };
    });
    return tx.immediate();
  } catch {
    return { ok: false, reason: "전원 깨우기 검사 중 오류가 나서 깨우지 않았습니다" };
  }
}
