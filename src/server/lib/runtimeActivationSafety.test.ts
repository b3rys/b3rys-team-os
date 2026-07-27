import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

describe("runtime activation safety", () => {
  test("Hermes reactivation force-corrects stale false TELEGRAM_REQUIRE_MENTION", () => {
    const script = readFileSync(
      join(import.meta.dir, "../runtimes/hermes/activate-hermes-agent.sh"),
      "utf-8",
    );
    expect(script).toContain('env["TELEGRAM_REQUIRE_MENTION"] = "true"');
    expect(script).not.toContain('env.setdefault("TELEGRAM_REQUIRE_MENTION"');
  });

  test("OpenClaw preflight detail documents both supported auth layouts", () => {
    const source = readFileSync(join(import.meta.dir, "runtimeAuth.ts"), "utf-8");
    expect(source).toContain("openclaw 인증 확인됨(전역 openclaw.json auth.profiles 또는 per-agent auth-profiles.json)");
    expect(source).toContain("openclaw 미인증(전역 openclaw.json auth.profiles가 비어 있고 per-agent auth-profiles.json도 없음)");
  });

  test("Hermes activation updates terminal.cwd even when backend is between terminal and cwd", () => {
    const script = readFileSync(
      join(import.meta.dir, "../runtimes/hermes/activate-hermes-agent.sh"),
      "utf-8",
    );
    const match = script.match(/def _set_terminal_cwd\(src, cwd\):[\s\S]*?\nnew, n = _set_terminal_cwd\(txt, hermes_cwd\)/);
    expect(match).not.toBeNull();

    const dir = mkdtempSync(join(tmpdir(), "b3os-hermes-cwd-"));
    try {
      const input = join(dir, "input.yaml");
      const output = join(dir, "output.yaml");
      writeFileSync(
        input,
        ["terminal:", "  backend: local", "  cwd: .", "  timeout: 180", "messaging:", "  transport: telegram", ""].join("\n"),
      );
      const py = [
        "import pathlib, re, sys",
        "txt = pathlib.Path(sys.argv[1]).read_text()",
        "hermes_cwd = sys.argv[3]",
        match![0],
        "assert n == 1, n",
        "pathlib.Path(sys.argv[2]).write_text(new)",
      ].join("\n");
      const run = spawnSync("python3", ["-c", py, input, output, "/Users/gdmini/Development/hermes"], { encoding: "utf-8" });
      expect(run.status, run.stderr || run.stdout).toBe(0);
      expect(readFileSync(output, "utf-8")).toBe(
        ["terminal:", "  backend: local", "  cwd: /Users/gdmini/Development/hermes", "  timeout: 180", "messaging:", "  transport: telegram", ""].join("\n"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Hermes activation expands HERMES_CWD=~/path under bash and zsh", () => {
    const source = readFileSync(
      join(import.meta.dir, "../runtimes/hermes/activate-hermes-agent.sh"),
      "utf-8",
    );
    const caseBlock = source.match(/case "\$HERMES_CWD" in[\s\S]*?\nesac/)?.[0];
    expect(caseBlock).toBeDefined();
    const snippet = [
      'HOME="/home/tester"',
      'HERMES_CWD="~/foo"',
      caseBlock!,
      'printf "%s" "$HERMES_CWD"',
    ].join("\n");
    for (const shell of ["bash", "zsh"]) {
      const run = spawnSync(shell, ["-c", snippet], { encoding: "utf-8" });
      expect(run.status, `${shell}: ${run.stderr || run.stdout}`).toBe(0);
      expect(run.stdout).toBe("/home/tester/foo");
    }
  });
});
