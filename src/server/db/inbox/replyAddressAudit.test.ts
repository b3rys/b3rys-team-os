// ★반창고가 계기판까지 가려버렸다★ (GD 2026-07-14: "다 빼?")
//
// 서버는 "1:1 질문에 broadcast 로 답한 것" 을 원 요청자에게 되돌려 저장한다(messages.ts:64).
// 이 보정은 ★필요하다★ — to=broadcast 면 요청자를 ★깨우지 않아서★ 위임이 영영 안 끝난다.
//
// ★나빴던 건 보정이 아니라 '조용함' 이었다.★ 30일간 98건이 발동했는데 ★감사로그에 한 줄도 없었다.★
// 그래서 6주 동안 아무도 hermes 가 주소를 틀린다는 걸 몰랐다. (98건 중 ★96건이 hermes_agent★)
//
// ★이 이벤트 수 = 근본이 고쳐졌는지의 계기판이다.★
//   오늘 hermes 주입문을 고쳤다 → 거의 0 으로 떨어져야 한다.
//   ★1주일 0건이면 보정을 통째로 삭제한다.★ 0 이 아니면 ★그 런타임의 주입문★ 을 고친다(코드를 더 붙이지 않는다).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../migrate";
import { insertMessage } from "./messages";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ★테스트는 라이브 감사로그를 건드리지 않는다★ (팀 규칙: 테스트 = 실 파일시스템 격리 필수)
let auditDir = "";
let prevDir: string | undefined;
beforeAll(() => {
  prevDir = process.env.B3OS_AUDIT_LOG_DIR;
  auditDir = mkdtempSync(join(tmpdir(), "audit-test-"));
  process.env.B3OS_AUDIT_LOG_DIR = auditDir;
});
afterAll(() => {
  if (prevDir === undefined) delete process.env.B3OS_AUDIT_LOG_DIR;
  else process.env.B3OS_AUDIT_LOG_DIR = prevDir;
  if (auditDir) rmSync(auditDir, { recursive: true, force: true });
});

function setup(): Database {
  const db = new Database(":memory:");
  migrate(db);
  for (const a of ["bill", "hermes"]) {
    db.prepare(
      `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES (?, ?, 'r', 'hermes_agent', 'hermes_gateway', '/tmp', 'p.md')`,
    ).run(a, a);
  }
  db.prepare(
    `INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t1','q','dm','["bill","hermes"]','bill')`,
  ).run();
  // bill 이 hermes 에게 ★1:1 로★ 물었다
  db.prepare(
    `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, created_at)
     VALUES ('ASK','t1','bill','hermes','dm','이거 어떻게 생각해?','agent',datetime('now'))`,
  ).run();
  return db;
}

const auditToday = () => {
  const f = join(auditDir, `audit-${new Date().toISOString().slice(0, 10)}.log`);
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};

