/**
 * owner-gate 의 ★자기 id★ 와 ★1:1/그룹 판정★ 을 고정한다.
 *
 * 시나리오는 ★루이 교차검증(PR #236)★ 이 만든 계측기에서 왔다. 원본은 당시 동작을 그대로
 * 적어둔 characterization 이었고(=지금 이렇다), 여기서는 ★고쳐진 계약★ 으로 뒤집어 적었다.
 * ★원본 그대로 두면 고침이 실패로 잡힌다.★
 *
 * 이 축이 왜 중요한가 — 자기 id 를 틀리면 게이트가 ★꺼지는 게 아니라 반대로 돈다.★
 * 진행표시 훅은 폴백이 틀리면 알림이 엉뚱한 방에 가서 ★보이지만★, 이 훅은 ★조용히★ 반대로 판정한다.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { installOwnerGateHook, ensureOwnerGateHook } from "./launcher";

const execFileAsync = promisify(execFile);
const HOOK = join(import.meta.dir, "../../../../hooks/telegram-owner-gate.py");
const GROUP = "-1009999999999";
const OTHER_GROUP = "-1008888888888"; // 리사팀·공개 설치의 두 번째 방
const DM = "7066867819";

let dirs: string[] = [];
let servers: Server[] = [];
afterEach(() => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
  for (const s of servers) { try { s.close(); } catch { /* noop */ } }
  dirs = []; servers = [];
});

