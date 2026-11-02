import { isAbsolute, resolve } from "node:path";

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
