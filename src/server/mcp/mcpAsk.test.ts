// MCP → 팀원에게 묻기. ★정상 경우를 먼저 재고★, 그 다음 사고 시나리오를 재현한다.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { RESERVED_AGENT_IDS } from "../../shared/envelopeSchema"; // ★진짜 코드의 목록을 그대로 쓴다★
import {
  roomIdFor,
  findAnswer,
  findUnlabeled,
  askTeammate,
  fetchAnswer,
  postQuestion,
  askProgress,
  busIdentityFor,
  lateAnswerPush,
  THREAD_ID_MAX,
} from "./mcpAsk";
import { buildMcpServer, ASK_WAIT_MAX_SEC, ASK_WAIT_DEFAULT_SEC } from "./b3osMcpServer";

function addAgent(d: Database, id: string) {
  d.prepare(
    `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file,
                        moderator_eligible, avatar_emoji, created_at)
     VALUES (?, ?, 'test', 'claude_channel', 'claude_tmux', ?, ?, 0, '🙂', '2026-08-06 00:00:00')`,
  ).run(id, id, `/tmp/${id}`, `/tmp/${id}/SOUL.md`);
}
function freshDb(): Database {
  const d = new Database(":memory:");
  migrate(d);
  // ★리드(gd)는 일부러 넣지 않는다★ — 라이브가 그 상태다. 넣으면 이 시험이 사고를 못 잡는다.
  for (const id of ["bill", "codex", "hermes", "demis"]) addAgent(d, id);
  return d;
}

/** message.thread_id 는 thread(id) 를 참조한다 — 실제 경로에서는 acceptInbound 의 ensureThread 가 만든다. */
function ensureRoom(db: Database, roomId: string, openedBy: string) {
  db.prepare(
    `INSERT OR IGNORE INTO thread (id, title, kind, participants_json, opened_by, last_message_at)
     VALUES (?, ?, 'dm', '[]', ?, datetime('now'))`,
  ).run(roomId, roomId, openedBy);
}

/**
 * 버스 입구 흉내.
 *
 * ★진짜보다 관대하면 안 된다★ (2026-08-06 라이브 사고): 예전 가짜는 발신자를 검사하지 않아
 * `from_agent_id: 'gd'` 를 받아줬다. 시험 29개가 전부 통과했는데 ★라이브 첫 호출에서 죽었다★ —
 * 실제 POST /api/inbox 는 레지스트리에 없는 발신자를 `unknown_from_agent` 로 거부한다.
 * 리드(gd)는 agent 표에 ★일부러★ 없다. → 가짜도 같은 문을 세운다.
 */
function fakeBus(db: Database) {
  let n = 0;
  const calls: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const p = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push(p);
    const from = p.from_agent_id as string;
    const known = (db.prepare(`SELECT id FROM agent`).all() as Array<{ id: string }>).map((a) => a.id);
    if (!RESERVED_AGENT_IDS.has(from) && !known.includes(from)) {
      return new Response(JSON.stringify({ ok: false, error: "unknown_from_agent", id: from }), {
        headers: { "content-type": "application/json" },
      });
    }
    const id = `q${++n}`;
    ensureRoom(db, p.thread_id as string, p.from_agent_id as string);
    db.prepare(
      `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, meta_json, created_at)
       VALUES (?, ?, ?, ?, 'dm', ?, 'agent', ?, datetime('now'))`,
    ).run(
      id,
      p.thread_id as string,
      p.from_agent_id as string,
      p.to_agent_id as string,
      p.body as string,
      p.meta ? JSON.stringify(p.meta) : null,
    );
    return new Response(JSON.stringify({ ok: true, message: { id, thread_id: p.thread_id } }), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { deps: { baseUrl: "http://x", fetchImpl }, calls };
}

/** 팀원이 답한다 — 번호를 달거나(정상) 안 달거나(사고 재현). */
function reply(db: Database, o: { id: string; room: string; from: string; body: string; inReplyTo?: string }) {
  ensureRoom(db, o.room, o.from);
  db.prepare(
    `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, in_reply_to, created_at)
     VALUES (?, ?, ?, 'gd', 'dm', ?, 'agent', ?, datetime('now'))`,
  ).run(o.id, o.room, o.from, o.body, o.inReplyTo ?? null);
}

const nowait = { waitMs: 0, pollMs: 1, sleep: async () => {} };

// ── 방 이름 ──

test("방 이름은 사람마다 하나로 정해진다 — 같은 상대면 항상 같은 방", () => {
  expect(roomIdFor("gd", "bill")).toBe("mcp-gd-bill");
  expect(roomIdFor("gd", "bill")).toBe(roomIdFor("gd", "bill")); // 기억할 필요가 없다
  expect(roomIdFor("gd", "demis")).not.toBe(roomIdFor("gd", "bill")); // 사람이 다르면 방이 다르다
});

test("방 이름이 32자를 넘지 않는다 — 넘으면 발신이 실패했다", () => {
  const id = roomIdFor("gd", "x".repeat(80));
  expect(id.length).toBeLessThanOrEqual(THREAD_ID_MAX);
  expect(id.startsWith("mcp-gd-")).toBe(true);
});

// ── 정상 경우 ──

test("★정상★ 답이 오면 그 답을 돌려준다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  // 질문이 들어가자마자 빌이 번호를 달아 답하는 상황
  const answered = askTeammate(
    db,
    bus.deps,
    { from: "gd", to: "bill", body: "대시보드 왜 느려?" },
    {
      waitMs: 500,
      pollMs: 5,
      sleep: async () => {
        reply(db, { id: "a1", room: "mcp-gd-bill", from: "bill", body: "리포트 목록이 매번 전체를 읽습니다", inReplyTo: "q1" });
      },
    },
  );
  const r = await answered;
  expect(r.status).toBe("answered");
  expect(r.requestId).toBe("q1");
  expect(r.roomId).toBe("mcp-gd-bill");
  expect(r.answer?.body).toContain("리포트 목록");
  expect(r.answer?.from).toBe("bill");
});

