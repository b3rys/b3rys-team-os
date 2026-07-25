import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hermesProtectedProfiles, isHermesMemberProtected } from "./hermesBaseProfile";

describe("Hermes base profile defense-in-depth", () => {
  test("공유 auth 심링크 원본을 설정과 독립적으로 탐지하고 대소문자 없이 보호", () => {
    const root = mkdtempSync(join(tmpdir(), "hermes-base-"));
    mkdirSync(join(root, "zzbase"));
    mkdirSync(join(root, "member"));
    writeFileSync(join(root, "zzbase", "auth.json"), "{}");
    symlinkSync(join(root, "zzbase", "auth.json"), join(root, "member", "auth.json"));
    const state = hermesProtectedProfiles(root);
    expect(state.ambiguous).toBe(false);
    expect(state.names.has("zzbase")).toBe(true);
  });

  test("공유 원본이 모호하면 destructive 경로가 전체 보호하도록 ambiguous", () => {
    const root = mkdtempSync(join(tmpdir(), "hermes-base-"));
    for (const profile of ["one", "two"]) {
      mkdirSync(join(root, profile));
      writeFileSync(join(root, profile, "auth.json"), "{}");
    }
    expect(hermesProtectedProfiles(root).ambiguous).toBe(true);
    expect(isHermesMemberProtected("hermes_agent", "some-member", root)).toBe(true);
    expect(isHermesMemberProtected("claude_channel", "some-member", root)).toBe(false);
    expect(isHermesMemberProtected("codex", "some-member", root)).toBe(false);
  });
});
