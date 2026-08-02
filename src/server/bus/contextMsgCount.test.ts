/**
 * 참고용 주입은 ★두 경로 다 5건★ 이다 (GD 2026-07-16 "전부 5개로 해. 분기 타지 말고",
 * 2026-08-02 재확인).
 *
 * ★숫자를 소스에서 읽지 않고 실제로 센다★ — 상수를 7로 바꾸면 이 테스트가 죽어야 한다.
 * 상수를 grep 하는 테스트는 값이 바뀌어도 같이 바뀌므로 아무것도 못 잡는다.
 *
 * ★두 경로를 한 파일에서 잰다★ — "분기 타지 말고" 가 지시의 핵심이라, 한쪽만 재면
 * 두 값이 갈라진 걸 못 본다(실제로 주석은 5인데 값이 6이었다).
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { acceptInbound } from "../db/inbox/acceptInbound";
import { buildTeamContext } from "./wakeDispatcher";
import { buildCaptureTeamContext } from "../workers/telegramCapture";

const GROUP = "tg--123";
const WANT = 5;

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

/** 8건을 넣는다 — 상한(5)보다 넉넉히 많아야 상한을 잰다. 6건이면 7로 바꿔도 안 죽는다. */
function fill(db: Database, from: string, to: string): void {
  for (let i = 1; i <= 8; i++) {
    acceptInbound(
      db,
      { thread_id: GROUP, from_agent_id: from, to_agent_id: to, body: `건${i}`, source: "agent", type: "dm" } as never,
      { dedupeWindowSec: 0 },
    );
  }
}

const lines = (ctx: string): string[] =>
  ctx.split("\n").filter((l) => /건\d/.test(l));

describe("참고용 주입은 두 경로 다 5건", () => {
  test("★팀버스 깨움 — 8건 넣으면 5건만 나온다★", () => {
    const db = setup();
    fill(db, "bill", "steve");
    const got = lines(buildTeamContext(db, GROUP, "steve"));
    expect(got).toHaveLength(WANT);
    // 최신 5건이다 — 오래된 것부터 버린다.
    expect(got[got.length - 1]).toContain("건8");
    expect(got[0]).toContain("건4");
  });

  test("★단톡방 인입 — 8건 넣으면 5건만 나온다★", () => {
    const db = setup();
    fill(db, "bill", "steve");
    const got = lines(buildCaptureTeamContext(db, GROUP));
    expect(got).toHaveLength(WANT);
    expect(got[got.length - 1]).toContain("건8");
  });

  test("★두 경로가 같은 수다 — 분기 없음★", () => {
    const db = setup();
    fill(db, "bill", "steve");
    expect(lines(buildCaptureTeamContext(db, GROUP)).length).toBe(
      lines(buildTeamContext(db, GROUP, "steve")).length,
    );
  });
});