test("★정상★ 질문에 MCP 표시가 붙는다 — 새 칸이 아니라 meta 안에", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "질문", client: "claude-code" }, nowait);
  const meta = bus.calls[0]!.meta as Record<string, unknown>;
  expect(meta.reply_route).toBe("mcp"); // 동작을 정하는 값
  expect(meta.mcp_client).toBe("claude-code"); // 기록용
  // 표는 늘리지 않는다 — 기존 message 행에 그대로 실린다
  const row = db.prepare(`SELECT meta_json FROM message WHERE id='q1'`).get() as { meta_json: string };
  expect(JSON.parse(row.meta_json).reply_route).toBe("mcp");
});

test("★정상★ 클라이언트를 안 알려줘도 동작한다 — mcp_client 는 없어도 된다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "질문" }, nowait);
  const meta = bus.calls[0]!.meta as Record<string, unknown>;
  expect(meta.reply_route).toBe("mcp");
  expect(meta.mcp_client).toBeUndefined();
});

test("★정상★ 이어서 물으면 같은 방에 쌓인다 — 팀원이 앞 얘기를 본다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "첫 질문" }, nowait);
  await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "이어서 질문" }, nowait);
  const rows = db.prepare(`SELECT body FROM message WHERE thread_id='mcp-gd-bill' ORDER BY id`).all() as Array<{ body: string }>;
  expect(rows.map((r) => r.body)).toEqual(["첫 질문", "이어서 질문"]);
});

test("★정상★ 두 사람에게 물으면 방이 갈린다 — 섞일 수가 없다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "빌에게" }, nowait);
  await askTeammate(db, bus.deps, { from: "gd", to: "codex", body: "코덱스에게" }, nowait);
  const threads = (db.prepare(`SELECT DISTINCT thread_id FROM message ORDER BY thread_id`).all() as Array<{ thread_id: string }>)
    .map((r) => r.thread_id);
  expect(threads).toEqual(["mcp-gd-bill", "mcp-gd-codex"]);
});

// ── 늦는 경우 ──

test("★정상★ 답이 늦으면 번호와 함께 접수로 끝난다 — 요청은 살아 있다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  const r = await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "PR 전체 리뷰" }, nowait);
  expect(r.status).toBe("pending");
  expect(r.requestId).toBe("q1");
  // ★질문 행은 지워지지 않는다★ — 시간 초과는 기다림만 끝낸다
  expect(db.prepare(`SELECT COUNT(*) n FROM message WHERE id='q1'`).get()).toEqual({ n: 1 });
});

test("★정상★ 접수로 끝난 뒤 늦게 온 답을 번호로 회수한다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  const r = await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "PR 전체 리뷰" }, nowait);
  expect(r.status).toBe("pending");
  reply(db, { id: "a1", room: "mcp-gd-bill", from: "bill", body: "결론부터 — 3번 파일이…", inReplyTo: r.requestId });
  const got = fetchAnswer(db, r.requestId, "gd");
  expect(got.found).toBe(true);
  if (got.found) expect(got.answer.body).toContain("3번 파일");
});

// ── ★사고 재현★ — 이게 이 설계의 존재 이유다 ──

