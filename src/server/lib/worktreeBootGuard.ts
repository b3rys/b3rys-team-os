import { realpathSync } from "node:fs";
import { gitDirs } from "./deployIdentity";

export const WORKTREE_WRITE_OVERRIDE = "B3OS_ALLOW_WORKTREE_MEMBER_WRITES";
export const WORKTREE_BOOT_ERROR = "B3OS_WORKTREE_MEMBER_WRITES_REFUSED";

/** Stop before DB/registry/workers can reach member paths. The override is env-only. */
export function assertMemberWriteBootAllowed(
  repoRoot: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (env[WORKTREE_WRITE_OVERRIDE] === "1") return;
  const dirs = gitDirs(repoRoot);
  let separate: boolean;
  try {
    if (!dirs) throw new Error("Git directories unavailable");
    separate = realpathSync(dirs.headDir) !== realpathSync(dirs.commonDir);
  } catch {
    throw new Error(`${WORKTREE_BOOT_ERROR}: Git 디렉터리를 확인할 수 없어 부팅을 거부합니다. 격리 환경에서만 ${WORKTREE_WRITE_OVERRIDE}=1로 해제하세요.`);
  }
  if (separate) {
    throw new Error(`${WORKTREE_BOOT_ERROR}: linked Git worktree에서는 팀원 경로 쓰기 전에 부팅을 거부합니다. 격리 환경에서만 ${WORKTREE_WRITE_OVERRIDE}=1로 해제하세요.`);
  }
}
