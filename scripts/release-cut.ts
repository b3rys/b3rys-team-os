import { mkdtempSync, readFileSync, writeFileSync, realpathSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { nextVersion, publicNotesDraft, checkPublicNotes, type ReleasePR, type PublicContext } from "./release-plan";

function run(args: string[], env: Record<string, string | undefined> = process.env, cwd = process.cwd()): string {
  const r = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", env, cwd });
  if (r.exitCode) throw new Error(`${args.slice(0, 2).join(" ")} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}
const argv = process.argv.slice(2);
const allowed = new Set(["--dry-run", "--prepare", "--publish", "--approved", "--out", "--prs-file", "--previous", "--context-file", "--plan", "--notes-file", "--submitted-by", "--help"]);
const values = new Set(["--out", "--prs-file", "--previous", "--context-file", "--plan", "--notes-file", "--submitted-by"]);
const opts = new Map<string, string>();
for (let i = 0; i < argv.length; i++) {
  const key = argv[i]!;
  if (!allowed.has(key) || opts.has(key)) throw new Error(`Unknown or duplicate option: ${key}`);
  const value = values.has(key) ? argv[++i] : "true";
  if (!value || value.startsWith("--")) throw new Error(`Missing value: ${key}`);
  opts.set(key, value);
}
if (opts.has("--help")) {
  console.log("release-cut.sh [--dry-run] [--out NEW_DIR] [--notes-file REVIEWED_MD]\nrelease-cut.sh --prepare --submitted-by MEMBER_ID --plan PLAN_JSON\nAfter release PR merge and fresh dry-run: --publish --approved --plan PLAN_JSON\nOffline: --prs-file JSON --previous vX.Y.Z --context-file JSON");
  process.exit(0);
}
const publish = opts.has("--publish");
const prepare = opts.has("--prepare");
if (prepare && (publish || opts.has("--dry-run") || !opts.has("--plan"))) throw new Error("Prepare requires --prepare --plan PLAN_JSON only");
if (publish && (opts.has("--dry-run") || !opts.has("--approved") || !opts.has("--plan"))) throw new Error("Publish requires human approval: --publish --approved --plan PLAN_JSON");
if ((publish || prepare) && ["--prs-file", "--previous", "--context-file", "--out", "--notes-file"].some(k => opts.has(k))) throw new Error("Fixture/preview options are not allowed for prepare/publish");
const root = realpathSync(run(["git", "rev-parse", "--show-toplevel"]));
const settingsUrl = process.env.B3OS_SETTINGS_URL ?? "http://127.0.0.1:7878/team/api/settings";
async function json(url: string): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`Context endpoint unavailable (${r.status})`);
  return r.json();
}
async function context(): Promise<PublicContext> {
  if (opts.has("--context-file")) return JSON.parse(readFileSync(opts.get("--context-file")!, "utf8"));
  const [agents, projects, raw] = await Promise.all([json(settingsUrl.replace(/settings$/, "agents")), json(settingsUrl.replace(/settings$/, "projects")), json(settingsUrl)]);
  const settings = raw.settings ?? raw;
  const allowTerms = new Set(readFileSync(join(root, "skills/b3os-release-ops/public-lint-allow.txt"), "utf8").split("\n").filter(l => l.startsWith("term:")).map(l => l.slice(5).trim().toLowerCase()));
  if (!Array.isArray(agents.agents ?? agents) || !Array.isArray(projects.projects ?? projects) || !settings.owner_name) throw new Error("Public context incomplete; cannot check release notes");
  return { agents: agents.agents ?? agents, projects: projects.projects ?? projects, ownerName: settings.owner_name, allowTerms };
}
const fixture = opts.has("--prs-file");
if (!fixture) run(["git", "fetch", "origin", "main", "--tags"]);
const tip = run(["git", "rev-parse", "origin/main"]);
const previous = opts.get("--previous") ?? run(["git", "describe", "--tags", "--match", "v[0-9]*", "--abbrev=0", tip]);
let prs: ReleasePR[];
if (fixture) prs = JSON.parse(readFileSync(opts.get("--prs-file")!, "utf8"));
else {
  const since = run(["git", "show", "-s", "--format=%cI", `${previous}^{commit}`]);
  const all: ReleasePR[] = JSON.parse(run(["gh", "pr", "list", "--state", "merged", "--base", "main", "--search", `merged:>=${since.slice(0, 10)}`, "--limit", "1000", "--json", "number,title,labels,mergeCommit"]));
  if (all.length >= 1000) throw new Error("PR query cap reached; refuse incomplete release");
  const commits = new Set(run(["git", "rev-list", `${previous}..${tip}`]).split("\n"));
  prs = all.filter(p => p.mergeCommit && commits.has(p.mergeCommit.oid)).sort((a, b) => a.number - b.number);
}
if (!Array.isArray(prs) || prs.some(p => !Number.isSafeInteger(p.number) || p.number <= 0 || typeof p.title !== "string" || !Array.isArray(p.labels))) throw new Error("Invalid PR input");
const version = nextVersion(previous, prs);
if (!version) { console.log("No merged PRs since previous tag; no files or release created."); process.exit(0); }
const publicContext = await context();
const { notes: generatedNotes, replaced } = publicNotesDraft(version, prs, publicContext);
if (!publish && !prepare) {
  const reviewedNotes = opts.has("--notes-file") ? readFileSync(opts.get("--notes-file")!, "utf8") : generatedNotes;
  checkPublicNotes(reviewedNotes, version, publicContext);
  const out = opts.get("--out") ? resolve(opts.get("--out")!) : mkdtempSync(join(tmpdir(), "b3os-release-"));
  if (opts.has("--out")) {
    if (existsSync(out)) throw new Error("--out must be a new directory");
    const parent = realpathSync(dirname(out));
    if (parent === root || parent.startsWith(root + "/")) throw new Error("Release output must be outside repository");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(out);
  }
  if (realpathSync(out) === root || realpathSync(out).startsWith(root + "/")) throw new Error("Release output must be outside repository");
  const notesFile = join(out, `v${version}.md`);
  writeFileSync(notesFile, reviewedNotes);
  writeFileSync(join(out, "plan.json"), JSON.stringify({ previous, version, tip, prs: prs.map(p => p.number), replaced, notesFile, notes: reviewedNotes, generatedNotes, fixture }, null, 2));
  console.log(`next=v${version} prs=${prs.length} replaced=${replaced}/${prs.length}\nnotes=${notesFile}\nplan=${join(out, "plan.json")}\nDry-run only; no commit, tag, push or release.`);
  process.exit(0);
}
const plan = JSON.parse(readFileSync(opts.get("--plan")!, "utf8"));
if (plan.fixture || plan.tip !== tip || plan.previous !== previous || plan.version !== version || JSON.stringify(plan.prs) !== JSON.stringify(prs.map(p => p.number))) throw new Error("Plan is stale or fixture-generated; regenerate and review");
const notes = readFileSync(plan.notesFile, "utf8");
if (notes !== plan.notes || plan.generatedNotes !== generatedNotes) throw new Error("Notes changed; regenerate and review the exact publish draft");
checkPublicNotes(notes, version, publicContext);
if (run(["git", "status", "--porcelain"])) throw new Error("Prepare/publish requires a clean worktree");
if (run(["git", "rev-parse", "HEAD"]) !== tip || (publish && run(["git", "branch", "--show-current"]) !== "main")) throw new Error("Use a clean worktree at reviewed origin/main; publish requires main");
run(["bash", "skills/b3os-release-ops/scripts/release-preflight.sh", "--mode", "post-merge"]);
if (run(["git", "rev-parse", "origin/main"]) !== tip) throw new Error("Remote main changed during preflight");
const settingsRaw = await json(settingsUrl);
const settings = settingsRaw.settings ?? settingsRaw;
const email = settings.github_team_commit_email;
if (typeof email !== "string" || !/^[^\s<>]+@users\.noreply\.github\.com$/.test(email)) throw new Error("A configured GitHub noreply commit email is required");
const tag = `v${version}`;
if (Bun.spawnSync(["git", "rev-parse", "--verify", `refs/tags/${tag}`]).exitCode === 0) throw new Error("Tag already exists; never move release tags");
const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const identity = ["git", "-c", "user.name=Release", "-c", `user.email=${email}`];
const identityEnv = { ...process.env, GIT_AUTHOR_NAME: "Release", GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: "Release", GIT_COMMITTER_EMAIL: email };
if (prepare) {
  const submitter = opts.get("--submitted-by");
  if (!submitter || !/^[a-z][a-z0-9-]*$/.test(submitter) || !publicContext.agents.some(a => a.id === submitter)) throw new Error("Prepare requires --submitted-by with a registered member ID");
  if (pkg.version === version) { console.log("Version already prepared on main; regenerate dry-run and request publication approval."); process.exit(0); }
  if (pkg.version !== previous.replace(/^v/, "")) throw new Error("package.json and previous tag versions differ; reconcile first");
  const account = settings.github_team_account;
  if (typeof account !== "string" || !account || account === settings.github_approver_account) throw new Error("Distinct team/approver accounts are required for the release PR");
  const token = run(["gh", "auth", "token", "--user", account]);
  if (!token) throw new Error("Team authentication unavailable");
  const branch = `release/${tag}`;
  const prDir = mkdtempSync(join(tmpdir(), "release-prepare-"));
  const worktree = join(prDir, "worktree");
  let added = false;
  let url: string;
  try {
    run(["git", "worktree", "add", "--detach", worktree, tip]);
    added = true;
    const workRun = (args: string[], env: Record<string, string | undefined> = process.env) => run(args, env, worktree);
    workRun(["git", "switch", "-c", branch, tip]);
    const preparedPkgPath = join(worktree, "package.json");
    const preparedPkg = JSON.parse(readFileSync(preparedPkgPath, "utf8"));
    preparedPkg.version = version;
    writeFileSync(preparedPkgPath, JSON.stringify(preparedPkg, null, 2) + "\n");
    workRun(["git", "add", "--", "package.json"]);
    workRun([...identity, "commit", "-m", `chore(release): ${tag}`], { ...identityEnv, GIT_AUTHOR_NAME: submitter, GIT_COMMITTER_NAME: submitter });
    if (workRun(["git", "log", "-1", "--format=%ae%n%ce"]) !== `${email}\n${email}`) throw new Error("Release commit identity mismatch; stop before push");
    workRun(["git", "push", "-u", "origin", `HEAD:refs/heads/${branch}`]);
    const bodyFile = join(prDir, "body.md");
    writeFileSync(bodyFile, `## Release version\n\nUpdate package.json to ${version}. No release tag or publication is performed by this PR. After review and merge, regenerate and review release notes at the new main tip before publication.\n\nSubmitted-by: ${submitter}\n`);
    url = workRun(["gh", "pr", "create", "--base", "main", "--head", branch, "--title", `chore(release): ${tag}`, "--body-file", bodyFile], { ...process.env, GH_TOKEN: token });
    const author = workRun(["gh", "pr", "view", url, "--json", "author", "--jq", ".author.login"], { ...process.env, GH_TOKEN: token });
    if (author !== account) throw new Error("Release PR author mismatch; stop and reconcile the PR account");
  } finally {
    if (added) run(["git", "worktree", "remove", "--force", worktree]);
    rmSync(prDir, { recursive: true, force: true });
  }
  console.log(`Release PR: ${url}\nNo main push, tag or Release. Await review and approved merge, then regenerate dry-run.`);
  process.exit(0);
}
if (pkg.version !== version) throw new Error("Version bump must be merged through a release PR first: run --prepare, review/merge, then regenerate dry-run");
run([...identity, "tag", "-a", tag, "-m", `Release ${tag}`], identityEnv);
if (run(["git", "for-each-ref", "--format=%(taggeremail)", `refs/tags/${tag}`]) !== `<${email}>`) throw new Error("Tag identity mismatch; stop before push");
// Tag the reviewed main commit; publication never writes the protected branch.
run(["git", "push", "origin", `refs/tags/${tag}`]);
run(["gh", "release", "create", tag, "--verify-tag", "--title", tag, "--notes-file", plan.notesFile]);
console.log(`Published ${tag}. Deployment/restart is a separate approved operation.`);
