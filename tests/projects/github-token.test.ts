/**
 * 수용 기준 §6-8 — GITHUB_TOKEN 이 요청 헤더로는 나가되, 오류·응답·캐시 파일 어디에도 안 남는다.
 * "안 나온다" 만 재면 토큰을 아예 안 읽는 코드도 통과하므로, 먼저 헤더에 실제로 실렸는지 잰다.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { GitHubDocs, type ProjectRegistration } from "../../src/server/lib/githubDocs";
import { createProjectRoutes } from "../../src/server/routes/projects";

const TOKEN = "dummy-test-token-ghp_0123456789";
const project: ProjectRegistration = { id: "sample", name: "Sample", repo: "example/sample", branch: "main", docs: { readme: "README.md", design: "DESIGN.md", features: "FEATURES.md", todo: "TODO.md" }, kanbanPrefix: "[sample]" };
const previous = process.env.GITHUB_TOKEN;
const cleanups: (() => void)[] = [];
afterEach(() => {
  if (previous === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previous;
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function setup(mode: "ok" | "fail") {
  const cacheDir = mkdtempSync(join(tmpdir(), "projects-token-")); cleanups.push(() => rmSync(cacheDir, { recursive: true, force: true }));
  const headers: string[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    headers.push(String((init?.headers as Record<string, string>)?.Authorization ?? ""));
    if (mode === "fail") return new Response("bad credentials for " + String(url), { status: 401 });
    if (String(url).includes("/branches/")) return Response.json({ commit: { sha: "c".repeat(40) } });
    return new Response("# Sample\n\nIntro\n\n- [ ] plan");
  }) as typeof fetch;
  return { cacheDir, headers, source: new GitHubDocs({ cacheDir, fetch: fetcher }) };
}
describe("GitHub 토큰 — 헤더에만 실리고 어디에도 안 남는다", () => {
  test("GITHUB_TOKEN 이 있으면 모든 GitHub 요청에 Bearer 로 실린다", async () => {
    process.env.GITHUB_TOKEN = TOKEN;
    const s = setup("ok");
    await s.source.get(project);
    expect(s.headers).toHaveLength(5);
    expect(s.headers.every(h => h === `Bearer ${TOKEN}`)).toBe(true);
  });
  test("tokenEnv 가 있으면 그 이름의 env 를 쓰고 GITHUB_TOKEN 은 안 본다", async () => {
    process.env.GITHUB_TOKEN = "wrong-" + TOKEN;
    process.env.GITHUB_TOKEN_STENO = TOKEN;
    try {
      const s = setup("ok");
      await s.source.get({ ...project, tokenEnv: "GITHUB_TOKEN_STENO" });
      expect(s.headers).toHaveLength(5);
      expect(s.headers.every(h => h === `Bearer ${TOKEN}`)).toBe(true);
    } finally { delete process.env.GITHUB_TOKEN_STENO; }
  });
  test("tokenEnv 이름의 env 가 비어 있으면 무인증으로 간다 (다른 프로젝트 토큰을 빌리지 않는다)", async () => {
    process.env.GITHUB_TOKEN = TOKEN;
    const s = setup("ok");
    await s.source.get({ ...project, tokenEnv: "GITHUB_TOKEN_MISSING" });
    expect(s.headers.every(h => h === "")).toBe(true);
  });
  test("캐시 파일에 토큰이 없다", async () => {
    process.env.GITHUB_TOKEN = TOKEN;
    const s = setup("ok");
    await s.source.get(project);
    const files = readdirSync(s.cacheDir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(join(s.cacheDir, f), "utf8")).not.toContain(TOKEN);
  });
  test("401 실패 → 502 응답 본문·오류 객체에 토큰도 원격 진단문도 없다", async () => {
    process.env.GITHUB_TOKEN = TOKEN;
    const s = setup("fail");
    const db = new Database(":memory:"); cleanups.push(() => db.close());
    db.exec("CREATE TABLE task (id TEXT, title TEXT, lane TEXT, updated_at TEXT)");
    const app = new Hono(); app.route("/team/api", createProjectRoutes({ db, projects: [project], source: s.source }));
    const res = await app.request("http://localhost/team/api/projects");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: "github_auth_or_not_found", key: "branch" }));
    expect(text).not.toContain(TOKEN); expect(text).not.toContain("bad credentials");
    expect(s.headers[0]).toBe(`Bearer ${TOKEN}`);
    let thrown: unknown;
    try { await s.source.get(project, true); } catch (e) { thrown = e; }
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))).not.toContain(TOKEN);
  });
  test("useToken=false 이면 토큰이 있어도 안 보낸다", async () => {
    process.env.GITHUB_TOKEN = TOKEN;
    const s = setup("ok");
    const source = new GitHubDocs({ cacheDir: s.cacheDir, fetch: (async (url: any, init: any) => { s.headers.push(String(init?.headers?.Authorization ?? "")); return String(url).includes("/branches/") ? Response.json({ commit: { sha: "c".repeat(40) } }) : new Response("# x"); }) as typeof fetch, useToken: false });
    await source.get(project);
    expect(s.headers.every(h => h === "")).toBe(true);
  });
});
