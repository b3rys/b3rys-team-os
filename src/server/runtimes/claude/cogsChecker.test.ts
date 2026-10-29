import { test, expect } from "bun:test";
import { checkCogsOperation, checkerArguments } from "./cogsChecker";
const input = { tool: "Write", normalizedPath: "/fixture/note.txt", input: { content: "hello" } };

test("allow preserves verdict, reason and audit model/version", async () => {
  const result = await checkCogsOperation(input, async () => '{"verdict":"allow","reason":"ordinary note"}');
  expect(result).toEqual({ verdict: "allow", reason: "ordinary note", model: "sonnet", promptVersion: "cogs-write-check-v1" });
});
test("explicit deny", async () => {
  expect((await checkCogsOperation(input, async () => '{"verdict":"deny","reason":"destructive"}')).verdict).toBe("deny");
});
test("timeout denies and aborts runner", async () => {
  let signal: AbortSignal | undefined;
  const result = await checkCogsOperation(input, async (_, s) => { signal = s; return await new Promise(() => {}); }, 5);
  expect(result.verdict).toBe("deny"); expect(result.reason).toBe("checker_timeout"); expect(signal?.aborted).toBe(true);
});
test("broken JSON and runtime errors deny", async () => {
  for (const response of ["not json", '```json\n{"verdict":"allow","reason":"ok"}\n```'])
    expect((await checkCogsOperation(input, async () => response)).verdict).toBe("deny");
  expect((await checkCogsOperation(input, async () => { throw new Error("synthetic failure"); })).verdict).toBe("deny");
});
test("missing or invalid verdict/reason deny", async () => {
  for (const response of ['{"reason":"ok"}', '{"verdict":"allow"}', '{"verdict":"ALLOW","reason":"ok"}', 'null', '[]', '{"verdict":"allow","reason":""}', '{"verdict":"allow","reason":"a\\nb"}'])
    expect((await checkCogsOperation(input, async () => response)).verdict).toBe("deny");
});
test("full nonsecret input is retained; structured secrets and secret file content masked", async () => {
  let received = "";
  await checkCogsOperation({ ...input, secretPath: true, input: { content: "synthetic sensitive content", password: "synthetic password", access_key: "synthetic access", accessKey: "synthetic access camel", nested: { token: "synthetic token" }, mode: "append" } }, async p => { received = p; return '{"verdict":"deny","reason":"unknown"}'; });
  expect(received).not.toContain("synthetic"); expect(JSON.parse(received).input.mode).toBe("append");
  await checkCogsOperation(input, async p => { received = p; return '{"verdict":"allow","reason":"ok"}'; });
  expect(JSON.parse(received).input).toEqual(input.input);
});
test("checker CLI has no tools, MCP servers, persisted session or workspace settings", () => {
  const args = checkerArguments();
  for (const [key, value] of [["--tools", ""], ["--allowedTools", ""], ["--setting-sources", ""], ["--mcp-config", '{"mcpServers":{}}'], ["--model", "sonnet"]] as const)
    expect(args[args.indexOf(key) + 1]).toBe(value);
  expect(args).toContain("--safe-mode"); expect(args).toContain("--strict-mcp-config"); expect(args).toContain("--no-session-persistence");
});
