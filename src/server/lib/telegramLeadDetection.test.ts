import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../db/migrate";
import { listDiscoveredGroups, rememberDiscoveredGroup } from "./telegramLeadDetection";

describe("telegram group discovery", () => {
  test("keeps the latest unique groups and ignores private chats", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(rememberDiscoveredGroup(db, { id: 1, type: "private" }, "2026-07-20T00:00:00Z")).toBeNull();
    rememberDiscoveredGroup(db, { id: -1001, type: "supergroup", title: "Old" }, "2026-07-20T00:00:00Z");
    rememberDiscoveredGroup(db, { id: -1002, type: "group", title: "Second" }, "2026-07-20T00:01:00Z");
    rememberDiscoveredGroup(db, { id: -1001, type: "supergroup", title: "New" }, "2026-07-20T00:02:00Z");
    expect(listDiscoveredGroups(db).map((group) => [group.id, group.title])).toEqual([
      ["-1001", "New"],
      ["-1002", "Second"],
    ]);
  });
});
