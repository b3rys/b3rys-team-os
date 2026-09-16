import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createProjectRoutes } from "./projects";
import { GitHubDocs, type ProjectRegistration } from "../lib/githubDocs";
import { createHostGate } from "../lib/hostGate";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const p: ProjectRegistration = { id: "sample", name: "Sample", repo: "example/sample", branch: "main", docs: { readme: "README.md", design: "DESIGN.md", features: "FEATURES.md", todo: "TODO.md" }, kanbanPrefix: "[sample]" };
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "projects-routes-"));
  const db = new Database(":memory:");
  db.exec("CREATE TABLE task (id TEXT, title TEXT, lane TEXT, updated_at TEXT)");
  for (const [id, title, lane] of [["one", "[sample] active", "doing"], ["two", "[sample] next", "plan"], ["three", "[sample] shipped", "done"], ["four", "other [sample]", "doing"]]) db.prepare("INSERT INTO task VALUES (?,?,?,?)").run(id!, title!, lane!, "2026-09-16 00:00:00");
  let fail = false;
  const source = new GitHubDocs({ cacheDir: dir, useToken: false, fetch: (async (url: any) => {
    if (fail) return new Response("upstream details", { status: 401 });
    if (String(url).includes("/branches/")) return Response.json({ commit: { sha: "a".repeat(40) } });
    return new Response("# Sample\n\nUseful app.\n\n- [~] working\n- [x] done\n## 📌 킵\n- [ ] held\n## next\n- [ ] plan\n\n```mermaid\ngraph TD\nA-->B\n```");
  }) as typeof fetch });
  const app = new Hono();
  app.route("/team/api", createProjectRoutes({ db, projects: [p], source }));
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { app, source, db, fail: () => { fail = true; } };
}
describe("Projects API", () => {
  test("list carries document existence, TODO counts and literal-prefix active kanban only", async () => {
    const { app } = setup();
    const res = await app.request("http://localhost/team/api/projects");
    expect(res.status).toBe(200); expect(res.headers.get("cache-control")).toBe("no-store");
    const { projects } = await res.json(); const item = projects[0];
    expect(item.todo).toEqual({ doing: 1, plan: 1, done: 1, doingTitles: ["working"] });
    expect(item.kanban.map((t: any) => t.id)).toEqual(["one", "two"]);
    expect(item.docs).toHaveLength(4); expect(item.docs.every((d: any) => d.exists)).toBe(true);
    expect(item.intro).toBe("Useful app.");
  });
  test("document/raw use same source; TODO adds parsed current items", async () => {
    const { app } = setup();
    const doc = await (await app.request("/team/api/projects/sample/doc/todo")).json();
    const raw = await app.request("/team/api/projects/sample/doc/todo/raw");
    expect(await raw.text()).toBe(doc.md);
    expect(raw.headers.get("x-project-sha")).toBe(doc.sha);
    expect(raw.headers.get("content-type")).toStartWith("text/markdown");
    expect(doc.needs).toEqual(["mermaid-svg"]);
    expect(doc.current.items.map((x: any) => x.title)).toEqual(["working", "done", "plan"]);
  });
  test("unknown project/key and path traversal do not fetch arbitrary paths", async () => {
    const { app } = setup();
    for (const url of ["/projects/unknown", "/projects/sample/doc/secret", "/projects/sample/doc/%2e%2e%2fsecret"]) expect((await app.request("/team/api" + url)).status).toBe(404);
  });
  test("refresh requires a trusted actor", async () => {
    const { app } = setup();
    expect((await app.request("https://untrusted.invalid/team/api/projects/sample/refresh", { method: "POST" })).status).toBe(403);
    const result = await app.request("http://localhost/team/api/projects/sample/refresh", { method: "POST" });
    expect(result.status).toBe(200); expect((await result.json()).sha).toBe("a".repeat(40));
  });
  test("upstream failure preserves list; cold failure is 502 not empty success", async () => {
    const warm = setup(); await warm.source.get(p); warm.fail(); await warm.source.get(p, true);
    const result = await (await warm.app.request("/team/api/projects")).json();
    expect(result.projects).toHaveLength(1); expect(result.projects[0].stale).toBe(true);
    const cold = setup(); cold.fail(); const response = await cold.app.request("/team/api/projects");
    expect(response.status).toBe(502); expect(await response.json()).toEqual({ error: "github_unavailable", key: "branch" });
  });
  test("registered routes remain behind the existing root host gate", async () => {
    const { app } = setup();
    const root = new Hono(); root.use("*", createHostGate({ isTrusted: () => false })); root.route("/", app);
    expect((await root.request("http://untrusted.invalid/team/api/projects")).status).toBe(403);
    const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(src.indexOf('rootApp.use("*", createHostGate')).toBeLessThan(src.indexOf('rootApp.get("/projects"'));
    expect(src).toContain('api.route("/", createProjectRoutes({ db }))');
  });
});
