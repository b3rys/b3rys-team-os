import { test, expect } from "bun:test";
import { missingFromLive } from "./rulesDrift";

test("같으면 0", () => {
  const s = "- a\n- b\n";
  expect(missingFromLive(s, s)).toEqual([]);
});
test("템플릿에만 있는 새 규칙을 잡는다", () => {
  expect(missingFromLive("- a\n- b\n", "- a\n- 새 규칙\n- b\n")).toEqual(["- 새 규칙"]);
});
test("정본에만 있는 팀 고유 규칙은 차이로 세지 않는다", () => {
  expect(missingFromLive("- a\n- 우리 팀만의 규칙\n", "- a\n")).toEqual([]);
});
test("빈 줄은 세지 않는다", () => {
  // 정본이 개행으로 끝나지 않으면 정본 쪽 집합에 "" 가 없다.
  // 그때 trim 검사가 없으면 템플릿의 빈 줄이 전부 "새 규칙" 으로 세어진다.
  expect(missingFromLive("- a", "- a\n\n\n")).toEqual([]);
});
