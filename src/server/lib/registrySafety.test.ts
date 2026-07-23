import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { consumeForcedEmptyRegistry, writeRegistrySafely } from "./registrySafety";

describe("writeRegistrySafely", () => {
  test("rejects a registry symlink that escapes the repository boundary", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-symlink-"));
    const repo = join(dir, "repo");
    const outside = join(dir, "live-agents.json");
    writeFileSync(outside, '[{"id":"live"}]\n');
    mkdirSync(repo);
    const link = join(repo, "agents.json");
    symlinkSync(outside, link);
    expect(() => writeRegistrySafely(link, [], { forceEmpty: true, repoRoot: repo })).toThrow("registry_symlink_escape");
    expect(JSON.parse(readFileSync(outside, "utf-8"))).toEqual([{ id: "live" }]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects a registry escape through a symlinked parent directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-parent-symlink-"));
    const repo = join(dir, "repo");
    const outside = join(dir, "live");
    mkdirSync(repo);
    mkdirSync(outside);
    writeFileSync(join(outside, "agents.json"), '[{"id":"live"}]\n');
    symlinkSync(outside, join(repo, "state"));
    const path = join(repo, "state", "agents.json");
    expect(() => writeRegistrySafely(path, [{ id: "evil" }], { repoRoot: repo })).toThrow("registry_symlink_escape");
    expect(JSON.parse(readFileSync(join(outside, "agents.json"), "utf-8"))).toEqual([{ id: "live" }]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("backs up and rejects non-empty to [] without explicit force", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-empty-"));
    const path = join(dir, "agents.json");
    writeFileSync(path, '[{"id":"one"}]\n');
    expect(() => writeRegistrySafely(path, [], { repoRoot: dir })).toThrow("registry_empty_requires_force");
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual([{ id: "one" }]);
    expect(readdirSync(dir).some((name) => name.startsWith("agents.json.bak-empty-"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("allows an explicit forced empty write and keeps a backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-force-empty-"));
    const path = join(dir, "agents.json");
    writeFileSync(path, '[{"id":"one"}]\n');
    writeRegistrySafely(path, [], { forceEmpty: true, repoRoot: dir });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual([]);
    expect(JSON.parse(readFileSync(`${path}.bak`, "utf-8"))).toEqual([{ id: "one" }]);
    expect(consumeForcedEmptyRegistry(path)).toBe(true);
    expect(consumeForcedEmptyRegistry(path)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects approval after the forced empty file is rewritten", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-force-empty-rewrite-"));
    const path = join(dir, "agents.json");
    writeFileSync(path, '[{"id":"one"}]\n');
    writeRegistrySafely(path, [], { forceEmpty: true, repoRoot: dir });
    writeFileSync(path, "[]\n");
    expect(consumeForcedEmptyRegistry(path)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
