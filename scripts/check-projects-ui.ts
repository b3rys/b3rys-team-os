/** Isolated Projects UI/API preview. No live registry, database, credentials or upstream reads. */
import { createServer } from "vite";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GitHubDocs, validateProjects } from "../src/server/lib/githubDocs";
import { createProjectRoutes } from "../src/server/routes/projects";
const root = resolve(import.meta.dir, "..");
const cache = mkdtempSync(join(tmpdir(), "projects-preview-"));
const db = new Database(":memory:");
db.exec("CREATE TABLE task (id TEXT, title TEXT, lane TEXT, updated_at TEXT)");
const docs = { readme: "README.md", design: "DESIGN.md", features: "FEATURES.md", todo: "TODO.md" };
const tracks = [
  { id: "desktop", name: "Desktop · Server", repo: "your-org/sample", docs },
  { id: "mobile", name: "Mobile", repo: "your-org/sample-mobile", docs },
];
const projects = validateProjects([
  { id: "sample", name: "Sample workspace", tracks },
  { id: "single", name: "Single repository", repo: "your-org/single", branch: "main", docs, kanbanPrefix: "[single]" },
  { id: "partial", name: "Partial availability", tracks: [tracks[0], { ...tracks[1], repo: "your-org/unavailable" }] },
]);
const source = new GitHubDocs({ cacheDir: cache, useToken: false, fetch: (async input => {
  const url = String(input);
  if (url.includes("your-org/unavailable")) return new Response("", { status: 401 });
  const mobile = url.includes("sample-mobile");
  if (url.includes("/branches/")) return Response.json({ commit: { sha: (mobile ? "b" : "a").repeat(40) } });
  return new Response(`# Sample ${mobile ? "Mobile" : "Desktop"}\n\nShared workspace for planning, documents and current tasks.\n\n## Current work\n- [~] ${mobile ? "Build the mobile task view" : "Connect the server activity feed"}\n- [~] ${mobile ? "Review touch navigation" : "Validate document previews"}\n- [ ] Next milestone\n- [ ] Accessibility checks\n- [x] Initial setup\n\n## Documents\n[Design](DESIGN.md)\n`);
}) as typeof fetch });
const app = new Hono(); app.route("/team/api", createProjectRoutes({ db, projects, source }));
const api = Bun.serve({ hostname: "127.0.0.1", port: 18913, fetch: app.fetch });
const vite = await createServer({ configFile: false, root: join(root, "src/web"), base: "/team/", server: {
  host: "127.0.0.1", port: 18912, strictPort: true, proxy: { "/team/api": "http://127.0.0.1:18913" },
} });
await vite.listen();
console.log("Projects isolated preview: http://127.0.0.1:18912/team/?view=projects");
async function close() { await vite.close(); api.stop(); db.close(); rmSync(cache, { recursive: true, force: true }); process.exit(0); }
process.on("SIGINT", close); process.on("SIGTERM", close);
