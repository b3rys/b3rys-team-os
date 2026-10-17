/** 훅을 실제 멤버 폴더와 같은 위치에 복사해 실행해야 저장소 밖에서도 그룹 설정을 찾는지 검증할 수 있다. 설정을 못 찾으면 담당자 억제가 풀린다. */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../../../..");
const HOOK_SRC = join(REPO, "hooks/telegram-progress.py");
const GROUP = "-1009999999999"; // 테스트 전용 가짜 값 — 실 chat_id 아니다

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "b3os-hook-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 훅 파일을 주어진 자리에 깔고, 그 자리에서 `_team_group_env()` 를 불러 결과를 돌려준다. */
function resolveAt(hookPath: string, env: Record<string, string>): string {
  copyFileSync(HOOK_SRC, hookPath);
  const py = [
    "import importlib.util,sys",
    `s=importlib.util.spec_from_file_location("h", ${JSON.stringify(hookPath)})`,
    "m=importlib.util.module_from_spec(s)",
    "try: s.loader.exec_module(m)",
    "except SystemExit: pass",
    "sys.stdout.write(m._team_group_env())",
  ].join("\n");
  return execFileSync("python3", ["-c", py], {
    env: { ...process.env, B3OS_ROOT: "", OWNER_GATE_GROUP: "", ...env },
    encoding: "utf-8",
  });
}

/** 저장소 루트 하나를 만들고 `.env` 에 그룹 ID 를 넣는다. */
function makeRepo(): string {
  const root = join(dir, "b3os");
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(join(root, ".env"), `TEAM_GROUP_ID=${GROUP}\n`);
  return root;
}

/** 런처가 까는 자리 — `<멤버>/.claude/hooks/telegram-progress.py`. */
function makeMemberHookPath(): string {
  const hooks = join(dir, "member", ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  return join(hooks, "telegram-progress.py");
}

describe("배포된 progress 훅의 그룹 ID 해결", () => {
  test("★B3OS_ROOT 가 있으면 배포 위치에서도 찾는다★ — 없으면 owner-skip 이 fail-open 이다", () => {
    const root = makeRepo();
    expect(resolveAt(makeMemberHookPath(), { B3OS_ROOT: root })).toBe(GROUP);
  });

  test("B3OS_ROOT 가 없으면 배포 위치에서는 못 찾는다 — 옛 배선이 죽어 있던 이유", () => {
    makeRepo();
    // 배포 위치에서 `../.env` 는 `<멤버>/.claude/.env` 라 존재하지 않는다.
    expect(resolveAt(makeMemberHookPath(), {})).toBe("");
  });

  test("★저장소 안에서 부르면 B3OS_ROOT 없이도 그대로 산다★ — 폴백을 안 깼다", () => {
    const root = makeRepo();
    expect(resolveAt(join(root, "hooks", "telegram-progress.py"), {})).toBe(GROUP);
  });

  test("★공개 저장소 소스에 실 chat_id 가 없다★", () => {
    // 텔레그램 그룹 chat_id 는 `-100` 으로 시작하는 긴 음수다. 소스에 박히면 공개 노출이다.
    expect(readFileSync(HOOK_SRC, "utf-8")).not.toMatch(/-100\d{10,}/);
  });
});
