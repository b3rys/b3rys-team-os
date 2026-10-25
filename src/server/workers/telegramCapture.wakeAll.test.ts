import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRecord } from "../types";
import { migrate } from "../db/migrate";

// "/all" 은 전원에게 게시만 하고, 전원 깨우기는 버튼 + 사용량 검사를 통과해야 한다. 팀장 외 클릭은 거부된다.
test("capture: /all posts to everyone without waking, wake-all button is guarded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "capture-wakeall-test-"));
  const usageFile = join(dir, "usage-limits.json");
  const env = {
    CAPTURE_TOKEN_FILE: join(dir, "none"), CAPTURE_BOT_TOKEN: "TEST_SECRET", CAPTURE_GROUP_FILE: join(dir, "group"),
    CAPTURE_GROUP_ID: "-123", CAPTURE_OFFSET_PATH: join(dir, "offset"), B3OS_AUDIT_LOG_DIR: join(dir, "audit"),
    APPROVAL_ALLOWED_USER_IDS: "7", TEAM_AGENT_REGISTRY: join(dir, "agents.json"), USAGE_LIMITS_FILE: usageFile,
  };
  const oldEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  await Bun.write(env.CAPTURE_OFFSET_PATH, "1");
  const goodUsage = () => {
    const s = Date.now() / 1000;
    return JSON.stringify({ ts: s - 5, five_hour: { used_percentage: 10 }, seven_day: { used_percentage: 10, resets_at: s - 2 * 86400 + 7 * 86400 } });
  };
  await writeFile(usageFile, goodUsage());

  const db = new Database(":memory:"); migrate(db);
  db.prepare("INSERT INTO setting(key,value) VALUES ('router_enabled','true')").run();
  for (const [id, name] of [["bill", "Bill"], ["dex", "Dex"]] as [string, string][]) {
    db.prepare("INSERT INTO agent(id, display_name, role, runtime, status_provider, workspace_path, persona_file) VALUES (?, ?, 'r', 'claude_channel', 'claude_tmux', '', '')").run(id, name);
  }
  const agents = [{ id: "bill", display_name: "Bill", nicknames: ["빌"] }, { id: "dex", display_name: "Dex", nicknames: ["덱스"] }] as AgentRecord[];
  const text = (id: number, t: string, from: any = { id: 7 }) => ({ update_id: id, message: { from, text: t, message_id: id + 100, chat: { id: -123, type: "supergroup" } } });
  const posted: any[] = [];
  const buttons = () => posted.filter((p) => p.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith("bcapv:"));
  const tap = (id: number, data: string, from: number) => ({ update_id: id, callback_query: { id: `cb${id}`, from: { id: from }, data, message: { message_id: 900 + id, chat: { id: -123, type: "supergroup" } } } });
  const edits: string[] = [];
  let poll = 0; let stop = () => {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("getUpdates")) {
      const n = poll++;
      if (n === 0) return Response.json({ ok: true, result: [text(1, "@빌 먼저 이어가자"), text(2, "/all 공지입니다"), text(3, "/all 덱스 확인해줘"), text(4, "이어서 진행해줘"), text(5, "/all 팀원 발언", { id: 9, is_bot: true })] });
      const [first, second] = buttons().map((b) => b.reply_markup.inline_keyboard[0][0].callback_data as string);
      if (n === 1) return Response.json({ ok: true, result: [tap(10, first!, 8)] }); // 팀장 아님
      if (n === 2) return Response.json({ ok: true, result: [tap(11, first!, 7)] }); // 사용량 정상
      if (n === 3) { await rm(usageFile); return Response.json({ ok: true, result: [tap(12, second!, 7)] }); } // 파일 없음
      stop(); return Response.json({ ok: true, result: [] });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (u.endsWith("sendMessage")) posted.push(body);
    if (u.endsWith("editMessageText")) edits.push(body.text);
    return Response.json({ ok: true, result: [] });
  }) as unknown as typeof fetch;
  try {
    const { setGroupOwner } = await import("../lib/groupOwner"); setGroupOwner([]);
    const { startTelegramCapture } = await import("./telegramCapture");
    stop = startTelegramCapture({ db, agents: () => agents });
    const deadline = Date.now() + 4000;
    while (poll < 5 && Date.now() < deadline) await Bun.sleep(5);
    expect(poll).toBeGreaterThanOrEqual(5);
    await Bun.sleep(150); // 마지막 콜백 처리가 끝나도록

    const audit = (await readFile(join(env.B3OS_AUDIT_LOG_DIR, (await Array.fromAsync(new Bun.Glob("audit-*.log").scan(env.B3OS_AUDIT_LOG_DIR)))[0]!), "utf8"))
      .trim().split("\n").map((l) => JSON.parse(l));
    const rows = db.query("SELECT id, body, type, to_agent_id, meta_json FROM message ORDER BY rowid").all() as any[];
    const recips = (id: string) => (db.query("SELECT agent_id FROM message_recipient WHERE message_id = ? ORDER BY agent_id").all(id) as any[]).map((r) => r.agent_id);
    const byBody = (s: string) => rows.find((r) => r.body.includes(s))!;
    const route = (r: any) => JSON.parse(r.meta_json).route;

    // 1) /all 본문: 수신 행은 전원, 깨우기 없음
    const plain = byBody("공지입니다");
    expect(plain.type).toBe("broadcast");
    expect(recips(plain.id)).toEqual(["bill", "dex"]);
    expect(route(plain)).toEqual({ reason: "broadcast_post_only", targets: [] });
    // 2) 이름을 부르면 그 사람만 깨운다(수신 행은 전원)
    const named = byBody("덱스 확인해줘");
    expect(recips(named.id)).toEqual(["bill", "dex"]);
    expect(route(named)).toEqual({ reason: "explicit_mention", targets: ["dex"] });
    // 3) sticky 불변: /all 뒤의 무-멘션 메시지는 /all 이전 담당(bill)
    expect(route(byBody("이어서 진행해줘")).targets).toEqual(["bill"]);
    // 4) 팀원(팀장 아닌 발신) 발언 /all 은 무시된다
    expect(audit.some((a) => a.action === "route_decision" && String(a.target).includes("팀원 발언"))).toBe(false);
    // 5) 깨움 시도는 정확히: @빌(1) + 이름 지명 덱스(1) + sticky 후속 빌(1) + 승인된 전원 깨우기(빌·덱스).
    //    /all 게시 자체·차단된 두 번째 요청·팀원 발신 /all 은 깨움을 만들지 않는다.
    const woken = audit.filter((a) => a.action === "injection_skip" || a.action === "injection").map((a) => a.target).sort();
    // 6) 버튼 2개(/all 두 번), 문구는 "전원 깨우기"
    expect(buttons()).toHaveLength(2);
    expect(buttons()[0].reply_markup.inline_keyboard[0][0].text).toBe("⏰ 전원 깨우기");
    // 7) 팀장 아닌 클릭은 거부, 깨움 없음
    expect(audit.some((a) => a.action === "callback_denied")).toBe(true);
    // 8) 팀장 클릭 + 정상 사용량 → 승인, 남은 팀원(bill, dex)에게 주입 시도
    expect(audit.some((a) => a.action === "broadcast_approved")).toBe(true);
    expect(woken).toEqual(["bill", "bill", "bill", "dex", "dex"]);
    // 9) 사용량 파일이 없으면 차단: 이유 한 줄, 깨움 없음
    expect(audit.some((a) => a.action === "broadcast_blocked")).toBe(true);
    expect(edits.some((t) => t.startsWith("⛔") && t.includes("사용량 파일"))).toBe(true);
    expect(audit.filter((a) => a.action === "broadcast_approved")).toHaveLength(1);
    // 10) 승인 1회만 횟수에 들어간다
    const count = db.query("SELECT value FROM setting WHERE key LIKE 'wake_all_count:%'").all() as any[];
    expect(count.map((c) => c.value)).toEqual(["1"]);
  } finally {
    stop(); globalThis.fetch = originalFetch; db.close();
    for (const [k, v] of Object.entries(oldEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await rm(dir, { recursive: true, force: true });
  }
});