test("★A 의 늦은 답이 C 자리에 뜨지 않는다★ — 1절 시나리오 그대로", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  // 10:00 A 질문 → 못 받고 끝남
  const a = await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "A 질문" }, nowait);
  expect(a.status).toBe("pending");
  // 10:11 A 의 답이 그제야 도착
  reply(db, { id: "aA", room: "mcp-gd-bill", from: "bill", body: "A 의 답", inReplyTo: a.requestId });
  // 10:10 C 질문 → 기다리는 중. ★A 의 답이 방에 있어도 C 는 그걸 집으면 안 된다★
  const c = await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "C 질문" }, nowait);
  expect(c.status).toBe("pending");
  expect(c.requestId).not.toBe(a.requestId);
  // A 의 답은 A 자리에만 있다
  expect(findAnswer(db, "mcp-gd-bill", a.requestId, "bill")?.body).toBe("A 의 답");
  expect(findAnswer(db, "mcp-gd-bill", c.requestId, "bill")).toBeNull();
});

test("★번호 없는 답은 대기 중인 질문에 붙지 않는다★ — 따로 보여준다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  const r = await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "질문" }, nowait);
  // 빌이 번호를 안 달고 방에 한 마디 했다 (평범한 발언일 수도 있다)
  reply(db, { id: "u1", room: "mcp-gd-bill", from: "bill", body: "잠깐만요" });
  expect(findAnswer(db, "mcp-gd-bill", r.requestId, "bill")).toBeNull(); // 답으로 안 친다
  const got = fetchAnswer(db, r.requestId, "gd");
  expect(got.found).toBe(false);
  if (!got.found) expect(got.unlabeled.map((u) => u.body)).toEqual(["잠깐만요"]); // 버리지도 않는다
});

test("★대조군★ — 같은 상황에서 번호를 달면 바로 답으로 잡힌다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  const r = await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "질문" }, nowait);
  reply(db, { id: "l1", room: "mcp-gd-bill", from: "bill", body: "잠깐만요", inReplyTo: r.requestId });
  expect(findAnswer(db, "mcp-gd-bill", r.requestId, "bill")?.body).toBe("잠깐만요");
});

test("다른 사람이 그 번호에 답해도 답으로 치지 않는다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  const r = await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "질문" }, nowait);
  reply(db, { id: "x1", room: "mcp-gd-bill", from: "codex", body: "제가 대신 답합니다", inReplyTo: r.requestId });
  expect(findAnswer(db, "mcp-gd-bill", r.requestId, "bill")).toBeNull();
});

test("다른 방의 같은 번호를 집어오지 않는다", () => {
  const db = freshDb();
  reply(db, { id: "z1", room: "mcp-gd-codex", from: "bill", body: "다른 방 답", inReplyTo: "q1" });
  expect(findAnswer(db, "mcp-gd-bill", "q1", "bill")).toBeNull();
});

// ── 회수·실패 ──

test("없는 번호로 회수하면 조용히 실패한다 — 아무거나 집어오지 않는다", () => {
  const db = freshDb();
  const got = fetchAnswer(db, "없는번호", "gd");
  expect(got.found).toBe(false);
  if (!got.found) expect(got.roomId).toBeNull();
});

test("버스가 접수를 거부하면 예외로 드러난다 — 조용히 성공처럼 굴지 않는다", async () => {
  const db = freshDb();
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ ok: false, error: "blocked" }), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  await expect(
    postQuestion({ baseUrl: "http://x", fetchImpl }, { from: "user", source: "user", actor: "gd", to: "bill", body: "질문", roomId: "mcp-gd-bill" }),
  ).rejects.toThrow(/접수 실패/);
});

// ── 늦은 답 밀어주기 판정 ──

test("★정상★ 접수로 끝난 뒤 온 답은 민다 — 어느 질문의 답인지 같이 보여준다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  const r = await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "PR 전체 리뷰해줘" }, nowait);
  reply(db, { id: "a1", room: "mcp-gd-bill", from: "bill", body: "결론부터 — 3번 파일이…", inReplyTo: r.requestId });
  const push = lateAnswerPush(db, { id: "a1", from_agent_id: "bill", in_reply_to: r.requestId, body: "결론부터 — 3번 파일이…" });
  expect(push).not.toBeNull();
  if (!push || "skipped" in push) throw new Error("밀어야 하는데 안 민다");
  expect(push.lead).toBe("gd");
  expect(push.text).toContain("PR 전체 리뷰해줘"); // 원 질문
  expect(push.text).toContain("3번 파일"); // 답 본문
});