describe("답 주소 — ★서버는 고치지 않는다. 기록만 한다★", () => {
  // ★GD 2026-07-14★: "보정을 하면 안된다니깐.. 근본이 아니잖아. 그냥 기록만 추가하고 삭제해.
  //                   보정 자체가 룰대로 동작을 안한건데.. 그걸 다른 반창고로 자꾸 덮으려는 그 접근을 바꿔."
  //
  // 예전엔 서버가 to=broadcast 를 ★몰래★ 원 요청자로 되돌렸다. 30일 98건 — ★로그 0줄.★
  // → 누가 틀리는지 볼 수 없었고, ★6주 동안 진짜 원인(주입문이 "팀장께 답하라")이 살아 있었다.★
  // → 그 보정이 오늘 유출까지 낳았다 (DB엔 1:1, 릴레이는 방).
  // ★이제 안 고친다. 기록만 한다. 틀린 답은 방에 떠서 ★보인다.★ 로그를 보고 ★주입문★ 을 고친다.★

  test("★주소가 틀려도 서버가 고치지 않는다★ (그대로 broadcast 로 저장)", () => {
    const db = setup();
    const stored = insertMessage(db, {
      thread_id: "t1",
      from_agent_id: "hermes",
      to_agent_id: "broadcast", // 1:1 질문에 방으로 답함 = 틀림
      in_reply_to: "ASK",
      type: "broadcast",
      body: "제 의견은…",
      source: "agent",
    } as never);
    expect(stored.to_agent_id).toBe("broadcast"); // ★안 고친다★ — 예전엔 'bill' 로 바꿔치기했다
    expect(stored.type).toBe("broadcast");
  });

  test("★★대신 기록한다 — 누가·어디로 갔어야 하는지★★", () => {
    const before = auditToday().length;
    const db = setup();
    insertMessage(db, {
      thread_id: "t1",
      from_agent_id: "hermes",
      to_agent_id: "broadcast",
      in_reply_to: "ASK",
      type: "broadcast",
      body: "제 의견은…",
      source: "agent",
    } as never);
    const added = auditToday().slice(before);
    expect(added).toContain("reply_address_wrong");
    expect(added).toContain("hermes"); // ★누가 틀렸나★ → 그 런타임의 주입문을 고친다
    expect(added).toContain("bill"); // 어디로 갔어야 하나
  });

  test("주소가 맞으면 기록도 없다 (정상 경로는 조용하다)", () => {
    const before = auditToday().length;
    const db = setup();
    const stored = insertMessage(db, {
      thread_id: "t1",
      from_agent_id: "hermes",
      to_agent_id: "bill", // ★맞게 보냄★ — 오늘 주입문 fix 후의 정상 동작
      in_reply_to: "ASK",
      type: "dm",
      body: "제 의견은…",
      source: "agent",
    } as never);
    expect(stored.to_agent_id).toBe("bill");
    expect(auditToday().slice(before)).not.toContain("reply_address_wrong");
  });
});

// ★서버는 추측하지 않는다 — 폴백을 넣었다가 ★데이터가 죽였다★★ (GD 2026-07-14)
//
//   "--in-reply-to 가 3~4할만 붙는다" 가 걱정돼서, 없으면 ★"이 스레드에서 이 사람에게 온 1:1 질문"★ 을
//   찾아 상관지으려 했다. ★조회처럼 보였지만 사실은 추측★ 이었다 — codex 가 정확히 짚었다:
//     ★"'질문 행이 존재한다' 는 조회지만, '이 broadcast 가 그 질문의 답이다' 는 추측이다."★
//   ★실측이 반증했다★ (30일): 폴백이 잡았을 3건 = ★전부 오탐★ (codex 의 정당한 팀 리뷰 요청).
//   ★오탐률 100%. 계기판이 아니라 노이즈 생성기였다.★ → 삭제.
describe("계기판 — ★추측하지 않는다★", () => {
  test("★in_reply_to 없으면 기록하지 않는다★ (그 broadcast 가 답인지 서버는 모른다)", () => {
    const before = auditToday().length;
    const db = setup(); // bill 이 hermes 에게 1:1 질문 'ASK' 를 걸어둔 상태
    insertMessage(db, {
      thread_id: "t1",
      from_agent_id: "hermes",
      to_agent_id: "broadcast",
      // ★in_reply_to 없음★ — 이건 ★답일 수도, 정당한 팀 공지일 수도★ 있다. 서버는 모른다.
      type: "broadcast",
      body: "[팀 전체] 구조도 리뷰 요청드립니다",
      source: "agent",
    } as never);
    // ★추측해서 '틀렸다' 고 찍지 않는다★ — 실측에서 이런 게 3건이었고 ★전부 정당한 공지★ 였다
    expect(auditToday().slice(before)).not.toContain("reply_address_wrong");
  });

  test("★모델이 '이건 X 의 답이다' 라고 말했을 때만 판정한다★ (그건 사실이다)", () => {
    const before = auditToday().length;
    const db = setup();
    insertMessage(db, {
      thread_id: "t1",
      from_agent_id: "hermes",
      to_agent_id: "broadcast",
      in_reply_to: "ASK", // ★모델이 스스로 말했다★ — 1:1 질문의 답인데 방에 썼다
      type: "broadcast",
      body: "제 의견은…",
      source: "agent",
    } as never);
    expect(auditToday().slice(before)).toContain("reply_address_wrong");
  });
});
