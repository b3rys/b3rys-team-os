import { describe, expect, test } from "bun:test";
import { deletePrompt, isTaskStale, localDateKey } from "./TasksKanban";

const now = Date.parse("2026-08-03T06:00:00Z");
const task = (updated_at: string, extra: Record<string, unknown> = {}) => ({
  id: "t1",
  title: "검토",
  owner: null,
  description: null,
  column: "plan" as const,
  updated_at,
  ...extra,
});

test("재검토일은 런타임의 로컬 달력 날짜를 사용한다", () => {
  expect(localDateKey(new Date(2026, 7, 17, 0, 30))).toBe("2026-08-17");
});

test("활성 카드와 보류 카드의 삭제 안내를 구분한다", () => {
  expect(deletePrompt(task("2026-08-03 00:00:00"))).toContain("보류하려면");
  expect(deletePrompt(task("2026-08-03 00:00:00", { held_at: "2026-08-03 01:00:00" }))).not.toContain("보류하려면");
});

describe("TasksKanban stale 후보", () => {
  test("SQLite UTC 문자열 기준 정확히 14일부터 stale이다", () => {
    expect(isTaskStale(task("2026-07-20 06:00:01"), now)).toBe(false);
    expect(isTaskStale(task("2026-07-20 06:00:00"), now)).toBe(true);
  });

  test("완료와 보류 카드는 stale 후보가 아니다", () => {
    expect(isTaskStale({ ...task("2026-07-01 00:00:00"), column: "done" }, now)).toBe(false);
    expect(isTaskStale(task("2026-07-01 00:00:00", { held_at: "2026-08-01 00:00:00" }), now)).toBe(false);
  });

  test("잘못된 날짜는 오래됐다고 단정하지 않는다", () => {
    expect(isTaskStale(task("not-a-date"), now)).toBe(false);
  });
});
