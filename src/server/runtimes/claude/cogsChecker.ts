import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import policy from "./cogsCheckerPolicy.json";
import { claudeCogsEnvironment } from "./cogsEnvironment";
import { redactSecrets } from "../../lib/redactSecrets";

export interface CheckerInput {
  tool: string;
  normalizedPath: string;
  input: Record<string, unknown>;
  secretPath?: boolean;
}
export interface CheckerResult {
  verdict: "allow" | "deny";
  reason: string;
  model: string;
  promptVersion: string;
}
export type CheckerRunner = (prompt: string, signal: AbortSignal) => Promise<string>;

export function checkerArguments(): string[] {
  return ["-p", "--model", policy.model, "--output-format", "text",
    "--safe-mode", "--setting-sources", "", "--settings", "{}",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--tools", "", "--allowedTools", "", "--no-session-persistence",
    "--system-prompt", policy.system];
}

// Never put candidate input in argv, stderr, or an execution log.
export const runCheckerCli: CheckerRunner = async (prompt, signal) => {
  const cwd = mkdtempSync(join(tmpdir(), "cogs-checker-"));
  try {
    return await new Promise<string>((resolve, reject) => {
      if (signal.aborted) { reject(new Error("aborted")); return; }
      const child = spawn(process.env.CLAUDE_BIN || "claude", checkerArguments(), {
        cwd, env: claudeCogsEnvironment(process.env), stdio: ["pipe", "pipe", "ignore"],
      });
      let output = "", oversized = false;
      const abort = () => child.kill("SIGKILL");
      signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", chunk => {
        if (output.length + chunk.length > 65536) { oversized = true; abort(); }
        else output += chunk.toString();
      });
      child.once("error", reject);
      child.once("close", code => {
        signal.removeEventListener("abort", abort);
        if (code !== 0 || oversized || signal.aborted) reject(new Error("checker_failed"));
        else resolve(output);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
};

function masked(value: unknown, secretPath: boolean, key = ""): unknown {
  if (/password|passwd|token|secret|credential|api[_-]?key|access[_-]?key|authorization|private[_-]?key/i.test(key)) return "<redacted>";
  if (secretPath && /^(content|old_string|new_string|text)$/i.test(key)) return "<redacted-secret-file-content>";
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(item => masked(item, secretPath));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, masked(v, secretPath, k)]));
  return value;
}

export async function checkCogsOperation(input: CheckerInput, runner: CheckerRunner = runCheckerCli,
  timeoutMs = policy.timeoutMs): Promise<CheckerResult> {
  const result = (verdict: CheckerResult["verdict"], reason: string): CheckerResult =>
    ({ verdict, reason, model: policy.model, promptVersion: policy.promptVersion });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!isAbsolute(input.normalizedPath) || !input.tool || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
      return result("deny", "checker_invalid_input");
    const prompt = JSON.stringify(masked({ tool: input.tool, normalizedPath: input.normalizedPath, input: input.input }, !!input.secretPath));
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, Math.min(timeoutMs, policy.timeoutMs));
    });
    const output = await Promise.race([runner(prompt, controller.signal), timeout]);
    const parsed = JSON.parse(output);
    if (!parsed || Array.isArray(parsed) || !["allow", "deny"].includes(parsed.verdict)
      || typeof parsed.reason !== "string" || !parsed.reason.trim() || /[\r\n]/.test(parsed.reason))
      return result("deny", "checker_invalid_output");
    return result(parsed.verdict, redactSecrets(parsed.reason).slice(0, 300));
  } catch {
    return result("deny", controller.signal.aborted ? "checker_timeout" : "checker_error");
  } finally { if (timer) clearTimeout(timer); }
}
