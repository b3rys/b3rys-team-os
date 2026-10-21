import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../db/migrate";
import { createB3chatPermissionRoutes } from "./b3chatPermissions";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const KEY = "k".repeat(40);
const flo = { id: "flo", display_name: "플로", runtime: "claude_channel", team_official_member: false, channel: { kind: "b3chat", api_base: "http://x", allow_from: ["42"], owner_chat: "42" } };
const lisa = { id: "lisa", display_name: "리사", runtime: "claude_channel" };

function setup(remote = "127.0.0.1") {
  const dir = mkdtempSync(join(tmpdir(), "cogs-perm-route-"));
  dirs.push(dir);
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify([flo, lisa]));
  const keyPath = join(dir, "link.key");
  writeFileSync(keyPath, KEY);
  const db = new Database(":memory:");
  migrate(db);
  const app = createB3chatPermissionRoutes({ db, registryPath, linkKeyPath: keyPath, remoteAddress: () => remote });
  const H = { "x-b3chat-link": KEY, "content-type": "application/json" };
  const get = (id: string, q = "actor_user_id=7&owner_user_id=7&room_id=42", headers: Record<string, string> = H) =>
    app.request(`/members/b3chat/member/${id}/permissions?${q}`, { headers });
  const put = (id: string, body: unknown) => app.request(`/members/b3chat/member/${id}/permissions`, { method: "PUT", headers: H, body: JSON.stringify(body) });
  return { registryPath, get, put };
}

const putBody = (over: Record<string, unknown> = {}) => ({ actor_user_id: 7, owner_user_id: 7, room_id: 42, expected_revision: 0, policy: { mode: "auto", allow: ["WebFetch"] }, ...over });

describe("연결 인증", () => {
  test("공유 비밀이 없으면 403", async () => {
    const s = setup();
    expect((await s.get("flo", undefined, {})).status).toBe(403);
  });
  test("다른 기계에서 오면 403", async () => {
    const s = setup("10.0.0.2");
    expect((await s.get("flo")).status).toBe(403);
  });
});

describe("GET", () => {
  test("옛 팀원은 absent, revision 0, 주인이면 can_edit", async () => {
    const s = setup();
    const r = await s.get("flo");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, runtime: "claude", state: "absent", policy: null, revision: 0, applies: "next_turn", can_edit: true });
  });
  test("주인이 아니면 보기만", async () => {
    const s = setup();
    expect(await (await s.get("flo", "actor_user_id=8&owner_user_id=7&room_id=42")).json()).toMatchObject({ can_edit: false });
  });
  test("방이 이 팀원 방이 아니면 403", async () => {
    const s = setup();
    expect((await s.get("flo", "actor_user_id=7&owner_user_id=7&room_id=43")).status).toBe(403);
  });
  test("사람·방 정보가 없으면 400", async () => {
    const s = setup();
    expect((await s.get("flo", "room_id=42")).status).toBe(400);
  });
  test("텔레그램 팀원은 404", async () => {
    const s = setup();
    expect((await s.get("lisa")).status).toBe(404);
  });
});

describe("PUT", () => {
  test("주인이 바꾸면 저장, 응답에 새 revision", async () => {
    const s = setup();
    const r = await s.put("flo", putBody());
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ state: "valid", revision: 1, policy: { allow: ["WebFetch"] }, applies: "next_turn" });
    expect(JSON.parse(readFileSync(s.registryPath, "utf-8"))[0].cogs_permissions.revision).toBe(1);
  });
  test("주인이 아니면 403, 원본 그대로", async () => {
    const s = setup();
    expect((await s.put("flo", putBody({ actor_user_id: 8 }))).status).toBe(403);
    expect(JSON.parse(readFileSync(s.registryPath, "utf-8"))[0].cogs_permissions).toBeUndefined();
  });
  test("revision 충돌 409", async () => {
    const s = setup();
    await s.put("flo", putBody());
    const r = await s.put("flo", putBody());
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ ok: false, code: "revision_conflict" });
  });
  test("expected_revision 없으면 400, 모르는 칸 400", async () => {
    const s = setup();
    expect((await s.put("flo", putBody({ expected_revision: undefined }))).status).toBe(400);
    const r = await s.put("flo", putBody({ policy: { mode: "auto", allow: [], extra: 1 } }));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ ok: false, code: "unsupported_field" });
  });
});
