import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RENDERER_VERSION, renderProjectDoc, type RenderedProjectDoc } from "./projectDocRender";

export const DOC_KEYS = ["readme", "design", "features", "todo"] as const;
export type DocKey = typeof DOC_KEYS[number];
export interface ProjectRegistration {
  id: string; name: string; repo: string; branch: string;
  docs: Record<DocKey, string>; kanbanPrefix: string;
}
export interface ProjectDocument extends RenderedProjectDoc { md: string; path: string }
export interface ProjectSnapshot {
  sha: string; fetchedAt: string; stale: boolean;
  docs: Record<DocKey, ProjectDocument | null>;
}
export class ProjectSourceError extends Error {
  constructor(public key: string, public reason = "github_unavailable") { super(reason); }
}
export function validateProjects(input: unknown): ProjectRegistration[] {
  if (!Array.isArray(input)) throw new Error("invalid_project_registry");
  const seen = new Set<string>();
  for (const p of input) {
    if (!p || typeof p.id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(p.id) || seen.has(p.id) || typeof p.name !== "string" ||
      !/^[\w.-]+\/[\w.-]+$/.test(p.repo) || typeof p.branch !== "string" || !p.branch ||
      typeof p.kanbanPrefix !== "string" || !p.kanbanPrefix || !p.docs ||
      DOC_KEYS.some(key => typeof p.docs[key] !== "string" || !p.docs[key] || p.docs[key].startsWith("/") ||
        /[\\\u0000-\u001f?#]/.test(p.docs[key]) || p.docs[key].split("/").some((x: string) => x === ".." || x === "."))) {
      throw new Error("invalid_project_registry");
    }
    seen.add(p.id);
  }
  return input;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const pathEncode = (s: string) => s.split("/").map(encodeURIComponent).join("/");

export class GitHubDocs {
  private snapshots = new Map<string, ProjectSnapshot>();
  private checked = new Map<string, number>();
  private pending = new Map<string, Promise<ProjectSnapshot>>();
  private fetcher: typeof fetch;
  private now: () => number;
  constructor(private opts: { cacheDir: string; fetch?: typeof fetch; now?: () => number; useToken?: boolean }) {
    this.fetcher = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }
  private registryKey(p: ProjectRegistration) { return hash([p.id, p.repo, p.branch, p.docs, RENDERER_VERSION]); }
  private docKey(p: ProjectRegistration, sha: string, key: DocKey) { return hash([p.repo, sha, p.docs[key], RENDERER_VERSION]); }
  private async readCache(key: string): Promise<any | null> {
    try { return JSON.parse(await readFile(join(this.opts.cacheDir, key + ".json"), "utf8")); } catch { return null; }
  }
  private async writeCache(key: string, value: unknown) {
    await mkdir(this.opts.cacheDir, { recursive: true, mode: 0o700 });
    const destination = join(this.opts.cacheDir, key + ".json");
    const temporary = destination + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, destination);
  }
  private async request(url: string, key: string): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "b3os-projects" };
    // Credentials are read only here and never included in cached data or errors.
    if (this.opts.useToken !== false && process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    try {
      return await this.fetcher(url, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
    } catch { throw new ProjectSourceError(key); }
  }
  async get(p: ProjectRegistration, force = false): Promise<ProjectSnapshot> {
    const registryKey = this.registryKey(p);
    const pending = this.pending.get(registryKey);
    if (pending) return pending;
    const current = this.snapshots.get(registryKey);
    if (!force && current && this.now() - (this.checked.get(registryKey) ?? -Infinity) < 60_000) return current;
    const promise = this.load(p, registryKey);
    this.pending.set(registryKey, promise);
    try { return await promise; } finally { this.pending.delete(registryKey); }
  }
  private async load(p: ProjectRegistration, registryKey: string): Promise<ProjectSnapshot> {
    let previous = this.snapshots.get(registryKey);
    if (!previous) {
      const disk = await this.readCache("snapshot-" + registryKey);
      if (disk && /^[a-f0-9]{40,64}$/i.test(disk.sha) && typeof disk.fetchedAt === "string" &&
        disk.docs && DOC_KEYS.every(k => disk.docs[k] === null || (typeof disk.docs[k]?.md === "string" && typeof disk.docs[k]?.html === "string"))) previous = disk;
    }
    try {
      const branch = await this.request(`https://api.github.com/repos/${p.repo}/branches/${encodeURIComponent(p.branch)}`, "branch");
      if (!branch.ok) throw new ProjectSourceError("branch");
      const payload = await branch.json() as { commit?: { sha?: string } };
      const sha = payload.commit?.sha;
      if (!sha || !/^[a-f0-9]{40,64}$/i.test(sha)) throw new ProjectSourceError("branch", "invalid_github_response");
      const docs = {} as ProjectSnapshot["docs"];
      const results = await Promise.allSettled(DOC_KEYS.map(async key => {
        const cached = await this.readCache(this.docKey(p, sha, key));
        // Rendering uses project-local links, so rebuild from cached source for this registration.
        if (cached && cached.path === p.docs[key] && typeof cached.md === "string") {
          docs[key] = { md: cached.md, path: p.docs[key], ...renderProjectDoc(cached.md, { ...p, sha, path: p.docs[key] }) }; return;
        }
        const response = await this.request(`https://raw.githubusercontent.com/${p.repo}/${sha}/${pathEncode(p.docs[key])}`, key);
        if (response.status === 404 && !previous?.docs[key]) { docs[key] = null; return; }
        if (!response.ok) throw new ProjectSourceError(key);
        const md = await response.text();
        if (md.length > 2_000_000) throw new ProjectSourceError(key, "document_too_large");
        docs[key] = { md, path: p.docs[key], ...renderProjectDoc(md, { ...p, sha, path: p.docs[key] }) };
        await this.writeCache(this.docKey(p, sha, key), docs[key]);
      }));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
      const snapshot: ProjectSnapshot = { sha, fetchedAt: new Date(this.now()).toISOString(), stale: false, docs };
      await this.writeCache("snapshot-" + registryKey, snapshot);
      this.snapshots.set(registryKey, snapshot);
      this.checked.set(registryKey, this.now());
      return snapshot;
    } catch (error) {
      if (!previous) throw error instanceof ProjectSourceError ? error : new ProjectSourceError("project");
      const stale = { ...previous, stale: true };
      this.snapshots.set(registryKey, stale);
      this.checked.set(registryKey, this.now());
      return stale;
    }
  }
}
