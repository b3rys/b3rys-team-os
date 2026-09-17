import { describe, expect, test } from "bun:test";
import { parseProjectTodo } from "./projectTodo";

describe("project TODO current state", () => {
  test("counts statuses independently and ignores examples in code fences", () => {
    const result = parseProjectTodo("# Todo\n- [~] working\n- [ ] next\n- [x] shipped\n```md\n- [ ] example\n```\n- [X] fixed");
    expect(result).toMatchObject({ doing: 1, plan: 1, done: 2, doingTitles: ["working"] });
  });
  const sectioned = "## 📌 킵\n- [ ] parked\n### nested\n- [ ] also parked\n- [x] completed\n## next\n- [ ] planned\n## 선택 대기\n- [ ] decision\n## 승인 대기\n- [ ] review\n## active\n- [~] progress";
  test("excludes registry-listed subtrees (substring on heading), resumes at a sibling", () => {
    const result = parseProjectTodo(sectioned, ["킵", "선택 대기", "승인 대기"]);
    expect(result).toMatchObject({ plan: 1, done: 1, doing: 1, excludeSections: ["킵", "선택 대기", "승인 대기"] });
    expect(result.items.map(i => i.title)).toEqual(["completed", "planned", "progress"]);
  });
  test("default excludes only 킵; the list is data, not code", () => {
    expect(parseProjectTodo(sectioned)).toMatchObject({ plan: 3, excludeSections: ["킵"] });
    expect(parseProjectTodo(sectioned, []).plan).toBe(5);
    expect(parseProjectTodo(sectioned, ["대기"]).plan).toBe(3);
  });
  test("fence of another type does not end the example; titles are bounded", () => {
    expect(parseProjectTodo("~~~md\n```\n- [ ] no\n~~~\n- [~] " + "가".repeat(90)).doingTitles).toEqual(["가".repeat(60)]);
    expect(parseProjectTodo("~~~md\n```\n- [ ] no\n~~~").plan).toBe(0);
  });
});
