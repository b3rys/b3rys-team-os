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
    if (String(url).endsWith("/DESIGN.md")) return new Response("# Design\n\nNo diagrams here.\n");
    return new Response("# Sample\n\nUseful app.\n\n<script>alert(1)</script>\n\n- [~] working\n- [x] done\n## 📌 킵\n- [ ] held\n## next\n- [ ] plan\n\n```mermaid\ngraph TD\nA-->B\n```");
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
    expect(item.excludeSections).toEqual(["킵"]);
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
    expect(doc.current.excludeSections).toEqual(["킵"]);
  });
  test("registry excludeSections drives both the list and the TODO document", async () => {
    const dir = mkdtempSync(join(tmpdir(), "projects-routes-")); const db = new Database(":memory:");
    db.exec("CREATE TABLE task (id TEXT, title TEXT, lane TEXT, updated_at TEXT)");
    cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    const source = new GitHubDocs({ cacheDir: dir, useToken: false, fetch: (async (url: any) => String(url).includes("/branches/")
      ? Response.json({ commit: { sha: "b".repeat(40) } }) : new Response("# S\n\n## 📌 킵\n- [ ] held\n## 답 대기\n- [ ] waiting\n## next\n- [ ] plan")) as typeof fetch });
    const app = new Hono(); app.route("/team/api", createProjectRoutes({ db, projects: [{ ...p, excludeSections: ["답 대기"] }], source }));
    const item = (await (await app.request("/team/api/projects")).json()).projects[0];
    expect(item.excludeSections).toEqual(["답 대기"]); expect(item.todo.plan).toBe(2);
    const doc = await (await app.request("/team/api/projects/sample/doc/todo")).json();
    expect(doc.current.excludeSections).toEqual(["답 대기"]); expect(doc.current.items.map((x: any) => x.title)).toEqual(["held", "plan"]);
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
    expect(response.status).toBe(502); expect(await response.json()).toEqual({ error: "github_auth_or_not_found", key: "branch" });
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

describe("새창 페이지 /doc/:key/page", () => {
  test("html 모드: 독립 HTML(문서 전환 바 + 본문), 스크립트 없음·CSP 있음·현재 문서 칩 on", async () => {
    const { app } = setup();
    const res = await app.request("http://localhost/team/api/projects/sample/doc/readme/page");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/html");
    expect(res.headers.get("x-project-sha")).toBe("a".repeat(40));
    // 이 픽스처엔 mermaid 펜스가 있다 → 스크립트는 우리 서버('self') + 요청마다 새 nonce 인라인 하나만
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toMatch(/^default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; script-src 'self' 'nonce-[A-Za-z0-9_-]{22}'; frame-ancestors 'none'$/);
    const nonce = csp.match(/'nonce-([A-Za-z0-9_-]{22})'/)![1]!;
    const html = await res.text();
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; script-src 'self' 'nonce-${nonce}'">`);
    expect(html).toContain(`<script nonce="${nonce}" src="/team/api/projects/vendor/mermaid.min.js"></script>`);
    expect(html).toContain(`<script nonce="${nonce}">(function(){var figs=Array.prototype.filter.call(document.querySelectorAll("figure.project-diagram")`);
    expect(html.match(/<script/g)).toHaveLength(2);
    expect(html).toContain('<figure class="project-diagram">');
    const res2 = await app.request("http://localhost/team/api/projects/sample/doc/readme/page");
    expect(res2.headers.get("content-security-policy")).not.toBe(csp); // nonce 는 요청마다 다르다
    // mermaid 펜스가 없는 html 문서(DESIGN 픽스처)는 예전 그대로 — script-src 없음·<script> 0
    const res3 = await app.request("http://localhost/team/api/projects/sample/doc/design/page");
    expect(res3.headers.get("content-security-policy")).toBe("default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const html3 = await res3.text();
    expect(html3).not.toContain("<script");
    expect(html3).toContain("No diagrams here.");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("prefers-color-scheme: light"); // 대시보드처럼 시스템 라이트/다크를 따른다
    expect(html).toContain('class="chip on"');                       // 현재 문서(README) 칩
    expect(html).toContain('href="/team/api/projects/sample/doc/design/page"');   // 같은 창에서 다른 문서로
    expect(html).toContain('href="/team/api/projects/sample/doc/readme/page?mode=md"'); // MD 링크
    expect(html).toContain('<article class="projects-prose">');
    expect(html).toContain("Useful app.");
  });
  test("mermaid 번들 경로: 우리 서버가 node_modules 의 파일을 JS 로 준다", async () => {
    const { app } = setup();
    const res = await app.request("http://localhost/team/api/projects/vendor/mermaid.min.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("application/javascript");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400"); // 문서용 no-store 미들웨어가 덮지 않는다
    const head = (await res.text()).slice(0, 4000);
    expect(head).toContain("mermaid");
  });
  test("md 모드: 원문을 이스케이프한 <pre> — 마크다운의 < 가 태그가 되지 않는다 · 스크립트 없음", async () => {
    const { app } = setup();
    const res = await app.request("http://localhost/team/api/projects/sample/doc/readme/page?mode=md");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const html = await res.text();
    expect(html).not.toContain("<script");
    expect(html).toContain('<pre class="projects-raw">');
    expect(html).toContain("```mermaid");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;"); // 원문의 태그는 글자로만
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<article");
    expect(html).toContain('class="mode on" href="/team/api/projects/sample/doc/readme/page?mode=md"');
  });
  test("모르는 프로젝트·문서는 404", async () => {
    const { app } = setup();
    expect((await app.request("http://localhost/team/api/projects/nope/doc/readme/page")).status).toBe(404);
    expect((await app.request("http://localhost/team/api/projects/sample/doc/secret/page")).status).toBe(404);
  });
});
