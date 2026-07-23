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
  captureConfigStatus,
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
    expect(status).toEqual({ has_capture_token: true, capture_group_id: "-100g", router_enabled: true });
    // 직렬화에도 토큰 값이 없어야 함
    expect(JSON.stringify(status)).not.toContain("SECRET-must-not-leak");
  });
});
