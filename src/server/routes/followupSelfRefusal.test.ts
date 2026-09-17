// POST /api/inbox/followup/self 가 ★거부할 때 다음 행동까지 알려주는지★ 고정한다.
//
// 왜 필요한가: 등록 대상이 아닌 런타임에는 `not_one_shot_runtime` 이라는 원인만 돌아갔다.
//   원인만 받으면 받는 쪽은 무엇을 대신 해야 하는지 모르고, 거부를 보고도 "등록됐으니
//   알림이 오겠지" 로 넘어가면 ★보고가 통째로 누락된다★. 그래서 실재하는 대안
//   (위임 본문 ETA + 칸반 doing 카드 → 60분 무변경 시 task-continuation-guard 가 깨움)을
//   응답에 같이 싣는다. 게이트 자체는 그대로다 — 이 변경은 ★문구만★ 늘린다.
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { createInboxRoutes } from "./inbox";

function setup(runtimes: Record<string, string>): ReturnType<typeof createInboxRoutes> {
  const db = new Database(":memory:");
  migrate(db);
  for (const [id, runtime] of Object.entries(runtimes)) {
    db.prepare(
      `INSERT OR IGNORE INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES (?, ?, 'r', ?, 'claude_tmux', '/tmp', 'P.md')`,
    ).run(id, id, runtime);
  }
  return createInboxRoutes({
    db,
    broadcast: () => {},
    registeredAgentIds: () => new Set(Object.keys(runtimes)),
  } as unknown as Parameters<typeof createInboxRoutes>[0]);
}

function register(app: ReturnType<typeof createInboxRoutes>, agent: string, extra: Record<string, unknown> = {}) {
  return app.request("/followup/self", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent_id: agent, thread_id: "t-work", ...extra }),
  });
}

describe("followup/self 거부 응답", () => {
  test("★등록 대상 밖 런타임은 거부 사유와 함께 대안을 돌려준다★", async () => {
    const app = setup({ jane: "claude_channel" });
    const res = await register(app, "jane");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; reason: string; alternative?: string };
    expect(body.ok).toBe(false);
    expect(body.reason, "게이트 판정 자체는 바뀌지 않는다").toBe("not_one_shot_runtime");
    // 대안이 ★실행 가능한 형태★ 인지 — 세 조각이 다 있어야 다음 행동이 된다.
    expect(body.alternative, "대안 문구가 없다").toBeTruthy();
    expect(body.alternative).toContain("ETA");
    expect(body.alternative).toContain("칸반 doing 카드");
    expect(body.alternative).toContain("continuation-guard");
    // 런타임 이름은 고정 문자열이 아니라 조회값이어야 한다 — 다른 런타임에 claude_channel 이라고 적으면 거짓말이 된다.
    expect(body.alternative).toContain("claude_channel");
  });

  test("codex 처럼 다른 런타임에도 ★그 런타임 이름으로★ 나간다", async () => {
    const app = setup({ carl: "codex" });
    const body = (await (await register(app, "carl")).json()) as { alternative?: string };
    expect(body.alternative).toContain("codex");
    expect(body.alternative, "다른 런타임인데 claude_channel 로 적히면 안 된다").not.toContain("claude_channel");
  });

  test("턴기반 런타임은 여전히 등록된다 (게이트 회귀 없음)", async () => {
    const app = setup({ otto: "openclaw" });
    const res = await register(app, "otto");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; alternative?: string };
    expect(body.ok).toBe(true);
    expect(body.alternative, "성공 응답에 대안이 붙으면 안 된다").toBeUndefined();
  });

  test("다른 거부 사유에는 대안을 붙이지 않는다 — 대안이 사유와 어긋나면 안 된다", async () => {
    const app = setup({ otto: "openclaw" });
    const res = await register(app, "otto", { duration: "nonsense" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { reason: string; alternative?: string };
    expect(body.reason).toBe("bad_duration");
    expect(body.alternative).toBeUndefined();
  });
});
