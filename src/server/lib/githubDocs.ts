import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RENDERER_VERSION, renderProjectDoc, type RenderedProjectDoc } from "./projectDocRender";

/** 화면에 보이는 순서. */
export const DOC_KEYS = ["readme", "project", "design", "features", "todo"] as const;
export type DocKey = typeof DOC_KEYS[number];
/** 등록하지 않아도 되는 문서. 빠지면 GitHub 에 묻지 않고 '없음' 으로 둔다(버튼도 안 보인다). */
export const OPTIONAL_DOC_KEYS: readonly DocKey[] = ["project"];
export const isOptionalDocKey = (key: DocKey) => OPTIONAL_DOC_KEYS.includes(key);
/** 이 프로젝트에 등록된 문서 키(순서 유지). */
export const registeredDocKeys = (p: ProjectRegistration) => DOC_KEYS.filter(k => p.docs[k] !== undefined);
type RequiredDocKey = Exclude<DocKey, "project">;
export interface ProjectTrack {
  id?: string; name: string; repo: string; branch?: string;
  docs: ProjectRegistration["docs"]; tokenEnv?: string;
  kanbanPrefix?: string; excludeSections?: string[];
}
export interface ProjectRegistration {
  tracks?: ProjectTrack[];
  /** Resolved source identity, used in links and cache separation. */
  trackId?: string;
  id: string; name: string; repo: string; branch: string;
  docs: Record<RequiredDocKey, string> & Partial<Record<"project", string>>; kanbanPrefix: string;
  /** TODO.md headings containing any of these hide their `[ ]` items from plan (default: ["킵"]). */
  excludeSections?: string[];
  /** Name of the env var holding this project's read-only GitHub token (default: GITHUB_TOKEN). The value never lives in the registry. */
  tokenEnv?: string;
}
export interface ProjectDocument extends RenderedProjectDoc { md: string; path: string }
export interface ProjectSnapshot {
  sha: string; fetchedAt: string; stale: boolean;
  docs: Record<DocKey, ProjectDocument | null>;
}
export class ProjectSourceError extends Error {
  constructor(public key: string, public reason = "github_unavailable") { super(reason); }
}
/** 401/403/404 mean the token or the repo/branch is wrong; anything else (5xx, network) is transient. */
export const sourceFailureReason = (status: number) =>
  status === 401 || status === 403 || status === 404 ? "github_auth_or_not_found" : "github_unavailable";
