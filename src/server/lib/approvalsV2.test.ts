/**
 * 승인 시스템 v2 (GD 2026-07-08) — 스키마 마이그레이션 · 10분 자동보류 · tier 인가.
 * 보안-핵심(누가 main 머지를 승인하냐)이라 tier 인가는 포괄 검증. 순수 로직 위주(부작용 격리).
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, migrateApprovalDeferredStatus } from "../db/migrate";
import {
  deferStaleApprovals,
  canApproveTier,
  getNormalApprovers,
  DEFAULT_NORMAL_TIER_APPROVERS,
} from "./approvals";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

describe("approval v2 — 스키마 'deferred'", () => {
  test("fresh DB 는 deferred 상태 허용", () => {
    const db = freshDb();
    db.prepare("INSERT INTO approval_request(id,action_key,title,status) VALUES('t','merge_to_main','x','deferred')").run();
    expect((db.query("SELECT status FROM approval_request WHERE id='t'").get() as any).status).toBe("deferred");
  });

  test("기존 DB(옛 CHECK) → 재빌드 마이그레이션이 deferred 허용 + 데이터 보존 + 멱등", () => {
    const db = new Database(":memory:");
    db.exec(
      `CREATE TABLE approval_request (id TEXT PRIMARY KEY, action_key TEXT NOT NULL, params_json TEXT NOT NULL DEFAULT '{}', title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','executing','done','failed','rejected','expired')),
        requested_by TEXT NOT NULL DEFAULT 'system', created_at TEXT NOT NULL DEFAULT (datetime('now')), decided_at TEXT, result TEXT)`,
    );
    db.prepare("INSERT INTO approval_request(id,action_key,title,status,requested_by) VALUES('keep','merge_to_main','k','approved','steve')").run();
    expect(() => db.prepare("INSERT INTO approval_request(id,action_key,title,status) VALUES('x','a','x','deferred')").run()).toThrow();
    migrateApprovalDeferredStatus(db);
    db.prepare("INSERT INTO approval_request(id,action_key,title,status) VALUES('n','a','x','deferred')").run();
    const kept = db.query("SELECT status,requested_by FROM approval_request WHERE id='keep'").get() as any;
    expect(kept.status).toBe("approved");
    expect(kept.requested_by).toBe("steve");
    migrateApprovalDeferredStatus(db); // 멱등
    expect((db.query("SELECT count(*) c FROM approval_request").get() as any).c).toBe(2);
  });
});

describe("approval v2 — 10분 자동보류(deferStaleApprovals)", () => {
  test("10분 초과 pending 만 보류, 방금·이미결정은 유지 (id 특정)", () => {
    const db = freshDb();
    db.prepare("INSERT INTO approval_request(id,action_key,title,status,requested_by,created_at) VALUES('old','merge_to_main','o','pending','steve',datetime('now','-11 minutes'))").run();
    db.prepare("INSERT INTO approval_request(id,action_key,title,status,requested_by,created_at) VALUES('new','merge_to_main','n','pending','bill',datetime('now'))").run();
    db.prepare("INSERT INTO approval_request(id,action_key,title,status,requested_by,created_at) VALUES('ok','merge_to_main','a','approved','codex',datetime('now','-20 minutes'))").run();
    const out = deferStaleApprovals(db, 10);
    expect(out.length).toBe(1);
    expect(out[0]!.id).toBe("old");
    expect(out[0]!.requested_by).toBe("steve");
    expect((db.query("SELECT status FROM approval_request WHERE id='old'").get() as any).status).toBe("deferred");
    expect((db.query("SELECT status FROM approval_request WHERE id='new'").get() as any).status).toBe("pending");
    expect((db.query("SELECT status FROM approval_request WHERE id='ok'").get() as any).status).toBe("approved");
  });
});

describe("approval v2 — tier 인가(canApproveTier) [보안-핵심]", () => {
  const pool = ["bill", "steve", "codex", "hermes"];
  const call = (o: Partial<Parameters<typeof canApproveTier>[0]>) =>
    canApproveTier({ tier: "normal", approver: "bill", author: "steve", isLead: false, normalApprovers: pool, ...o });

  test("① self-approve 금지 — 모든 tier(lead 포함)", () => {
    expect(call({ approver: "steve", author: "steve" }).ok).toBe(false);
    expect(call({ tier: "core", approver: "gd", author: "gd", isLead: true }).ok).toBe(false);
    expect(call({ approver: "Steve", author: "steve" }).ok).toBe(false); // case-insensitive
  });

  test("⑧ core 는 lead(GD) 만", () => {
    expect(call({ tier: "core", approver: "gd", author: "steve", isLead: true }).ok).toBe(true);
    expect(call({ tier: "core", approver: "bill", author: "steve", isLead: false }).ok).toBe(false);
  });

  test("normal 은 풀 멤버 or lead", () => {
    expect(call({ approver: "bill", author: "steve" }).ok).toBe(true);
    expect(call({ approver: "hermes", author: "codex" }).ok).toBe(true);
    expect(call({ approver: "ames", author: "steve" }).ok).toBe(false); // 풀 밖
    expect(call({ approver: "gd", author: "steve", isLead: true }).ok).toBe(true); // lead superset
  });

  test("config 변경 반영 — 풀에서 빠지면 승인 불가", () => {
    expect(call({ approver: "steve", author: "bill", normalApprovers: ["codex", "hermes"] }).ok).toBe(false);
  });
});

describe("approval v2 — 승인자 풀 설정(getNormalApprovers) config-driven", () => {
  test("미설정=기본 4인", () => {
    expect(getNormalApprovers(freshDb())).toEqual(DEFAULT_NORMAL_TIER_APPROVERS.map((s) => s));
  });
  test("설정값 파싱(콤마/공백·소문자)", () => {
    const db = freshDb();
    db.prepare("INSERT INTO setting(key,value) VALUES('merge_approvers_normal','Bill, dbak  Codex')").run();
    expect(getNormalApprovers(db)).toEqual(["bill", "dbak", "codex"]);
  });
  test("빈 설정=기본(락아웃 방지)", () => {
    const db = freshDb();
    db.prepare("INSERT INTO setting(key,value) VALUES('merge_approvers_normal','   ')").run();
    expect(getNormalApprovers(db).length).toBe(4);
  });
});
