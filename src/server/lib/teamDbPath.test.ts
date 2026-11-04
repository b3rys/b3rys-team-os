import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { teamDbPathForChild, withTeamDbPathForChild } from "./teamDbPath";
import { appServerSpawnEnv } from "../runtimes/codex/appServerClient";

// The server opens `TEAM_DB_PATH ?? default` relative to its own folder (index.ts). A child in another folder
// must get the path of that same file.
const serverFile = (value: string, cwd: string) => resolve(cwd, value);

describe("teamDbPathForChild", () => {
  test("a relative path names the server's file", () => {
    expect(teamDbPathForChild("./team.db", "/srv/b3os")).toBe(serverFile("./team.db", "/srv/b3os"));
  });
  test("an absolute path is kept", () => {
    expect(teamDbPathForChild("/data/team.db", "/srv/b3os")).toBe("/data/team.db");
  });
  test("spaces are kept, as the server keeps them", () => {
    expect(teamDbPathForChild(" team.db", "/srv/b3os")).toBe(serverFile(" team.db", "/srv/b3os"));
  });
  test("unset and empty pass through unchanged", () => {
    expect(teamDbPathForChild(undefined, "/srv/b3os")).toBeUndefined();
    expect(teamDbPathForChild("", "/srv/b3os")).toBe("");
  });
});

describe("member process environments carry the absolute path", () => {
  const base = { TEAM_DB_PATH: "./team.db", OTHER: "x" } as NodeJS.ProcessEnv;
  const expected = resolve(process.cwd(), "./team.db");
  test("withTeamDbPathForChild leaves its input alone", () => {
    const out = withTeamDbPathForChild(base, "/srv/b3os");
    expect(out.TEAM_DB_PATH).toBe("/srv/b3os/team.db");
    expect(out.OTHER).toBe("x");
    expect(base.TEAM_DB_PATH).toBe("./team.db");
    expect(withTeamDbPathForChild({ OTHER: "x" }, "/srv/b3os").TEAM_DB_PATH).toBeUndefined();
  });
  test("codex app-server", () => {
    expect(appServerSpawnEnv(undefined, base).TEAM_DB_PATH).toBe(expected);
  });
});
