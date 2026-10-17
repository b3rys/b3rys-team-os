import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const [title, expected] of [["feat: add view", "0.7.0"], ["fix: reconnect", "0.6.2"], [null, null]] as const) {
  test(`dry-run fixture: ${expected ?? "zero PRs"}`, () => {
    const temp = mkdtempSync(join(tmpdir(), "release-fixture-"));
    try {
      const prs = join(temp, "prs.json"), context = join(temp, "context.json"), out = join(temp, "out");
      writeFileSync(prs, JSON.stringify(title ? [{ number: 1, title, labels: [] }] : []));
      writeFileSync(context, JSON.stringify({ agents: [], projects: [], ownerName: "Example" }));
      const result = Bun.spawnSync(["bash", "scripts/release-cut.sh", "--prs-file", prs, "--previous", "v0.6.1", "--context-file", context, "--out", out]);
      expect(result.exitCode).toBe(0);
      if (expected) {
        expect(readFileSync(join(out, "plan.json"), "utf8")).toContain(`"version": "${expected}"`);
        expect(readdirSync(out).sort()).toEqual(["plan.json", `v${expected}.md`]);
      } else expect(existsSync(out)).toBe(false);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
}
test("publish without approval is rejected before any mutation", () => {
  const result = Bun.spawnSync(["bash", "scripts/release-cut.sh", "--publish"]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("requires human approval");
});
