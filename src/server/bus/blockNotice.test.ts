/**
 * ★차단되면 발신자에게 알린다★ (GD 승인 2026-07-26).
 *
 * 무슨 일이 있었나: 빌→스티브 4건이 pingpong 가드에 막혔는데
 *   · 발신자 — send.sh 가 ★"✓ sent" 를 찍었다★
 *   · 수신자 — ★아무것도 안 왔다★
 *   · ★양쪽 다 몰랐다★ → 빌이 스티브를 무응답으로 판단하고 리뷰를 재배치했다
 *
 * ★스티브 요청: "통보 자체가 안 막히는지 실측하라. 문구만 그럴싸하고 실제로 안 오면
 *   오늘 하루 우리가 고친 것과 같은 형태가 된다."★
 * 그래서 이 테스트는 소스를 grep 하지 않는다 — ★실제로 차단을 일으키고, 통보를 만들고,
 * 그 통보를 다시 가드에 넣어본다.★
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "../db/migrate";
import { insertMessage } from "../db/inboxQueries";
import { checkPingpong } from "./antiPingpong";
import { notifySenderOfBlock } from "./wakeDispatcher";
import type { PendingDispatchRow } from "./types";
import type { AgentRecord } from "../types";

const AGENTS = [
  { id: "bill", display_name: "Bill" },
  { id: "steve", display_name: "Steve" },
] as unknown as AgentRecord[];
const ROSTER = new Set(["bill", "steve"]);

/** 실 스키마 DB. message.thread_id 는 thread(id) FK 라 스레드를 먼저 만든다. */
function freshDb(): Database {
  const d = new Database(":memory:");
  migrate(d);
  d.run(`INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t-chain','t','dm','[]','bill')`);
  return d;
}

/** bill↔steve 가 n번 주고받은 체인을 실제로 만든다. 마지막 메시지 id 를 돌려준다. */
function buildChain(db: Database, n: number): string {
  let parent: string | null = null;
  let last = "";
  for (let i = 0; i < n; i++) {
    const m = insertMessage(db, {
      thread_id: "t-chain",
      from_agent_id: i % 2 === 0 ? "steve" : "bill",
      to_agent_id: i % 2 === 0 ? "bill" : "steve",
      type: "dm", body: `msg ${i}`, source: "agent",
      hop_count: 0, priority: "normal",
      ...(parent ? { in_reply_to: parent } : {}),
    } as Parameters<typeof insertMessage>[1]);
    parent = m.id; last = m.id;
  }
  return last;
}

function row(over: Partial<PendingDispatchRow>): PendingDispatchRow {
  return {
    message_id: "m-new", agent_id: "steve", delivery_state: "pending", retry_count: 0, last_error: null,
    from_agent_id: "bill", to_agent_id: "steve", body: "x", source: "agent", created_by: null,
    max_hop: 16, hop_count: 0, in_reply_to: null, parent_message_id: null, sync: "none",
    thread_id: "t-chain", type: "dm", created_at: "2026-07-26", priority: "normal",
    ...over,
  };
}

