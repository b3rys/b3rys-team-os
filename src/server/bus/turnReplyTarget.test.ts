/**
 * ★턴의 답변을 누구에게 보낼 것인가.★
 *
 * ═══ 이 버그가 오늘 밤 전체를 헛돌게 했다 ═══
 * 나는 "게이트웨이는 기억이 없어 종합을 못 한다" 고 진단하고 ★상시세션(tmux)을 밤새 만들었다.★
 * ★틀렸다.★ 실측하니 hermes 는 ★종합을 훌륭하게 만들고 있었다.★ 다만 그걸
 * ★자기를 깨운 기여자(dbak)에게 보내고 있었다.★ 팀장은 "질문했습니다" ack 만 받았다.
 *
 * ★규칙 하나가 두 상황을 같다고 봤다★: "나를 깨운 사람 = 내가 답을 줘야 할 사람".
 *   1:1 문답이면 참. ★수집이면 거짓★ — 기여자의 답이 나를 깨우지만, 내 산출물은 ★위임자의 것★ 이다.
 *
 * ★그리고 룰이 그 오류를 증폭했다★ (Steve): 번들 지시문이 "종합은 ★턴 답변 본문★ 으로 쓰고
 * send.sh 로 다시 보내지 마라(이중발송 방지)" 라고 한다. 수집 기계가 있을 땐 서버가 릴레이해서 맞았다.
 * ★기계를 걷어내니 그 지시가 "종합을 기여자에게 보내라" 가 됐다.★ ★룰 × 코드 상호작용이다.★
 *
 * → ★코드가 주소를 제대로 찾으면 그 룰은 다시 참이 된다.★ 그래서 룰이 아니라 코드를 고쳤다.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { turnReplyTarget } from "./replyTarget";
import type { AgentRecord } from "../types";
import type { PendingDispatchRow } from "./types";

const ROSTER = [
  { id: "bill" },
  { id: "hermes" },
  { id: "steve" },
  { id: "dbak" },
] as unknown as AgentRecord[];

let db: Database;

function msg(id: string, thread: string, from: string, to: string, inReplyTo: string | null, ts: string) {
  db.run(
    `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, body, in_reply_to, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [id, thread, from, to, "…", inReplyTo, ts],
  );
}

function row(over: Partial<PendingDispatchRow>): PendingDispatchRow {
  return {
    message_id: "m",
    thread_id: "t",
    from_agent_id: "bill",
    agent_id: "hermes",
    body: "…",
    hop_count: 0,
    in_reply_to: null,
    source: "agent",
    meta_json: null,
    ...over,
  } as PendingDispatchRow;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.run(`CREATE TABLE message (
    id TEXT PRIMARY KEY, thread_id TEXT, from_agent_id TEXT, to_agent_id TEXT,
    body TEXT, in_reply_to TEXT, created_at TEXT)`);
});

describe("turnReplyTarget", () => {
  it("★1:1 문답은 그대로★ — 팀장이 물으면 팀장에게 답한다 (기존 동작 무변경)", () => {
    msg("m1", "t1", "bill", "hermes", null, "2026-07-13 01:00:00");
    const t = turnReplyTarget(db, row({ message_id: "m1", thread_id: "t1", from_agent_id: "bill" }), "hermes", ROSTER);
    expect(t).toBe("bill");
  });

  it("★🔴 핵심: 기여자의 답이 깨우면, 종합은 그 기여자가 아니라 ★원 위임자★ 에게 간다★", () => {
    // 팀장 → hermes : "steve·dbak 한테 물어보고 종합해서 나한테 보고해줘"
    msg("m1", "t1", "bill", "hermes", null, "2026-07-13 01:00:00");
    // hermes → dbak : 팬아웃 질문
    msg("m2", "t1", "hermes", "dbak", "m1", "2026-07-13 01:00:30");
    // dbak → hermes : 답 (★이게 hermes 를 깨운다★)
    msg("m3", "t1", "dbak", "hermes", "m2", "2026-07-13 01:00:50");

    const t = turnReplyTarget(
      db,
      row({ message_id: "m3", thread_id: "t1", from_agent_id: "dbak", in_reply_to: "m2" }),
      "hermes",
      ROSTER,
    );
    // ★예전엔 "dbak" 이었다 — 종합이 기여자에게 새고 팀장은 ack 만 받았다.★
    expect(t).toBe("bill");
  });

  it("두 기여자가 각각 깨워도 ★둘 다★ 원 위임자로 향한다 (마지막 waker 가 누구든 무관)", () => {
    msg("m1", "t1", "bill", "hermes", null, "2026-07-13 01:00:00");
    msg("m2", "t1", "hermes", "steve", "m1", "2026-07-13 01:00:30");
    msg("m3", "t1", "hermes", "dbak", "m1", "2026-07-13 01:00:31");
    msg("m4", "t1", "steve", "hermes", "m2", "2026-07-13 01:00:50");
    msg("m5", "t1", "dbak", "hermes", "m3", "2026-07-13 01:00:55");

    for (const [mid, who, parent] of [["m4", "steve", "m2"], ["m5", "dbak", "m3"]] as const) {
      const t = turnReplyTarget(
        db,
        row({ message_id: mid, thread_id: "t1", from_agent_id: who, in_reply_to: parent }),
        "hermes",
        ROSTER,
      );
      expect(t).toBe("bill"); // ★운에 맡기지 않는다★ — 누가 마지막이든 팀장에게 간다
    }
  });

  it("★내 질문의 답이 아니면 건드리지 않는다★ — steve 가 새로 물으면 steve 에게 답한다", () => {
    msg("m1", "t1", "bill", "hermes", null, "2026-07-13 01:00:00");
    msg("m9", "t1", "steve", "hermes", null, "2026-07-13 01:02:00"); // in_reply_to 없음 = 새 질문
    const t = turnReplyTarget(
      db,
      row({ message_id: "m9", thread_id: "t1", from_agent_id: "steve", in_reply_to: null }),
      "hermes",
      ROSTER,
    );
    expect(t).toBe("steve");
  });

  it("★내가 안 보낸 메시지에 대한 답이면 그대로★ — 다른 사람의 대화에 끼어들지 않는다", () => {
    msg("m1", "t1", "bill", "hermes", null, "2026-07-13 01:00:00");
    msg("m2", "t1", "bill", "steve", null, "2026-07-13 01:00:10"); // 팀장이 steve 에게 직접
    msg("m3", "t1", "steve", "hermes", "m2", "2026-07-13 01:00:20"); // steve 가 그 답을 hermes 에게
    const t = turnReplyTarget(
      db,
      row({ message_id: "m3", thread_id: "t1", from_agent_id: "steve", in_reply_to: "m2" }),
      "hermes",
      ROSTER,
    );
    expect(t).toBe("steve"); // 부모(m2)를 hermes 가 안 보냈다 → 옛 규칙 그대로
  });

  it("원 위임자가 로스터에 없으면 안전하게 예전 규칙으로 (모르는 사람에게 보내지 않는다)", () => {
    msg("m1", "t1", "ghost", "hermes", null, "2026-07-13 01:00:00");
    msg("m2", "t1", "hermes", "dbak", "m1", "2026-07-13 01:00:30");
    msg("m3", "t1", "dbak", "hermes", "m2", "2026-07-13 01:00:50");
    const t = turnReplyTarget(
      db,
      row({ message_id: "m3", thread_id: "t1", from_agent_id: "dbak", in_reply_to: "m2" }),
      "hermes",
      ROSTER,
    );
    expect(t).toBe("dbak");
  });
});

/**
 * ★역-가드: 이 판정을 복붙한 곳이 다시 생기면 빨개진다.★
 *
 * ═══ 왜 ═══
 * 나는 `wakeDispatcher` 한 곳을 고치고 ★"오배송은 hermes 경로 고유"★ 라고 보고하려 했다.
 * ★틀렸다.★ 같은 코드가 ★세 곳★ 에 복붙돼 있었다 (hermes · codex_cli · b3os_native).
 * dex·native 는 ★안 터진 게 아니라 collector 로 안 써본 것뿐★ 이다 (Steve).
 * ★"관측된 것만 보고 '고유' 라고 단정" — 오늘 이 병으로 여덟 번 틀렸다.★
 *
 * → ★판정은 replyTarget.ts 한 곳에서만.★ 어댑터가 직접 `row.from_agent_id` 로 수신자를 정하면 안 된다.
 */
