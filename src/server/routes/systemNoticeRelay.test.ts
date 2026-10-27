// from=system · to=broadcast · meta.op_notice=true 인 요청만 그룹방에 중계한다. 그 밖의 system 발신은 기록만, agent 경로는 그대로.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../db/migrate";
import { createInboxRoutes } from "./inbox";
import { channelRegistry } from "../channels/registry";
import type { ChannelAdapter } from "../channels/types";

const GROUP_ID = "-2000000000001";
const tmpDir = mkdtempSync(join(tmpdir(), "b3os-sysnotice-"));
const prev = { file: process.env.CAPTURE_GROUP_FILE, id: process.env.CAPTURE_GROUP_ID };
let sent: Array<{ target: string; text: string; agent?: { id: string } }> = [];
let realTelegram: ChannelAdapter | undefined;

function fakeTelegram(ok: boolean): ChannelAdapter {
  return {
    kind: "telegram",
    async send(req: { target: string; text: string; agent?: { id: string } }) {
      sent.push(req);
      return ok ? { ok: true } : { ok: false, error: "telegram_send_failed" };
    },
  } as unknown as ChannelAdapter;
}

function setup(): Database {
  const db = new Database(":memory:");
  migrate(db);
  for (const id of ["bill", "steve"]) {
    db.prepare(
      `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES (?, ?, 'dev', 'claude_channel', 'claude_tmux', '/tmp', 'p.md')`,
    ).run(id, id);
  }
  return db;
}

const post = (db: Database, body: Record<string, unknown>) =>
  createInboxRoutes({
    db,
    broadcast: () => {},
    registeredAgentIds: () => new Set(["bill", "steve"]),
    agents: () => [
      { id: "bill", display_name: "Bill", capabilities: ["coordinator"] } as never,
      { id: "steve", display_name: "Steve" } as never,
    ],
  } as never).request("/inbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const notice = (over: Record<string, unknown> = {}) => ({
  from_agent_id: "system", to_agent_id: "broadcast", type: "broadcast", source: "system",
  thread_id: "reboot-202610270300", body: "Mac 재부팅 감지", priority: "normal", hop_count: 0,
  meta: { op_notice: true }, ...over,
});

describe("system op_notice → 그룹방", () => {
  beforeEach(() => {
    sent = [];
    realTelegram = channelRegistry.get("telegram");
    process.env.CAPTURE_GROUP_FILE = join(tmpDir, "capture-group-id.txt"); // 없는 파일: 라이브 상태파일 차단
    process.env.CAPTURE_GROUP_ID = GROUP_ID;
    channelRegistry.set("telegram", fakeTelegram(true));
  });
  afterEach(() => {
    if (realTelegram) channelRegistry.set("telegram", realTelegram);
    if (prev.file === undefined) delete process.env.CAPTURE_GROUP_FILE; else process.env.CAPTURE_GROUP_FILE = prev.file;
    if (prev.id === undefined) delete process.env.CAPTURE_GROUP_ID; else process.env.CAPTURE_GROUP_ID = prev.id;
  });

  test("op_notice 있음 → 코디네이터 봇으로 방에 게시, 첫 줄 [b3os 시스템 알림], posted:true", async () => {
    const res = await post(setup(), notice());
    expect(res.status).toBe(201);
    expect(((await res.json()) as { posted?: boolean }).posted).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.target).toBe(GROUP_ID);
    expect(sent[0]!.agent?.id).toBe("bill");
    expect(sent[0]!.text).toBe("[b3os 시스템 알림]\nMac 재부팅 감지");
  });

  test("첫 줄이 이미 있으면 겹쳐 붙이지 않는다", async () => {
    await post(setup(), notice({ body: "[b3os 시스템 알림]\n본문" }));
    expect(sent[0]!.text).toBe("[b3os 시스템 알림]\n본문");
  });

  test("op_notice 없음 → 기록만(게시 안 함, posted 없음)", async () => {
    const res = await post(setup(), notice({ meta: undefined }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { posted?: boolean }).posted).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  test("op_notice:'true' 같은 느슨한 값은 인정하지 않는다", async () => {
    await post(setup(), notice({ meta: { op_notice: "true" } }));
    expect(sent).toHaveLength(0);
  });

  test("to 가 broadcast 가 아니면 중계하지 않는다", async () => {
    await post(setup(), notice({ to_agent_id: "steve", type: "dm" }));
    expect(sent).toHaveLength(0);
  });

  test("다른 발신자가 source:system 을 주장해도 중계하지 않는다", async () => {
    await post(setup(), notice({ from_agent_id: "steve" }));
    expect(sent).toHaveLength(0);
  });

  test("게시 실패 → 502 + posted:false + '기록만 됨', 기록은 남는다", async () => {
    channelRegistry.set("telegram", fakeTelegram(false));
    const db = setup();
    const res = await post(db, notice());
    expect(res.status).toBe(502);
    const j = (await res.json()) as { ok: boolean; posted: boolean; next: string };
    expect(j.ok).toBe(false);
    expect(j.posted).toBe(false);
    expect(j.next).toContain("기록만 됨");
    expect((db.prepare("SELECT COUNT(*) AS n FROM message WHERE source='system'").get() as { n: number }).n).toBe(1);
  });

  test("그룹 미설정 → 502 capture_group_not_configured", async () => {
    delete process.env.CAPTURE_GROUP_ID;
    const res = await post(setup(), notice());
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("capture_group_not_configured");
    expect(sent).toHaveLength(0);
  });
});