const validId = (value: unknown) => typeof value === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(value);
function validSource(p: any): boolean {
  return typeof p.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(p.repo) &&
    typeof p.branch === "string" && !!p.branch &&
    (p.kanbanPrefix === undefined || (typeof p.kanbanPrefix === "string" && !!p.kanbanPrefix)) && !!p.docs &&
    (p.excludeSections === undefined || (Array.isArray(p.excludeSections) && p.excludeSections.every((x: unknown) => typeof x === "string" && !!x))) &&
    (p.tokenEnv === undefined || (typeof p.tokenEnv === "string" && /^[A-Z][A-Z0-9_]*$/.test(p.tokenEnv))) &&
    DOC_KEYS.every(key => p.docs[key] === undefined && isOptionalDocKey(key) ||
      typeof p.docs[key] === "string" && !!p.docs[key] && !p.docs[key].startsWith("/") &&
      !/[\\\u0000-\u001f?#]/.test(p.docs[key]) && !p.docs[key].split("/").some((x: string) => x === ".." || x === "."));
}
/** Resolve tracks independently; kanban is opt-in per track to avoid cross-repository tasks. */
export function projectSources(p: ProjectRegistration): ProjectRegistration[] {
  if (!p.tracks) return [p];
  return p.tracks.map((t, i) => ({
    id: p.id, name: t.name, repo: t.repo, branch: t.branch ?? p.branch ?? "main", docs: t.docs,
    tokenEnv: t.tokenEnv ?? p.tokenEnv, excludeSections: t.excludeSections ?? p.excludeSections,
    kanbanPrefix: t.kanbanPrefix ?? "", trackId: t.id ?? String(i),
  }));
}
export function validateProjects(input: unknown): ProjectRegistration[] {
  if (!Array.isArray(input)) throw new Error("invalid_project_registry");
  const seen = new Set<string>();
  return input.map(p => {
    if (!p || !validId(p.id) || seen.has(p.id) || typeof p.name !== "string" || !p.name.trim()) throw new Error("invalid_project_registry");
    seen.add(p.id);
    if (p.tracks !== undefined) {
      if (!Array.isArray(p.tracks) || !p.tracks.length) throw new Error("invalid_project_registry");
      const ids = new Set<string>();
      for (const [i, t] of p.tracks.entries()) {
        const id = t?.id ?? String(i);
        if (!t || !validId(id) || ids.has(id) || typeof t.name !== "string" || !t.name.trim() ||
          !validSource({ ...t, branch: t.branch ?? p.branch ?? "main", tokenEnv: t.tokenEnv ?? p.tokenEnv, excludeSections: t.excludeSections ?? p.excludeSections })) throw new Error("invalid_project_registry");
        ids.add(id);
      }
      const first = p.tracks[0];
      return { ...p, repo: p.repo ?? first.repo, docs: p.docs ?? first.docs, branch: p.branch ?? "main", kanbanPrefix: p.kanbanPrefix ?? "" };
    }
    if (!validSource(p) || !p.kanbanPrefix) throw new Error("invalid_project_registry");
    return p;
  });
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
  private registryKey(p: ProjectRegistration) { return hash([p.id, p.repo, p.branch, p.docs, p.trackId, p.tokenEnv, RENDERER_VERSION]); }
  private docKey(p: ProjectRegistration, sha: string, key: DocKey) { return hash([p.repo, sha, p.docs[key], RENDERER_VERSION]); }
  /** 등록되지 않은 선택 문서는 캐시에 키가 없어도 된다 — 없으면 null 로 채운다(예전 캐시 호환). */
  private normalizeDocs(docs: Record<string, unknown>) {
    for (const k of OPTIONAL_DOC_KEYS) if (docs[k] === undefined) docs[k] = null;
    return docs;
  }
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
  private async request(url: string, key: string, tokenEnv = "GITHUB_TOKEN"): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "b3os-projects" };
    // Credentials are read only here and never included in cached data or errors. Which env var holds the
    // token is per project (`tokenEnv`), so one .env can carry GITHUB_TOKEN_SAMPLE, GITHUB_TOKEN_OTHER, …
    const token = this.opts.useToken !== false ? process.env[tokenEnv] : undefined;
    if (token) headers.Authorization = `Bearer ${token}`;
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
        disk.docs && DOC_KEYS.every(k => disk.docs[k] === null || (disk.docs[k] === undefined && isOptionalDocKey(k)) ||
          (typeof disk.docs[k]?.md === "string" && typeof disk.docs[k]?.html === "string"))) {
        this.normalizeDocs(disk.docs);
        previous = disk;
      }
    }
    try {
      const branch = await this.request(`https://api.github.com/repos/${p.repo}/branches/${encodeURIComponent(p.branch)}`, "branch", p.tokenEnv);
      if (!branch.ok) throw new ProjectSourceError("branch", sourceFailureReason(branch.status));
      const payload = await branch.json() as { commit?: { sha?: string } };
      const sha = payload.commit?.sha;
      if (!sha || !/^[a-f0-9]{40,64}$/i.test(sha)) throw new ProjectSourceError("branch", "invalid_github_response");
      const docs = {} as ProjectSnapshot["docs"];
      const results = await Promise.allSettled(DOC_KEYS.map(async key => {
        const path = p.docs[key];
        if (path === undefined) { docs[key] = null; return; }
        const cached = await this.readCache(this.docKey(p, sha, key));
        // Rendering uses project-local links, so rebuild from cached source for this registration.
        if (cached && cached.path === path && typeof cached.md === "string") {
          docs[key] = { md: cached.md, path, ...renderProjectDoc(cached.md, { ...p, sha, path }) }; return;
        }
        const response = await this.request(`https://raw.githubusercontent.com/${p.repo}/${sha}/${pathEncode(path)}`, key, p.tokenEnv);
        if (response.status === 404 && !previous?.docs[key]) { docs[key] = null; return; }
        if (!response.ok) throw new ProjectSourceError(key);
        const md = await response.text();
        if (md.length > 2_000_000) throw new ProjectSourceError(key, "document_too_large");
        docs[key] = { md, path, ...renderProjectDoc(md, { ...p, sha, path }) };
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
