import { Hono, type Context } from "hono";
import { fileURLToPath } from "node:url";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOC_KEYS, GitHubDocs, registeredDocKeys, ProjectSourceError, validateProjects, projectSources, type ProjectRegistration, type DocKey } from "../lib/githubDocs";
import { projectIntro } from "../lib/projectDocRender";
import { standaloneCsp, standaloneDocPage } from "../../shared/projectsProse";
import { DEFAULT_EXCLUDE_SECTIONS, parseProjectTodo } from "../lib/projectTodo";
import { leadActorId, trustedActorFromRequest } from "../lib/opAuth";

interface ProjectDeps {
  db: Database;
  root?: string;
  projects?: ProjectRegistration[];
  source?: GitHubDocs;
}
/** projects.json = 이 설치본의 프로젝트 등록(각 머신 고유, git 추적 안 함 — agents.json 과 같다).
 *  없으면 빈 목록. 깨졌거나 모양이 틀려도 서버를 세우지 않는다 — 로그를 남기고 빈 목록. */
export function loadProjectRegistry(root: string): ProjectRegistration[] {
  const file = join(root, "projects.json");
  if (!existsSync(file)) return [];
  try {
    return validateProjects(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    console.error(`[projects] projects.json 을 읽지 못해 빈 목록으로 둡니다: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
export function createProjectRoutes(deps: ProjectDeps) {
  const root = deps.root ?? process.env.TEAM_COLLAB_ROOT ?? fileURLToPath(new URL("../../../", import.meta.url));
  const projects = deps.projects ? validateProjects(deps.projects) : loadProjectRegistry(root);
  const source = deps.source ?? new GitHubDocs({ cacheDir: join(root, "var/projects-cache") });
  const app = new Hono();
  // 문서 응답은 no-store. mermaid 번들(불변 파일)만 예외 — 새창마다 5MB 를 다시 받지 않게.
  app.use("*", async (c, next) => { await next(); if (!c.req.path.endsWith("/projects/vendor/mermaid.min.js")) c.header("Cache-Control", "no-store"); });
  app.onError((err, c) => c.json({ error: err instanceof ProjectSourceError ? err.reason : "projects_unavailable", key: err instanceof ProjectSourceError ? err.key : "project" }, 502));
  const excludeSections = (p: ProjectRegistration) => p.excludeSections ?? [...DEFAULT_EXCLUDE_SECTIONS];
  async function sourceSummary(p: ProjectRegistration, force = false) {
    const snapshot = await source.get(p, force);
    const { items: _items, excludeSections: _ex, ...todo } = parseProjectTodo(snapshot.docs.todo?.md ?? "", excludeSections(p));
    const kanban = p.kanbanPrefix ? deps.db.prepare(`SELECT id, title, lane, updated_at AS updatedAt FROM task
      WHERE substr(title, 1, length(?)) = ? AND lane IN ('plan', 'doing') ORDER BY updated_at DESC, id`).all(p.kanbanPrefix, p.kanbanPrefix) : [];
    return {
      id: p.id, name: p.name, repo: p.repo, branch: p.branch, sha: snapshot.sha,
      intro: projectIntro(snapshot.docs.readme?.md ?? ""),
      docs: registeredDocKeys(p).map(key => ({ key, path: p.docs[key], exists: snapshot.docs[key] !== null })),
      todo, excludeSections: excludeSections(p), kanban, fetchedAt: snapshot.fetchedAt, stale: snapshot.stale,
    };
  }
  async function summary(p: ProjectRegistration, force = false) {
    if (!p.tracks) return sourceSummary(p, force);
    const sources = projectSources(p);
    const settled = await Promise.allSettled(sources.map(t => sourceSummary(t, force)));
    const tracks = settled.map((r, i) => r.status === "fulfilled"
      ? { ...r.value, id: sources[i]!.trackId! }
      : { id: sources[i]!.trackId!, name: sources[i]!.name, repo: sources[i]!.repo,
          error: r.reason instanceof ProjectSourceError ? r.reason.reason : "projects_unavailable",
          key: r.reason instanceof ProjectSourceError ? r.reason.key : "project" });
    const ok = tracks.filter((t): t is Extract<typeof t, { todo: unknown }> => "todo" in t);
    if (!ok.length) throw (settled[0] as PromiseRejectedResult).reason;
    return { ...ok[0]!, id: p.id, name: p.name, tracks,
      todo: { doing: ok.reduce((n, t) => n + t.todo.doing, 0), plan: ok.reduce((n, t) => n + t.todo.plan, 0),
        done: ok.reduce((n, t) => n + t.todo.done, 0), doingTitles: ok.flatMap(t => t.todo.doingTitles) },
      kanban: [], fetchedAt: ok.map(t => t.fetchedAt).sort().at(-1)!, stale: ok.some(t => t.stale),
    };
  }
  function requestedSource(c: Context): ProjectRegistration | undefined {
    const p = projects.find(p => p.id === c.req.param("id"));
    if (!p) return undefined;
    const track = c.req.query("track");
    if (!p.tracks) return track === undefined ? p : undefined;
    const sources = projectSources(p);
    return track === undefined ? sources[0] : sources.find(t => t.trackId === track);
  }
  // 프로젝트마다 따로 읽는다 — 한 프로젝트의 토큰·저장소 문제(캐시도 없을 때)가 목록 전체를 502 로 만들지 않게(#511).
  //   일부만 실패: 200 + 성공한 것만 projects, 실패한 것은 failed[{id,error,key}] (토큰·응답 본문은 담지 않는다).
  //   전부 실패: 예전처럼 첫 오류를 던져 502 {error,key} — 화면은 빈 목록 대신 오류+다시 시도.
  app.get("/projects", async c => {
    const settled = await Promise.allSettled(projects.map(p => summary(p)));
    const ok = settled.flatMap(r => r.status === "fulfilled" ? [r.value] : []);
    const failed = settled.flatMap((r, i) => r.status === "rejected" ? [{ id: projects[i]!.id,
      error: r.reason instanceof ProjectSourceError ? r.reason.reason : "projects_unavailable",
      key: r.reason instanceof ProjectSourceError ? r.reason.key : "project" }] : []);
    if (!ok.length && settled.length) throw (settled[0] as PromiseRejectedResult).reason;
    return c.json(failed.length ? { projects: ok, failed } : { projects: ok });
  });
  app.get("/projects/:id", async c => {
    const p = projects.find(p => p.id === c.req.param("id"));
    return p ? c.json(await summary(p)) : c.json({ error: "project_not_found", key: c.req.param("id") }, 404);
  });
  const document = async (c: Context, raw: boolean) => {
    const p = requestedSource(c);
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
  // mermaid 브라우저 번들 — 새창 페이지가 CSP script-src 'self' 로 이 경로만 허용한다. 파일은 node_modules 의 것을 그대로.
  const MERMAID_PATH = (() => { try { return fileURLToPath(import.meta.resolve("mermaid/dist/mermaid.min.js")); } catch { return null; } })();
  app.get("/projects/vendor/mermaid.min.js", c => {
    if (!MERMAID_PATH) return c.json({ error: "vendor_missing" }, 404);
    return new Response(Bun.file(MERMAID_PATH), { headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    } });
  });
  app.get("/projects/:id/doc/:key/page", async c => {
    const p = requestedSource(c);
    const key = c.req.param("key") as DocKey;
    if (!p || !DOC_KEYS.includes(key)) return c.json({ error: "document_not_found", key }, 404);
    const snapshot = await source.get(p);
    const doc = snapshot.docs[key];
    if (!doc) return c.json({ error: "document_not_found", key }, 404);
    const mode = c.req.query("mode") === "md" ? "md" : "html";
    const exists = Object.fromEntries(registeredDocKeys(p).map(k => [k, snapshot.docs[k] !== null]));
    const basePath = process.env.BASE_PATH ?? "/team";
    const mermaidNonce = mode === "html" && doc.needs.includes("mermaid-svg") && MERMAID_PATH
      ? Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url") // 128비트, 요청마다 새로
      : null;
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", `${standaloneCsp(mermaidNonce)}; frame-ancestors 'none'`);
    c.header("X-Project-Sha", snapshot.sha);
    return c.body(standaloneDocPage({
      projectId: p.id, trackId: p.trackId, projectName: p.name, title: doc.title, path: doc.path, sha: snapshot.sha, key, mode,
      html: doc.html, md: doc.md, exists, basePath, githubUrl: `https://github.com/${p.repo}/blob/${snapshot.sha}/${doc.path}`,
      mermaidNonce,
    }));
  });
  app.post("/projects/:id/refresh", async c => {
    const actor = trustedActorFromRequest(c.req.raw, { loopbackDashboardActor: leadActorId(deps.db) });
    if (!actor.ok) return c.json({ error: actor.error }, (actor.status ?? 403) as 401 | 403 | 503);
    const p = projects.find(p => p.id === c.req.param("id"));
    if (!p) return c.json({ error: "project_not_found", key: c.req.param("id") }, 404);
    const result = await summary(p, true);
    return c.json({ sha: result.sha, stale: result.stale, ...("tracks" in result ? { tracks: result.tracks } : {}) });
  });
  return app;
}
