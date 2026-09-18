import { Hono, type Context } from "hono";
import { fileURLToPath } from "node:url";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOC_KEYS, GitHubDocs, ProjectSourceError, validateProjects, type ProjectRegistration, type DocKey } from "../lib/githubDocs";
import { projectIntro } from "../lib/projectDocRender";
import { standaloneDocPage } from "../../shared/projectsProse";
import { DEFAULT_EXCLUDE_SECTIONS, parseProjectTodo } from "../lib/projectTodo";
import { leadActorId, trustedActorFromRequest } from "../lib/opAuth";

interface ProjectDeps {
  db: Database;
  root?: string;
  projects?: ProjectRegistration[];
  source?: GitHubDocs;
}
export function createProjectRoutes(deps: ProjectDeps) {
  const root = deps.root ?? process.env.TEAM_COLLAB_ROOT ?? fileURLToPath(new URL("../../../", import.meta.url));
  const projects = validateProjects(deps.projects ?? JSON.parse(readFileSync(join(root, "projects.json"), "utf8")));
  const source = deps.source ?? new GitHubDocs({ cacheDir: join(root, "var/projects-cache") });
  const app = new Hono();
  app.use("*", async (c, next) => { await next(); c.header("Cache-Control", "no-store"); });
  app.onError((err, c) => c.json({ error: err instanceof ProjectSourceError ? err.reason : "projects_unavailable", key: err instanceof ProjectSourceError ? err.key : "project" }, 502));
  const excludeSections = (p: ProjectRegistration) => p.excludeSections ?? [...DEFAULT_EXCLUDE_SECTIONS];
  async function summary(p: ProjectRegistration) {
    const snapshot = await source.get(p);
    const { items: _items, excludeSections: _ex, ...todo } = parseProjectTodo(snapshot.docs.todo?.md ?? "", excludeSections(p));
    const kanban = deps.db.prepare(`SELECT id, title, lane, updated_at AS updatedAt FROM task
      WHERE substr(title, 1, length(?)) = ? AND lane IN ('plan', 'doing') ORDER BY updated_at DESC, id`).all(p.kanbanPrefix, p.kanbanPrefix);
    return {
      id: p.id, name: p.name, repo: p.repo, branch: p.branch, sha: snapshot.sha,
      intro: projectIntro(snapshot.docs.readme?.md ?? ""),
      docs: DOC_KEYS.map(key => ({ key, path: p.docs[key], exists: snapshot.docs[key] !== null })),
      todo, excludeSections: excludeSections(p), kanban, fetchedAt: snapshot.fetchedAt, stale: snapshot.stale,
    };
  }
  app.get("/projects", async c => c.json({ projects: await Promise.all(projects.map(summary)) }));
  app.get("/projects/:id", async c => {
    const p = projects.find(p => p.id === c.req.param("id"));
    return p ? c.json(await summary(p)) : c.json({ error: "project_not_found", key: c.req.param("id") }, 404);
  });
  const document = async (c: Context, raw: boolean) => {
    const p = projects.find(p => p.id === c.req.param("id"));
    const key = c.req.param("key") as DocKey;
    if (!p || !DOC_KEYS.includes(key)) return c.json({ error: "document_not_found", key }, 404);
    const snapshot = await source.get(p);
    const doc = snapshot.docs[key];
    if (!doc) return c.json({ error: "document_not_found", key }, 404);
    if (raw) {
      c.header("Content-Type", "text/markdown; charset=utf-8");
      c.header("X-Project-Sha", snapshot.sha);
      c.header("X-Project-Stale", String(snapshot.stale));
      c.header("X-Content-Type-Options", "nosniff");
      return c.body(doc.md);
    }
    return c.json({ id: p.id, key, sha: snapshot.sha, ...doc, stale: snapshot.stale,
      ...(key === "todo" ? { current: parseProjectTodo(doc.md, excludeSections(p)) } : {}) });
  };
  app.get("/projects/:id/doc/:key", c => document(c, false));
  app.get("/projects/:id/doc/:key/raw", c => document(c, true));
  // 새창 페이지 — 그 창 안에서 같은 프로젝트의 문서를 돌려볼 수 있게 상단 바가 붙은 독립 HTML(팀장 2026-09-18).
  //   ?mode=md 면 원문을 <pre> 로. 스크립트 0 · CSP default-src 'none'. 열람 규칙은 다른 문서 응답과 같다(/team 아래).
  app.get("/projects/:id/doc/:key/page", async c => {
    const p = projects.find(p => p.id === c.req.param("id"));
    const key = c.req.param("key") as DocKey;
    if (!p || !DOC_KEYS.includes(key)) return c.json({ error: "document_not_found", key }, 404);
    const snapshot = await source.get(p);
    const doc = snapshot.docs[key];
    if (!doc) return c.json({ error: "document_not_found", key }, 404);
    const mode = c.req.query("mode") === "md" ? "md" : "html";
    const exists = Object.fromEntries(DOC_KEYS.map(k => [k, snapshot.docs[k] !== null]));
    const basePath = process.env.BASE_PATH ?? "/team";
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Project-Sha", snapshot.sha);
    return c.body(standaloneDocPage({
      projectId: p.id, projectName: p.name, title: doc.title, path: doc.path, sha: snapshot.sha, key, mode,
      html: doc.html, md: doc.md, exists, basePath, githubUrl: `https://github.com/${p.repo}/blob/${snapshot.sha}/${doc.path}`,
    }));
  });
  app.post("/projects/:id/refresh", async c => {
    const actor = trustedActorFromRequest(c.req.raw, { loopbackDashboardActor: leadActorId(deps.db) });
    if (!actor.ok) return c.json({ error: actor.error }, (actor.status ?? 403) as 401 | 403 | 503);
    const p = projects.find(p => p.id === c.req.param("id"));
    if (!p) return c.json({ error: "project_not_found", key: c.req.param("id") }, 404);
    const snapshot = await source.get(p, true);
    return c.json({ sha: snapshot.sha, stale: snapshot.stale });
  });
  return app;
}
