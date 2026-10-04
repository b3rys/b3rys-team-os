// 사전점검이 실행해 볼 codex = 브리지가 실제로 돌릴 codex(CODEX_BIN 우선).
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCodexBin } from "./runtimeAuth";

function fakeBin(): string {
  const p = join(mkdtempSync(join(tmpdir(), "b3os-codexbin-")), "codex");
  writeFileSync(p, "#!/bin/sh\necho codex-test\n");
  chmodSync(p, 0o755);
  return p;
}

test("CODEX_BIN 이 있으면 PATH 의 codex 보다 먼저 — 브리지가 실제로 돌릴 파일을 잰다", () => {
  const bin = fakeBin();
  // PATH 에 다른 codex 가 있어도(이 기계: /opt/homebrew/bin/codex) CODEX_BIN 을 고른다
  expect(resolveCodexBin({ CODEX_BIN: bin })).toBe(bin);
});

test("CODEX_BIN 경로에 파일이 없으면 예전 순서로 떨어진다(없는 경로를 고르지 않는다)", () => {
  const missing = join(tmpdir(), "no-such-dir-b3os", "codex");
  expect(resolveCodexBin({ CODEX_BIN: missing })).not.toBe(missing);
});