test("★기다리는 호출이 있으면 밀지 않는다★ — 같은 답이 두 번 가면 안 된다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  let duringWait: ReturnType<typeof lateAnswerPush> = null;
  await askTeammate(
    db,
    bus.deps,
    { from: "gd", to: "bill", body: "질문" },
    {
      waitMs: 200,
      pollMs: 5,
      sleep: async () => {
        // 아직 기다리는 중에 답이 도착한 상황
        if (duringWait === null) {
          reply(db, { id: "a1", room: "mcp-gd-bill", from: "bill", body: "답", inReplyTo: "q1" });
          duringWait = lateAnswerPush(db, { id: "a1", from_agent_id: "bill", in_reply_to: "q1", body: "답" });
        }
      },
    },
  );
  expect(duringWait).toBeNull(); // 그 호출이 화면에 띄운다 — 밀지 않는다
  // ★대조군★ — 기다림이 끝난 지금은 같은 답을 민다
  expect(lateAnswerPush(db, { id: "a1", from_agent_id: "bill", in_reply_to: "q1", body: "답" })).not.toBeNull();
});

test("MCP 질문이 아니면 밀지 않는다 — 평범한 팀 대화까지 팀장님께 가면 안 된다", () => {
  const db = freshDb();
  reply(db, { id: "n1", room: "mcp-gd-bill", from: "gd", body: "일반 질문" }); // meta 없음
  reply(db, { id: "n2", room: "mcp-gd-bill", from: "bill", body: "일반 답", inReplyTo: "n1" });
  expect(lateAnswerPush(db, { id: "n2", from_agent_id: "bill", in_reply_to: "n1", body: "일반 답" })).toBeNull();
});

test("번호가 없으면 밀지 않는다", () => {
  const db = freshDb();
  expect(lateAnswerPush(db, { id: "x", from_agent_id: "bill", in_reply_to: null, body: "아무말" })).toBeNull();
});

test("물어본 상대가 아닌 사람이 답하면 밀지 않는다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  const r = await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "질문" }, nowait);
  reply(db, { id: "c1", room: "mcp-gd-bill", from: "codex", body: "제가 대신", inReplyTo: r.requestId });
  expect(lateAnswerPush(db, { id: "c1", from_agent_id: "codex", in_reply_to: r.requestId, body: "제가 대신" })).toBeNull();
});

// ── 권한 ──

test("★묻기는 쓰기, 회수는 읽기★ — read 신원도 접수해 둔 답은 받을 수 있다", () => {
  const db = freshDb();
  const names = (scope: "read" | "write") =>
    new Set(Object.keys((buildMcpServer(db, "demis", scope) as unknown as { _registeredTools: Record<string, unknown> })._registeredTools ?? {}));
  const read = names("read");
  const write = names("write");
  expect(write.has("b3os_ask_teammate")).toBe(true);
  expect(read.has("b3os_ask_teammate")).toBe(false); // 질문을 남기는 건 쓰기다
  expect(read.has("b3os_fetch_answer")).toBe(true); // 회수는 읽기다
  expect(write.has("b3os_fetch_answer")).toBe(true);
});

test("한 호출의 대기 상한은 Cloudflare 한계(125초) 아래다", () => {
  expect(ASK_WAIT_MAX_SEC).toBeLessThan(125);
  expect(ASK_WAIT_DEFAULT_SEC).toBeLessThanOrEqual(ASK_WAIT_MAX_SEC);
});

test("번호 없는 발언 조회는 질문 이전 발언을 끌고 오지 않는다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  reply(db, { id: "old", room: "mcp-gd-bill", from: "bill", body: "옛날 발언" });
  await Bun.sleep(1100); // created_at 이 초 단위라 실제로 시각을 벌린다
  const r = await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "질문" }, nowait);
  reply(db, { id: "new", room: "mcp-gd-bill", from: "bill", body: "새 발언" });
  const list = findUnlabeled(db, "mcp-gd-bill", "bill", r.requestId);
  expect(list.map((u) => u.body)).toEqual(["새 발언"]);
});

test("★남의 번호로는 회수되지 않는다★ — 번호를 안다고 남의 대화가 열리면 안 된다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  const r = await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "질문" }, nowait);
  reply(db, { id: "a1", room: "mcp-gd-bill", from: "bill", body: "답", inReplyTo: r.requestId });
  const other = fetchAnswer(db, r.requestId, "hermes"); // 이 질문을 한 사람이 아니다
  expect(other.found).toBe(false);
  if (!other.found) expect(other.denied).toBe(true);
});

test("★대조군★ — 질문한 본인은 같은 번호로 받는다(위 시험이 전부 막는 게 아님)", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  const r = await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "질문" }, nowait);
  reply(db, { id: "a1", room: "mcp-gd-bill", from: "bill", body: "답", inReplyTo: r.requestId });
  const mine = fetchAnswer(db, r.requestId, "gd");
  expect(mine.found).toBe(true);
});

