/**
 * owner-gate 훅 — ★서버가 죽어도 사용자를 먹통으로 만들지 않는다★ 가 제일 중요한 축이다.
 *
 * 소스 머리말은 "라우터 에러·타임아웃은 fail-open" 이라고 적고 있다. ★적힌 것과 도는 것은 다르다★ —
 * 그래서 여기서는 ★진짜 죽은 포트★ 와 ★진짜 멈춘 소켓★ 에 붙여 훅을 실행하고 exit 출력으로 잰다.
 * 여기서 fail-closed 면 퍼블릭 사용자 전원이 먹통이 된다.
 *
 * 게이트가 ★실제로 막는지★ 도 같이 잰다 — 막지 않으면 깔 이유가 없다.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

const HOOK = join(import.meta.dir, "../../../../hooks/telegram-owner-gate.py");
const GROUP = "-1009999999999"; // 테스트 전용 가짜 값
const DM = "9999999999";

let dirs: string[] = [];
let servers: Server[] = [];
afterEach(() => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  for (const s of servers) { try { s.close(); } catch { /* best-effort */ } }
  dirs = []; servers = [];
});

/** 훅을 실행한다. 반환: block 이면 true.
 *
 *  ★반드시 비동기로 돌린다★ — `execFileSync` 는 이벤트 루프를 막아서 같은 프로세스에 띄운
 *  가짜 라우터가 ★응답을 못 한다.★ 그러면 모든 케이스가 타임아웃으로 흘러 "항상 통과" 로 보이고,
 *  ★막는 축을 재는 테스트가 조용히 무의미해진다.★ (실제로 그렇게 한 번 통과할 뻔했다.)
 */
async function gateBlocks(chatId: string, text: string, routeUrl: string, env: Record<string, string> = {}): Promise<boolean> {
  const prompt = `<channel source="plugin:telegram:telegram" chat_id="${chatId}" message_id="8199">${text}</channel>`;
  const child = execFileAsync("python3", [HOOK], {
    encoding: "utf-8",
    env: {
      ...process.env,
      OWNER_GATE_SELF: "steve",
      OWNER_GATE_GROUP: GROUP,
      OWNER_GATE_ROUTE_URL: routeUrl,
      B3OS_ROOT: "",
      ...env,
    },
  });
  child.child.stdin?.end(JSON.stringify({ prompt }));
  const { stdout } = await child;
  return stdout.includes('"block"');
}

/** 지정한 JSON 을 돌려주는 가짜 라우터. */
async function fakeRouter(body: unknown): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return `http://127.0.0.1:${port}/route`;
}

describe("owner-gate — 서버가 없어도 막지 않는다(fail-open)", () => {
  test("★라우터가 죽어 있으면 통과한다★ — 여기서 막으면 사용자 전원이 먹통이다", async () => {
    // 아무도 안 듣는 포트 = 연결 거부.
    expect(await gateBlocks(GROUP, "@빌 이거 해줘", "http://127.0.0.1:59999/route")).toBe(false);
  });

  test("★라우터가 멈춰 있어도(응답 없음) 통과한다★ — 타임아웃도 fail-open", async () => {
    // 연결은 받되 절대 응답하지 않는 서버 = 타임아웃 경로(거부와 다른 축이다).
    const server = createServer(() => { /* 응답하지 않는다 */ });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    expect(await gateBlocks(GROUP, "@빌 이거 해줘", `http://127.0.0.1:${port}/route`)).toBe(false);
  }, 15000);

  test("라우터가 깨진 응답을 줘도 통과한다", async () => {
    const server = createServer((_req, res) => { res.writeHead(200); res.end("not json"); });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    expect(await gateBlocks(GROUP, "@빌 이거 해줘", `http://127.0.0.1:${port}/route`)).toBe(false);
  });
});

describe("owner-gate — 막을 때는 막는다", () => {
  test("★서버가 suppress 라고 하면 막는다★ (내가 오너가 아닌 글)", async () => {
    const url = await fakeRouter({ suppress: true, reason: "explicit_mention", targetAgentIds: ["bill"] });
    expect(await gateBlocks(GROUP, "@빌 이거 해줘", url)).toBe(true);
  });

  test("서버가 suppress 아니라고 하면 통과", async () => {
    const url = await fakeRouter({ suppress: false, reason: "explicit_mention", targetAgentIds: ["steve"] });
    expect(await gateBlocks(GROUP, "@스티브 이거 해줘", url)).toBe(false);
  });

  test("★1:1 DM 은 서버에 묻지도 않고 통과★ — DM 은 항상 내 것이다", async () => {
    // suppress=true 를 주는 라우터를 붙여도 1:1 이면 막히면 안 된다.
    const url = await fakeRouter({ suppress: true, reason: "explicit_mention", targetAgentIds: ["bill"] });
    expect(await gateBlocks(DM, "@빌 이거 해줘", url)).toBe(false);
  });
});

describe("owner-gate — 배포 위치에서 단톡방 id 를 구한다", () => {
  /** 훅을 배포 위치 모양(`<멤버>/.claude/hooks/`)으로 깔고, 그 자리에서 `_team_group()` 을 부른다.
   *  `withRoot=true` 면 런처가 싣는 것과 같은 `B3OS_ROOT` 를 주고, false 면 대조군이다. */
  function resolveFromDeployed(withRoot: boolean): string {
    const base = mkdtempSync(join(tmpdir(), "b3os-gate-"));
    dirs.push(base);
    const root = join(base, "b3os");
    const hooks = join(base, "member", ".claude", "hooks");
    mkdirSync(root, { recursive: true });
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(root, ".env"), `TEAM_GROUP_ID=${GROUP}\n`);
    const dst = join(hooks, "telegram-owner-gate.py");
    copyFileSync(HOOK, dst);
    const py = [
      "import importlib.util,sys",
      `s=importlib.util.spec_from_file_location("g", ${JSON.stringify(dst)})`,
      "m=importlib.util.module_from_spec(s)",
      "try: s.loader.exec_module(m)",
      "except SystemExit: pass",
      "sys.stdout.write(m._team_group())",
    ].join("\n");
    return execFileSync("python3", ["-c", py], {
      env: { ...process.env, OWNER_GATE_GROUP: "", B3OS_ROOT: withRoot ? root : "" },
      encoding: "utf-8",
    });
  }

  test("★B3OS_ROOT 가 있으면 배포 위치에서도 구한다★", () => {
    expect(resolveFromDeployed(true)).toBe(GROUP);
  });

  test("★대조군 — B3OS_ROOT 없이는 못 구한다(빈 값 → 게이트 무력화)★", () => {
    expect(resolveFromDeployed(false)).toBe("");
  });
});