describe("복붙 역-가드 — ★수신자 판정은 한 곳에서만★", () => {
  it("어떤 어댑터도 `from_agent_id`를 답장 대상으로 직접 쓰지 않는다", () => {
    const SERVER = join(import.meta.dir, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".ts") && !e.name.includes(".test.")) {
          const src = readFileSync(full, "utf8");
          // 복붙된 형태: `row.from_agent_id !== targetAgentId && ... ? row.from_agent_id : "broadcast"`
          const rel = relative(SERVER, full);
          if (rel === "bus/replyTarget.ts") continue; // ★정본★ — 판정이 사는 곳
          if (/from_agent_id !== targetAgentId/.test(src)) offenders.push(rel);
        }
      }
    };
    walk(SERVER);
    expect(offenders).toEqual([]); // 실패하면 ★어느 파일이 다시 복붙했는지★ 이름이 찍힌다
  });
});

/**
 * ★회귀 가드 — 내 fix 가 만들 뻔한 ★새 오배송★.★ (Steve 실측, 2026-07-13)
 *
 * 내 첫 fix 는 "이 스레드에서 나에게 처음 일을 시킨 사람" 을 찾아 거기로 보냈다.
 * ★위임 스레드에선 맞다. 그룹에선 재앙이다.★
 *   그룹 스레드 `tg-...` 는 ★영원히 하나★ 다 — 실측 ★3,072건 · 6주 · hermes 에게 말 건 사람 8명.★
 *   "처음 시킨 사람" = ★6주 전의 codex★ → ★그룹에서 누가 답하면 내 답이 6주 전 사람에게 간다.★
 *   ★지금 버그보다 더 나쁘다.★
 *
 * ★소스 스캔 가드는 이걸 못 잡았다★ — "한 곳으로 모았나" 만 보지 ★"그 한 곳이 옳은가" 는 안 본다.★
 * ★둘은 다른 문제다.★ 그래서 케이스를 테스트에 박는다.
 */
