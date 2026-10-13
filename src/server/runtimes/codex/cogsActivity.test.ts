import { expect, test } from "bun:test";
import { cogsActivityLine } from "./cogsActivity";

test("hook-style tool kind and compact target", () => {
  expect(cogsActivityLine({ command: "cat /tmp/work/bridge.ts" })).toBe("읽기 · bridge.ts");
  expect(cogsActivityLine({ command: ["bun", "test", "src/a.test.ts"] })).toBe("실행 · bun test");
  expect(cogsActivityLine({ changes: [{ path: "/tmp/work/note.md", kind: { type: "add" } }] })).toBe("새로 쓰기 · note.md");
  expect(cogsActivityLine({ fileChanges: { "/tmp/work/a.ts": {} } })).toBe("수정 · a.ts");
  expect(cogsActivityLine({ type: "webSearch", action: { queries: ["codex config"] } })).toBe("검색 · codex config");
  expect(cogsActivityLine({ type: "webSearch", action: { type: "openPage", url: "https://user:fixture@example.com/private?token=fixture" } })).toBe("페이지 열기 · example.com");
});

test("Korean activity targets cover multiple files, tools and empty targets", () => {
  expect(cogsActivityLine({ changes: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }] })).toBe("수정 · 파일 3개");
  expect(cogsActivityLine({ type: "mcpToolCall", name: "mcp__fixture__lookup" })).toBe("도구 · lookup");
  expect(cogsActivityLine({ type: "web_search", queries: ["판교", "오늘 날씨"] })).toBe("검색 · 판교 · 오늘 날씨");
  expect(cogsActivityLine({ type: "webSearch", query: "" })).toBe("검색");
  expect(cogsActivityLine({ type: "webSearch", queries: [] })).toBe("검색");
  expect(cogsActivityLine({ type: "webSearch", action: { type: "openPage", url: "" } })).toBe("페이지 열기");
  expect(cogsActivityLine({ command: "" })).toBe("실행");
  expect(cogsActivityLine({ command: [] })).toBe("실행");
  expect(cogsActivityLine({ command: "cat" })).toBe("읽기");
  expect(cogsActivityLine({ changes: [{ kind: { type: "add" } }] })).toBe("새로 쓰기");
  expect(cogsActivityLine({ changes: [{}] })).toBe("수정");
  expect(cogsActivityLine({ type: "mcpToolCall" })).toBe("도구");
  expect(cogsActivityLine(null)).toBe("도구");
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
    const line = cogsActivityLine(input);
    expect(!line.includes("fixture_value") && !line.includes("/tmp/private") && !line.includes("PRIVATE_ENV") && !line.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ123456")).toBe(true);
  }
  expect(cogsActivityLine({ command: 'API_KEY=fixture_value bun test' })).toBe("실행 · bun test");
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
  const result = client.runTurn("fixture", { onActivity: (_line, _id, item) => targets.push(cogsActivityLine(item)) }, 1000);
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
    const line = cogsActivityLine({ type: "webSearch", query });
    expect(line).toContain("[redacted]");
    expect(line).not.toContain("fixture_value");
    expect(line).not.toContain("quotes");
    expect(line).not.toContain("commas");
  }
  expect(cogsActivityLine({ type: "webSearch", query: JSON.stringify({ api_key: "fixture_value", topic: "docs" }) }))
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
    const line = cogsActivityLine({ type: "webSearch", query });
    expect(line).toContain("[redacted]");
    expect(line).not.toContain(basic);
    expect(line).not.toContain("abc");
  }
  expect(cogsActivityLine({ type: "webSearch", query: `Authorization: Basic ${basic}` }))
    .toBe("검색 · [redacted]");
});
