// seedClaudeAccess — 재활성화 시 승인된 DM allowlist 보존 + 첫 멤버 pairing 시드 회귀 검증.
// ★실 FS 격리: 각 케이스를 임시 HOME의 별도 Bun 프로세스에서 실행해 라이브 ~/.claude를 절대 건드리지 않는다.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDirs: string[] = [];

function setupHome(): string {
  const home = mkdtempSync(join(tmpdir(), "b3os-seedaccess-"));
  tmpDirs.push(home);
  return home;
}

function accessPath(home: string, id: string): string {
  return join(home, ".claude", "channels", `telegram-${id}`, "access.json");
}

function writeAccess(home: string, id: string, access: unknown): void {
  const path = accessPath(home, id);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(access, null, 2) + "\n", "utf-8");
}

function readAccess(home: string, id: string): any {
  return JSON.parse(readFileSync(accessPath(home, id), "utf-8"));
}

function runSeed(home: string, id: string, captureGroupId = ""): void {
  const launcherUrl = new URL("./launcher.ts", import.meta.url).href;
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "-e", `import { seedClaudeAccess } from ${JSON.stringify(launcherUrl)}; seedClaudeAccess(${JSON.stringify(id)});`],
    env: { ...process.env, HOME: home, B3RYS_MEMBERS_ROOT: join(home, "members"), CAPTURE_GROUP_ID: captureGroupId },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(new TextDecoder().decode(proc.stderr)).toBe("");
  expect(proc.exitCode).toBe(0);
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

test("재활성화 대상에 승인 allowFrom이 있으면 access.json 전체를 그대로 보존한다", () => {
  const home = setupHome();
  const approved = {
    dmPolicy: "allowlist",
    allowFrom: ["1000000001"],
    groups: { "-100123": { requireMention: false, allowFrom: ["2000000002"] } },
    pending: { old: { senderId: "3000000003" } },
    ackReaction: "✅",
  };
  writeAccess(home, "bill", approved);
  const before = readFileSync(accessPath(home, "bill"), "utf-8");

  runSeed(home, "bill");

  expect(readFileSync(accessPath(home, "bill"), "utf-8")).toBe(before);
  expect(readAccess(home, "bill")).toEqual(approved);
});

test("첫 claude 멤버는 기존대로 pairing과 capture group 기본값을 시드한다", () => {
  const home = setupHome();

  runSeed(home, "bill", "-1001234567890");

  expect(readAccess(home, "bill")).toEqual({
    dmPolicy: "pairing",
    allowFrom: [],
    groups: { "-1001234567890": { requireMention: true, allowFrom: [] } },
    pending: {},
    ackReaction: "👀",
  });
});

test("대상 access.json에 승인 allowFrom이 없으면 기존 pairing 기본값으로 다시 시드한다", () => {
  const home = setupHome();
  writeAccess(home, "bill", { dmPolicy: "allowlist", allowFrom: [], groups: { stale: {} }, pending: { stale: {} } });

  runSeed(home, "bill");

  expect(readAccess(home, "bill")).toEqual({
    dmPolicy: "pairing",
    allowFrom: [],
    groups: {},
    pending: {},
    ackReaction: "👀",
  });
});