test("회수는 신원 없는 연결에 열려 있지 않다 — 도구가 신원을 먼저 막는다", () => {
  const db = freshDb();
  const tools = (buildMcpServer(db, null, "read") as unknown as { _registeredTools: Record<string, unknown> })._registeredTools ?? {};
  expect(Object.keys(tools)).toContain("b3os_fetch_answer"); // 등록은 된다(신원 검사는 호출 시점)
});

test("★신원 없는 연결은 회수 자체가 거부된다★ — 도구를 직접 불러 확인", async () => {
  const db = freshDb();
  const tools = (buildMcpServer(db, null, "read") as unknown as {
    _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ isError?: boolean; structuredContent?: { error?: string } }> }>;
  })._registeredTools;
  const res = await tools.b3os_fetch_answer!.handler({ request_id: "q1" }, {});
  expect(res.isError).toBe(true);
  expect(res.structuredContent?.error).toBe("identity_required");
});

test("★대조군★ — 신원이 있으면 그 거부가 아니라 조회로 간다", async () => {
  const db = freshDb();
  const tools = (buildMcpServer(db, "gd", "read") as unknown as {
    _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ structuredContent?: { error?: string } }> }>;
  })._registeredTools;
  const res = await tools.b3os_fetch_answer!.handler({ request_id: "q1" }, {});
  expect(res.structuredContent?.error).toBe("unknown_request"); // 신원 거부가 아니다
});

// ── 늦은 답을 ★누구에게★ 미는가 (리뷰 P1 2회차) ──

test("★리드가 아닌 사람이 물은 질문의 늦은 답은 팀 리드에게 안 간다★", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  // hermes 가 MCP 로 bill 에게 물었다 (리드가 아니다)
  const r = await askTeammate(db, bus.deps, { from: "hermes", to: "bill", body: "질문" }, nowait);
  reply(db, { id: "a1", room: r.roomId, from: "bill", body: "답", inReplyTo: r.requestId });
  const late = lateAnswerPush(db, { id: "a1", from_agent_id: "bill", in_reply_to: r.requestId, body: "답" });
  expect(late).not.toBeNull();
  expect(late && "skipped" in late).toBe(true); // 밀지 않는다 — 대신 기록으로 남긴다
  if (late && "skipped" in late) expect(late.asker).toBe("hermes");
});

test("★대조군★ — 리드가 물은 질문의 늦은 답은 민다(위 시험이 전부 막는 게 아님)", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  const r = await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "질문" }, nowait);
  reply(db, { id: "a1", room: r.roomId, from: "bill", body: "답", inReplyTo: r.requestId });
  const late = lateAnswerPush(db, { id: "a1", from_agent_id: "bill", in_reply_to: r.requestId, body: "답" });
  expect(late && "skipped" in late).toBe(false);
  if (late && !("skipped" in late)) expect(late.lead).toBe("gd");
});

// ── ★라이브 회귀★ — 리드는 agent 표에 없다 (2026-08-06 실사고) ──

test("★리드의 질문은 버스에 user 로 나간다★ — gd 로 나가면 입구가 거부한다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  const r = await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "질문" }, nowait);
  expect(r.status).toBe("pending"); // 접수 자체가 됐다 = 거부 안 당했다
  expect(bus.calls[0]!.from_agent_id).toBe("user");
  expect(bus.calls[0]!.source).toBe("user");
  // ★그래도 방은 리드의 방이고 신원은 gd 로 남는다★
  expect(r.roomId).toBe("mcp-gd-bill");
  expect((bus.calls[0]!.meta as Record<string, unknown>).mcp_actor).toBe("gd");
});

test("★대조군★ — 등록 안 된 신원으로 보내면 가짜 버스도 진짜처럼 거부한다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  await expect(
    postQuestion(bus.deps, { from: "ghost", source: "agent", actor: "ghost", to: "bill", body: "질문", roomId: "mcp-x-bill" }),
  ).rejects.toThrow(/unknown_from_agent/);
});

test("팀원이 물으면 자기 id 로 나간다 — 리드만 user 다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  await askTeammate(db, bus.deps, { from: "demis", to: "bill", body: "질문" }, nowait);
  expect(bus.calls[0]!.from_agent_id).toBe("demis");
  expect(bus.calls[0]!.source).toBe("agent");
});

