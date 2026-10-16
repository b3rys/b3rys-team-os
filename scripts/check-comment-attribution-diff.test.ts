import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addedLineNumbers, GUIDANCE, scanAddedComments } from "./check-comment-attribution";

test("zero-context hunks include additions only", () => {
  expect([...addedLineNumbers('+++ b/src/file.ts\n@@ -2,0 +3,2 @@\n+first\n+second\n@@ -8 +10 @@\n-old\n+new\n\\ No newline at end of file')]).toEqual([3, 4, 10]);
});

test("historical attribution fails only when added; old lines and intentional values pass", () => {
  const cwd = mkdtempSync(join(tmpdir(), "attribution-diff-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const commit = () => { git("add", "."); git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"); };
  // Source: a697205^, src/server/bus/collectionDeadline.ts:285.
  const bad = "// ★--individual = 확정이 아니라 '사실로 반박 가능한 힌트' 다.★ (dbak 리뷰 2026-07-17, GD 지시로 도입)";
  const padding = Array.from({length: 20}, (_, i) => `const stable${i} = ${i};`).join("\n");
  const script = resolve("scripts/check-comment-attribution.ts");
  try {
    git("init", "-q"); mkdirSync(join(cwd, "src"));
    const file = join(cwd, "src", 'space 이름.ts');
    writeFileSync(file, `${bad}\nconst value = 1;\n${padding}\n`); commit();
    const base = git("rev-parse", "HEAD").trim();
    writeFileSync(file, `${bad}\nconst value = 2;\n// 팀장 chat_id 를 설정에서 읽는다\nconst example = "dbak 리뷰";\n${padding}\n`); commit();
    expect(scanAddedComments(base, "HEAD", cwd)).toHaveLength(0);
    writeFileSync(file, `${bad}\nconst value = 2;\n${bad}\n${padding}\n`); commit();
    expect(scanAddedComments(base, "HEAD", cwd)).toEqual([{ file: 'src/space 이름.ts', line: 3, text: bad }]);
    const result = spawnSync(process.execPath, [script, "--diff", base], { cwd, encoding: "utf8" });
    expect(result.status).toBe(3); expect(result.stderr).toContain(GUIDANCE);
    // A pure rename does not turn unchanged legacy comments into new additions.
    const beforeRename = git("rev-parse", "HEAD").trim();
    git("mv", 'src/space 이름.ts', 'src/renamed.ts'); commit();
    expect(scanAddedComments(beforeRename, "HEAD", cwd)).toHaveLength(0);
    expect(scanAddedComments(base, "HEAD", cwd)).toHaveLength(1);
    expect(scanAddedComments("HEAD", "HEAD", cwd)).toHaveLength(0);
    expect(() => scanAddedComments("missing-ref", "HEAD", cwd)).toThrow();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
