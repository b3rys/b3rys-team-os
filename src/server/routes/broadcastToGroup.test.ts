// broadcast = "방에 말한다". 뜻이 하나다. (GD 2026-07-14 "기본부터 다지자")
//
// ★무엇이 조용히 깨져 있었나★
//   inbox.ts 가 단톡방 게시 여부를 ★스레드 이름의 앞글자★ 로 판단했다:
//       if (broadcast && thread_id.startsWith("tg-")) → 게시
//   그래서 두 방향으로 틀렸다:
//     ① 이름이 tg- 가 아니면 → ★팀에 하려던 말이 조용히 사라지고 201 ok:true★ 를 돌려줬다.
//        실측 14일: 그룹 게시 102건 vs ★조용히 사라진 것 36건(26%)★. 대부분 hermes 의 카드 답변이었다.
//        ★본인은 "말했다" 고 믿고, 아무도 못 들었다.★
//     ② 이름만 tg- 로 지으면 → 아무 스레드나 단톡방에 올라갔다 (tg-relay-analysis 등).
//   방의 정체는 ★이름이 아니라 chat_id★ 다. 문자열 앞글자로 실제 게시를 판단하면 안 된다.
//
// ★불변식★: --to broadcast 는 ★언제나★ 단톡방(chat_id)에 게시한다. 못 하면 ★502 로 사실을 말한다.★
//            조용히 성공이라고 하지 않는다 — 그게 36건을 삼킨 방식이다.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { createInboxRoutes } from "./inbox";
import { channelRegistry } from "../channels/registry";
import type { ChannelAdapter } from "../channels/types";

const GROUP_ID = "-2000000000001";
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
      { id: "bill", display_name: "Bill" } as never,
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
    process.env.CAPTURE_GROUP_ID = GROUP_ID;
    channelRegistry.set("telegram", fakeTelegram(true));
  });
  afterEach(() => {
    if (realTelegram) channelRegistry.set("telegram", realTelegram);
  });

  test("그룹 스레드(tg-<chatid>) → 게시된다 (기존에도 됐던 것 — 회귀 방지)", async () => {
    const res = await post(setup(), bcast(`tg-${GROUP_ID}`));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ posted: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.target).toBe(GROUP_ID);
  });

  test("★핵심: 이름이 tg- 가 아닌 스레드도 게시된다★ (예전엔 조용히 사라졌다 — 14일간 36건)", async () => {
    const res = await post(setup(), bcast("commsuite-sysalarm")); // hermes 가 실제로 쓰던 스레드
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ posted: true });
    expect(sent).toHaveLength(1); // ★예전: 0건. 아무 데도 안 갔고 ok:true 를 받았다★
    expect(sent[0]?.target).toBe(GROUP_ID); // 이름이 아니라 ★chat_id★ 로 간다
  });

  test("게시 실패 → ★502 + 진짜 이유★ (성공이라고 거짓말 안 함)", async () => {
    channelRegistry.set("telegram", fakeTelegram(false, "bot_blocked_by_group"));
    const res = await post(setup(), bcast("commsuite-sysalarm"));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ posted: false, error: "bot_blocked_by_group" });
  });

  // (그룹 미설정 → 502 분기는 여기서 격리 못 한다: getCaptureGroupId() 가 ★파일★(var/capture-group-id.txt)
  //  을 먼저 읽으므로 env 를 비워도 값이 남는다 — 프로덕션에선 그게 맞는 동작이다. 코드 리뷰로 갈음.)

  // ★뜻이 뒤집혔다★ (GD 2026-07-14: "보정을 하면 안된다니깐.. 근본이 아니잖아. 그냥 기록만 추가하고 삭제해")
  //   아침엔 서버가 잘못된 broadcast 를 ★몰래 1:1 로 고쳐서★ 저장했고, 그래서 "방에 안 나가야 한다" 가 정답이었다.
  //   그런데 ★그 보정 자체가 반창고★ 였다 — 팀원이 룰대로 안 한 걸 서버가 덮으니 ★진짜 원인(주입문)이 6주간 살아 있었다.★
  //   ★이제 서버는 안 고친다.★ 팀원이 broadcast 라 썼으면 ★방에 뜬다★ — 그게 "보낸 것만 말한 것이다" 다.
  //   틀린 건 ★보이고★, 로그(reply_address_wrong)가 잡고, ★그 런타임의 주입문★ 을 고친다.
  test("★주소를 틀리면 방에 뜬다 — 숨기지 않는다 (서버가 팀원의 말을 뒤집지 않는다)★", async () => {
    const db = setup();
    // steve 가 bill 에게 directed 로 물어본다 (수집 질문)
    db.prepare(
      `INSERT INTO thread (id, title, kind, participants_json, opened_by)
       VALUES ('collect-1','q','dm','["bill","steve"]','steve')`,
    ).run();
    db.prepare(
      `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, created_at)
       VALUES ('ASK1','collect-1','steve','bill','dm','이 코드 어떻게 생각해?','agent',datetime('now'))`,
    ).run();

    // bill 이 그 질문에 ★--to broadcast 로 잘못★ 답한다 (hermes 가 실제로 이러는 습관)
    const res = await app(db).request("/inbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        thread_id: "collect-1",
        from_agent_id: "bill",
        to_agent_id: "broadcast",
        in_reply_to: "ASK1",
        body: "내부 검토 결과입니다 — 아직 공개 못 할 내용.",
        source: "agent",
        type: "broadcast",
      }),
    });

    expect(res.status).toBe(201);
    // ★서버가 고치지 않는다★ — 예전엔 여기서 'steve' 로 바꿔치기했다
    const row = db.prepare(`SELECT to_agent_id FROM message WHERE in_reply_to='ASK1'`).get() as {
      to_agent_id: string;
    };
    expect(row.to_agent_id).toBe("broadcast");
    // ★방에 뜬다 — 팀원이 그렇게 보냈으니까.★ 조용히 사라지거나 몰래 고쳐지지 않는다.
    expect(sent).toHaveLength(1);
    // 그리고 stored 를 보고 보내므로 ★저장된 것 = 보낸 것★ 은 그대로 유지된다.
    expect(sent[0]?.target).toBe(GROUP_ID);
  });

  test("팀원에게 보내는 건(--to steve) 방에 안 나간다 — 버스는 함수호출 채널이다", async () => {
    const res = await post(setup(), { ...bcast("어떤-스레드"), to_agent_id: "steve", type: "dm" });
    expect(res.status).toBe(201);
    expect(sent).toHaveLength(0); // ★방에 안 나가는 게 맞다★
  });
});
