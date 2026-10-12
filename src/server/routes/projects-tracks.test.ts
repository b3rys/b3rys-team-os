import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubDocs, validateProjects, projectSources } from "../lib/githubDocs";
import { createProjectRoutes } from "./projects";

const docs = { readme: "README.md", design: "DESIGN.md", features: "FEATURES.md", todo: "TODO.md" };
const registry = [{ id: "sample", name: "Sample", tokenEnv: "GITHUB_TOKEN_SAMPLE", tracks: [
  { id: "desktop", name: "Desktop", repo: "your-org/sample", docs, kanbanPrefix: "[sample]" },
  { id: "mobile", name: "Mobile", repo: "your-org/sample-mobile", docs, tokenEnv: "GITHUB_TOKEN_MOBILE" },
] }];
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
function setup(failedRepo?: string, status = 401, registrations: unknown = registry) {
  const dir = mkdtempSync(join(tmpdir(), "projects-tracks-"));
  const db = new Database(":memory:");
  db.exec("CREATE TABLE task (id TEXT, title TEXT, lane TEXT, updated_at TEXT)");
  db.exec("INSERT INTO task VALUES ('local', '[sample] Desktop only', 'doing', '2026-10-12 00:00:00')");
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const calls: string[] = [];
  const source = new GitHubDocs({ cacheDir: dir, useToken: false, fetch: (async url => {
    const u = String(url); calls.push(u);
    if (failedRepo && u.includes(failedRepo)) return new Response("private diagnostic", { status });
    const mobile = u.includes("sample-mobile");
    if (u.includes("/branches/")) return Response.json({ commit: { sha: (mobile ? "b" : "a").repeat(40) } });
    return new Response(`# ${mobile ? "Mobile" : "Desktop"}\n\nSample introduction.\n\n[Design](DESIGN.md)\n- [~] ${mobile ? "Mobile task" : "Desktop task"}\n- [ ] Next\n- [x] Shipped`);
  }) as typeof fetch });
  return { app: createProjectRoutes({ db, projects: validateProjects(registrations), source }), calls };
}
describe("Projects tracks", () => {
  test("tracks-only registry resolves defaults and keeps explicit tokens separate", () => {
    const [p] = validateProjects(registry);
    expect(p!.branch).toBe("main");
    expect(p!.tracks).toHaveLength(2);
    for (const tracks of [[], [{ ...registry[0]!.tracks[0], docs: { ...docs, todo: "../TODO.md" } }],
      [{ ...registry[0]!.tracks[0], tokenEnv: "bad-name" }], [registry[0]!.tracks[0], registry[0]!.tracks[0]]]) {
      expect(() => validateProjects([{ ...registry[0], tracks }])).toThrow("invalid_project_registry");
    }
  });
  test("list and detail aggregate counts, while each track keeps docs, SHA, TODO and kanban separate", async () => {
    const { app } = setup();
    const list = await (await app.request("/projects")).json();
    const p = list.projects[0];
    expect(p.todo).toEqual({ doing: 2, plan: 2, done: 2, doingTitles: ["Desktop task", "Mobile task"] });
    expect(p.tracks.map((t: any) => t.name)).toEqual(["Desktop", "Mobile"]);
    expect(p.tracks[0].kanban).toHaveLength(1);
    expect(p.tracks[1].kanban).toEqual([]);
    expect(p.tracks[1].todo.doingTitles).toEqual(["Mobile task"]);
    expect(p.tracks[1].sha).toBe("b".repeat(40));
    expect((await (await app.request("/projects/sample")).json()).todo).toEqual(p.todo);
    expect(JSON.stringify(p)).not.toContain("tokenEnv");
  });
  test("selected track controls JSON, raw, standalone chips and markdown document links", async () => {
    const { app } = setup();
    const doc = await (await app.request("/projects/sample/doc/readme?track=mobile")).json();
    expect(doc.md).toContain("Mobile task");
    expect(doc.html).toContain("track=mobile");
    const raw = await (await app.request("/projects/sample/doc/todo/raw?track=mobile")).text();
    expect(raw).toContain("Mobile task");
    const page = await (await app.request("/projects/sample/doc/readme/page?track=mobile")).text();
    expect(page).toContain("/doc/design/page?track=mobile");
    expect(page).toContain("?mode=md&amp;track=mobile");
    expect(page).toContain("your-org/sample-mobile/blob/");
    expect((await app.request("/projects/sample/doc/todo?track=unknown")).status).toBe(404);
  });
  for (const repo of ["your-org/sample/", "your-org/sample-mobile"]) for (const status of [401, 403, 404]) {
    test(`cold ${status} on ${repo} preserves the healthy track in list and detail`, async () => {
      const { app } = setup(repo, status);
      for (const path of ["/projects", "/projects/sample"]) {
        const response = await app.request(path);
        expect(response.status).toBe(200);
        const body = await response.json(); const p = body.projects?.[0] ?? body;
        expect(p.tracks.filter((t: any) => t.error)).toHaveLength(1);
        expect(p.tracks.filter((t: any) => !t.error)).toHaveLength(1);
        expect(p.todo.doing).toBe(1);
        expect(JSON.stringify(body)).not.toContain("private diagnostic");
      }
    });
  }
});


