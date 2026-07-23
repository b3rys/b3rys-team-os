// 공개 릴리즈는 /scripts/ 를 제외한다(make-public-release.sh). 그래서 스케줄러 allowlist 의
// 커맨드(scripts/*.ts)는 공개 클론에 존재하지 않는다 — 그대로 spawn 하면 원인 모를 실패로 끝난다.
// 이 테스트는 "없으면 없다고 말한다"를 못 박는다(조용한 실패 금지).
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXEC_ALLOWLIST, isExecSpecAvailable, execSpecScriptPath, type ExecSpec } from "./core";

function fakeRepo(withScripts: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "b3os-exec-avail-"));
  if (withScripts.length) mkdirSync(join(root, "scripts"), { recursive: true });
  for (const s of withScripts) writeFileSync(join(root, s), "// stub\n");
  return root;
}

describe("execSpecScriptPath — argv 에서 스크립트 경로를 뽑는다", () => {
  test("bun run scripts/x.ts → scripts/x.ts", () => {
    const spec: ExecSpec = { command: ["bun", "run", "scripts/x.ts"], timeoutMs: 1000, label: "t" };
    expect(execSpecScriptPath(spec)).toBe("scripts/x.ts");
  });

  test("인자가 뒤에 붙어도 스크립트를 찾는다", () => {
    const spec: ExecSpec = { command: ["bun", "run", "scripts/w.ts", "kanban"], timeoutMs: 1000, label: "t" };
    expect(execSpecScriptPath(spec)).toBe("scripts/w.ts");
  });
});

describe("isExecSpecAvailable — 설치본에 스크립트가 실제로 있는가", () => {
  const spec: ExecSpec = { command: ["bun", "run", "scripts/task-review-ping.ts"], timeoutMs: 1000, label: "t" };

  test("스크립트가 있으면 available", () => {
    const root = fakeRepo(["scripts/task-review-ping.ts"]);
    expect(isExecSpecAvailable(spec, root)).toBe(true);
  });

  // ★핵심 회귀 가드: 공개 클론(= /scripts/ 없음)에서 available=false 여야 한다.
  //   true 로 새면 없는 파일을 spawn 해서 "스케줄러가 그냥 안 돈다"로 끝난다.
  test("★공개 클론처럼 /scripts/ 가 없으면 available=false★", () => {
    const root = fakeRepo([]); // /scripts/ 자체가 없음 = 공개 릴리즈 상태
    expect(isExecSpecAvailable(spec, root)).toBe(false);
  });

  test("스크립트 파일에 의존하지 않는 커맨드는 available", () => {
    const noScript: ExecSpec = { command: ["echo", "hi"], timeoutMs: 1000, label: "t" };
    expect(isExecSpecAvailable(noScript, fakeRepo([]))).toBe(true);
  });
});

describe("EXEC_ALLOWLIST 전 항목이 가용성 판정 대상이다", () => {
  test("모든 allowlist 커맨드에서 스크립트 경로를 뽑을 수 있다(판정 누락 없음)", () => {
    const keys = Object.keys(EXEC_ALLOWLIST);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      const spec = EXEC_ALLOWLIST[k]!;
      expect(execSpecScriptPath(spec)).toBeDefined();
    }
  });

  test("공개 클론(스크립트 없음)에서는 allowlist 전부 unavailable 로 판정된다", () => {
    const root = fakeRepo([]);
    for (const k of Object.keys(EXEC_ALLOWLIST)) {
      expect(isExecSpecAvailable(EXEC_ALLOWLIST[k]!, root)).toBe(false);
    }
  });
});
