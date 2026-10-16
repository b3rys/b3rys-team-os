import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cogsActivityArgs } from "./cogsActivity";
import { handleMessage, resetChatThreads, tgEdit, tgSend } from "./bridge";

// All credentials and paths below are synthetic. Tests use mock HTTP only.
const command = 'curl --header "X-Private: fixture_header_value" --data fixture_body https://user:fixture_password@example.com/private?token=fixture_token';
const fixtures = [
  { item: { type: "commandExecution", command }, args: { target: "curl" } },
  { item: { type: "commandExecution", command: ["curl", "--header", "X-Private: fixture_header_value", "https://example.com/?token=fixture_token"] }, args: { target: "curl" } },
  { item: { command: `env API_KEY=fixture_env /usr/bin/curl --header X-Private:fixture_header_value` }, args: { target: "curl" } },
  { item: { command: ["/bin/zsh", "-lc", command] }, args: { target: "zsh" } },
  { item: { command: "git status --porcelain /private/work/fixture_file" }, args: { target: "git status" } },
  { item: { command: "bun test /private/work/fixture_file" }, args: { target: "bun test" } },
  { item: { command: "curl test fixture_header_value" }, args: { target: "curl" } },
  { item: { command: "cat /private/work/readme.md" }, args: { target: "readme.md" } },
  { item: { type: "fileChange", changes: [{ path: "/private/work/file.swift" }] }, args: { target: "file.swift" } },
  { item: { type: "fileChange", changes: [{ path: "/private/work/a.swift" }, { path: "/private/work/b.swift" }] }, args: { count: 2 } },
  { item: { type: "webSearch", action: { type: "openPage", url: "https://user:fixture_password@example.com/private?token=fixture_token" } }, args: { target: "example.com" } },
  { item: { type: "webSearch", query: "docs Authorization: Bearer fixture_header_value" }, args: { target: "docs [redacted]" } },
];

for (const [index, { item, args }] of fixtures.entries()) {
  test(`activity privacy: structured fixture ${index + 1} keeps only safe target/count`, () => {
    const actual = cogsActivityArgs(item);
    expect(actual).toEqual(args);
    expect(Object.keys(actual).every(key => key === "target" || key === "count")).toBe(true);
    expect(actual).not.toHaveProperty("command");
    expect(actual).not.toHaveProperty("query");
  });
}

test("activity privacy: combined executable/subcommand target stays within 45 characters", () => {
  expect(Array.from(cogsActivityArgs({ command: `${"x".repeat(60)} test` }).target ?? "").length).toBeLessThanOrEqual(45);
});

let previousFirstContact: string | undefined;
let home: string;
beforeEach(() => {
  resetChatThreads();
  previousFirstContact = process.env.B3OS_FIRST_CONTACT_DIR;
  home = mkdtempSync(join(tmpdir(), "cogs-privacy-"));
  process.env.B3OS_FIRST_CONTACT_DIR = home;
});
afterEach(() => {
  if (previousFirstContact === undefined) delete process.env.B3OS_FIRST_CONTACT_DIR;
  else process.env.B3OS_FIRST_CONTACT_DIR = previousFirstContact;
  resetChatThreads();
});

for (const failEdit of [false, true]) {
  test(`activity privacy: handleMessage → HTTP ${failEdit ? "failed edit and replacement send" : "edit"} never sends raw activity or legacy args`, async () => {
    const requests: { url: string; body: Record<string, any> }[] = [];
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json(failEdit && String(url).endsWith("/editMessageText")
        ? { ok: false, error_code: 400, description: "fixture edit failure" }
        : { ok: true, result: { message_id: 6 } });
    }) as typeof fetch;
    const transport = { apiBase: "http://app.invalid", plainOnly: true };
    const result = await handleMessage(93, "question", 5, {
      agentId: "privacyprobe", codexHome: home, workdir: home, sandbox: "read-only",
      channel: { kind: "b3chat", apiBase: transport.apiBase, allowFrom: ["93"], ownerChat: "93" },
      sendMessage: tgSend("fixture", fetchFn, transport),
      editMessage: tgEdit("fixture", fetchFn, transport),
      runTurn: async options => {
        for (const [i, { item }] of fixtures.entries()) {
          // Deliberately unsafe legacy display line must never be used on cogs.
          options.onActivity?.(`legacy ${command}`, `privacy-${i}`, item);
          await Bun.sleep(425);
        }
        return { ok: true, reply: "model answer", detail: "ok", elapsedMs: 1 };
      },
    });
    expect(result.turnOk).toBe(true);
    const activityRequests = requests.filter(r => r.body.cogs_activity_code);
    expect(activityRequests.length).toBeGreaterThanOrEqual(fixtures.length);
    for (const { args } of fixtures) {
      expect(activityRequests.map(r => r.body.cogs_activity_args)).toContainEqual(args);
    }
    expect(activityRequests.some(r => r.url.endsWith("/editMessageText"))).toBe(true);
    expect(activityRequests.some(r => r.url.endsWith("/sendMessage"))).toBe(failEdit);
    for (const { body } of requests) {
      expect(body).not.toHaveProperty("command");
      expect(body).not.toHaveProperty("query");
      expect(body).not.toHaveProperty("cogs_activity");
      if (body.cogs_activity_args) {
        expect(Object.keys(body.cogs_activity_args).every(key => key === "target" || key === "count")).toBe(true);
        expect(body.cogs_activity_args).not.toHaveProperty("command");
        expect(body.cogs_activity_args).not.toHaveProperty("query");
      }
      const encoded = JSON.stringify(body);
      for (const privateValue of ["fixture_header_value", "fixture_body", "fixture_password", "fixture_token", "fixture_env", "fixture_file", "/private/work", "--header", "legacy "]) {
        expect(encoded).not.toContain(privateValue);
      }
      expect(body.text === "" || body.text === "model answer").toBe(true);
    }
  }, 15000);
}
