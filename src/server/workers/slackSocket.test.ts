// slackSocket 연결대상 판정(socketEligible) 회귀 가드 — webhook 에이전트가 소켓 연결되지 않게(먹통/이중처리 방지). (Devon/하네스 재검증)
import { test, expect } from "bun:test";
import { socketEligible } from "./slackSocket";

const both = { app_token: "xapp-x", bot_token: "xoxb-x" };

test("socket + app_token + bot_token → 연결 대상", () => {
  expect(socketEligible({ slack_connection_mode: "socket" }, both)).toBe(true);
});

test("webhook 모드는 토큰 다 있어도 제외(소켓 연결 안 함)", () => {
  expect(socketEligible({ slack_connection_mode: "webhook" }, both)).toBe(false);
});

test("mode 미지정(null)은 제외 — 기본 webhook 취급", () => {
  expect(socketEligible({ slack_connection_mode: null }, both)).toBe(false);
  expect(socketEligible({}, both)).toBe(false);
});

test("socket이라도 app_token 없으면 제외", () => {
  expect(socketEligible({ slack_connection_mode: "socket" }, { bot_token: "xoxb-x" })).toBe(false);
});

test("socket이라도 bot_token 없으면 제외(답신 못 함)", () => {
  expect(socketEligible({ slack_connection_mode: "socket" }, { app_token: "xapp-x" })).toBe(false);
});

test("creds 없음 → 제외", () => {
  expect(socketEligible({ slack_connection_mode: "socket" }, null)).toBe(false);
});
