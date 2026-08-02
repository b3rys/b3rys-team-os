/**
 * progress 훅 배선을 ★낡은 채로 두지 않는다.★
 *
 * 예전 구현은 settings.json 에 `telegram-progress.py` 가 있으면 통째로 skip 했다. 그래서
 * 훅 ★파일★ 은 새것으로 덮이는데 ★커맨드★ 는 옛것이 남았다 — 그 상태로 `B3OS_ROOT` 가 안 실려
 * owner-skip 이 fail-open 으로 돌았다. 파일만 고치고 배선을 안 고치면 같은 일이 반복된다.
 *
 * ★실 FS 격리★: mkdtemp 임시 dir 만 만진다(roots 이음매로 주입). 실 멤버 폴더는 안 건드린다.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installProgressHook, repairProgressHook, repairReplyGuardHook, installOwnerGateHook, repairOwnerGateHook } from "./launcher";

const ID = "testmember";
let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  dirs = [];
});

function setup(settings?: unknown): { membersRoot: string; repoRoot: string; settingsPath: string } {
  const base = mkdtempSync(join(tmpdir(), "b3os-reconcile-"));
  dirs.push(base);
  const repoRoot = join(base, "b3os");
  const membersRoot = join(base, "members");
  mkdirSync(join(repoRoot, "hooks"), { recursive: true });
  writeFileSync(join(repoRoot, "hooks", "telegram-progress.py"), "# stub\n");
  const dotClaude = join(membersRoot, ID, ".claude");
  mkdirSync(dotClaude, { recursive: true });
  const settingsPath = join(dotClaude, "settings.json");
  if (settings !== undefined) writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return { membersRoot, repoRoot, settingsPath };
}

const commandsIn = (settingsPath: string): string[] => {
  const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
  return Object.values(s.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)
    .flat()
    .flatMap((e) => e.hooks.map((h) => h.command));
};

/** 옛 배선 — `B3OS_ROOT` 없이 python3 만 부른다. 이게 라이브에 남아 있던 모양이다. */
const staleSettings = (membersRoot: string) => ({
  hooks: {
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `python3 "${membersRoot}/${ID}/.claude/hooks/telegram-progress.py" pre` }] }],
    Stop: [{ hooks: [{ type: "command", command: `python3 "${membersRoot}/${ID}/.claude/hooks/telegram-progress.py" stop` }] }],
    PreCompact: [{ matcher: "*", hooks: [{ type: "command", command: `python3 "${membersRoot}/${ID}/.claude/hooks/telegram-progress.py" compact` }] }],
  },
});

describe("progress 훅 배선 reconcile", () => {
  test("★낡은 커맨드를 새 커맨드로 바꾼다★ — 예전엔 있으면 skip 이라 영영 안 바뀌었다", () => {
    const { membersRoot, repoRoot, settingsPath } = setup(null);
    writeFileSync(settingsPath, JSON.stringify(staleSettings(membersRoot), null, 2) + "\n");

    installProgressHook(ID, { membersRoot, repoRoot });

    const cmds = commandsIn(settingsPath);
    expect(cmds).toHaveLength(3);
    for (const c of cmds) expect(c).toContain(`B3OS_ROOT="${repoRoot}"`);
    // 옛 커맨드가 남아 있으면 안 된다 — 추가만 하고 안 지우면 훅이 두 번 돈다.
    expect(cmds.some((c) => !c.includes("B3OS_ROOT"))).toBe(false);
  });

  test("두 번 돌려도 항목이 늘지 않는다 (멱등)", () => {
    const { membersRoot, repoRoot, settingsPath } = setup({});
    installProgressHook(ID, { membersRoot, repoRoot });
    const first = readFileSync(settingsPath, "utf-8");
    installProgressHook(ID, { membersRoot, repoRoot });
    expect(readFileSync(settingsPath, "utf-8")).toBe(first);
    expect(commandsIn(settingsPath)).toHaveLength(3);
  });

  test("다른 훅(reply-guard)은 건드리지 않는다", () => {
    const { membersRoot, repoRoot, settingsPath } = setup({
      hooks: { Stop: [{ hooks: [{ type: "command", command: `python3 "/x/reply-guard.py"` }] }] },
    });
    installProgressHook(ID, { membersRoot, repoRoot });
    expect(commandsIn(settingsPath).filter((c) => c.includes("reply-guard.py"))).toHaveLength(1);
  });

  test("★repair 는 이미 깔린 멤버만 고친다★ — 안 깔린 멤버에 새로 깔지 않는다(라이브 보호)", () => {
    const { membersRoot, repoRoot, settingsPath } = setup({ hooks: {} });
    repairProgressHook(ID, { membersRoot, repoRoot });
    expect(readFileSync(settingsPath, "utf-8")).not.toContain("telegram-progress.py");
  });

  test("repair 는 깔려 있으면 낡은 커맨드를 고친다", () => {
    const { membersRoot, repoRoot, settingsPath } = setup(null);
    writeFileSync(settingsPath, JSON.stringify(staleSettings(membersRoot), null, 2) + "\n");
    repairProgressHook(ID, { membersRoot, repoRoot });
    for (const c of commandsIn(settingsPath)) expect(c).toContain("B3OS_ROOT=");
  });
});

