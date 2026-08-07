// captureConfig 테스트 — 토큰 0600 파일·write-only / router·group DB setting / env fallback / 마스킹.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, statSync, existsSync } from "node:fs";
import { migrate } from "../db/migrate";
import {
  hasCaptureToken, getCaptureToken, setCaptureToken,
  isRouterEnabled, setRouterEnabled, getCaptureGroupId, setCaptureGroupId,
  captureConfigStatus, isMcpEnabled, setMcpEnabled,
} from "./captureConfig";

const TOKEN_FILE = join(tmpdir(), "captureconfig-test-token.txt");
const GROUP_FILE = join(tmpdir(), "captureconfig-test-group.txt");

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

beforeEach(() => {
  process.env.CAPTURE_TOKEN_FILE = TOKEN_FILE;
  process.env.CAPTURE_GROUP_FILE = GROUP_FILE;
  try { rmSync(TOKEN_FILE); } catch { /* 없으면 무시 */ }
  try { rmSync(GROUP_FILE); } catch { /* 없으면 무시 */ }
  delete process.env.CAPTURE_BOT_TOKEN;
  delete process.env.ROUTER_ENABLED;
  delete process.env.CAPTURE_GROUP_ID;
});
afterEach(() => {
  try { rmSync(TOKEN_FILE); } catch { /* 무시 */ }
  try { rmSync(GROUP_FILE); } catch { /* 무시 */ }
  delete process.env.CAPTURE_TOKEN_FILE;
  delete process.env.CAPTURE_GROUP_FILE;
});