test("★리드 본인은 자기 질문의 답을 회수할 수 있다★ — user 로 나갔어도 신원은 gd", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  const r = await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "질문" }, nowait);
  reply(db, { id: "a1", room: r.roomId, from: "bill", body: "답", inReplyTo: r.requestId });
  expect(fetchAnswer(db, r.requestId, "gd").found).toBe(true);
  // ★대조군★ — 남은 여전히 못 본다
  expect(fetchAnswer(db, r.requestId, "hermes").found).toBe(false);
});

test("★리드의 늦은 답은 그대로 밀린다★ — user 로 나갔다고 non_lead 로 오판하지 않는다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  const r = await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "질문" }, nowait);
  reply(db, { id: "a1", room: r.roomId, from: "bill", body: "답", inReplyTo: r.requestId });
  const late = lateAnswerPush(db, { id: "a1", from_agent_id: "bill", in_reply_to: r.requestId, body: "답" });
  expect(late && "skipped" in late).toBe(false);
  if (late && !("skipped" in late)) expect(late.lead).toBe("gd");
});

test("★뮤턴트 확인★ — 번역을 빼고 gd 로 그냥 보내면 가짜 버스가 빨간불을 낸다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  // busIdentityFor 를 안 거친 상태를 그대로 재현한다(= 라이브에서 죽었던 그 호출).
  await expect(
    postQuestion(bus.deps, { from: "gd", source: "user", actor: "gd", to: "bill", body: "질문", roomId: "mcp-gd-bill" }),
  ).rejects.toThrow(/unknown_from_agent/);
  // ★대조군★ — 번역을 거치면 통과한다
  const ok = await postQuestion(bus.deps, {
    from: busIdentityFor(db, "gd"), source: "user", actor: "gd", to: "bill", body: "질문", roomId: "mcp-gd-bill",
  });
  expect(ok.id).toBeTruthy();
});

test("소유권 판정이 meta 를 읽지 않는다 — 위조한 mcp_actor 로 남의 답을 못 본다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  const r = await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "질문" }, nowait);
  reply(db, { id: "a1", room: r.roomId, from: "bill", body: "답", inReplyTo: r.requestId });
  // hermes 가 그 질문 행의 meta 를 'hermes' 로 바꿔치기해도(= 위조 상황)
  db.prepare(`UPDATE message SET meta_json = ? WHERE id = ?`)
    .run(JSON.stringify({ reply_route: "mcp", mcp_actor: "hermes" }), r.requestId);
  expect(fetchAnswer(db, r.requestId, "hermes").found).toBe(false); // meta 를 믿었다면 열렸다
  expect(fetchAnswer(db, r.requestId, "gd").found).toBe(true); // 실제 발신자 기준이라 본인은 그대로
});

// ── ★깨우기 회귀★ (2026-08-07 라이브 사고) ──
//
// #279 로 리드를 'user' 로 바꾼 뒤, 질문은 DB 에 들어가는데 ★아무도 안 깨웠다.★
// source='user' 는 dispatch 표시가 없으면 수신자 행이 ★'completed' 로 박혀★ 디스패처가
// 영영 안 집는다(messages.ts:152). ★메시지는 멀쩡히 있고 팀원만 모른다.★
//
// ★이 시험은 가짜 버스를 쓰지 않는다.★ 가짜는 이 규칙을 안 갖고 있어서 넣어봐야 못 잡는다 —
// 어제 우리를 통과시킨 그 함정이다. ★진짜 insert 경로(acceptInbound)에 그대로 넣어서 잰다.★
import { acceptInbound } from "../db/inboxQueries";

function postThroughRealBus(db: Database, extra: Record<string, unknown>) {
  return acceptInbound(
    db,
    {
      from_agent_id: "user", to_agent_id: "bill", body: "질문 " + JSON.stringify(extra),
      type: "dm", priority: "normal", source: "user", thread_id: "mcp-gd-bill", ...extra,
    } as never,
    { dedupeWindowSec: 0 },
  );
}
const recipientState = (db: Database, messageId: string) =>
  db.prepare(`SELECT delivery_state FROM message_recipient WHERE message_id = ? AND agent_id = 'bill'`)
    .get(messageId) as { delivery_state: string } | undefined;

test("★dispatch 표시가 있으면 배달 대기(pending) 로 들어간다★ — 그래야 팀원을 깨운다", () => {
  const db = freshDb();
  const r = postThroughRealBus(db, { dispatch: true });
  if (!r.ok) throw new Error("접수됐어야 한다");
  expect(recipientState(db, r.stored.id)?.delivery_state).toBe("pending");
});

test("★대조군 — 표시가 없으면 completed 로 박혀 영영 안 깨운다★ (2026-08-07 에 실제로 이랬다)", () => {
  const db = freshDb();
  const r = postThroughRealBus(db, {});
  if (!r.ok) throw new Error("접수됐어야 한다");
  expect(recipientState(db, r.stored.id)?.delivery_state).toBe("completed"); // ← 이게 사고였다
});