describe("★차단 통보 — 실제로 막히고, 실제로 통보가 나가고, 그 통보는 안 막힌다★", () => {
  test("① 6왕복 넘으면 실제로 차단된다 (전제 확인)", () => {
    const db = freshDb();
    const parent = buildChain(db, 6);
    const v = checkPingpong(db, row({ parent_message_id: parent }), ROSTER);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("pingpong_limit_exceeded");
  });

  test("② 차단되면 ★발신자에게★ 통보가 실제로 들어간다", () => {
    const db = freshDb();
    const parent = buildChain(db, 6);
    const blocked = row({ parent_message_id: parent, message_id: "m-blocked" });
    notifySenderOfBlock(db, blocked, AGENTS, "pingpong_limit_exceeded:rounds=6,max=6");

    const n = db.query("SELECT * FROM message WHERE from_agent_id='system' ORDER BY rowid DESC LIMIT 1").get() as any;
    expect(n).toBeTruthy();
    expect(n.to_agent_id).toBe("bill");                 // ★수신자가 아니라 발신자에게★
    expect(n.source).toBe("system");
    expect(String(n.body)).toContain("m-blocked");       // ★차단된 메시지 id 포함★ (재전송·이관용)
    expect(String(n.body)).toContain("새 스레드");        // 실행 가능한 복구 행동
  });

  test("③ ★그 통보 자체는 같은 가드에 안 걸린다★ — 이게 핵심이다", () => {
    const db = freshDb();
    const parent = buildChain(db, 6);
    notifySenderOfBlock(db, row({ parent_message_id: parent }), AGENTS, "pingpong_limit_exceeded:rounds=6,max=6");
    const n = db.query("SELECT * FROM message WHERE from_agent_id='system' ORDER BY rowid DESC LIMIT 1").get() as any;

    // ★체인 밖★ — parent 가 없어야 한다. 있으면 통보가 통보를 막는다.
    expect(n.parent_message_id).toBeNull();
    expect(n.hop_count).toBe(0);

    // 그 통보를 그대로 가드에 넣어본다 → ★통과해야 한다★
    const v = checkPingpong(db, row({
      message_id: n.id, source: "system", from_agent_id: "system", created_by: "system",
      to_agent_id: "bill", agent_id: "bill", parent_message_id: n.parent_message_id, hop_count: 0,
    }), ROSTER);
    expect(v.allowed).toBe(true);
  });

  test("④ ★통보가 통보를 부르지 않는다★ — system 발신에는 통보하지 않는다", () => {
    const db = freshDb();
    notifySenderOfBlock(db, row({ source: "system", from_agent_id: "system" }), AGENTS, "x");
    const cnt = db.query("SELECT COUNT(*) c FROM message WHERE from_agent_id='system'").get() as any;
    expect(cnt.c).toBe(0);
  });

  test("⑤ 같은 차단으로 두 번 알리지 않는다 (dedupe)", () => {
    const db = freshDb();
    const parent = buildChain(db, 6);
    const r = row({ parent_message_id: parent, message_id: "m-dup" });
    notifySenderOfBlock(db, r, AGENTS, "pingpong_limit_exceeded:rounds=6,max=6");
    notifySenderOfBlock(db, r, AGENTS, "pingpong_limit_exceeded:rounds=6,max=6");
    const cnt = db.query("SELECT COUNT(*) c FROM message WHERE from_agent_id='system'").get() as any;
    expect(cnt.c).toBe(1);
  });
});

/* ★배선 검사 — 위 동작 테스트만으로는 부족하다.★
 * 내가 뮤테이션을 돌려보니 ★차단 지점의 호출을 통째로 지워도 5건이 다 통과했다.★
 * 동작 테스트가 notifySenderOfBlock 을 직접 부르기 때문이다 — 함수는 맞는데 ★아무도 안 부르면★ 소용없다.
 * 오늘 하루 계속 나온 형태(요구가 아니라 구현을 확인)를 내 테스트가 또 저지르고 있었다.
 * 소스 문자열 검사는 약하지만, 이 배선을 지키는 다른 방법이 지금 없다(디스패처 전체를 띄워야 한다). */
describe("★배선 — 차단 지점이 실제로 통보를 부른다★", () => {
  const SRC = readFileSync(join(import.meta.dir, "wakeDispatcher.ts"), "utf8");

  test("checkPingpong 차단 분기 안에서 통보를 호출한다", () => {
    const blockBranch = SRC.slice(SRC.indexOf("const verdict = checkPingpong("));
    const untilReturn = blockBranch.slice(0, blockBranch.indexOf('return { kind: "skip" };'));
    expect(untilReturn).toContain("notifySenderOfBlock(db, row, agents, verdict.reason)");
  });
});
