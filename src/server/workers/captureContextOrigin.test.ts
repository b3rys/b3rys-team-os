/**
 * 단톡방 인입 경로의 주입 문맥도 줄마다 출처를 밝힌다.
 *
 * ★이 파일은 `telegramCapture` 쪽 줄을 잰다★ — 팀버스 쪽(`buildTeamContext`)만 보는 테스트는
 * 이 축을 못 잡는다. 실제로 출처 표시를 팀버스에만 붙였을 때, 팀버스 테스트는 전부 통과하는데
 * ★팀장님이 실제로 받으시는 주입문은 그대로 `[이름] 본문`★ 이었다.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { acceptInbound } from "../db/inbox/acceptInbound";
import { buildCaptureTeamContext } from "./telegramCapture";

const GROUP = "tg--123";

function setup(): Database {
  const db = new Database(":memory:");
  migrate(db);
  for (const a of ["bill", "steve"]) {
    db.prepare(
      `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES (?, ?, 'role', 'claude_channel', 'claude_tmux', '/tmp', 'p.md')`,
    ).run(a, a);
  }
  db.prepare(
    `INSERT INTO thread (id, title, kind, participants_json, opened_by)
     VALUES ('${GROUP}','group','dm','["bill","steve"]','bill')`,
  ).run();
  return db;
}

const put = (db: Database, from: string, to: string, body: string, source: string) =>
  acceptInbound(
    db,
    { thread_id: GROUP, from_agent_id: from, to_agent_id: to, body, source, type: "dm" } as never,
    { dedupeWindowSec: 0 },
  );

function lineFor(ctx: string, needle: string): string {
  const line = ctx.split("\n").find((l) => l.includes(needle));
  expect(line, `문맥에 '${needle}' 줄이 없다`).toBeDefined();
  return line!;
}

describe("단톡방 인입 주입문도 줄마다 출처를 밝힌다", () => {
  test("★팀장님 발언은 단체, 팀버스 메시지는 팀버스★ — 한 문맥 안에서 갈린다", () => {
    const db = setup();
    put(db, "user", "bill", "@빌 다 끝났어?", "user");
    put(db, "bill", "steve", "버스로만 보낸 지시다", "agent");

    const ctx = buildCaptureTeamContext(db, GROUP);

    expect(lineFor(ctx, "다 끝났어?")).toContain("단체");
    expect(lineFor(ctx, "버스로만 보낸 지시다")).toContain("팀버스");
    // 두 줄이 서로 달라야 한다 — 같은 라벨이면 가른 게 아니다.
    expect(lineFor(ctx, "버스로만 보낸 지시다")).not.toContain("단체");
  });

  test("시스템 통지는 사람 발언과 갈린다", () => {
    const db = setup();
    put(db, "system", "steve", "슬랙 게시 실패", "system");
    expect(lineFor(buildCaptureTeamContext(db, GROUP), "슬랙 게시 실패")).toContain("시스템");
  });

  test("★수신자가 하나로 안 정해지는 자리라 '너' 가 없다★ — 방 전체용 문맥이다", () => {
    const db = setup();
    put(db, "bill", "steve", "누구에게 갈지 모른다", "agent");
    expect(buildCaptureTeamContext(db, GROUP)).not.toContain("너");
  });

  test("기존 동작 — 200자에서 자르고 줄바꿈을 공백으로 바꾼다", () => {
    const db = setup();
    put(db, "bill", "steve", "가".repeat(250) + "\n" + "끝", "agent");

    const ctx = buildCaptureTeamContext(db, GROUP);
    expect(ctx.split("\n")).toHaveLength(1); // 본문의 줄바꿈이 줄을 늘리지 않는다
    expect(ctx).toContain("가".repeat(200));
    expect(ctx).not.toContain("가".repeat(201));
    expect(ctx).toContain("잘림: 원문 252자"); // 조용히 자르지 않는다
  });

  test("빈 스레드는 빈 문자열", () => {
    expect(buildCaptureTeamContext(setup(), GROUP)).toBe("");
  });
});
