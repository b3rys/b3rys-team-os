import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRecord } from "../types";
import { migrate } from "../db/migrate";
import type { InjectPromptOptions, InjectResult } from "../lib/tmuxInject";

// 그룹 캡처가 팀원 tmux 에 직접 넣는 길(runInjection): 권한 창이 열려 있으면 넣지 않고 미루고, 닫히면 한 번 넣는다.
test("group capture: prompt open → nothing pasted, held; closed → delivered exactly once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "capture-pp-test-"));
  const env = { CAPTURE_TOKEN_FILE: join(dir, "none"), CAPTURE_BOT_TOKEN: "TEST_SECRET", CAPTURE_GROUP_FILE: join(dir, "group"), CAPTURE_GROUP_ID: "-123", CAPTURE_OFFSET_PATH: join(dir, "offset"), B3OS_AUDIT_LOG_DIR: join(dir, "audit"), APPROVAL_ALLOWED_USER_IDS: "7", TEAM_AGENT_REGISTRY: join(dir, "agents.json") };
  const oldEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  await Bun.write(env.CAPTURE_OFFSET_PATH, "1");
  const db = new Database(":memory:"); migrate(db);
  db.prepare("INSERT INTO setting(key,value) VALUES ('router_enabled','true')").run();
  const agents = [{ id: "bill", display_name: "Bill", nicknames: ["빌"], runtime: "claude_channel", tmux_session: "claude-bill" }] as unknown as AgentRecord[];
  let poll = 0; let stop = () => {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes("getUpdates")) {
      if (poll++ === 0) return Response.json({ ok: true, result: [{ update_id: 1, message: { from: { id: 7 }, text: "빌, 이거 확인해줘", message_id: 100, chat: { id: -123, type: "supergroup" } } }] });
      await Bun.sleep(20); // 빈 폴링이 마이크로태스크로 타이머를 굶기지 않게
      return Response.json({ ok: true, result: [] });
    }
    return Response.json({ ok: true, result: [] });
  }) as unknown as typeof fetch;
  let open = true; const pasted: InjectPromptOptions[] = [];
  const inject = (async (o: InjectPromptOptions): Promise<InjectResult> => {
    if (open) return { ok: false, reason: "permission_prompt" };
    pasted.push(o); return { ok: true };
  }) as never;
  try {
    const { setGroupOwner } = await import("../lib/groupOwner"); setGroupOwner([]);
    const { startTelegramCapture } = await import("./telegramCapture");
    stop = startTelegramCapture({ db, agents: () => agents, inject: { inject, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), retryMs: 1 } });
    const deadline = Date.now() + 3000;
    while (poll < 1 && Date.now() < deadline) await Bun.sleep(5);
    await Bun.sleep(50);
    expect(poll).toBeGreaterThan(0);
    expect(pasted).toHaveLength(0); // 창이 열려 있는 동안 붙여넣지 않는다
    expect((db.query("SELECT count(*) AS n FROM message WHERE to_agent_id='bill'").get() as { n: number }).n).toBe(1); // 글은 버스에 저장돼 있다
    open = false;
    const d2 = Date.now() + 3000;
    while (pasted.length < 1 && Date.now() < d2) await Bun.sleep(5);
    await Bun.sleep(50);
    expect(pasted).toHaveLength(1);
    expect(pasted[0]).toMatchObject({ source: "telegram", kind: "group", agentId: "bill" });
    expect(pasted[0]!.body).toContain("이거 확인해줘");
  } finally {
    stop(); globalThis.fetch = originalFetch; db.close();
    for (const [k, v] of Object.entries(oldEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await rm(dir, { recursive: true, force: true });
  }
});
