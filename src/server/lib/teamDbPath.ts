import { resolve } from "node:path";

/**
 * The team.db path handed to a member's child process (send.sh·_me.sh run there).
 * The child runs in the member's own folder, so a relative TEAM_DB_PATH such as `./team.db`
 * must be resolved against the server's folder first, or the scripts cannot find the team.
 */
export function teamDbPathForChild(value: string | undefined, fallback: string, cwd: string = process.cwd()): string {
  return resolve(cwd, value?.trim() || fallback);
}
