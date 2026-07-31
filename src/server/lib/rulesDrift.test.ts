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

// steve 지적: 게이트를 "다르다" 로 두면 이 경우에 "0개" 경고가 영구히 뜬다.
// 경고 조건은 missing.length > 0 이므로, 이 경우 조용해야 한다.
test("팀이 고유 규칙만 더한 상태에서는 알릴 것이 없다", () => {
  const tmpl = "- a\n- b\n";
  const live = "- a\n- b\n- 우리 팀만의 규칙\n";
  expect(live).not.toBe(tmpl);          // 파일은 분명히 다르다
  expect(missingFromLive(live, tmpl)).toEqual([]);  // 그런데 안 받은 규칙은 없다
});

test("고유 규칙이 있어도 새 규칙이 오면 그것만 집는다", () => {
  const tmpl = "- a\n- 새 규칙\n- b\n";
  const live = "- a\n- b\n- 우리 팀만의 규칙\n";
  expect(missingFromLive(live, tmpl)).toEqual(["- 새 규칙"]);
});

