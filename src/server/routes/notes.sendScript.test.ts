// steno-send.sh 를 실제로 돌려 본다 — 임시 DB + 임의 포트의 임시 서버. 라이브 서버·team.db 는 건드리지 않는다.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openDb, migrate } from "../db/migrate";
import { createNotesRoutes } from "./notes";

const SCRIPT = resolve(import.meta.dir, "../../../skills/b3os-team-inbox/scripts/steno-send.sh");
let dir: string;
let dbPath: string;
let db: Database;
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "steno-send-")));
  dbPath = join(dir, "team.db");
  db = openDb(dbPath);
  migrate(db);
  db.prepare(
    `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES ('bill', 'Bill', 'dev', 'claude_channel', 'claude_tmux', ?, 'x.md')`,
  ).run(dir);
  const api = new Hono();
  api.route("/", createNotesRoutes({ db, memberIds: () => ["bill"], maxBytes: 64 }));
  const root = new Hono();
  root.route("/team/api", api);
  server = Bun.serve({ port: 0, fetch: root.fetch });
  base = `http://127.0.0.1:${server.port}/team`;
});
afterAll(() => {
  server.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ★비동기로 돌린다★ — spawnSync 는 이벤트 루프를 막아 같은 프로세스의 임시 서버가 응답하지 못한다(교착).
async function run(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(["bash", SCRIPT, ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: dir, TEAM_BASE: base, TEAM_DB_PATH: dbPath, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out.trim(), err };
}
const notes = () => db.prepare(`SELECT from_agent, name, format, content FROM team_note ORDER BY id`).all() as Array<Record<string, string>>;

describe("steno-send.sh", () => {
  test("md 파일을 보내면 id 를 찍고, 보낸 이는 워크스페이스로 정해진다", async () => {
    const f = join(dir, "보고서.md");
    writeFileSync(f, "# 제목\n`코드` 와 $HOME 은 그대로\n");
    const r = await run([f]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^\d+$/);
    const last = notes().at(-1)!;
    expect(last).toEqual({ from_agent: "bill", name: "보고서.md", format: "md", content: "# 제목\n`코드` 와 $HOME 은 그대로\n" });
  });
  test("html + --name", async () => {
    const f = join(dir, "page.htm");
    writeFileSync(f, "<p>x</p>");
    const r = await run([f, "--name", "../../주간 보고"]);
    expect(r.code).toBe(0);
    expect(notes().at(-1)!).toMatchObject({ name: "주간 보고.html", format: "html" });
  });
  test("형식 밖은 보내기 전에 거절", async () => {
    const f = join(dir, "a.txt");
    writeFileSync(f, "x");
    const before = notes().length;
    const r = await run([f]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("md·html 만");
    expect(notes().length).toBe(before);
  });
  test("서버가 크기 초과로 거절하면 1 과 이유", async () => {
    const f = join(dir, "big.md");
    writeFileSync(f, "a".repeat(65));
    const r = await run([f]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("413");
  });
  test("없는 파일·빈 파일은 거절", async () => {
    expect((await run([join(dir, "none.md")])).code).toBe(1);
    const f = join(dir, "empty.md");
    writeFileSync(f, "");
    expect((await run([f])).code).toBe(1);
  });
  test("보낸 이를 못 정하면 보내지 않는다", async () => {
    const f = join(dir, "x.md");
    writeFileSync(f, "x");
    const before = notes().length;
    const r = await run([f], { GD_AGENT_ID: "nobody" });
    expect(r.code).toBe(1);
    expect(notes().length).toBe(before);
  });
});
