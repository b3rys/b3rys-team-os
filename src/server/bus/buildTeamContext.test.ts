// buildTeamContext — B fix (GD 2026-07-16): 단톡방(그룹 스레드)만 자기것만·6h·6건.
//   그룹방은 스레드 하나에 전 과제가 섞여 노이즈 → 자기것만 남긴다. 작업/수집 스레드(tg- 아님)는 full.
//   in-memory sqlite, 라이브 무관.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { acceptInbound } from "../db/inbox/acceptInbound";
import { buildTeamContext } from "./wakeDispatcher";

function setup(): Database {
  const db = new Database(":memory:");
  migrate(db);
  for (const a of ["codex", "steve", "ames"]) {
    db.prepare(
      `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES (?, ?, 'role', 'claude_channel', 'claude_tmux', '/tmp', 'p.md')`,
    ).run(a, a);
  }
  // thread.kind 는 CHECK(dm/meeting/broadcast)만 허용 — resolveThreadKind 는 thread_id('tg-')로 판별하므로 무관.
  db.prepare(
    `INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('tg--123','group','dm','["codex","steve","ames"]','codex')`,
  ).run();
  db.prepare(
    `INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('task-1','task','dm','["codex","steve"]','codex')`,
  ).run();
  return db;
}

const put = (db: Database, thread: string, from: string, to: string, body: string) =>
  acceptInbound(
    db,
    { thread_id: thread, from_agent_id: from, to_agent_id: to, body, source: "agent", type: "dm" } as never,
    { dedupeWindowSec: 0 },
  );

describe("buildTeamContext — 자기것만·5건 (그룹·버스 통일, GD 2026-07-16)", () => {
  test("★그룹방(tg-) → 자기것 + 나에게 온 것 (딴-과제 잡담 제거, 기여자 답은 유지)", () => {
    const db = setup();
    put(db, "tg--123", "codex", "steve", "판교 날씨 종합입니다"); // 내 것(from=me) → 유지
    put(db, "tg--123", "steve", "codex", "판교 흐림 26도 입니다"); // ★기여자 답(to=me) → 유지(그룹 수집 안 깨짐)
    put(db, "tg--123", "steve", "broadcast", "증시 하락 분석입니다"); // 남의 딴 과제(to=broadcast) → 제거
    put(db, "tg--123", "ames", "broadcast", "민재 인사 건입니다"); // 남의 딴 과제 → 제거
    const ctx = buildTeamContext(db, "tg--123", "codex");
    expect(ctx).toContain("판교 날씨 종합"); // 내 것 보임
    expect(ctx).toContain("판교 흐림 26도"); // ★기여자 답(to=me) 보임 = 그룹 수집 안 깨짐
    expect(ctx).not.toContain("증시 하락 분석"); // 딴 과제 잡담 제거
    expect(ctx).not.toContain("민재 인사");
  });

  test("★작업/버스 스레드(tg- 아님)도 자기것만 (GD 2026-07-16 '전부 5개, 분기 타지 말고')", () => {
    const db = setup();
    put(db, "task-1", "codex", "steve", "판교 알려줘"); // 내 팬아웃(from=me) → 유지
    put(db, "task-1", "steve", "codex", "판교 흐림 26도입니다"); // 기여자 답(to=me) → 유지(수집 안 깨짐)
    put(db, "task-1", "steve", "ames", "딴-대화 리뷰 요청입니다"); // ★남의 딴-대화(neither) → 이제 제거
    const ctx = buildTeamContext(db, "task-1", "codex");
    expect(ctx).toContain("판교 알려줘"); // from=me 보임
    expect(ctx).toContain("판교 흐림 26도"); // to=me(기여자 답) 보임 = 버스 수집도 안 깨짐
    expect(ctx).not.toContain("딴-대화 리뷰 요청"); // ★버스도 남의 딴-대화 제거(신 동작 증명 — fix 끄면 빨개짐)
  });
});
