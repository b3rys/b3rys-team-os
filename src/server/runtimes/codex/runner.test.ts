import { describe, expect, test } from "bun:test";
import { buildCodexArgs, extractSessionId, redactPromptArg } from "./runner";

describe("codex runner args", () => {
  test("new turn uses read-only sandbox and terminates options before prompt", () => {
    const args = buildCodexArgs({ prompt: "--dangerously-bypass-approvals-and-sandbox" }, "/tmp/last.txt");
    expect(args.slice(0, 4)).toEqual(["exec", "--ignore-user-config", "-s", "read-only"]);
    expect(args).toContain("--json");
    expect(args).toContain("--skip-git-repo-check");
    expect(args.slice(-2)).toEqual(["--", "--dangerously-bypass-approvals-and-sandbox"]);
  });

  test("new turn preserves explicit sandbox and model", () => {
    const args = buildCodexArgs(
      { prompt: "hi", sandbox: "workspace-write", model: "gpt-test" },
      "/tmp/last.txt",
    );
    expect(args.slice(0, 4)).toEqual(["exec", "--ignore-user-config", "-s", "workspace-write"]);
    expect(args).toContain("-m");
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-test");
  });

  test("new workspace-write turn can enable network access", () => {
    const args = buildCodexArgs(
      { prompt: "hi", sandbox: "workspace-write", networkAccess: true },
      "/tmp/last.txt",
    );
    expect(args.slice(0, 4)).toEqual(["exec", "--ignore-user-config", "-s", "workspace-write"]);
    expect(args).toContain("-c");
    expect(args).toContain("sandbox_workspace_write.writable_roots=[]");
    expect(args).toContain("sandbox_workspace_write.network_access=true");
  });

  test("new workspace-write turn code-enforces writable roots from cwd", () => {
    const args = buildCodexArgs(
      { prompt: "hi", sandbox: "workspace-write", cwd: "/tmp/codex-work" },
      "/tmp/last.txt",
    );
    expect(args).toContain('sandbox_workspace_write.writable_roots=["/tmp/codex-work"]');
  });

  test("resume does not pass -s, forces configured sandbox, and terminates options before prompt", () => {
    const args = buildCodexArgs(
      { prompt: "-starts-with-dash", resumeSessionId: "sess-1", sandbox: "danger-full-access" },
      "/tmp/last.txt",
    );
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "sess-1"]);
    expect(args).not.toContain("-s");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("-c");
    expect(args[args.indexOf("-c") + 1]).toBe('sandbox_mode="danger-full-access"');
    expect(args.slice(-2)).toEqual(["--", "-starts-with-dash"]);
  });

  test("resume defaults to read-only even though -s is unavailable for the resume subcommand", () => {
    const args = buildCodexArgs({ prompt: "hi", resumeSessionId: "sess-1" }, "/tmp/last.txt");
    expect(args).not.toContain("-s");
    expect(args[args.indexOf("-c") + 1]).toBe('sandbox_mode="read-only"');
  });

  test("resume workspace-write turn preserves network access override", () => {
    const args = buildCodexArgs(
      {
        prompt: "hi",
        resumeSessionId: "sess-1",
        sandbox: "workspace-write",
        networkAccess: true,
        writableRoots: ["/tmp/codex-work"],
      },
      "/tmp/last.txt",
    );
    expect(args).not.toContain("-s");
    expect(args).toContain('sandbox_mode="workspace-write"');
    expect(args).toContain('sandbox_workspace_write.writable_roots=["/tmp/codex-work"]');
    expect(args).toContain("sandbox_workspace_write.network_access=true");
  });

  test("spawn trace redacts prompt while preserving codex args", () => {
    const args = buildCodexArgs({ prompt: "private message", sandbox: "workspace-write" }, "/tmp/last.txt");
    expect(redactPromptArg(args)).toEqual([
      "exec",
      "--ignore-user-config",
      "-s",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.writable_roots=[]",
      "--json",
      "--skip-git-repo-check",
      "-o",
      "/tmp/last.txt",
      "--",
      "[prompt redacted]",
    ]);
  });
});

describe("extractSessionId", () => {
  test("reads thread_id first", () => {
    expect(extractSessionId('{"thread_id":"t-1"}\n')).toBe("t-1");
  });

  test("accepts known session id variants", () => {
    expect(extractSessionId('{"session_id":"s-1"}')).toBe("s-1");
    expect(extractSessionId('{"sessionId":"s-2"}')).toBe("s-2");
    expect(extractSessionId('{"session":{"id":"s-3"}}')).toBe("s-3");
    expect(extractSessionId('{"thread":{"id":"t-2"}}')).toBe("t-2");
  });

  test("skips invalid and non-json lines", () => {
    const jsonl = ["not json", "{broken", '{"event":"noop"}', '{"thread_id":"t-ok"}'].join("\n");
    expect(extractSessionId(jsonl)).toBe("t-ok");
  });
});