test("track tokens inherit or override without entering response/cache data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "projects-track-token-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const names = ["GITHUB_TOKEN_SAMPLE", "GITHUB_TOKEN_MOBILE"] as const;
  const previous = names.map(n => process.env[n]);
  cleanup.push(() => names.forEach((n, i) => { if (previous[i] === undefined) delete process.env[n]; else process.env[n] = previous[i]; }));
  process.env.GITHUB_TOKEN_SAMPLE = "test-placeholder-desktop";
  process.env.GITHUB_TOKEN_MOBILE = "test-placeholder-mobile";
  const used: boolean[] = [];
  const source = new GitHubDocs({ cacheDir: dir, fetch: (async (url, init) => {
    const mobile = String(url).includes("sample-mobile");
    used.push(new Headers(init?.headers).get("authorization") === `Bearer ${process.env[mobile ? names[1] : names[0]]}`);
    return String(url).includes("/branches/") ? Response.json({ commit: { sha: "c".repeat(40) } }) : new Response("# Sample");
  }) as typeof fetch });
  const resolved = projectSources(validateProjects(registry)[0]!);
  expect(resolved.map(p => p.tokenEnv)).toEqual([...names]);
  for (const p of resolved) {
    const snapshot = await source.get(p);
    expect(JSON.stringify(snapshot).includes("test-placeholder")).toBe(false);
  }
  expect(used.length).toBe(10);
  expect(used.every(Boolean)).toBe(true);
});

test("first-track failure preserves top-level repository identity without borrowing another track's snapshot", async () => {
  const { app } = setup("your-org/sample/", 401);
  for (const path of ["/projects", "/projects/sample"]) {
    const body = await (await app.request(path)).json();
    const p = body.projects?.[0] ?? body;
    expect(p.repo).toBe("your-org/sample");
    expect(p.branch).toBe("main");
    expect(p.sha).toBe("");
    expect(p.intro).toBe("");
    expect(p.docs.every((d: any) => !d.exists)).toBe(true);
    expect(p.tracks[0].error).toBe("github_auth_or_not_found");
    expect(p.tracks[1].repo).toBe("your-org/sample-mobile");
    expect(p.tracks[1].sha).toBe("b".repeat(40));
    expect(p.todo.doing).toBe(1);
  }
});


test("tracks register only present documents; legacy required docs remain enforced", async () => {
  const sparseDocs = { readme: "README.md", project: "PROJECT.md", todo: "TODO.md" };
  const registrations = [{ ...registry[0], tracks: [registry[0]!.tracks[0], { ...registry[0]!.tracks[1], docs: sparseDocs }] }];
  const { app, calls } = setup(undefined, 401, registrations);
  const p = (await (await app.request("/projects/sample")).json());
  expect(p.tracks[1].docs.map((d: any) => d.key)).toEqual(["readme", "project", "todo"]);
  expect(p.tracks[1].todo.doingTitles).toEqual(["Mobile task"]);
  expect(calls.filter(u => u.includes("sample-mobile") && /\/(DESIGN|FEATURES)\.md$/.test(u))).toEqual([]);
  expect((await app.request("/projects/sample/doc/design?track=mobile")).status).toBe(404);
  const page = await (await app.request("/projects/sample/doc/readme/page?track=mobile")).text();
  expect(page).toContain("/doc/project/page?track=mobile");
  expect(page).not.toContain("/doc/design/page");
  expect(page).not.toContain("/doc/features/page");
  expect(() => validateProjects([{ id: "single", name: "Single", repo: "your-org/single", branch: "main", docs: sparseDocs, kanbanPrefix: "[single]" }])).toThrow("invalid_project_registry");
  expect(() => validateProjects([{ ...registry[0], tracks: [{ ...registry[0]!.tracks[0], docs: {} }] }])).toThrow("invalid_project_registry");
});
