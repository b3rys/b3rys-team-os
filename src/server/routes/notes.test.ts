import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openDb, migrate } from "../db/migrate";
import { apiCfGate, type ApiCfGateConfig } from "../lib/apiCfGate";
import { CF_JWT_HEADER } from "../mcp/mcpAuth";
import { createNotesRoutes, notesMaxBytes, safeNoteName, DEFAULT_MAX_BYTES } from "./notes";

let db: Database;
let app: Hono;
const MEMBERS = ["bill", "steve"];

const post = (body: unknown) =>
  app.request("/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = async (qs = "") => {
  const r = await app.request(`/notes${qs}`);
  return { status: r.status, body: (await r.json()) as { notes: Array<Record<string, unknown>>; error?: string } };
};

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  app = createNotesRoutes({ db, memberIds: () => MEMBERS, maxBytes: 100 });
});

describe("POST /notes", () => {
  test("받으면 201 + 오르는 정수 id", async () => {
    const a = await post({ from_agent_id: "bill", name: "report.md", format: "md", content: "# hi" });
    const b = await post({ from_agent_id: "steve", format: "html", content: "<p>x</p>" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const ida = ((await a.json()) as { id: number }).id;
    const idb = ((await b.json()) as { id: number }).id;
    expect(Number.isInteger(ida)).toBe(true);
    expect(idb).toBeGreaterThan(ida);
  });
  const bad: Array<[string, Record<string, unknown>, number, string]> = [
    ["모르는 보낸 이", { from_agent_id: "nobody", format: "md", content: "x" }, 400, "unknown_from_agent_id"],
    ["보낸 이 없음", { format: "md", content: "x" }, 400, "unknown_from_agent_id"],
    ["형식 밖(txt)", { from_agent_id: "bill", format: "txt", content: "x" }, 400, "format_must_be_md_or_html"],
    ["빈 content", { from_agent_id: "bill", format: "md", content: "" }, 400, "content_required"],
    ["content 가 문자열이 아님", { from_agent_id: "bill", format: "md", content: 3 }, 400, "content_required"],
    ["크기 초과(바이트 기준)", { from_agent_id: "bill", format: "md", content: "가".repeat(34) }, 413, "content_too_large"],
  ];
  for (const [label, body, status, error] of bad) {
    test(`거절: ${label}`, async () => {
      const r = await post(body);
      expect(r.status).toBe(status);
      expect(((await r.json()) as { error: string }).error).toBe(error);
      expect((await get()).body.notes.length).toBe(0);
    });
  }
  test("상한 딱 맞는 크기는 받는다", async () => {
    expect((await post({ from_agent_id: "bill", format: "md", content: "a".repeat(100) })).status).toBe(201);
  });
  test("JSON 이 아니면 400", async () => {
    const r = await app.request("/notes", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(r.status).toBe(400);
  });
});

describe("GET /notes", () => {
  test("{notes:[…]} 오래된 순 · 계약 필드", async () => {
    await post({ from_agent_id: "bill", name: "a", format: "md", content: "A" });
    await post({ from_agent_id: "steve", format: "html", content: "B" });
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.notes.map((n) => n.content)).toEqual(["A", "B"]);
    expect(Object.keys(body.notes[0]!).sort()).toEqual(["content", "created_at", "format", "from_agent_id", "id", "name"]);
    expect(body.notes[0]!.from_agent_id).toBe("bill");
    expect(body.notes[0]!.name).toBe("a.md");
    expect(body.notes[1]!.name).toBeNull();
  });
  test("after 로 이어 받는다", async () => {
    for (const c of ["1", "2", "3"]) await post({ from_agent_id: "bill", format: "md", content: c });
    const first = (await get()).body.notes;
    const rest = (await get(`?after=${first[0]!.id}`)).body.notes;
    expect(rest.map((n) => n.content)).toEqual(["2", "3"]);
    expect((await get(`?after=${first[2]!.id}`)).body.notes).toEqual([]);
  });
  test("limit 기본·최대 50", async () => {
    for (let i = 0; i < 55; i++) await post({ from_agent_id: "bill", format: "md", content: String(i) });
    expect((await get()).body.notes.length).toBe(50);
    expect((await get("?limit=500")).body.notes.length).toBe(50);
    expect((await get("?limit=3")).body.notes.length).toBe(3);
  });
  test("after·limit 가 정수가 아니면 400", async () => {
    expect((await get("?after=abc")).status).toBe(400);
    expect((await get("?after=-1")).status).toBe(400);
    expect((await get("?limit=1.5")).status).toBe(400);
  });
  test("덮어쓰기·삭제 경로가 없다", async () => {
    await post({ from_agent_id: "bill", format: "md", content: "x" });
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const r = await app.request("/notes", { method });
      expect(r.status).toBe(404);
    }
    expect((await get()).body.notes.length).toBe(1);
  });
});

describe("safeNoteName — 받는 쪽 파일 이름으로 안전하게", () => {
  const table: Array<[unknown, "md" | "html", string | null]> = [
    ["report.md", "md", "report.md"],
    ["report", "md", "report.md"],
    ["page.html", "html", "page.html"],
    ["notes.md", "html", "notes.md.html"],
    ["../../etc/passwd", "md", "passwd.md"],
    ["a\\b\\c.md", "md", "c.md"],
    ["..", "md", null],
    [".hidden.md", "md", "hidden.md"],
    ["a:b*c?.md", "md", "a_b_c_.md"],
    ["line\nbreak.md", "md", "line_break.md"],
    ["", "md", null],
    [42, "md", null],
    [undefined, "md", null],
  ];
  for (const [raw, fmt, want] of table) {
    test(`${JSON.stringify(raw)} → ${want}`, () => expect(safeNoteName(raw, fmt)).toBe(want));
  }
  test("길이 상한 120 · 확장자 유지", () => {
    const n = safeNoteName("x".repeat(300), "md")!;
    expect(n.length).toBe(120);
    expect(n.endsWith(".md")).toBe(true);
  });
});

describe("크기 상한 설정값", () => {
  test("기본 1 MB, env 로 바꾼다, 잘못된 값은 기본", () => {
    expect(notesMaxBytes({})).toBe(DEFAULT_MAX_BYTES);
    expect(notesMaxBytes({ B3OS_NOTES_MAX_BYTES: "2048" })).toBe(2048);
    expect(notesMaxBytes({ B3OS_NOTES_MAX_BYTES: "abc" })).toBe(DEFAULT_MAX_BYTES);
    expect(notesMaxBytes({ B3OS_NOTES_MAX_BYTES: "0" })).toBe(DEFAULT_MAX_BYTES);
  });
});

describe("원격은 CF Access 관문을 지난다", () => {
  const cfg: ApiCfGateConfig = {
    teamDomain: "team.cloudflareaccess.com",
    audiences: ["aud-team"],
    principals: new Map([["steno1.access", { agentId: "gd", scope: "write" as const }]]),
  };
  const fakeVerify = async (token: string, _d: string, audience: string | string[]) => {
    const p = JSON.parse(token) as Record<string, unknown>;
    return (Array.isArray(audience) ? audience : [audience]).includes(String(p.aud)) ? p : null;
  };
  const gated = () => {
    const api = new Hono();
    api.use("*", apiCfGate({ config: () => cfg, verify: fakeVerify }));
    api.route("/", createNotesRoutes({ db, memberIds: () => MEMBERS }));
    return api;
  };
  test("증명서 없는 원격 GET 은 401 — 내용이 나가지 않는다", async () => {
    await post({ from_agent_id: "bill", format: "md", content: "secret" });
    const r = await gated().request("http://127.0.0.1:7878/notes", { headers: { host: "dev.b3rys.com", "cf-ray": "x" } });
    expect(r.status).toBe(401);
    expect(await r.text()).not.toContain("secret");
  });
  test("증명서 있는 원격 GET 은 200", async () => {
    await post({ from_agent_id: "bill", format: "md", content: "hello" });
    const jwt = JSON.stringify({ aud: "aud-team", common_name: "steno1.access" });
    const r = await gated().request("http://127.0.0.1:7878/notes", {
      headers: { host: "dev.b3rys.com", "cf-ray": "x", [CF_JWT_HEADER]: jwt },
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { notes: unknown[] }).notes.length).toBe(1);
  });
  test("로컬 POST 는 증명서 없이 받는다(팀원 스크립트 경로)", async () => {
    const r = await gated().request("http://127.0.0.1:7878/notes", {
      method: "POST",
      headers: { host: "127.0.0.1:7878", "content-type": "application/json" },
      body: JSON.stringify({ from_agent_id: "bill", format: "md", content: "x" }),
    });
    expect(r.status).toBe(201);
  });
});
