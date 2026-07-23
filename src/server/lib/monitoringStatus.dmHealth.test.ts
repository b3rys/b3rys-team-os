import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { readDmHealth } from "./monitoringStatus";

function agent(db: Database, id: string, runtime: string): void {
  const provider = runtime === "claude_channel" ? "claude_tmux" : runtime === "openclaw" ? "openclaw_gateway" : "hermes_gateway";
  db.prepare(`INSERT INTO agent (id,display_name,role,runtime,status_provider,workspace_path,persona_file)
    VALUES (?,?, 'member', ?, ?, '/tmp', '/tmp/persona')`).run(id, id, runtime, provider);
}

describe("readDmHealth member-level 판정", () => {
  test("한 런타임의 신선한 DM이 다른 멤버의 실패를 가리지 않는다", () => {
    const db = new Database(":memory:");
    migrate(db);
    agent(db, "bill", "claude_channel");
    agent(db, "codex", "openclaw");
    db.prepare(`INSERT INTO dm_sync_health(member_id,runtime,state,last_success_at) VALUES ('bill','claude_channel','ok',datetime('now'))`).run();
    db.prepare(`INSERT INTO dm_sync_health(member_id,runtime,state,last_error_at,error) VALUES ('codex','openclaw','error',datetime('now'),'bad format')`).run();
    const health = readDmHealth(db);
    expect(health.stale).toBe(true);
    expect(health.perMember.find((m) => m.memberId === "codex")?.state).toBe("error");
  });

  test("메시지가 없어도 모든 대상 멤버 probe 성공이면 정상이다", () => {
    const db = new Database(":memory:");
    migrate(db);
    agent(db, "quiet", "hermes_agent");
    db.prepare(`INSERT INTO dm_sync_health(member_id,runtime,state,last_success_at) VALUES ('quiet','hermes_agent','ok',datetime('now'))`).run();
    const health = readDmHealth(db);
    expect(health.total).toBe(0);
    expect(health.stale).toBe(false);
  });
});
