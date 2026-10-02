// healthCheck 가 게이트웨이 생존 결과를 op 알림까지 실제로 흘려보내는지 — 배선 시험.
// 설정 파일(essentials)은 정상인데 게이트웨이만 내려간 경우가 핵심이다: 설정만 보던 때는 이 경우가 조용했다.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import type { AgentRecord } from "../types";
import type { LaunchdState } from "../lib/gatewayLiveness";

process.env.HEALTH_CHECK_INTERVAL_MS = "20";
process.env.OP_NOTICE_AFTER_TICKS = "2";

let startHealthCheck: typeof import("./healthCheck").startHealthCheck;
beforeAll(async () => {
  ({ startHealthCheck } = await import("./healthCheck"));
});
afterAll(() => {
  delete process.env.HEALTH_CHECK_INTERVAL_MS;
  delete process.env.OP_NOTICE_AFTER_TICKS;
});

// agent 행은 op 알림 수신자 존재 확인용이다(런타임 판단은 agents() 가 준다).
function seed(db: Database, id: string) {
  db.prepare(
    `INSERT OR IGNORE INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES (?, ?, 'role', 'claude_channel', 'claude_tmux', '/tmp', 'P.md')`,
  ).run(id, id);
}

// 설정 검사는 항상 정상으로 주입한다 — 이 시험은 '설정은 멀쩡한데 게이트웨이만 내려간' 경우만 본다.
// lead 는 알림 수신자(coordinator) 역할이다.
const agents = (): AgentRecord[] =>
  [
    { id: "bill", runtime: "claude_channel", enabled: false },
    { id: "lead", runtime: "unknown_runtime", capabilities: ["coordinator"] },
    { id: "devon", runtime: "openclaw", openclaw_agent_id: "devon", enabled: true },
  ] as unknown as AgentRecord[];

async function waitFor(fn: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return fn();
}

describe("healthCheck — 게이트웨이가 내려가면 op 알림이 나간다", () => {
  test("★launchd 미로드 게이트웨이 → 연속 tick 뒤 down 알림, 본문에 게이트웨이 항목★", async () => {
    const db = new Database(":memory:");
    migrate(db);
    for (const id of ["bill", "lead", "devon"]) seed(db, id);
    let state: LaunchdState = { loaded: false, pid: null };
    const settingsOk = () => ({ ok: true, missing: [], canAutoFix: false });
    const stop = startHealthCheck({ db, agents, launchdProbe: () => state, checkSettings: settingsOk });
    try {
      const body = () =>
        (db.query(`SELECT body FROM message WHERE to_agent_id='lead' ORDER BY rowid DESC LIMIT 1`).get() as { body: string } | null)?.body ?? "";
      expect(await waitFor(() => body().includes("devon"))).toBe(true);
      expect(body()).toContain("gateway:ai.openclaw.gateway launchd 미로드");

      // 다시 뜨면 회복 알림
      state = { loaded: true, pid: 99 };
      expect(await waitFor(() => body().includes("정상으로 돌아왔습니다"))).toBe(true);
    } finally {
      stop();
    }
  });
});