describe("captureConfig — 토큰(0600 파일, write-only)", () => {
  test("set→get 라운드트립 + hasCaptureToken", () => {
    expect(hasCaptureToken()).toBe(false);
    setCaptureToken("123456:ABCdef-token");
    expect(getCaptureToken()).toBe("123456:ABCdef-token");
    expect(hasCaptureToken()).toBe(true);
  });

  test("파일 권한 0600", () => {
    setCaptureToken("123:tok");
    const mode = statSync(TOKEN_FILE).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("env fallback — 파일 없으면 CAPTURE_BOT_TOKEN 사용", () => {
    expect(existsSync(TOKEN_FILE)).toBe(false);
    process.env.CAPTURE_BOT_TOKEN = "env:fallback-token";
    expect(getCaptureToken()).toBe("env:fallback-token");
    expect(hasCaptureToken()).toBe(true);
  });

  test("파일이 env보다 우선", () => {
    process.env.CAPTURE_BOT_TOKEN = "env-tok";
    setCaptureToken("file-tok");
    expect(getCaptureToken()).toBe("file-tok");
  });
});

describe("captureConfig — router/group (setting DB, 라이브 읽기)", () => {
  test("router setRouterEnabled→isRouterEnabled 즉시 반영", () => {
    const db = freshDb();
    expect(isRouterEnabled(db)).toBe(true); // 기본 ON (GD 0721 — 신규 사용자 마찰 제거)
    setRouterEnabled(db, true);
    expect(isRouterEnabled(db)).toBe(true);
    setRouterEnabled(db, false);
    expect(isRouterEnabled(db)).toBe(false);
  });

  test("router env fallback — setting 없으면 ROUTER_ENABLED", () => {
    const db = freshDb();
    process.env.ROUTER_ENABLED = "true";
    expect(isRouterEnabled(db)).toBe(true); // store 비어있음 → env
    setRouterEnabled(db, false); // store가 env 덮어씀
    expect(isRouterEnabled(db)).toBe(false);
  });

  test("router 기본 ON — setting·env 둘 다 없으면 true, env=false면 킬스위치", () => {
    const db = freshDb();
    expect(isRouterEnabled(db)).toBe(true); // 기본 ON (신규 사용자 마찰 제거)
    process.env.ROUTER_ENABLED = "false";
    expect(isRouterEnabled(db)).toBe(false); // env 명시 OFF = 킬스위치
    setRouterEnabled(db, true); // setting이 env보다 우선
    expect(isRouterEnabled(db)).toBe(true);
  });

  test("group set→get + env fallback (파일기반 — 모듈 const 읽기 호환)", () => {
    process.env.CAPTURE_GROUP_ID = "-100env";
    expect(getCaptureGroupId()).toBe("-100env"); // 파일 없음 → env fallback
    setCaptureGroupId("-100stored");
    expect(getCaptureGroupId()).toBe("-100stored"); // 파일 우선
  });
});

describe("captureConfig — 상태 마스킹(★토큰 값 노출 금지)", () => {
  test("captureConfigStatus는 토큰 값을 절대 포함하지 않음", () => {
    const db = freshDb();
    setCaptureToken("SECRET-must-not-leak");
    setCaptureGroupId("-100g");
    setRouterEnabled(db, true);
    const status = captureConfigStatus(db);
    expect(status).toEqual({ has_capture_token: true, capture_group_id: "-100g", router_enabled: true, mcp_enabled: false });
    // 직렬화에도 토큰 값이 없어야 함
    expect(JSON.stringify(status)).not.toContain("SECRET-must-not-leak");
  });
});

// ── ★이미 쓰던 설치는 안 끊긴다★ (빌 리뷰 2026-08-07) ──
//
// 기본만 꺼짐으로 두고 배포하면 ★쓰고 있던 사람이 그 순간 끊긴다.★
// 그리고 ★끊긴 그 창이 그 사람이 우리에게 알릴 수단★ 이다.
// → 마이그레이션이 "이미 MCP 를 쓴 흔적(감사기록)" 이 있는 설치만 켜준다.
// ★"off 면 막힌다" 만 재면 이 사고를 못 잡는다★ — 이쪽을 재야 한다.

test("★이미 MCP 를 쓰던 설치는 켜진 채로 올라온다★", () => {
  const d = new Database(":memory:");
  migrate(d);
  d.prepare(`INSERT INTO audit_event (actor, action, target, at) VALUES ('gd','mcp.http.request','x',datetime('now'))`).run();
  migrate(d); // 다시 돌려도 안전해야 한다(운영은 부팅마다 돈다)
  expect(isMcpEnabled(d)).toBe(true);
});

test("★새 설치는 꺼진 채로 올라온다★ — 공개 clone 은 아무것도 안 하면 닫혀 있다", () => {
  const d = new Database(":memory:");
  migrate(d);
  expect(isMcpEnabled(d)).toBe(false);
});

test("★사람이 끈 것은 마이그레이션이 되살리지 않는다★", () => {
  const d = new Database(":memory:");
  migrate(d);
  d.prepare(`INSERT INTO audit_event (actor, action, target, at) VALUES ('gd','mcp.http.request','x',datetime('now'))`).run();
  migrate(d);
  setMcpEnabled(d, false); // 사람이 명시적으로 끔
  migrate(d); // 재부팅
  expect(isMcpEnabled(d)).toBe(false); // ★끈 것을 되켜면 안 된다★
});

// ★거절 기록은 "쓴 흔적" 이 아니다★ (dex 리뷰 2026-08-07)
//
// 처음엔 action LIKE 'mcp.%' 로 잡았다. 그런데 ★인증 실패·미등록 신원·게이트 거절이 전부
// mcp.http.denied 로 남는다.★ 즉 외부 스캐너가 한 번 두드리고 간 공개 설치가 ★다음 부팅에
// 스스로 열린다.★ 문을 잠그려고 넣은 코드가 문을 여는 셈이었다.
// ★내 원래 시험은 이걸 못 봤다★ — 통과 기록(mcp.http.request)만 넣고 재서 양쪽이 다 초록불이었다.

test("★두드리다 거절당한 기록만 있는 설치는 열리지 않는다★ — 스캐너가 문을 열어주면 안 된다", () => {
  const d = new Database(":memory:");
  migrate(d);
  for (const reason of ["mcp_disabled", "unauthorized", "actor_not_registered"]) {
    d.prepare(`INSERT INTO audit_event (actor, action, target, at) VALUES ('unknown','mcp.http.denied',?,datetime('now'))`).run(reason);
  }
  migrate(d); // 재부팅
  expect(isMcpEnabled(d)).toBe(false);
});

test("★대조군 — 통과한 기록이 하나라도 있으면 열린다★ (stdio 도구 사용 포함)", () => {
  for (const action of ["mcp.http.request", "mcp.send_message", "mcp.ask_teammate", "mcp.kanban_add", "mcp.kanban_update"]) {
    const d = new Database(":memory:");
    migrate(d);
    d.prepare(`INSERT INTO audit_event (actor, action, target, at) VALUES ('gd',?,'x',datetime('now'))`).run(action);
    d.prepare(`INSERT INTO audit_event (actor, action, target, at) VALUES ('unknown','mcp.http.denied','unauthorized',datetime('now'))`).run();
    migrate(d);
    expect({ action, on: isMcpEnabled(d) }).toEqual({ action, on: true });
  }
});
