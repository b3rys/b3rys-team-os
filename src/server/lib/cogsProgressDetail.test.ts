import { expect, test } from "bun:test";
import { COGS_PROGRESS_DETAIL_MAX, safeProgressDetail } from "./cogsProgressDetail";

test("safe descriptions and Unicode length cap", () => {
  expect(safeProgressDetail("  Run activity tests  ")).toBe("Run activity tests");
  expect(safeProgressDetail("cogsTyping.test.ts")).toBe("cogsTyping.test.ts");
  expect(Array.from(safeProgressDetail("시험 😀 ".repeat(30)))).toHaveLength(COGS_PROGRESS_DETAIL_MAX);
});

test("secret patterns and raw command/path material fail closed before clipping", () => {
  for (const value of ["token=fixture", "Bearer fixture", "api_key: fixture", "Read .env.local", "private key fixture", "credentials.json", "id_ed25519", "cert.pem", "key.key", "sk-fixture012345678901234567890", "/Users/private/a.ts", "src/a.ts", "C:\\private\\a.ts", "curl https://fixture", "echo $HOME", "echo hi; pwd", "Read\nsecret", "safe ".repeat(30) + "token=fixture", {}, null]) {
    expect(safeProgressDetail(value)).toBe("");
  }
});
