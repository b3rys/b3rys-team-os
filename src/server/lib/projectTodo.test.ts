import { describe, expect, test } from "bun:test";
import { parseProjectTodo } from "./projectTodo";

describe("project TODO current state", () => {
  test("counts statuses independently and ignores examples in code fences", () => {
    const result = parseProjectTodo("# Todo\n- [~] working\n- [ ] next\n- [x] shipped\n```md\n- [ ] example\n```\n- [X] fixed");
    expect(result).toMatchObject({ doing: 1, plan: 1, done: 2, doingTitles: ["working"] });
  });
  test("excludes keep and approval subtrees, resumes at a sibling", () => {
    const result = parseProjectTodo("## 📌 킵\n- [ ] parked\n### nested\n- [ ] also parked\n- [x] completed\n## next\n- [ ] planned\n## GD 선택 대기\n- [ ] decision\n## 승인 대기\n- [ ] review\n## active\n- [~] progress");
    expect(result).toMatchObject({ plan: 1, done: 1, doing: 1 });
    expect(result.items.map(i => i.title)).toEqual(["completed", "planned", "progress"]);
  });
  test("fence of another type does not end the example; titles are bounded", () => {
    expect(parseProjectTodo("~~~md\n```\n- [ ] no\n~~~\n- [~] " + "가".repeat(90)).doingTitles).toEqual(["가".repeat(60)]);
    expect(parseProjectTodo("~~~md\n```\n- [ ] no\n~~~").plan).toBe(0);
  });
});
