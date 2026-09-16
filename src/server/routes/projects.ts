import { Hono, type Context } from "hono";
import { fileURLToPath } from "node:url";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOC_KEYS, GitHubDocs, ProjectSourceError, validateProjects, type ProjectRegistration, type DocKey } from "../lib/githubDocs";
import { projectIntro } from "../lib/projectDocRender";
import { parseProjectTodo } from "../lib/projectTodo";
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
  async function summary(p: ProjectRegistration) {
    const snapshot = await source.get(p);
    const { items: _items, ...todo } = parseProjectTodo(snapshot.docs.todo?.md ?? "");
    const kanban = deps.db.prepare(`SELECT id, title, lane, updated_at AS updatedAt FROM task
      WHERE substr(title, 1, length(?)) = ? AND lane IN ('plan', 'doing') ORDER BY updated_at DESC, id`).all(p.kanbanPrefix, p.kanbanPrefix);
    return {
      id: p.id, name: p.name, repo: p.repo, branch: p.branch, sha: snapshot.sha,
      intro: projectIntro(snapshot.docs.readme?.md ?? ""),
      docs: DOC_KEYS.map(key => ({ key, path: p.docs[key], exists: snapshot.docs[key] !== null })),
      todo, kanban, fetchedAt: snapshot.fetchedAt, stale: snapshot.stale,
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
      ...(key === "todo" ? { current: parseProjectTodo(doc.md) } : {}) });
  };
  app.get("/projects/:id/doc/:key", c => document(c, false));
  app.get("/projects/:id/doc/:key/raw", c => document(c, true));
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
