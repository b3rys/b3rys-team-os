import { describe, expect, test } from "bun:test";
import { summarizeProjects, type Task } from "./taskQueries";

function task(title: string, column: Task["column"], owner: string | null = null, description: string | null = null): Task {
  return {
    id: `${title}-${column}`,
    title,
    column,
    owner,
    description,
    held_at: null,
    hold_reason: null,
    review_at: null,
    sort_order: 0,
    created_at: "2026-08-31 00:00:00",
    updated_at: "2026-08-31 00:00:00",
  };
}

describe("summarizeProjects", () => {
  test("승격 목록에 없는 접두어를 제외한다", () => {
    const projects = summarizeProjects([
      task("[infra] deploy", "doing", "bill"),
      task("[proposal] unrelated", "done", "steve"),
    ], ["infra"]);

    expect(projects.map((project) => project.name)).toEqual(["infra"]);
    expect(projects[0]!.counts).toEqual({ done: 0, doing: 1, plan: 0 });
  });

  test("대소문자가 다른 접두어를 한 프로젝트로 합친다", () => {
    const projects = summarizeProjects([
      task("[PM] project card", "doing", "steve", "다음 액션: 구현 리뷰"),
      task("[pm] implementation", "done", "devon"),
      task("[Pm] follow-up", "plan", null),
    ], ["pm"]);

    expect(projects).toEqual([{
      name: "pm",
      counts: { done: 1, doing: 1, plan: 1 },
      next_action: "구현 리뷰",
      owner: "steve",
    }]);
  });
});
