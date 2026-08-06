// MCP → 팀원에게 묻기. ★정상 경우를 먼저 재고★, 그 다음 사고 시나리오를 재현한다.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import {
  roomIdFor,
  findAnswer,
  findUnlabeled,
  askTeammate,
  fetchAnswer,
  postQuestion,
  lateAnswerPush,
  THREAD_ID_MAX,
} from "./mcpAsk";
import { buildMcpServer, ASK_WAIT_MAX_SEC, ASK_WAIT_DEFAULT_SEC } from "./b3osMcpServer";

function freshDb(): Database {
  const d = new Database(":memory:");
  migrate(d);
  return d;
}

/** message.thread_id 는 thread(id) 를 참조한다 — 실제 경로에서는 acceptInbound 의 ensureThread 가 만든다. */
function ensureRoom(db: Database, roomId: string, openedBy: string) {
  db.prepare(
    `INSERT OR IGNORE INTO thread (id, title, kind, participants_json, opened_by, last_message_at)
     VALUES (?, ?, 'dm', '[]', ?, datetime('now'))`,
  ).run(roomId, roomId, openedBy);
}

/** 버스 입구 흉내 — 실제 POST /api/inbox 와 같은 응답 모양으로 message 행을 넣는다. */
function fakeBus(db: Database) {
  let n = 0;
  const calls: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const p = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push(p);
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
    postQuestion({ baseUrl: "http://x", fetchImpl }, { from: "gd", to: "bill", body: "질문", roomId: "mcp-gd-bill" }),
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
  expect(push!.lead).toBe("gd");
  expect(push!.text).toContain("PR 전체 리뷰해줘"); // 원 질문
  expect(push!.text).toContain("3번 파일"); // 답 본문
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
