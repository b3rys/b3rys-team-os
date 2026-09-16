import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOC_KEYS, GitHubDocs, ProjectSourceError, validateProjects, type ProjectRegistration } from "./githubDocs";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
export const project: ProjectRegistration = { id: "sample", name: "Sample", repo: "example/sample", branch: "main", docs: { readme: "README.md", design: "DESIGN.md", features: "FEATURES.md", todo: "TODO.md" }, kanbanPrefix: "[sample]" };
function setup() {
  const cacheDir = mkdtempSync(join(tmpdir(), "projects-source-")); dirs.push(cacheDir);
  let now = 0, sha = "a".repeat(40), failure = 0, missing = "";
  const calls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    const u = String(url); calls.push(u);
    if (failure) return new Response("remote diagnostic must not leak", { status: failure });
    if (u.includes("/branches/")) return Response.json({ commit: { sha } });
    if (u.endsWith(missing) && missing) return new Response("", { status: 404 });
    return new Response("# Source\n\nIntro\n\n- [~] current");
  }) as typeof fetch;
  return { cacheDir, calls, fetcher, now: () => now,
    advance: (ms: number) => { now += ms; }, sha: (value: string) => { sha = value; }, fail: (status = 401) => { failure = status; }, missing: (value: string) => { missing = value; },
    source: new GitHubDocs({ cacheDir, fetch: fetcher, now: () => now, useToken: false }) };
}
describe("GitHub project snapshots", () => {
  test("pins four documents to one SHA and revalidates after 60 seconds", async () => {
    const s = setup();
    const first = await s.source.get(project);
    expect(s.calls).toHaveLength(5);
    expect(s.calls.slice(1).every(u => u.includes(first.sha))).toBe(true);
    s.sha("b".repeat(40)); s.advance(59_999);
    expect((await s.source.get(project)).sha).toBe(first.sha);
    expect(s.calls).toHaveLength(5);
    s.advance(1);
    expect((await s.source.get(project)).sha).toBe("b".repeat(40));
    expect(s.calls).toHaveLength(10);
  });
  test("coalesces concurrent reads, reuses immutable source cache", async () => {
    const s = setup();
    await Promise.all([s.source.get(project), s.source.get(project), s.source.get(project)]);
    expect(s.calls).toHaveLength(5);
    await s.source.get(project, true);
    expect(s.calls).toHaveLength(6);
  });
  test("retains entire previous snapshot on failed SHA/doc updates", async () => {
    const s = setup(); const first = await s.source.get(project);
    s.sha("b".repeat(40)); s.missing("TODO.md"); s.advance(60_000);
    const stale = await s.source.get(project);
    expect(stale.stale).toBe(true);
    expect(stale.sha).toBe(first.sha);
    expect(stale.docs.todo).toEqual(first.docs.todo);
  });
  test("cold 401/403/404 on the branch is typed auth_or_not_found and never includes remote diagnostics", async () => {
    for (const status of [401, 403, 404]) {
      const s = setup(); s.fail(status);
      try { await s.source.get(project); throw new Error("expected failure"); }
      catch (e) {
        expect(e).toBeInstanceOf(ProjectSourceError);
        expect((e as ProjectSourceError).reason).toBe("github_auth_or_not_found"); expect((e as ProjectSourceError).key).toBe("branch");
        expect((e as Error).message).not.toContain("diagnostic");
      }
    }
  });
  test("cold 5xx on the branch is github_unavailable", async () => {
    const s = setup(); s.fail(503);
    try { await s.source.get(project); throw new Error("expected failure"); }
    catch (e) { expect(e).toBeInstanceOf(ProjectSourceError); expect((e as ProjectSourceError).reason).toBe("github_unavailable"); expect((e as ProjectSourceError).key).toBe("branch"); }
  });
  test("restart can recover stale disk snapshot without GitHub", async () => {
    const s = setup(); const first = await s.source.get(project); s.fail();
    const restarted = new GitHubDocs({ cacheDir: s.cacheDir, fetch: s.fetcher, now: s.now, useToken: false });
    expect(await restarted.get(project)).toEqual({ ...first, stale: true });
  });
  test("missing initial documents stay explicitly unavailable", async () => {
    const s = setup(); s.missing("FEATURES.md");
    const result = await s.source.get(project);
    expect(result.docs.features).toBeNull();
    expect(DOC_KEYS.filter(k => result.docs[k])).toHaveLength(3);
  });
  test("network exceptions are sanitized", async () => {
    const s = setup(); const source = new GitHubDocs({ cacheDir: s.cacheDir, useToken: false, fetch: (async () => { throw new Error("sensitive remote diagnostic"); }) as unknown as typeof fetch });
    await expect(source.get(project)).rejects.toThrow("github_unavailable");
  });
  test("validates registry paths, identifiers and duplicate entries", () => {
    expect(validateProjects([project])).toEqual([project]);
    expect(validateProjects([{ ...project, excludeSections: ["킵", "대기"] }])[0]!.excludeSections).toEqual(["킵", "대기"]);
    for (const input of [[project, project], [{ ...project, repo: "https://evil.test" }], [{ ...project, docs: { ...project.docs, todo: "../private.md" } }], [{ ...project, excludeSections: "킵" }], [{ ...project, excludeSections: [""] }]]) expect(() => validateProjects(input)).toThrow("invalid_project_registry");
  });
});
