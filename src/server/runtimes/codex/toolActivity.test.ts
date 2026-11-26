import { expect, test } from "bun:test";
import { toolActivityArgs, toolActivityLine } from "./toolActivity";

test("hook-style tool kind and compact target", () => {
  expect(toolActivityLine({ command: "cat /tmp/work/bridge.ts" })).toBe("읽기 · bridge.ts");
  expect(toolActivityLine({ command: ["bun", "test", "src/a.test.ts"] })).toBe("테스트 · bun test");
  expect(toolActivityLine({ changes: [{ path: "/tmp/work/note.md", kind: { type: "add" } }] })).toBe("새로 쓰기 · note.md");
  expect(toolActivityLine({ fileChanges: { "/tmp/work/a.ts": {} } })).toBe("수정 · a.ts");
  expect(toolActivityLine({ type: "webSearch", action: { queries: ["codex config"] } })).toBe("검색 · codex config");
  expect(toolActivityLine({ type: "webSearch", action: { type: "openPage", url: "https://user:fixture@example.com/private?token=fixture" } })).toBe("페이지 열기 · example.com");
});

test("Korean activity targets cover multiple files, tools and empty targets", () => {
  expect(toolActivityLine({ changes: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }] })).toBe("수정 · 파일 3개");
  expect(toolActivityLine({ type: "mcpToolCall", name: "mcp__fixture__lookup" })).toBe("실행");
  expect(toolActivityLine({ type: "web_search", queries: ["판교", "오늘 날씨"] })).toBe("검색 · 판교 · 오늘 날씨");
  expect(toolActivityLine({ type: "webSearch", query: "" })).toBe("검색");
  expect(toolActivityLine({ type: "webSearch", queries: [] })).toBe("검색");
  expect(toolActivityLine({ type: "webSearch", action: { type: "openPage", url: "" } })).toBe("페이지 열기");
  expect(toolActivityLine({ command: "" })).toBe("도구");
  expect(toolActivityLine({ command: [] })).toBe("실행");
  expect(toolActivityLine({ command: "cat" })).toBe("읽기");
  expect(toolActivityLine({ changes: [{ kind: { type: "add" } }] })).toBe("수정");
  expect(toolActivityLine({ changes: [{}] })).toBe("수정");
  expect(toolActivityLine({ type: "mcpToolCall" })).toBe("실행");
  expect(toolActivityLine(null)).toBe("도구");
});

test("command arguments, assignments, credentials and full paths are withheld", () => {
  // Synthetic fixtures only. No process environment values are read or printed.
  const inputs = [
    { command: 'API_KEY=fixture_value curl -H "Authorization: Bearer fixture_value" /tmp/private/data' },
    { command: 'echo fixture_value' },
    { command: 'env API_KEY="fixture_value with spaces" bun test' },
    { type: "webSearch", query: 'Authorization: Bearer fixture_value' },
    { type: "webSearch", query: 'password: "fixture_value with spaces"' },
    { type: "webSearch", query: 'config TOKEN="fixture_value" /tmp/private/data $PRIVATE_ENV secret: fixture_value' },
    { type: "webSearch", query: "config ABCDEFGHIJKLMNOPQRSTUVWXYZ123456" },
  ];
  for (const input of inputs) {
    const line = toolActivityLine(input);
    expect(!line.includes("fixture_value") && !line.includes("/tmp/private") && !line.includes("PRIVATE_ENV") && !line.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ123456")).toBe(true);
  }
  expect(toolActivityLine({ command: 'API_KEY=fixture_value bun test' })).toBe("테스트 · bun test");
});

test("app-server start/completion notifications pass structured targets to the formatter", async () => {
  const { CodexAppServerClient } = await import("./appServerClient");
  const client = new CodexAppServerClient();
  const internal = client as unknown as {
    threadId: string;
    notify: () => Promise<void>;
    handleNotification: (method: string, params: unknown) => void;
  };
  internal.threadId = "fixture-thread";
  internal.notify = async () => {};
  const targets: string[] = [];
  const result = client.runTurn("fixture", { onActivity: (_line, _id, item) => targets.push(toolActivityLine(item)) }, 1000);
  internal.handleNotification("item/started", { item: { id: "s1", type: "webSearch" } });
  internal.handleNotification("item/completed", { item: { id: "s1", type: "webSearch", action: { query: "completed query" } } });
  internal.handleNotification("turn/completed", { turn: { status: "completed" } });
  await result;
  expect(targets).toEqual(["검색", "검색 · completed query"]);
});


test("quoted credential keys hide the complete value before activity is clipped", () => {
  const queries = [
    JSON.stringify({ api_key: "fixture_value" }),
    JSON.stringify({ token: 'fixture_value with "quotes", commas and spaces' }),
    JSON.stringify({ authorization: "Bearer fixture_value" }),
    '{ "password" : "fixture_value" }',
    "{'secret':'fixture_value with spaces'}",
    '"api-key"="fixture_value"',
  ];
  for (const query of queries) {
    const line = toolActivityLine({ type: "webSearch", query });
    expect(line).toContain("[redacted]");
    expect(line).not.toContain("fixture_value");
    expect(line).not.toContain("quotes");
    expect(line).not.toContain("commas");
  }
  expect(toolActivityLine({ type: "webSearch", query: JSON.stringify({ api_key: "fixture_value", topic: "docs" }) }))
    .toBe('검색 · {[redacted],"topic":"docs"}');
});


test("authentication schemes hide short credentials regardless of token length", () => {
  const basic = btoa("u:p");
  const queries = [
    `Authorization: Basic ${basic}`,
    `authorization: basic ${basic}`,
    `Proxy-Authorization: Basic ${basic}`,
    `Authorization: Custom ${basic}`,
    `Basic ${basic}`,
    'Bearer abc',
    'Negotiate abc',
    'NTLM abc',
    'Digest username="u", response="abc"',
    JSON.stringify({ authorization: `Basic ${basic}` }),
  ];
  for (const query of queries) {
    const line = toolActivityLine({ type: "webSearch", query });
    expect(line).toContain("[redacted]");
    expect(line).not.toContain(basic);
    expect(line).not.toContain("abc");
  }
  expect(toolActivityLine({ type: "webSearch", query: `Authorization: Basic ${basic}` }))
    .toBe("검색 · [redacted]");
});

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
    const actual = toolActivityArgs(item);
    expect(actual).toEqual(args);
    expect(Object.keys(actual).every(key => key === "target" || key === "count")).toBe(true);
    expect(actual).not.toHaveProperty("command");
    expect(actual).not.toHaveProperty("query");
  });
}

test("activity privacy: combined executable/subcommand target stays within 45 characters", () => {
  expect(Array.from(toolActivityArgs({ command: `${"x".repeat(60)} test` }).target ?? "").length).toBeLessThanOrEqual(45);
});
