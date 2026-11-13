import { isAbsolute, join, resolve } from "node:path";

/**
 * The team.db path handed to a member's child process (send.sh·_me.sh run there).
 * The child runs in the member's own folder, so a relative TEAM_DB_PATH such as `./team.db` is resolved
 * against the server's folder — the folder the server itself opened it from (index.ts: `TEAM_DB_PATH ?? …`).
 * Nothing else changes: unset and empty stay as they are, and the value is not trimmed, so server and child
 * always name the same file.
 */
export function teamDbPathForChild(value: string | undefined, cwd: string = process.cwd()): string | undefined {
  return value && !isAbsolute(value) ? resolve(cwd, value) : value;
}

/** `env` with its TEAM_DB_PATH made absolute (see teamDbPathForChild); the input is not changed. */
export function withTeamDbPathForChild(env: NodeJS.ProcessEnv, cwd: string = process.cwd()): NodeJS.ProcessEnv {
  if (env.TEAM_DB_PATH === undefined) return env;
  return { ...env, TEAM_DB_PATH: teamDbPathForChild(env.TEAM_DB_PATH, cwd) };
}

/** The team.db and agents.json the server itself opened (index.ts: env value, else next to the repo), made absolute. */
export function serverTeamPaths(repoRoot: string, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): { db: string; registry: string } {
  return {
    db: teamDbPathForChild(env.TEAM_DB_PATH, cwd) ?? join(repoRoot, "team.db"),
    registry: teamDbPathForChild(env.TEAM_AGENT_REGISTRY, cwd) ?? join(repoRoot, "agents.json"),
  };
}

const shellQuoted = (v: string) => `"${v.replace(/(["\\$`])/g, "\\$1")}"`;

/**
 * Wrapper lines that hand a launchd bridge the server's own team.db and agents.json.
 * The bridge runs bun from the repo folder, and bun loads that folder's .env by itself — so without these lines
 * an install that moved to a new folder keeps the old paths in .env, and the bridge (and send.sh inside its turns)
 * reads a team list without the member. Variables already in the environment win over .env, so exporting them here is enough.
 */
export function teamPathEnvLines(repoRoot: string, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string[] {
  const p = serverTeamPaths(repoRoot, env, cwd);
  return [`export TEAM_DB_PATH=${shellQuoted(p.db)}`, `export TEAM_AGENT_REGISTRY=${shellQuoted(p.registry)}`];
}

/**
 * Keys in the repo .env whose value is not what the server is using (the server's own launcher set another value).
 * Members started by the server get the server's value, but any bun script run from the repo folder still reads .env —
 * so the server names the mismatch at boot instead of letting it stay silent. Values are paths; nothing else is read.
 */
export function envFileTeamPathMismatches(envText: string, effective: { db: string; registry: string }, repoRoot: string): { key: string; envFile: string; server: string }[] {
  const out: { key: string; envFile: string; server: string }[] = [];
  for (const [key, server] of [["TEAM_DB_PATH", effective.db], ["TEAM_AGENT_REGISTRY", effective.registry]] as const) {
    // 한 줄씩 본다 — 값이 빈 줄 뒤의 다른 설정(키·토큰)이 경로로 읽혀 경고에 찍히지 않게.
    const line = envText.split(/\r?\n/).findLast((l) => new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=`).test(l));
    if (line === undefined) continue;
    const raw = line.slice(line.indexOf("=") + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (!raw) continue;
    const home = process.env.HOME ?? "";
    const value = raw.startsWith("~/") && home ? join(home, raw.slice(2)) : raw;
    const envFile = isAbsolute(value) ? value : resolve(repoRoot, value);
    if (envFile !== server) out.push({ key, envFile, server });
  }
  return out;
}
