import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { envFileTeamPathMismatches, serverTeamPaths, teamDbPathForChild, teamPathEnvLines, withTeamDbPathForChild } from "./teamDbPath";
import { appServerSpawnEnv } from "../runtimes/codex/appServerClient";
import { claudeCogsEnvironment } from "../runtimes/claude/cogsEnvironment";

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
  test("claude cogs runner", () => {
    expect(claudeCogsEnvironment(base).TEAM_DB_PATH).toBe(expected);
  });
});

describe("bridge team paths", () => {
  const repo = "/opt/b3os";
  test("no env value → the files next to the repo, as the server opens them", () => {
    expect(serverTeamPaths(repo, {}, "/x")).toEqual({ db: "/opt/b3os/team.db", registry: "/opt/b3os/agents.json" });
  });
  test("the server's own value wins and a relative one is made absolute against the server's folder", () => {
    expect(serverTeamPaths(repo, { TEAM_DB_PATH: "./team.db", TEAM_AGENT_REGISTRY: "/live/agents.json" }, "/srv"))
      .toEqual({ db: "/srv/team.db", registry: "/live/agents.json" });
  });
  test("wrapper lines export both paths, shell-quoted", () => {
    expect(teamPathEnvLines(repo, { TEAM_DB_PATH: '/a "b"/$x.db' }, "/x")).toEqual([
      'export TEAM_DB_PATH="/a \\"b\\"/\\$x.db"',
      'export TEAM_AGENT_REGISTRY="/opt/b3os/agents.json"',
    ]);
  });
  test("a .env written by a run started outside the server cannot win: exported values beat bun's .env load", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/team-paths-`);
    writeFileSync(`${dir}/.env`, "TEAM_DB_PATH=/old/team.db\nTEAM_AGENT_REGISTRY=/old/agents.json\n");
    writeFileSync(`${dir}/w.sh`, [...teamPathEnvLines(dir, {}, dir), `exec "${process.execPath}" -e 'console.log(process.env.TEAM_DB_PATH, process.env.TEAM_AGENT_REGISTRY)'`, ""].join("\n"));
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.TEAM_DB_PATH; delete env.TEAM_AGENT_REGISTRY;
    const r = Bun.spawnSync(["/bin/bash", `${dir}/w.sh`], { cwd: dir, env: env as Record<string, string> });
    expect(r.stdout.toString().trim()).toBe(`${dir}/team.db ${dir}/agents.json`);
  });
});

describe("envFileTeamPathMismatches", () => {
  const repo = "/opt/b3os";
  const live = { db: "/opt/b3os/team.db", registry: "/opt/b3os/agents.json" };
  test("a moved install's old paths are named", () => {
    expect(envFileTeamPathMismatches("TEAM_DB_PATH=/old/team.db\nX=1\nTEAM_AGENT_REGISTRY=\"/old/agents.json\"\n", live, repo)).toEqual([
      { key: "TEAM_DB_PATH", envFile: "/old/team.db", server: live.db },
      { key: "TEAM_AGENT_REGISTRY", envFile: "/old/agents.json", server: live.registry },
    ]);
  });
  test("the example .env's relative values match a fresh install: nothing to say", () => {
    expect(envFileTeamPathMismatches("TEAM_DB_PATH=./team.db\nTEAM_AGENT_REGISTRY=./agents.json\n", live, repo)).toEqual([]);
  });
  test("an empty value never reads the next line: other settings stay out of the warning", () => {
    expect(envFileTeamPathMismatches("TEAM_DB_PATH=\nAPI_KEY=SYNTHETIC_SENTINEL\nTEAM_AGENT_REGISTRY=   \nGITHUB_TOKEN=SYNTHETIC_SENTINEL2\n", live, repo)).toEqual([]);
  });
  test("the last line for a key wins, as in a dotenv load", () => {
    expect(envFileTeamPathMismatches("TEAM_DB_PATH=/old/team.db\nTEAM_DB_PATH=./team.db\n", live, repo)).toEqual([]);
  });
  test("missing, empty or commented keys are not mismatches", () => {
    expect(envFileTeamPathMismatches("# TEAM_DB_PATH=/old/team.db\nTEAM_AGENT_REGISTRY=\n", live, repo)).toEqual([]);
  });
});
