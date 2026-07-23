// approvals 라우트 — PIN 설정/변경 가드(보안). 첫 설정 무인증 / 변경은 기존 PIN 필수.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { migrate } from "../db/migrate";
import { createApprovalsApp } from "./approvals";

const PIN_FILE = join(tmpdir(), "approvals-route-test-pin.hash");
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  return createApprovalsApp({ db });
}

beforeEach(() => {
  process.env.ADMIN_PIN_FILE = PIN_FILE;
  try { rmSync(PIN_FILE); } catch { /* 무시 */ }
});
afterEach(() => {
  try { rmSync(PIN_FILE); } catch { /* 무시 */ }
  delete process.env.ADMIN_PIN_FILE;
});

describe("approvals: PIN 설정/변경 가드", () => {
  test("첫 설정은 무인증 허용 + GET으로 설정여부 반영", async () => {
    const app = setup();
    expect((await (await app.request("/approvals/pin")).json())).toEqual({ set: false });
    const r = await app.request("/approvals/pin", post({ pin: "123456" }));
    expect(r.status).toBe(200);
    expect((await (await app.request("/approvals/pin")).json())).toEqual({ set: true });
  });

  test("★변경은 기존 PIN 없으면 거부(403) — 가드 무력화 방지", async () => {
    const app = setup();
    await app.request("/approvals/pin", post({ pin: "123456" })); // 첫 설정
    const noCurrent = await app.request("/approvals/pin", post({ pin: "654321" })); // 기존PIN 없이 변경 시도
    expect(noCurrent.status).toBe(403);
    const wrongCurrent = await app.request("/approvals/pin", post({ pin: "654321", current_pin: "000000" }));
    expect(wrongCurrent.status).toBe(403);
  });

  test("기존 PIN 맞으면 변경 허용", async () => {
    const app = setup();
    await app.request("/approvals/pin", post({ pin: "123456" }));
    const ok = await app.request("/approvals/pin", post({ pin: "654321", current_pin: "123456" }));
    expect(ok.status).toBe(200);
  });

  test("6자리 아니면 거부(400)", async () => {
    const app = setup();
    expect((await app.request("/approvals/pin", post({ pin: "12" }))).status).toBe(400);
  });
});