describe("reply-guard 훅 파일 수리", () => {
  /** reply-guard 는 커맨드가 `python3 "<경로>"` 뿐이라 ★배선은 안 낡고 파일만 낡는다.★ */
  function setupGuard(settings?: unknown): { membersRoot: string; repoRoot: string; hookPath: string } {
    const base = mkdtempSync(join(tmpdir(), "b3os-guard-repair-"));
    dirs.push(base);
    const repoRoot = join(base, "b3os");
    const membersRoot = join(base, "members");
    mkdirSync(join(repoRoot, "src/server/runtimes/claude"), { recursive: true });
    writeFileSync(join(repoRoot, "src/server/runtimes/claude/reply-guard.py"), "# NEW\n");
    const dotClaude = join(membersRoot, ID, ".claude");
    mkdirSync(join(dotClaude, "hooks"), { recursive: true });
    writeFileSync(join(dotClaude, "hooks", "reply-guard.py"), "# OLD\n");
    if (settings !== undefined) writeFileSync(join(dotClaude, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
    return { membersRoot, repoRoot, hookPath: join(dotClaude, "hooks", "reply-guard.py") };
  }
  const wired = (membersRoot: string) => ({
    hooks: { Stop: [{ hooks: [{ type: "command", command: `python3 "${membersRoot}/${ID}/.claude/hooks/reply-guard.py"` }] }] },
  });

  test("★배선이 있으면 낡은 훅 파일을 저장소판으로 덮는다★ — 이게 없으면 고쳐도 안 나간다", () => {
    const { membersRoot, repoRoot, hookPath } = setupGuard(null);
    writeFileSync(join(membersRoot, ID, ".claude", "settings.json"), JSON.stringify(wired(membersRoot), null, 2) + "\n");
    repairReplyGuardHook(ID, { membersRoot, repoRoot });
    expect(readFileSync(hookPath, "utf-8")).toBe("# NEW\n");
  });

  test("배선이 없는 멤버에는 새로 깔지 않는다 (라이브 보호)", () => {
    const { membersRoot, repoRoot, hookPath } = setupGuard({ hooks: {} });
    repairReplyGuardHook(ID, { membersRoot, repoRoot });
    expect(readFileSync(hookPath, "utf-8")).toBe("# OLD\n"); // 안 건드림
  });
});

describe("owner-gate 훅 설치·수리", () => {
  function setupGate(settings?: unknown): { membersRoot: string; repoRoot: string; settingsPath: string; hookPath: string } {
    const base = mkdtempSync(join(tmpdir(), "b3os-gate-install-"));
    dirs.push(base);
    const repoRoot = join(base, "b3os");
    const membersRoot = join(base, "members");
    mkdirSync(join(repoRoot, "hooks"), { recursive: true });
    writeFileSync(join(repoRoot, "hooks", "telegram-owner-gate.py"), "# NEW\n");
    const dotClaude = join(membersRoot, ID, ".claude");
    mkdirSync(dotClaude, { recursive: true });
    const settingsPath = join(dotClaude, "settings.json");
    if (settings !== undefined) writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    return { membersRoot, repoRoot, settingsPath, hookPath: join(dotClaude, "hooks", "telegram-owner-gate.py") };
  }

  test("★UserPromptSubmit 배선이 생기고 훅 파일이 깔린다★ (기준 1·2)", () => {
    const { membersRoot, repoRoot, settingsPath, hookPath } = setupGate({});
    installOwnerGateHook(ID, { membersRoot, repoRoot });
    const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const cmds = (s.hooks.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>)
      .flatMap((e) => e.hooks.map((h) => h.command));
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain("telegram-owner-gate.py");
    // ★B3OS_ROOT 가 실려야 한다★ — 없으면 깔려도 게이트가 무력화된다.
    expect(cmds[0]).toContain(`B3OS_ROOT="${repoRoot}"`);
    // ★자기 id 도 실려야 한다★ — 없으면 훅이 추측하고, 틀리면 게이트가 반대로 돈다.
    expect(cmds[0]).toContain(`OWNER_GATE_SELF="${ID}"`);
    expect(readFileSync(hookPath, "utf-8")).toBe("# NEW\n");
  });

  test("두 번 돌려도 항목이 늘지 않는다 (멱등)", () => {
    const { membersRoot, repoRoot, settingsPath } = setupGate({});
    installOwnerGateHook(ID, { membersRoot, repoRoot });
    const first = readFileSync(settingsPath, "utf-8");
    installOwnerGateHook(ID, { membersRoot, repoRoot });
    expect(readFileSync(settingsPath, "utf-8")).toBe(first);
  });

  test("다른 UserPromptSubmit 훅은 건드리지 않는다", () => {
    const { membersRoot, repoRoot, settingsPath } = setupGate({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "python3 /x/other.py" }] }] },
    });
    installOwnerGateHook(ID, { membersRoot, repoRoot });
    const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const cmds = (s.hooks.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>)
      .flatMap((e) => e.hooks.map((h) => h.command));
    expect(cmds.filter((c) => c.includes("other.py"))).toHaveLength(1);
    expect(cmds.filter((c) => c.includes("telegram-owner-gate.py"))).toHaveLength(1);
  });

  test("★repair 는 이미 배선된 멤버만★ — 안 깔린 멤버엔 새로 깔지 않는다", () => {
    const { membersRoot, repoRoot, settingsPath } = setupGate({ hooks: {} });
    repairOwnerGateHook(ID, { membersRoot, repoRoot });
    expect(readFileSync(settingsPath, "utf-8")).not.toContain("telegram-owner-gate.py");
  });
});
