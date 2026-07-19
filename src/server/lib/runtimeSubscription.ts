import { spawn } from "node:child_process";
import { runCodexTurn } from "../runtimes/codex/runner";
import { codexBridgePaths } from "../runtimes/codex/launcher";
import { codexRuntimePreflight } from "../runtimes/codex/permissions";

export interface FirstModelCallResult {
  runtime: string;
  ok: boolean;
  subscriptionNeeded: boolean;
  detail: string;
}

const FIRST_MODEL_PROMPT = "Reply with exactly: ok";
const FIRST_MODEL_TIMEOUT_MS = Number(process.env.RUNTIME_FIRST_MODEL_TIMEOUT_MS ?? 60_000);

export function isSubscriptionNeededDetail(detail: string | null | undefined): boolean {
  if (!detail) return false;
  return /monthly spend limit|usage credit balance|wait for limit to reset|used 100% of your session limit|429|rate limit|quota|usage limit|insufficient_quota|billing|credit|subscription/i.test(detail);
}

function cleanDetail(detail: string): string {
  return detail.replace(/\s+/g, " ").trim().slice(-500);
}

async function runClaudeFirstModelCall(workdir?: string): Promise<FirstModelCallResult> {
  const started = Date.now();
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const env = {
      ...process.env,
      PATH: `${process.env.HOME ?? ""}/.claude/local:${process.env.HOME ?? ""}/.bun/bin:/opt/homebrew/bin:${process.env.PATH ?? ""}`,
    };
    const proc = spawn("claude", ["-p", FIRST_MODEL_PROMPT], { cwd: workdir, env, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (ok: boolean, detail: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const clean = cleanDetail(detail || `elapsed_${Date.now() - started}ms`);
      resolve({ runtime: "claude_channel", ok, subscriptionNeeded: isSubscriptionNeededDetail(clean), detail: clean });
    };
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      finish(false, `timeout_${FIRST_MODEL_TIMEOUT_MS}ms`);
    }, FIRST_MODEL_TIMEOUT_MS);
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (e) => finish(false, `spawn_error:${e.message}`));
    proc.on("close", (code) => finish(code === 0 && stdout.trim().length > 0, code === 0 ? "ok" : `exit_${code}:${stderr || stdout}`));
  });
}

export async function verifyFirstModelCall(input: { id: string; runtime: string; workspacePath?: string }): Promise<FirstModelCallResult> {
  if (input.runtime === "codex") {
    const paths = codexBridgePaths(input.id);
    const preflight = codexRuntimePreflight(
      { id: input.id, workspace_path: input.workspacePath ?? paths.workdir },
      "read-only",
      false,
    );
    if (preflight) {
      return {
        runtime: "codex",
        ok: false,
        subscriptionNeeded: false,
        detail: cleanDetail(`permission_${preflight.tier}:${preflight.rule}`),
      };
    }
    const result = await runCodexTurn({
      prompt: FIRST_MODEL_PROMPT,
      cwd: input.workspacePath ?? paths.workdir,
      codexHome: paths.codexHome,
      timeoutMs: FIRST_MODEL_TIMEOUT_MS,
    });
    return {
      runtime: "codex",
      ok: result.ok,
      subscriptionNeeded: isSubscriptionNeededDetail(result.detail),
      detail: cleanDetail(result.ok ? "ok" : result.detail),
    };
  }
  if (input.runtime === "claude_channel") return runClaudeFirstModelCall(input.workspacePath);
  return { runtime: input.runtime, ok: true, subscriptionNeeded: false, detail: "first model call not required for this runtime" };
}
