import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/migrate";
import { getPermissionRequest } from "../permissionGate";
import { createCogsApproval } from "./approvals";
import { handleCogsApprovalCallback, type CogsCallbackQuery } from "./bridgeCallback";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup(alwaysRule: string | null = "Bash(git push:*)") {
  const dir = mkdtempSync(join(tmpdir(), "cogs-cb-"));
  dirs.push(dir);
  const registryPath = join(dir, "agents.json");
  const dbPath = join(dir, "team.db");
  writeFileSync(registryPath, JSON.stringify([{
    id: "flo", display_name: "플로", runtime: "claude_channel", team_official_member: false,
    channel: { kind: "b3chat", api_base: "http://cogs", allow_from: ["42"], owner_chat: "42" },
    cogs_permissions: { runtime: "claude", schema_version: 1, revision: 1, mode: "auto", allow: [] },
  }]));
  const db = openDb(dbPath);
  migrate(db);
  const { request } = createCogsApproval(db, {
    op: { runtime: "claude", agent_id: "flo", action: "run_command", command: "git push" },
    roomId: "42", policyRevision: 1, sessionId: "s", processGen: "g", ttlMs: 300_000, nowMs: Date.now(), alwaysRule,
  });
  db.close();
  const calls: Array<{ method: string; body: any }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(url).split("/").pop()!, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const deps = { apiBase: "http://cogs", agentId: "flo", registryPath, dbPath, fetchFn };
  const status = () => { const d = openDb(dbPath); try { return getPermissionRequest(d, request.id)!.status; } finally { d.close(); } };
  return { id: request.id, deps, calls, status, registryPath };
}

const cb = (id: string, over: Partial<CogsCallbackQuery> = {}): CogsCallbackQuery =>
  ({ id: "cb1", data: `pg1:${id}`, from: { id: 7 }, message: { message_id: 99, chat: { id: 42 } }, cogs_bot_owner_id: 7, ...over });

describe("cogs 카드 누름", () => {
  test("주인이 누르면 결정 + 답 + 버튼 걷기", async () => {
    const s = setup();
    expect(await handleCogsApprovalCallback("T", cb(s.id), s.deps)).toBe("decided");
    expect(s.status()).toBe("allowed_once");
    expect(s.calls.map((c) => c.method)).toEqual(["answerCallbackQuery", "editMessageReplyMarkup"]);
    expect(s.calls[0]!.body.text_code).toBe("callback_allow_once");
  });
  test("방 id 와 같은 사람 id 라도 주인이 아니면 거절 — 방 허용 목록으로 인가하지 않는다", async () => {
    const s = setup();
    expect(await handleCogsApprovalCallback("T", cb(s.id, { from: { id: 42 } }), s.deps)).toBe("forbidden");
    expect(s.status()).toBe("pending");
    expect(s.calls.map((c) => c.method)).toEqual(["answerCallbackQuery"]); // 버튼은 남긴다
    expect(s.calls[0]!.body).toMatchObject({ text_code: "callback_forbidden", show_alert: true });
  });
  test("옛 cogs 서버(주인 정보 없음) → 아무도 결정 못 함", async () => {
    const s = setup();
    expect(await handleCogsApprovalCallback("T", cb(s.id, { cogs_bot_owner_id: undefined }), s.deps)).toBe("forbidden");
  });
  test("다른 팀원 브리지가 받으면 거절", async () => {
    const s = setup();
    expect(await handleCogsApprovalCallback("T", cb(s.id), { ...s.deps, agentId: "mille" })).toBe("forbidden");
  });
  test("항상 허용 → 원본 정책에 규칙이 들어간다", async () => {
    const s = setup();
    expect(await handleCogsApprovalCallback("T", cb(s.id, { data: `pga:${s.id}` }), s.deps)).toBe("decided");
    const policy = JSON.parse(readFileSync(s.registryPath, "utf-8"))[0].cogs_permissions;
    expect(policy).toMatchObject({ revision: 2, allow: ["Bash(git push:*)"] });
    expect(s.status()).toBe("allowed_always");
  });
  test("정책이 바뀐 뒤 옛 카드 → 만료", async () => {
    const s = setup();
    const list = JSON.parse(readFileSync(s.registryPath, "utf-8"));
    list[0].cogs_permissions.revision = 5;
    writeFileSync(s.registryPath, JSON.stringify(list));
    expect(await handleCogsApprovalCallback("T", cb(s.id), s.deps)).toBe("expired");
    expect(s.status()).toBe("expired");
  });
  test("결합 없는 옛 승인 id(코덱스 팝업 등) → 만료로 답한다", async () => {
    const s = setup();
    expect(await handleCogsApprovalCallback("T", cb("prm_aaaaaaaaaaaaaaaaaa"), s.deps)).toBe("expired");
  });
  test("모르는 callback_data 는 건드리지 않는다(일반 봇 버튼)", async () => {
    const s = setup();
    expect(await handleCogsApprovalCallback("T", cb(s.id, { data: "menu:open" }), s.deps)).toBe("ignored");
    expect(s.calls).toEqual([]);
  });
});
