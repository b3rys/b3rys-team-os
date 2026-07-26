// approvals 라우트 — PIN 설정/변경 가드(보안). 첫 설정 무인증 / 변경은 기존 PIN 필수.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { migrate } from "../db/migrate";
import { createApprovalsApp } from "./approvals";
import { ACTIONS } from "../lib/approvals";

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

// ─────────────────────────────────────────────────────────────────────────────
// 실행 대상이 없는 액션은 ★HTTP 계층에서도★ 막힌다.
//
// ★왜 라우트 테스트가 따로 필요한가★ — lib(enqueueApproval)이 throw 하는지만 보면
//   routes 의 409 분기를 통째로 지워도 테스트가 통과한다(응답이 500 으로 바뀔 뿐 "막히긴" 하니까).
//   그러면 "왜 안 되는지"를 알려주던 계약(409 + missing 목록)이 조용히 사라진다.
//   실제 클라이언트가 보는 것은 상태코드와 사유이므로 그걸 직접 단언한다.
describe("실행 대상 없는 액션 — POST /approvals 는 409 + 사유", () => {
  const KEY = "__test_missing_target__";
  beforeEach(() => {
    ACTIONS[KEY] = {
      key: KEY,
      label: "테스트 전용(실행 대상 없음)",
      description: "requiresFiles 가 없는 파일을 가리키는 액션.",
      danger: "low",
      run: { cmd: ["bash", "-c", "true"] },
      requiresFiles: ["scripts/__definitely-not-here__.sh"],
    };
  });
  afterEach(() => { delete ACTIONS[KEY]; });

  test("409 · error=action_unavailable · 없는 파일을 알려준다", async () => {
    const app = setup();
    const res = await app.request("/approvals", post({ action_key: KEY }));
    expect(res.status).toBe(409);                       // ★500 이 아니다★
    const body = (await res.json()) as any;
    expect(body.error).toBe("action_unavailable");
    expect(body.missing).toEqual(["scripts/__definitely-not-here__.sh"]);
    expect(String(body.hint ?? "")).not.toBe("");        // 왜 안 되는지 말해준다
  });

  test("액션 목록에서도 빠지고, 이유와 함께 unavailable 로 보고된다", async () => {
    const app = setup();
    const body = (await (await app.request("/approvals/actions")).json()) as any;
    expect(body.actions.map((a: any) => a.key)).not.toContain(KEY);
    const hidden = body.unavailable.find((u: any) => u.key === KEY);
    expect(hidden?.missing).toEqual(["scripts/__definitely-not-here__.sh"]);
  });
});
