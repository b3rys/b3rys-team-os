// 재부팅일 때만 한 번 알리고, 서버만 재시작했거나 부팅 시각을 모르면 조용해야 한다.
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import type { AgentRecord } from "../types";
import {
  BOOT_TIME_SETTING_KEY,
  buildRebootBody,
  checkRebootNotice,
  parseBootTime,
} from "./rebootNotice";

const agent = (id: string, capabilities: string[] = []): AgentRecord =>
  ({ id, runtime: "claude_channel", capabilities } as unknown as AgentRecord);
const TEAM = [agent("jane"), agent("lisa", ["coordinator"])];

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  for (const a of TEAM) {
    db.prepare(
      `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES (?, ?, 'x', 'claude_channel', 'claude_tmux', '/tmp', '/tmp/x')`,
    ).run(a.id, a.id);
  }
  return db;
}
const notices = (db: Database) =>
  db.query("SELECT to_agent_id, body, meta_json AS meta FROM message WHERE from_agent_id = 'system'").all() as {
    to_agent_id: string;
    body: string;
    meta: string;
  }[];
const stored = (db: Database) =>
  (db.query("SELECT value FROM setting WHERE key = ?").get(BOOT_TIME_SETTING_KEY) as { value: string } | null)?.value;

describe("parseBootTime", () => {
  test("macOS sysctl 출력에서 sec 를 읽는다", () => {
    expect(parseBootTime("{ sec = 1792932454, usec = 530969 } Sun Oct 25 21:47:34 2026")).toBe(1792932454);
  });
  test("usec 만 있거나 엉뚱한 출력이면 null", () => {
    expect(parseBootTime("{ usec = 5 }")).toBeNull();
    expect(parseBootTime("")).toBeNull();
    expect(parseBootTime("sysctl: unknown oid")).toBeNull();
  });
});

describe("checkRebootNotice", () => {
  test("처음 실행은 저장만 하고 알리지 않는다", () => {
    const db = freshDb();
    expect(checkRebootNotice(db, TEAM, { bootSec: 1000, enabled: true })).toBe("first_run");
    expect(stored(db)).toBe("1000");
    expect(notices(db)).toHaveLength(0);
  });

  test("서버만 재시작(부팅 시각 같음·몇 초 흔들림)은 알리지 않는다", () => {
    const db = freshDb();
    checkRebootNotice(db, TEAM, { bootSec: 1000, enabled: true });
    expect(checkRebootNotice(db, TEAM, { bootSec: 1000, enabled: true })).toBe("same_boot");
    expect(checkRebootNotice(db, TEAM, { bootSec: 1003, enabled: true })).toBe("same_boot");
    expect(notices(db)).toHaveLength(0);
  });

  test("재부팅이면 coordinator 한 명에게 op 알림 한 번, 같은 부팅에 두 번 안 보낸다", () => {
    const db = freshDb();
    checkRebootNotice(db, TEAM, { bootSec: 1000, enabled: true });
    expect(checkRebootNotice(db, TEAM, { bootSec: 90000, enabled: true })).toBe("notified");
    expect(checkRebootNotice(db, TEAM, { bootSec: 90000, enabled: true })).toBe("same_boot");
    const n = notices(db);
    expect(n).toHaveLength(1);
    expect(n[0]!.to_agent_id).toBe("lisa");
    expect(JSON.parse(n[0]!.meta)).toMatchObject({ op_notice: true, no_wake: true });
    expect(n[0]!.body).toBe(buildRebootBody(90000));
    // 그룹방(broadcast)으로는 나가지 않는다
    expect(db.query("SELECT COUNT(*) AS c FROM message WHERE to_agent_id = 'broadcast'").get()).toEqual({ c: 0 });
  });

  test("부팅 시각을 못 읽으면 저장도 알림도 안 한다", () => {
    const db = freshDb();
    checkRebootNotice(db, TEAM, { bootSec: 1000, enabled: true });
    expect(checkRebootNotice(db, TEAM, { bootSec: null, enabled: true })).toBe("unknown");
    expect(stored(db)).toBe("1000");
    expect(notices(db)).toHaveLength(0);
  });

  test("꺼져 있으면 아무것도 안 한다", () => {
    const db = freshDb();
    checkRebootNotice(db, TEAM, { bootSec: 1000, enabled: true });
    expect(checkRebootNotice(db, TEAM, { bootSec: 90000, enabled: false })).toBe("disabled");
    expect(stored(db)).toBe("1000");
    expect(notices(db)).toHaveLength(0);
  });

  test("받을 팀원이 없으면 audit 만 남긴다", () => {
    const db = freshDb();
    checkRebootNotice(db, [], { bootSec: 1000, enabled: true });
    expect(checkRebootNotice(db, [], { bootSec: 90000, enabled: true })).toBe("no_recipient");
    expect(notices(db)).toHaveLength(0);
  });
});

describe("REBOOT_OP_NOTICE 환경 변수", () => {
  test("기본은 켜짐, '0' 이면 꺼짐", () => {
    const old = process.env.REBOOT_OP_NOTICE;
    try {
      delete process.env.REBOOT_OP_NOTICE;
      const db = freshDb();
      expect(checkRebootNotice(db, TEAM, { bootSec: 1000 })).toBe("first_run");
      process.env.REBOOT_OP_NOTICE = "0";
      expect(checkRebootNotice(db, TEAM, { bootSec: 90000 })).toBe("disabled");
    } finally {
      if (old === undefined) delete process.env.REBOOT_OP_NOTICE;
      else process.env.REBOOT_OP_NOTICE = old;
    }
  });
});

describe("리뷰 보강", () => {
  test("수신자는 있는데 agent 행이 없어 적재 실패면 notified 로 기록하지 않는다", () => {
    const db = freshDb();
    const ghost = [agent("ghost", ["coordinator"])];
    checkRebootNotice(db, ghost, { bootSec: 1000, enabled: true });
    expect(checkRebootNotice(db, ghost, { bootSec: 90000, enabled: true })).toBe("send_failed");
    expect(notices(db)).toHaveLength(0);
    const audit = db.query("SELECT action FROM audit_event WHERE target = 'reboot'").all() as { action: string }[];
    expect(audit.map((a) => a.action)).toEqual(["op_notice_failed"]);
  });

  test("두 서버가 같은 DB 로 겹쳐 떠도 이전 값을 읽고 보내는 쪽은 하나", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const os = require("node:os") as typeof import("node:os");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reboot-")), "t.db");
    const a = new Database(file);
    migrate(a);
    for (const m of TEAM) {
      a.prepare(
        `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
         VALUES (?, ?, 'x', 'claude_channel', 'claude_tmux', '/tmp', '/tmp/x')`,
      ).run(m.id, m.id);
    }
    checkRebootNotice(a, TEAM, { bootSec: 1000, enabled: true });
    const b = new Database(file);
    b.run("PRAGMA busy_timeout = 0");
    let second: string = "not_run";
    // a 가 이전 값을 읽은 직후·저장 전에 b 가 끼어든다.
    const first = checkRebootNotice(a, TEAM, {
      bootSec: 90000,
      enabled: true,
      afterRead: () => {
        try {
          second = checkRebootNotice(b, TEAM, { bootSec: 90000, enabled: true });
        } catch {
          second = "busy";
        }
      },
    });
    expect(first).toBe("notified");
    expect(second).toBe("busy");
    expect(notices(a)).toHaveLength(1);
    a.close();
    b.close();
  });
});
