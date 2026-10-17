// broadcast는 스레드 이름과 무관하게 설정된 단톡방 chat_id로 게시한다.
// 게시 실패는 502로 반환해야 버스 저장을 실제 채널 전달 성공으로 오인하지 않는다.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { createInboxRoutes } from "./inbox";
import { channelRegistry } from "../channels/registry";
import type { ChannelAdapter } from "../channels/types";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GROUP_ID = "-2000000000001";
// 라이브 상태파일 차단용 tmp 디렉터리(파일은 만들지 않는다 → getCaptureGroupId 가 env fallback 을 쓴다).
const tmpGroupDir = mkdtempSync(join(tmpdir(), "b3os-bcast-"));
const prevGroupFile = process.env.CAPTURE_GROUP_FILE;
const prevGroupId = process.env.CAPTURE_GROUP_ID;
function restoreEnv(): void {
  if (prevGroupFile === undefined) delete process.env.CAPTURE_GROUP_FILE;
  else process.env.CAPTURE_GROUP_FILE = prevGroupFile;
  if (prevGroupId === undefined) delete process.env.CAPTURE_GROUP_ID;
  else process.env.CAPTURE_GROUP_ID = prevGroupId;
}
let sent: Array<{ target: string; text: string }> = [];
let realTelegram: ChannelAdapter | undefined;

function fakeTelegram(ok: boolean, error?: string): ChannelAdapter {
  return {
    kind: "telegram",
    async send({ target, text }: { target: string; text: string }) {
      sent.push({ target, text });
      return ok ? { ok: true } : { ok: false, error: error ?? "telegram_send_failed" };
    },
  } as unknown as ChannelAdapter;
}

function setup(): Database {
  const db = new Database(":memory:");
  migrate(db);
  db.prepare(
    `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES ('bill','Bill','dev','claude_channel','claude_tmux','/tmp','p.md')`,
  ).run();
  db.prepare(
    `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES ('steve','Steve','dev','claude_channel','claude_tmux','/tmp','p.md')`,
  ).run();
  return db;
}

const app = (db: Database) =>
  createInboxRoutes({
    db,
    broadcast: () => {},
    registeredAgentIds: () => new Set(["bill", "steve"]),
    agents: () => [
      { id: "bill", display_name: "Bill", capabilities: ["coordinator"] } as never,
      { id: "steve", display_name: "Steve" } as never,
    ],
  } as never);

const post = (db: Database, body: Record<string, unknown>) =>
  app(db).request("/inbox", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const bcast = (thread: string) => ({
  all_hands: "게시 경로 테스트",
  thread_id: thread,
  from_agent_id: "bill",
  to_agent_id: "broadcast",
  body: "팀 여러분, 이거 확인 부탁합니다.",
  source: "agent",
  type: "broadcast",
});

describe("--to broadcast → 언제나 단톡방", () => {
  beforeEach(() => {
    sent = [];
    realTelegram = channelRegistry.get("telegram");
    // getCaptureGroupId는 env보다 상태파일을 우선하므로 파일 경로도 tmp로 격리해야 실제 방 ID가 시험에 섞이지 않는다.
    process.env.CAPTURE_GROUP_FILE = join(tmpGroupDir, "capture-group-id.txt");
    process.env.CAPTURE_GROUP_ID = GROUP_ID;
    channelRegistry.set("telegram", fakeTelegram(true));
  });
  afterEach(() => {
    if (realTelegram) channelRegistry.set("telegram", realTelegram);
    restoreEnv();
  });

  test("그룹 스레드(tg-<chatid>) → 게시된다 (기존에도 됐던 것 — 회귀 방지)", async () => {
    const res = await post(setup(), bcast(`tg-${GROUP_ID}`));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ posted: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.target).toBe(GROUP_ID);
  });

  test("★핵심: 이름이 tg- 가 아닌 스레드도 게시된다★ (예전엔 조용히 사라졌다 — 14일간 36건)", async () => {
    const res = await post(setup(), bcast("commsuite-sysalarm")); // tg- 접두사가 없는 스레드도 게시 대상이다.
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ posted: true });
    expect(sent).toHaveLength(1); // 저장 응답뿐 아니라 실제 게시 호출도 확인한다.
    expect(sent[0]?.target).toBe(GROUP_ID); // 이름이 아니라 chat_id 로 간다
  });

  test("게시 실패 → ★502 + 진짜 이유★ (성공이라고 거짓말 안 함)", async () => {
    channelRegistry.set("telegram", fakeTelegram(false, "bot_blocked_by_group"));
    const res = await post(setup(), bcast("commsuite-sysalarm"));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ posted: false, error: "bot_blocked_by_group" });
  });

  // 그룹 미설정 502 분기는 상태파일 우선 조회 때문에 이 시험에서 격리하지 못한다. env를 비워도 파일 값이 남는다.

  // 서버는 잘못 쓴 broadcast 주소를 요청자 DM으로 보정하지 않는다. 방에 게시하고 주소 오류를 기록한다.
  test("★주소를 틀리면 방에 뜬다 — 숨기지 않는다 (서버가 팀원의 말을 뒤집지 않는다)★", async () => {
    const db = setup();
    // steve 가 bill 에게 directed 로 물어본다 (수집 질문)
    db.prepare(
      `INSERT INTO thread (id, title, kind, participants_json, opened_by)
       VALUES ('collect-1','q','dm','["bill","steve"]','steve')`,
    ).run();
    db.prepare(
      `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, created_at)
       VALUES ('ASK1','collect-1','bill','steve','dm','이 코드 어떻게 생각해?','agent',datetime('now'))`,
    ).run();

    // directed 질문에 broadcast로 잘못 답하는 경우를 검증한다.
    const res = await app(db).request("/inbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        thread_id: "collect-1",
        from_agent_id: "steve",
        to_agent_id: "broadcast",
        in_reply_to: "ASK1",
        body: "내부 검토 결과입니다 — 아직 공개 못 할 내용.",
        source: "agent",
        type: "broadcast",
      }),
    });

    // 주소를 보정하지 않고 방에 게시한다. 팀원 broadcast에 대한 broadcast 답장만 차단한다.
    expect(res.status).toBe(201);
    const row = db.prepare(`SELECT to_agent_id FROM message WHERE in_reply_to='ASK1'`).get() as {
      to_agent_id: string;
    };
    expect(row.to_agent_id).toBe("broadcast");
    expect(sent).toHaveLength(1);
  });

  test("팀원에게 보내는 건(--to steve) 방에 안 나간다 — 버스는 함수호출 채널이다", async () => {
    const res = await post(setup(), { ...bcast("어떤-스레드"), to_agent_id: "steve", type: "dm" });
    expect(res.status).toBe(201);
    expect(sent).toHaveLength(0); // 방에 안 나가는 게 맞다
  });
});
