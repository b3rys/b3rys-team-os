import { existsSync, mkdirSync, symlinkSync, lstatSync, readlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { HERMES_ROOT, REPO_ROOT } from "./paths";

/** 팀 버스 스킬(정본) 이름. */
export const TEAM_INBOX_SKILL = "b3os-team-inbox";

// Hermes는 프로필 안의 스킬만 읽고 프로필 복제는 낡은 사본을 남길 수 있어 정본 심링크를 사용한다. 기존 사본은 .stale-*로 보존한다.
export function linkHermesTeamSkill(
  profile: string,
  opts?: { hermesRoot?: string; repoRoot?: string; now?: number },
): { linked: boolean; path: string; detail: string } {
  const hermesRoot = opts?.hermesRoot ?? HERMES_ROOT;
  const repoRoot = opts?.repoRoot ?? REPO_ROOT;
  const target = join(repoRoot, "skills", TEAM_INBOX_SKILL);
  const dir = join(hermesRoot, "profiles", profile, "skills", "claude-imports");
  const link = join(dir, TEAM_INBOX_SKILL);

  if (!/^[a-z0-9_-]+$/i.test(profile)) {
    return { linked: false, path: link, detail: `프로필 이름이 안전하지 않다: ${profile}` };
  }
  if (!existsSync(target)) {
    // 정본이 없으면 링크를 걸지 않는다 — 깨진 링크는 "있는데 안 되는" 상태라 사본보다 나쁘다.
    return { linked: false, path: link, detail: `정본 스킬이 없다: ${target}` };
  }

  mkdirSync(dir, { recursive: true });

  try {
    const st = lstatSync(link);
    if (st.isSymbolicLink() && readlinkSync(link) === target) {
      return { linked: true, path: link, detail: "이미 정본 심링크" };
    }
    // 사본이거나 다른 곳을 가리킨다 → 비켜놓는다(백업 우선, 삭제하지 않는다).
    renameSync(link, `${link}.stale-${opts?.now ?? Date.now()}`);
  } catch {
    /* 아직 없음 = 정상 경로 */
  }

  symlinkSync(target, link);
  return { linked: true, path: link, detail: `정본 심링크 → ${target}` };
}

/**
 * 프로필에 팀 스킬 사본 이 있는지 검사한다 (doctor 용).
 * 사본 = 심링크가 아닌 실제 디렉토리. 옛 이름(gd-team-inbox)도 사본으로 본다.
 */
export function findHermesSkillCopies(
  profiles: string[],
  opts?: { hermesRoot?: string },
): Array<{ profile: string; path: string; reason: string }> {
  const hermesRoot = opts?.hermesRoot ?? HERMES_ROOT;
  const found: Array<{ profile: string; path: string; reason: string }> = [];
  for (const profile of profiles) {
    if (!/^[a-z0-9_-]+$/i.test(profile)) continue;
    const base = join(hermesRoot, "profiles", profile, "skills", "claude-imports");
    for (const name of [TEAM_INBOX_SKILL, "gd-team-inbox"]) {
      const p = join(base, name);
      if (!existsSync(p)) continue;
      let isLink = false;
      try {
        isLink = lstatSync(p).isSymbolicLink();
      } catch {
        continue;
      }
      if (!isLink) {
        found.push({
          profile,
          path: p,
          reason: name === TEAM_INBOX_SKILL ? "정본이 아니라 사본이다(심링크가 아님)" : "옛 이름의 사본이다",
        });
      }
    }
  }
  return found;
}
