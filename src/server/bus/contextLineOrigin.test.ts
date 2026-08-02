// 주입 문맥의 줄마다 출처를 붙인다 — 단체 · 팀버스 · 1:1 · 시스템.
//
// 한 스레드에 세 가지가 섞여 들어오는데 줄 모양이 같아서, 버스로만 간 줄을
// 방에 올라간 것으로 읽는 일이 실제로 있었다. in-memory sqlite, 라이브 무관.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { acceptInbound } from "../db/inbox/acceptInbound";
import { buildTeamContext } from "./wakeDispatcher";
import { teamContextLabel } from "../channels/registry";

const GROUP = "tg--123";

function setup(): Database {
  const db = new Database(":memory:");
  migrate(db);
  for (const a of ["bill", "steve", "codex"]) {
    db.prepare(
      `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES (?, ?, 'role', 'claude_channel', 'claude_tmux', '/tmp', 'p.md')`,
    ).run(a, a);
  }
  db.prepare(
    `INSERT INTO thread (id, title, kind, participants_json, opened_by)
     VALUES ('${GROUP}','group','dm','["bill","steve","codex"]','bill')`,
  ).run();
  db.prepare(
    `INSERT INTO thread (id, title, kind, participants_json, opened_by)
     VALUES ('task-1','task','dm','["bill","steve"]','bill')`,
  ).run();
  return db;
}

const put = (
  db: Database,
  thread: string,
  from: string,
  to: string,
  body: string,
  source: string,
  type = "dm",
) =>
  acceptInbound(
    db,
    { thread_id: thread, from_agent_id: from, to_agent_id: to, body, source, type } as never,
    { dedupeWindowSec: 0 },
  );

/** 그 본문이 실린 줄 하나를 꺼낸다. */
function lineFor(ctx: string, needle: string): string {
  const line = ctx.split("\n").find((l) => l.includes(needle));
  expect(line, `문맥에 '${needle}' 줄이 없다`).toBeDefined();
  return line!;
}

describe("주입 문맥은 줄마다 출처를 밝힌다", () => {
  test("★버스로만 간 줄이 단체로 보이면 안 된다★ — 이 혼동이 잘못된 보고를 만들었다", () => {
    const db = setup();
    // 같은 스레드에 둘 다 넣는다. 지금까지 이 둘은 줄 모양이 똑같았다.
    //
    // ★남이 방에 올린 글로는 이 축을 못 잰다★ — 문맥 필터가 `from=나 OR to=나` 라
    // `bill → broadcast` 는 steve 문맥에 아예 안 들어온다(GD 2026-07-16 "자기것 + 나에게 온 것만").
    // 그래서 ★내가 방에 올린 글★ 을 쓴다. 실측에서도 이 모양이 제일 흔하다
    // (`<나> → broadcast`, type=dm — 팀원 방 게시의 정상 모양이다).
    put(db, GROUP, "bill", "steve", "버스로만 보낸 지시다", "agent");
    put(db, GROUP, "steve", "broadcast", "방에 올린 공지다", "agent");

    const ctx = buildTeamContext(db, GROUP, "steve");

    expect(lineFor(ctx, "버스로만 보낸 지시다")).toContain("팀버스");
    expect(lineFor(ctx, "방에 올린 공지다")).toContain("단체");
    // 두 줄이 서로 다르게 보여야 한다 — 같은 라벨이면 가른 게 아니다.
    expect(lineFor(ctx, "버스로만 보낸 지시다")).not.toContain("단체");
  });

  test("팀장님이 방에 올린 글은 수신자가 개인이어도 단체다", () => {
    const db = setup();
    // 팀장님이 방에서 한 명을 지목하면 to_agent_id 가 그 사람이 된다.
    // to_agent_id 만 보면 팀버스로 오인한다 — source 를 함께 봐야 한다.
    put(db, GROUP, "user", "steve", "@스티브 이것 좀 봐줘", "user");

    expect(lineFor(buildTeamContext(db, GROUP, "steve"), "이것 좀 봐줘")).toContain("단체");
  });

  test("팀장님 개인 방(그룹 아님)은 1:1", () => {
    const db = setup();
    put(db, "task-1", "user", "steve", "개인적으로 묻는다", "user");

    expect(lineFor(buildTeamContext(db, "task-1", "steve"), "개인적으로 묻는다")).toContain("1:1");
  });

  test("시스템 통지는 사람 발언과 갈린다", () => {
    const db = setup();
    put(db, GROUP, "system", "steve", "슬랙 게시 실패", "system");

    expect(lineFor(buildTeamContext(db, GROUP, "steve"), "슬랙 게시 실패")).toContain("시스템");
  });

  test("머리말이 스레드 이름만 보고 전부를 단톡방이라고 말하지 않는다", () => {
    // ★머리말은 buildTeamContext 가 만들지 않는다★ — teamContextLabel 이 만들어 앞에 붙인다.
    // 그래서 이 축은 그 함수에 직접 물어야 한다. buildTeamContext 로 재면 어떤 구현이든 통과한다.
    // 스레드 이름은 그대로 `tg-` 다 — 그런데도 "단톡방" 이라고 단정하지 않아야 한다.
    expect(teamContextLabel("ko")).not.toContain("단톡방");
    expect(teamContextLabel("en")).not.toContain("Group-room");
  });
});
