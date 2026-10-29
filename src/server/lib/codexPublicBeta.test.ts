import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Real activation/caller code with executable stubs and an isolated HOME; no launchd or account access. */
async function scenario(kind: "missing-owner" | "poller-failure" | "bootstrap-failure" | "first-call") {
  const root = mkdtempSync(join(tmpdir(), "codex-beta-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "rules"));
  writeFileSync(join(root, "rules/TEAM-OS.md"), "# Team rules\n");
  writeFileSync(join(root, "agents.json"), "[]\n");
  const codex = join(bin, "codex");
  writeFileSync(codex, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.PROBE_RECORD, JSON.stringify({args})+'\\n');
if (args[0] === '--version') { console.log('codex-cli 0.147.0'); process.exit(0); }
if (args[0] === 'login') process.exit(0);
if (args[0] !== 'app-server') process.exit(2);
for await (const line of console) {
  const r = JSON.parse(line);
  appendFileSync(process.env.PROBE_RECORD, JSON.stringify(r)+'\\n');
  if (r.method === 'initialize') console.log(JSON.stringify({id:r.id,result:{}}));
  if (r.method === 'thread/start') console.log(JSON.stringify({id:r.id,result:{thread:{id:'thread-probe'}}}));
  if (r.method === 'turn/start') {
    console.log(JSON.stringify({id:r.id,result:{turn:{id:'turn-probe'}}}));
    console.log(JSON.stringify({method:'item/completed',params:{threadId:'thread-probe',item:{id:'answer',type:'agentMessage',text:'ok'}}}));
    console.log(JSON.stringify({method:'turn/completed',params:{threadId:'thread-probe',turn:{id:'turn-probe',status:'completed'}}}));
  }
}
`);
  chmodSync(codex, 0o755);
  const launchctl = join(bin, "launchctl");
  writeFileSync(launchctl, `#!/bin/sh\necho "$*" >> "$PROBE_LAUNCHCTL"\n${kind === "bootstrap-failure" ? 'if [ "$1" != "bootout" ]; then exit 1; fi\n' : ""}exit 0\n`);
  chmodSync(launchctl, 0o755);
  const script = `
    import { Database } from 'bun:sqlite';
    import { activateMember } from ${JSON.stringify(join(import.meta.dir, "activation.ts"))};
    import { verifyFirstModelCall } from ${JSON.stringify(join(import.meta.dir, "runtimeSubscription.ts"))};
    const db = new Database(process.env.TEAM_DB_PATH);
    db.run('CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT)');
    ${kind === "missing-owner" ? "" : "db.run(\"INSERT INTO setting VALUES ('owner_chat_id', '123456789')\");"}
    const result = ${kind === "first-call" ? "await verifyFirstModelCall({id:'probe',runtime:'codex',workspacePath:process.env.PROBE_ROOT})" : "await activateMember(db,{id:'probe',display_name:'Probe',role:'developer',runtime:'codex',bot_token:'fixture',registryPath:process.env.TEAM_AGENT_REGISTRY})"};
    db.close();
    console.log('RESULT:'+JSON.stringify(result));
  `;
  try {
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env, HOME: root, GD_CHAT_ID: "", CODEX_HOME: join(root, "codex-home"),
        TEAM_COLLAB_ROOT: root, B3RYS_MEMBERS_ROOT: join(root, "members"),
        B3OS_TEST_MEMBERS_ROOT: join(root, "members"), TEAM_AGENT_REGISTRY: join(root, "agents.json"),
        TEAM_DB_PATH: join(root, "team.db"), CODEX_BIN: codex, PATH: `${bin}:${process.env.PATH}`,
        TEAMOS_AGENT_OFF_FILE: join(root, "off"), TEAMOS_BUS_WAKE_EXTRA_FILE: join(root, "wake"),
        APPROVAL_EXECUTION_ENABLED: "1", TEAMOS_POLLER_WAIT_MS: "0", TEAM_HTTP_PORT: "8123",
        PROBE_ROOT: root, PROBE_RECORD: join(root, "rpc"), PROBE_LAUNCHCTL: join(root, "launchctl-log"),
      }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(exit, stderr).toBe(0);
    const result = JSON.parse(stdout.split("RESULT:")[1]!);
    const read = (file: string) => { try { return readFileSync(join(root, file), "utf8"); } catch { return ""; } };
    return { result, rpc: read("rpc"), launchctl: read("launchctl-log"), wrapper: read("var/codex-bridge/probe-launch.sh") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("First Codex member with no owner stops before starting any process", async () => {
  const { result, rpc, launchctl } = await scenario("missing-owner");
  expect(result.ok).toBe(false);
  expect(result.steps[0].step).toBe("owner-chat");
  expect(rpc).toBe("");
  expect(launchctl).toBe("");
});

for (const kind of ["poller-failure", "bootstrap-failure"] as const) {
  test(`Codex ${kind} boots out the failed bridge and reports cleanup`, async () => {
    const { result, launchctl, wrapper } = await scenario(kind);
    expect(result.ok).toBe(false);
    expect(result.steps).toContainEqual(expect.objectContaining({ step: "runtime-cleanup", ok: true }));
    expect(launchctl).toContain("bootstrap");
    expect(launchctl).toContain("bootout");
    expect(wrapper).toContain('export CODEX_BIN="/');
    expect(wrapper).toContain('export TEAM_BASE_URL="http://127.0.0.1:8123/team"');
  });
}

test("First model call uses the real app-server request path with full permissions and no exec fallback", async () => {
  const { result, rpc } = await scenario("first-call");
  expect(result.ok).toBe(true);
  const records = rpc.trim().split("\n").map((line) => JSON.parse(line));
  expect(records.find((r) => r.args)?.args).toEqual(["app-server"]);
  expect(records.find((r) => r.method === "thread/start")?.params).toMatchObject({ sandbox: "danger-full-access", approvalPolicy: "never" });
  expect(records.find((r) => r.method === "turn/start")?.params).toMatchObject({ sandboxPolicy: { type: "dangerFullAccess" }, approvalPolicy: "never" });
});
