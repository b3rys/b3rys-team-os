// ★진행 표시에 붙일 '지금 하는 일' 줄★ — 실제 화면 모양으로 잰다.
//
// 왜 이 시험이 필요한가: 지금까지 저장하던 last_log_line 은 ★화면 맨 아랫줄★ 이었고
// 실측하면 늘 "⏵⏵ auto mode on" 이었다 — ★아무 정보가 없었다.★
// 아래 입력은 ★실제 팀원 화면에서 그대로 떠온 모양★ 이다(2026-08-07).
import { expect, test } from "bun:test";
import { currentActivityLine } from "./statusProbe";

// 실측: 디백 화면. ⏺ 출력이 있고 그 아래 입력창·푸터가 있다.
const REAL_PANE = [
  "  ⏺ ames의 수합 완료 통지는 종결 메시지라 회신하지 않았습니다",
  "  ⏺ 그룹방에 인사 전송 완료 (msg mT11g2B0KpHU, thread tg--1003947108339).",
  "",
  "✻ Cogitated for 12s",
  "",
  "──────────────────────────────",
  "❯ ",
  "──────────────────────────────",
  "   /Users/gdmini/Development/dbak   main   Opus 5 (1M context)",
  "  ctx 21% [===--------------] · reset 49m",
  "  ⏺ main",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
];

test("★대화 영역의 마지막 ⏺ 줄을 고른다★", () => {
  expect(currentActivityLine(REAL_PANE)).toBe("그룹방에 인사 전송 완료 (msg mT11g2B0KpHU, thread tg--1003947108339).");
});

test("★푸터의 '⏺ main' 은 안 고른다★ — 그건 브랜치 표시지 하는 일이 아니다", () => {
  // 대화 영역에 ⏺ 가 하나도 없으면 null 이어야 한다. 푸터의 ⏺ main 을 집으면 안 된다.
  const onlyFooter = REAL_PANE.slice(5); // 구분선부터 = 대화 영역 없음
  expect(currentActivityLine(onlyFooter)).toBeNull();
});

test("★맨 아랫줄(고정 장식)을 고르지 않는다★ — 이게 지금까지의 문제였다", () => {
  const got = currentActivityLine(REAL_PANE);
  expect(got).not.toContain("auto mode on");
  expect(got).not.toContain("ctx ");
});

test("도구 사용 줄도 그대로 나온다", () => {
  const pane = ["  ⏺ Read(src/server/mcp/mcpAsk.ts)", "──────────────", "❯ ", "  ⏵⏵ auto mode on"];
  expect(currentActivityLine(pane)).toBe("Read(src/server/mcp/mcpAsk.ts)");
});

test("⏺ 가 없으면 null — 없는 걸 지어내지 않는다", () => {
  expect(currentActivityLine(["  ✻ Sautéed for 1m 7s", "──────", "❯ ", "  ⏵⏵ auto mode on"])).toBeNull();
  expect(currentActivityLine([])).toBeNull();
});

test("아주 긴 줄은 잘린다 — 진행 표시 한 줄에 들어가야 한다", () => {
  const long = "  ⏺ " + "가".repeat(400);
  const got = currentActivityLine([long, "──────", "❯ "]);
  expect(got!.length).toBeLessThanOrEqual(161);
  expect(got!.endsWith("…")).toBe(true);
});