test("★askTeammate 가 보내는 payload 에 dispatch 가 실린다★", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "질문" }, nowait);
  expect(bus.calls[0]!.dispatch).toBe(true);
  expect(bus.calls[0]!.source).toBe("user"); // 리드는 user 로 나간다(#279) — 그래서 이 표시가 꼭 필요하다
});

// ── ★진행 표시: '몇 초' 가 아니라 '어디까지 왔나'★ (팀 리드 2026-08-07) ──

function setRecipient(db: Database, messageId: string, agent: string, delivery: string, recipient: string) {
  db.prepare(`UPDATE message_recipient SET delivery_state = ?, recipient_state = ? WHERE message_id = ? AND agent_id = ?`)
    .run(delivery, recipient, messageId, agent);
}

test("★단계마다 다른 말을 한다★ — 전달 중 · 안 열어봄 · 작업 중 · 답 쓰는 중", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  const r = await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "질문" }, nowait);
  db.prepare(`INSERT OR IGNORE INTO message_recipient (message_id, agent_id, delivery_state, recipient_state) VALUES (?, 'bill', 'pending', 'open')`)
    .run(r.requestId);

  const label = () => askProgress(db, r.requestId, "bill").label;
  expect(label()).toContain("전달 중");
  setRecipient(db, r.requestId, "bill", "wake_dispatched", "open");
  expect(label()).toContain("아직 열어보지 않았");
  setRecipient(db, r.requestId, "bill", "completed", "in_progress");
  expect(label()).toContain("읽고 작업 중");
  setRecipient(db, r.requestId, "bill", "completed", "acknowledged");
  expect(label()).toContain("답을 쓰는 중");
  // ★네 단계가 서로 다른 말이어야 의미가 있다★ — 같은 말이면 '몇 초' 와 다를 게 없다
});

test("★막힌 것은 막혔다고 말한다★ — 기다려도 안 오는데 초만 세면 안 된다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  const r = await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "질문" }, nowait);
  db.prepare(`INSERT OR IGNORE INTO message_recipient (message_id, agent_id, delivery_state, recipient_state) VALUES (?, 'bill', 'pending', 'open')`)
    .run(r.requestId);
  for (const [state, word] of [["blocked", "막혔"], ["dead_letter", "배달 실패"], ["expired", "만료"]] as const) {
    setRecipient(db, r.requestId, "bill", state, "open");
    const p = askProgress(db, r.requestId, "bill");
    expect(p.label).toContain(word);
    expect(p.stuck).toBe(true); // ★호출부가 이걸 보고 일찍 끝낼 수 있다★
  }
  // ★대조군★ — 정상 진행은 stuck 이 아니다
  setRecipient(db, r.requestId, "bill", "completed", "in_progress");
  expect(askProgress(db, r.requestId, "bill").stuck).toBe(false);
});

test("수신자 행이 아직 없어도 죽지 않는다", () => {
  const db = freshDb();
  expect(askProgress(db, "없는번호", "bill").label).toContain("전달 준비 중");
});

test("★막히면 상한까지 안 기다리고 바로 끝낸다★ — 판정을 계산만 하지 않는다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  let polls = 0;
  const r = await askTeammate(
    db, bus.deps, { from: "gd", to: "bill", body: "질문" },
    {
      waitMs: 60_000, pollMs: 1,
      sleep: async () => {
        polls++;
        // 첫 대기 직후 배달이 막힌 상태로 바꾼다
        db.prepare(`INSERT OR REPLACE INTO message_recipient (message_id, agent_id, delivery_state, recipient_state) VALUES ('q1', 'bill', 'blocked', 'open')`).run();
      },
      now: (() => { let t = 0; return () => (t += 10); })(),
    },
  );
  expect(r.status).toBe("pending");
  expect(r.stuckReason).toContain("막혔");
  expect(polls).toBeLessThan(5); // ★상한(60초)까지 세지 않았다★
});

test("★대조군 — 안 막히면 상한까지 기다린다★", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  let polls = 0;
  const r = await askTeammate(
    db, bus.deps, { from: "gd", to: "bill", body: "질문" },
    { waitMs: 50, pollMs: 1, sleep: async () => { polls++; }, now: (() => { let t = 0; return () => (t += 10); })() },
  );
  expect(r.stuckReason).toBeUndefined();
  expect(polls).toBeGreaterThanOrEqual(4); // 50/10 = 5회쯤 돈다
});

