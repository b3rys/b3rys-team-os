import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRecord } from "../types";
import { migrate } from "../db/migrate";

// 기존 전원 호출("@all", 첫머리 "모두…")도 버튼 승인 시 같은 사용량·횟수 검사를 받는다.
for (const [label, body] of [["@all", "@all 공지"], ["leading 모두", "모두 모여 주세요"]] as const) {
  test(`capture: ${label} wake-all is blocked when usage cannot be read`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "capture-wakeall-legacy-"));
    const env = {
      CAPTURE_TOKEN_FILE: join(dir, "none"), CAPTURE_BOT_TOKEN: "TEST_SECRET", CAPTURE_GROUP_FILE: join(dir, "group"),
      CAPTURE_GROUP_ID: "-123", CAPTURE_OFFSET_PATH: join(dir, "offset"), B3OS_AUDIT_LOG_DIR: join(dir, "audit"),
      APPROVAL_ALLOWED_USER_IDS: "7", TEAM_AGENT_REGISTRY: join(dir, "agents.json"), USAGE_LIMITS_FILE: join(dir, "missing.json"),
    };
    const oldEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    await Bun.write(env.CAPTURE_OFFSET_PATH, "1");
    const db = new Database(":memory:"); migrate(db);
    db.prepare("INSERT INTO setting(key,value) VALUES ('router_enabled','true')").run();
    for (const id of ["bill", "dex"]) {
      db.prepare("INSERT INTO agent(id, display_name, role, runtime, status_provider, workspace_path, persona_file) VALUES (?, ?, 'r', 'claude_channel', 'claude_tmux', '', '')").run(id, id);
    }
    const agents = [{ id: "bill", display_name: "Bill", nicknames: ["빌"] }, { id: "dex", display_name: "Dex", nicknames: ["덱스"] }] as AgentRecord[];
    const posted: any[] = []; const edits: string[] = [];
    let poll = 0; let stop = () => {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("getUpdates")) {
        const n = poll++;
        if (n === 0) return Response.json({ ok: true, result: [{ update_id: 1, message: { from: { id: 7 }, text: body, message_id: 101, chat: { id: -123, type: "supergroup" } } }] });
        if (n === 1) {
          const data = posted.find((p) => p.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith("bcapv:"))!.reply_markup.inline_keyboard[0][0].callback_data;
          return Response.json({ ok: true, result: [{ update_id: 2, callback_query: { id: "cb", from: { id: 7 }, data, message: { message_id: 900, chat: { id: -123, type: "supergroup" } } } }] });
        }
        stop(); return Response.json({ ok: true, result: [] });
      }
      const b = init?.body ? JSON.parse(String(init.body)) : {};
      if (u.endsWith("sendMessage")) posted.push(b);
      if (u.endsWith("editMessageText")) edits.push(b.text);
      return Response.json({ ok: true, result: [] });
    }) as unknown as typeof fetch;
    try {
      const { setGroupOwner } = await import("../lib/groupOwner"); setGroupOwner([]);
      const { startTelegramCapture } = await import("./telegramCapture");
      stop = startTelegramCapture({ db, agents: () => agents });
      const deadline = Date.now() + 4000;
      while (poll < 3 && Date.now() < deadline) await Bun.sleep(5);
      await Bun.sleep(100);
      const file = (await Array.fromAsync(new Bun.Glob("audit-*.log").scan(env.B3OS_AUDIT_LOG_DIR)))[0]!;
      const audit = (await readFile(join(env.B3OS_AUDIT_LOG_DIR, file), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      expect(audit.some((a) => a.action === "broadcast_held")).toBe(true);
      expect(audit.some((a) => a.action === "broadcast_blocked")).toBe(true);
      expect(audit.some((a) => a.action === "broadcast_approved")).toBe(false);
      expect(audit.some((a) => a.action === "injection_skip" || a.action === "injection")).toBe(false);
      expect(edits.some((t) => t.startsWith("⛔"))).toBe(true);
    } finally {
      stop(); globalThis.fetch = originalFetch; db.close();
      for (const [k, v] of Object.entries(oldEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      await rm(dir, { recursive: true, force: true });
    }
  });
}