/** 진짜 서버처럼 판정하는 라우터: 훅이 보낸 self 를 받아 explicit_mention 이면 targets 포함 여부로 suppress. */
async function realisticRouter(targets: string[]): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let self = "";
      try { self = JSON.parse(body).self ?? ""; } catch { /* noop */ }
      seen.push(self);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        suppress: !targets.includes(self),
        reason: "explicit_mention",
        targetAgentIds: targets,
      }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/route`, seen };
}

/** 훅 실행. env 를 그대로 준다(OWNER_GATE_SELF 를 일부러 빼는 게 이 검증의 핵심). */
async function runHook(chatId: string, text: string, routeUrl: string, env: Record<string, string>): Promise<string> {
  const prompt = `<channel source="plugin:telegram:telegram" chat_id="${chatId}" message_id="8199">${text}</channel>`;
  const base = { ...process.env } as Record<string, string>;
  delete base.OWNER_GATE_SELF;
  delete base.TELEGRAM_STATE_DIR;
  const child = execFileAsync("python3", [HOOK], {
    encoding: "utf-8",
    env: { ...base, OWNER_GATE_GROUP: GROUP, OWNER_GATE_ROUTE_URL: routeUrl, B3OS_ROOT: "", ...env },
  });
  child.child.stdin?.end(JSON.stringify({ prompt }));
  const { stdout } = await child;
  return stdout;
}

// ── 축1: _self_id() 폴백 ─────────────────────────────────────────────────────
describe("자기 id — 모르면 남의 id 로 판정하지 않는다", () => {
  test("★정상 경로: telegram-<id> 면 자기 id 를 맞게 보낸다★", async () => {
    const { url, seen } = await realisticRouter(["demis"]);
    await runHook(GROUP, "@데미스 이거 해줘", url, { TELEGRAM_STATE_DIR: "/x/channels/telegram-demis" });
    expect(seen).toEqual(["demis"]);
  });

  test("★자기 id 를 모르면 라우터에 묻지 않는다★ — 예전엔 'bill' 로 폴백해서 남의 이름으로 물었다", async () => {
    const { url, seen } = await realisticRouter(["demis"]);
    await runHook(GROUP, "@데미스 이거 해줘", url, {});
    expect(seen).toEqual([]);   // 남의 id 로 묻느니 게이트를 끈다
  });

  test("★자기 앞으로 온 글에서 자기가 막히지 않는다★ (@데미스 → 데미스 세션 통과)", async () => {
    // 예전: self 가 'bill' 로 폴백 → "not bill" 사유로 ★자기 지시에 자기가 막혔다.★
    const { url } = await realisticRouter(["demis"]);
    const out = await runHook(GROUP, "@데미스 이거 해줘", url, {});
    expect(out).not.toContain('"block"');
  });

  test("★id 를 실어주면 남의 글에서 제대로 막힌다★ (@빌 → 데미스 세션 block)", async () => {
    // 런처가 OWNER_GATE_SELF 를 싣는 상태. 이게 게이트가 ★일하는★ 모습이다.
    const { url } = await realisticRouter(["bill"]);
    const out = await runHook(GROUP, "@빌 이거 해줘", url, { OWNER_GATE_SELF: "demis" });
    expect(out).toContain('"block"');
  });

  test("state dir 이름이 agent id 와 다르면 그 이름으로 나간다 — ★그래서 런처가 id 를 직접 싣는다★", async () => {
    const { url, seen } = await realisticRouter(["demis"]);
    const out = await runHook(GROUP, "@데미스 이거 해줘", url, { TELEGRAM_STATE_DIR: "/x/channels/telegram-claude" });
    expect(seen).toEqual(["claude"]);
    expect(out).toContain('"block"');           // 명부에 없는 id → 항상 suppress
  });
});

// ── 축3: 1:1 및 다른 방 ──────────────────────────────────────────────────────
describe("1:1/그룹 판정 — chat_id 부호로 가른다(reply-guard 와 같은 정의)", () => {
  test("1:1(양수 chat_id) 은 suppress 라우터에도 통과 — 요구사항 충족", async () => {
    const { url, seen } = await realisticRouter(["bill"]);
    const out = await runHook(DM, "@빌 이거 해줘", url, { TELEGRAM_STATE_DIR: "/x/channels/telegram-demis" });
    expect(out).not.toContain('"block"');
    expect(seen).toEqual([]);                   // ★라우터에 묻지도 않는다★ — 서버가 죽어도 1:1 은 산다
  });

  test("★두 번째 단톡방(음수)도 게이트가 걸린다★ — 방이 둘 이상인 설치에 구멍이 없어야 한다", async () => {
    // 예전 기준은 "설정된 GROUP_ID 와 다른가" 라 ★두 번째 방이 1:1 처럼 통과★ 했다(라우터 호출 0회).
    const { url, seen } = await realisticRouter(["bill"]);
    const out = await runHook(OTHER_GROUP, "@빌 이거 해줘", url, { TELEGRAM_STATE_DIR: "/x/channels/telegram-demis" });
    expect(seen).toEqual(["demis"]);   // 라우터에 실제로 묻는다
    expect(out).toContain('"block"');  // 내 것이 아니므로 막는다
  });
});

// ── 축2·축4: 설치 멱등성과 기존 배선 ────────────────────────────────────────
function member(existing: string | null): { root: string; membersRoot: string; repoRoot: string; settings: string } {
  const base = mkdtempSync(join(tmpdir(), "b3os-inst-"));
  dirs.push(base);
  const membersRoot = join(base, "members");
  const repoRoot = join(base, "repo");
  mkdirSync(join(membersRoot, "m1", ".claude"), { recursive: true });
  mkdirSync(join(repoRoot, "hooks"), { recursive: true });
  writeFileSync(join(repoRoot, "hooks", "telegram-owner-gate.py"), readFileSync(HOOK, "utf-8"));
  const settings = join(membersRoot, "m1", ".claude", "settings.json");
  if (existing !== null) writeFileSync(settings, existing);
  return { root: base, membersRoot, repoRoot, settings };
}

// 라이브 팀원 5명이 실제로 갖고 있는 모양 (Stop 2 · PreToolUse 1 · PreCompact 1)
const LIVE_SHAPE = JSON.stringify({
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "a" }] }, { hooks: [{ type: "command", command: "b" }] }],
    PreToolUse: [{ hooks: [{ type: "command", command: "c" }] }],
    PreCompact: [{ hooks: [{ type: "command", command: "d" }] }],
  },
  permissions: { allow: ["Bash"] },
}, null, 2);

describe("축2·축4 — 설치가 기존 배선을 건드리는가 / 반복하면 쌓이는가", () => {
  test("★10회 반복 설치해도 항목이 안 늘어난다 (멱등)★", () => {
    const m = member(LIVE_SHAPE);
    for (let i = 0; i < 10; i++) installOwnerGateHook("m1", { membersRoot: m.membersRoot, repoRoot: m.repoRoot });
    const s = JSON.parse(readFileSync(m.settings, "utf-8"));
    expect(s.hooks.UserPromptSubmit.length).toBe(1);
    expect(s.hooks.Stop.length).toBe(2);
    expect(s.hooks.PreToolUse.length).toBe(1);
    expect(s.hooks.PreCompact.length).toBe(1);
    expect(s.permissions).toEqual({ allow: ["Bash"] });   // 훅 밖 키도 보존
  });

  test("★부팅 갱신(ensure) 10회도 멱등★", () => {
    const m = member(LIVE_SHAPE);
    installOwnerGateHook("m1", { membersRoot: m.membersRoot, repoRoot: m.repoRoot });
    for (let i = 0; i < 10; i++) ensureOwnerGateHook("m1", { membersRoot: m.membersRoot, repoRoot: m.repoRoot });
    const s = JSON.parse(readFileSync(m.settings, "utf-8"));
    expect(s.hooks.UserPromptSubmit.length).toBe(1);
    expect(s.hooks.Stop.length).toBe(2);
  });

  test("★안 깔린 멤버에도 부팅 때 깔린다★ — 기존 설치본이 이 PR 의 대상이다", () => {
    // ★기대값을 뒤집었다.★ 예전에는 "새로 깔지 않는다" 를 고정하고 있었는데, 그러면
    // ★배선이 하나도 없는 기존 설치본에서 전원 건너뛰어 효과가 0★ 이 된다(배포 후 5명 실측).
    // owner-gate 는 progress·reply-guard 와 목적이 반대다 — ★없는 곳에 넣는 게 존재 이유★ 다.
    const m = member(LIVE_SHAPE);
    ensureOwnerGateHook("m1", { membersRoot: m.membersRoot, repoRoot: m.repoRoot });
    const s = JSON.parse(readFileSync(m.settings, "utf-8"));
    expect(s.hooks.UserPromptSubmit.length).toBe(1);
    expect(s.hooks.Stop.length).toBe(2);          // 기존 배선은 그대로
    expect(s.hooks.PreToolUse.length).toBe(1);
  });

  // ★현재 동작을 그대로 적어둔 것이다(고침 아님).★ 별건 카드로 뺀 항목 — 여기서 고치면 범위가 커진다.
  test("[알려진 결함] settings.json 이 깨져 있으면 기존 배선이 통째로 날아간다", () => {
    const m = member('{"hooks": {"Stop": [{"hooks":');   // 잘린 JSON (쓰기 중 중단 등)
    installOwnerGateHook("m1", { membersRoot: m.membersRoot, repoRoot: m.repoRoot });
    const s = JSON.parse(readFileSync(m.settings, "utf-8"));
    expect(s.hooks.UserPromptSubmit.length).toBe(1);
    expect(s.hooks.Stop).toBeUndefined();        // ★Stop·PreToolUse·PreCompact 소멸★
    expect(s.hooks.PreToolUse).toBeUndefined();
  });

  test("settings.json 이 아예 없으면 새로 만든다 (정상)", () => {
    const m = member(null);
    installOwnerGateHook("m1", { membersRoot: m.membersRoot, repoRoot: m.repoRoot });
    expect(existsSync(m.settings)).toBe(true);
  });
});
