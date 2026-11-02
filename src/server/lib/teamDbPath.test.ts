import { describe, expect, test } from "bun:test";
import { teamDbPathForChild } from "./teamDbPath";

describe("teamDbPathForChild", () => {
  test("a relative TEAM_DB_PATH becomes the server folder's path", () => {
    expect(teamDbPathForChild("./team.db", "/fallback/team.db", "/srv/b3os")).toBe("/srv/b3os/team.db");
  });
  test("an absolute TEAM_DB_PATH is kept", () => {
    expect(teamDbPathForChild("/data/team.db", "/fallback/team.db", "/srv/b3os")).toBe("/data/team.db");
  });
  test("no TEAM_DB_PATH uses the fallback", () => {
    expect(teamDbPathForChild(undefined, "/fallback/team.db", "/srv/b3os")).toBe("/fallback/team.db");
    expect(teamDbPathForChild("  ", "/fallback/team.db", "/srv/b3os")).toBe("/fallback/team.db");
  });
});
