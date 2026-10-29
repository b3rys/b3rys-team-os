import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCogsPath } from "./cogsPathGate";

test("inside/outside, traversal, symlink with dot-dot, new parents, protected and secret", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cogs-path-")));
  const workspace = join(base, "work"), outside = join(base, "outside"), control = join(base, "control");
  for (const dir of [workspace, outside, control, join(outside, "deep")]) mkdirSync(dir);
  const context = { workspace, protectedPaths: [control] };
  symlinkSync(join(outside, "deep"), join(workspace, "alias"));
  symlinkSync(control, join(workspace, "control-alias"));
  symlinkSync(join(base, "missing"), join(workspace, "dangling"));
  writeFileSync(join(workspace, "file"), "fixture");
  try {
    for (const [input, kind, path] of [
      ["note.txt", "inside", join(workspace, "note.txt")],
      ["../outside/note.txt", "outside", join(outside, "note.txt")],
      ["alias/../note.txt", "outside", join(outside, "note.txt")],
      ["new/deep/note.txt", "inside", join(workspace, "new/deep/note.txt")],
      ["control-alias/config.json", "protected", join(control, "config.json")],
      ["SOUL.md", "protected", join(workspace, "SOUL.md")],
      [".env", "secret", join(workspace, ".env")],
      ["../outside/.ssh/id", "secret", join(outside, ".ssh/id")],
      ["../outside/key.pem", "secret", join(outside, "key.pem")],
    ] as const) expect(classifyCogsPath(input, context)).toEqual({ ok: true, kind, path });
    for (const input of ["dangling", "dangling/child", "file/child", "file/../note.txt", "bad\0path", ""])
      expect(classifyCogsPath(input, context)).toEqual({ ok: false, reason: "path_unresolved" });
    expect(classifyCogsPath("note.txt", { workspace: join(base, "missing"), protectedPaths: [] }).ok).toBe(false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
