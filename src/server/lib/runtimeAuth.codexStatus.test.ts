import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkCodexCliStatus, supportedCodexVersion } from "./runtimeAuth";

test("Codex app-server minimum version rejects old, unknown and prerelease versions", () => {
  for (const v of ["codex-cli 0.146.9", "codex-cli 0.147.0-alpha", "unexpected"]) expect(supportedCodexVersion(v)).toBe(false);
  for (const v of ["codex-cli 0.147.0", "codex-cli 0.161.0", "codex-cli 1.0.0"]) expect(supportedCodexVersion(v)).toBe(true);
});

test("Login status determines readiness without an auth file; failed status blocks and hides raw output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-status-"));
  const bin = join(dir, "codex");
  try {
    for (const code of [0, 1]) {
      writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'codex-cli 0.147.0'; exit 0; fi\necho 'private-account-marker' >&2\nexit ${code}\n`);
      chmodSync(bin, 0o755);
      const result = await checkCodexCliStatus(bin);
      expect(result.loggedIn).toBe(code === 0);
      expect(JSON.stringify(result)).not.toContain("private-account-marker");
    }
    writeFileSync(bin, "#!/bin/sh\necho 'codex-cli 0.146.9'\n");
    expect(await checkCodexCliStatus(bin)).toMatchObject({ loggedIn: false, detail: "codex 최소 버전 0.147.0 필요" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("An unresponsive status is reported as unconfirmed, with a bounded wait", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-status-timeout-"));
  const bin = join(dir, "codex");
  try {
    writeFileSync(bin, `#!${process.execPath}\nif (process.argv[2] === '--version') console.log('codex-cli 0.147.0'); else await new Promise(r => setTimeout(r, 5000));\n`);
    chmodSync(bin, 0o755);
    expect(await checkCodexCliStatus(bin, 30)).toMatchObject({ loggedIn: false, detail: "codex 로그인 상태 확인 시간 초과" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
