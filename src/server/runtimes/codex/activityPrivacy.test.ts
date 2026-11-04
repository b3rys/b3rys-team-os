import { expect, test } from "bun:test";
import { activityArgs } from "./activityLine";

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
    const actual = activityArgs(item);
    expect(actual).toEqual(args);
    expect(Object.keys(actual).every(key => key === "target" || key === "count")).toBe(true);
    expect(actual).not.toHaveProperty("command");
    expect(actual).not.toHaveProperty("query");
  });
}

test("activity privacy: combined executable/subcommand target stays within 45 characters", () => {
  expect(Array.from(activityArgs({ command: `${"x".repeat(60)} test` }).target ?? "").length).toBeLessThanOrEqual(45);
});