test("★작업 중일 때 '무엇을 하는지' 가 붙는다★", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  const r = await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "질문" }, nowait);
  db.prepare(`INSERT OR REPLACE INTO message_recipient (message_id, agent_id, delivery_state, recipient_state) VALUES (?, 'bill', 'completed', 'in_progress')`).run(r.requestId);
  db.prepare(`INSERT OR REPLACE INTO agent_status (agent_id, state, activity_line) VALUES ('bill', 'running', 'Read(src/server/mcp/mcpAsk.ts)')`).run();
  expect(askProgress(db, r.requestId, "bill").label).toContain("Read(src/server/mcp/mcpAsk.ts)");
});

test("★활동 줄이 없는 팀원(화면 없는 런타임)도 멀쩡히 나온다★", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  const r = await askTeammate(db, bus.deps, { from: "gd", to: "codex", body: "질문" }, nowait);
  db.prepare(`INSERT OR REPLACE INTO message_recipient (message_id, agent_id, delivery_state, recipient_state) VALUES (?, 'codex', 'completed', 'in_progress')`).run(r.requestId);
  const label = askProgress(db, r.requestId, "codex").label;
  expect(label).toContain("읽고 작업 중"); // ★12명 전부 이건 나온다★
  expect(label).not.toContain("·"); // 붙일 게 없으면 안 붙인다
});

test("★막힘에는 활동 줄을 안 붙인다★ — 그건 지금 하는 일이 아니라 결론이다", async () => {
  const db = freshDb();
  const bus = fakeBus(db);
  const r = await askTeammate(db, bus.deps, { from: "gd", to: "bill", body: "질문" }, nowait);
  db.prepare(`INSERT OR REPLACE INTO message_recipient (message_id, agent_id, delivery_state, recipient_state) VALUES (?, 'bill', 'blocked', 'open')`).run(r.requestId);
  db.prepare(`INSERT OR REPLACE INTO agent_status (agent_id, state, activity_line) VALUES ('bill', 'running', 'Read(파일)')`).run();
  const p = askProgress(db, r.requestId, "bill");
  expect(p.stuck).toBe(true);
  expect(p.label).not.toContain("Read(파일)");
});

// ── ★진행 알림이 안 나가는 클라이언트에서도 판정이 보인다★ (실측 2026-08-07) ──
//
// 클로드 코드는 progressToken 을 안 보낸다 → 진행 알림이 ★0건★ 도착한다(팀 리드 확인).
// 규약상 토큰 없이는 서버가 보낼 수 없으므로 ★우리가 고를 수 있는 게 아니다.★
// → 같은 판정을 ★보이는 자리(접수 문구)★ 에도 쓴다.

test("★접수 문구가 실제로 판정을 담는다★ — 진행 알림이 0건이어도 화면에 보이는 줄이다", async () => {
  // ★이 시험이 읽어야 하는 건 '접수 문구' 자체다.★ 앞판은 askProgress 를 직접 불러서
  // ★이 PR 이 바꾼 한 줄을 되돌려도 통과했다★(빌 뮤턴트 실측: 51개 전부 통과).
  // mcpAsk.ts 가 `deps.fetchImpl ?? fetch` 라 ★전역 fetch 를 갈면 핸들러 경로가 그대로 돈다.★
  const db = freshDb();
  const bus = fakeBus(db);
  const realFetch = globalThis.fetch;
  globalThis.fetch = bus.deps.fetchImpl!;
  try {
    const tools = (buildMcpServer(db, "gd", "write") as unknown as {
      _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[] }> }>;
    })._registeredTools;
    // extra 를 {} 로 준다 = ★progressToken 없는 클라이언트★. 그 상태에서 무엇이 보이는지가 이 PR 의 전부다.
    const r = await tools.b3os_ask_teammate!.handler({ to: "bill", question: "q", wait_seconds: 1 }, {});
    const text = r.content[0]!.text;
    expect(text).not.toContain("아직 답하지 않았습니다");
    expect(text).toContain("전달");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("★명부를 DB 에서 읽는다★ — 손으로 박으면 이 시험이 죽는다", () => {
  // 앞판은 not.toContain("nova") 였는데 ★nova 는 원래 없으니 손으로 박아도 통과★ 했다.
  // ★코드에 있을 수 없는 id 를 넣어야★ 생성인지 박은 건지 갈린다.
  const db = freshDb();
  addAgent(db, "zzqa");
  const t = (buildMcpServer(db, "gd", "write") as unknown as {
    _registeredTools: Record<string, { inputSchema?: { shape?: { to?: { description?: string } } } }>;
  })._registeredTools.b3os_ask_teammate;
  expect(t?.inputSchema?.shape?.to?.description ?? "").toContain("zzqa");
});