describe("★그룹에서도 위임자를 찾는다 — '가장 최근 요청'★", () => {
  it("★🔴 장수 그룹: 6주 전 사람이 아니라 ★지금 위임한 사람★ 에게 간다★", () => {
    // 실측: tg- 그룹은 영원히 하나 (3,072건·6주·8명). "처음 시킨 사람" 은 6주 전 codex 다.
    msg("g1", "tg-99", "codex", "hermes", null, "2026-05-31 10:00:00"); // ★6주 전★
    msg("g2", "tg-99", "bill", "hermes", null, "2026-07-13 01:00:00");  // ★지금 위임★
    msg("g3", "tg-99", "hermes", "dbak", null, "2026-07-13 01:00:30");  // 내 팬아웃
    msg("g4", "tg-99", "dbak", "hermes", "g3", "2026-07-13 01:00:50");  // dbak 답 → 나를 깨움

    const t = turnReplyTarget(
      db,
      row({ message_id: "g4", thread_id: "tg-99", from_agent_id: "dbak", in_reply_to: "g3" }),
      "hermes",
      ROSTER,
    );
    expect(t).toBe("bill");     // ★지금 위임한 사람★
    expect(t).not.toBe("codex"); // ★6주 전 사람 아님★
    expect(t).not.toBe("dbak");  // ★깨운 기여자 아님 — 이게 라이브에서 나던 오배송★
  });

  it("★위임 뒤에 누가 딴 말을 걸어도 흔들리지 않는다★ — 기준은 ★내 팬아웃 시점★", () => {
    msg("h1", "t9", "bill", "hermes", null, "2026-07-13 01:00:00");   // ★위임★
    msg("h2", "t9", "hermes", "dbak", null, "2026-07-13 01:00:30");   // 내 팬아웃
    msg("h3", "t9", "lui", "hermes", null, "2026-07-13 01:00:40");    // ★팬아웃 뒤 딴 얘기★
    msg("h4", "t9", "dbak", "hermes", "h2", "2026-07-13 01:00:50");   // dbak 답

    const t = turnReplyTarget(
      db,
      row({ message_id: "h4", thread_id: "t9", from_agent_id: "dbak", in_reply_to: "h2" }),
      "hermes",
      ROSTER,
    );
    expect(t).toBe("bill");    // 내 팬아웃 시점 기준 → 위임자
    expect(t).not.toBe("lui"); // ★팬아웃 뒤에 온 딴 얘기에 흔들리지 않는다★
  });

  it("요청자가 둘이면 ★나중 것(내가 지금 처리 중인 것)★ 에게 간다", () => {
    msg("k1", "t8", "steve", "hermes", null, "2026-07-13 01:00:00");
    msg("k2", "t8", "bill", "hermes", null, "2026-07-13 01:01:00");   // ★이게 지금 처리 중인 위임★
    msg("k3", "t8", "hermes", "dbak", null, "2026-07-13 01:01:30");
    msg("k4", "t8", "dbak", "hermes", "k3", "2026-07-13 01:01:50");
    const t = turnReplyTarget(
      db,
      row({ message_id: "k4", thread_id: "t8", from_agent_id: "dbak", in_reply_to: "k3" }),
      "hermes",
      ROSTER,
    );
    expect(t).toBe("bill");
  });
});
