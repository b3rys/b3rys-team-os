import { existsSync, mkdirSync, symlinkSync, lstatSync, readlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { HERMES_ROOT, REPO_ROOT } from "./paths";

/** 팀 버스 스킬(정본) 이름. */
export const TEAM_INBOX_SKILL = "b3os-team-inbox";

/**
 * ★hermes 프로필의 팀 스킬 = 정본 심링크. 사본을 만들지 않는다.★ (GD 2026-07-14)
 *
 * ═══ 왜 ═══
 * hermes 는 ★자기 프로필 폴더의 스킬만★ 본다 (외부 skills 경로 설정이 없다).
 * 그런데 영입 스크립트(activate-hermes-agent.sh)는 ★기존 프로필을 통째로 복제★ 한다 →
 * 스킬도 ★사본★ 으로 따라간다. 그래서 정본을 고쳐도 사본은 그대로 남는다.
 *
 * ★실측(2026-07-14):★ `--from` 차단(신원 위장 방지)을 정본 send.sh 에 넣었는데,
 *   hermes·ames·forin 프로필의 사본(7/13자)은 ★차단이 없어서 그대로 뚫려 있었다.★
 *   룰에서 `--from` 을 지워도 ★문 자체는 열려 있었다.★ 게다가 사본엔 bus-recall.sh·thread.sh 가
 *   ★아예 없어서★, 룰이 시키는 명령을 팀원이 ★실행할 수 없었다.★
 *
 * → 사본을 두는 한 같은 일이 반복된다. ★정본을 가리키게 한다.★ 고치면 전원이 즉시 따라온다.
 *
 * 멱등: 이미 올바른 심링크면 그대로 둔다. 사본/낡은 링크가 있으면 ★지우지 않고 비켜놓는다★(.stale-*).
 */
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
    // ★정본이 없으면 링크를 걸지 않는다★ — 깨진 링크는 "있는데 안 되는" 상태라 사본보다 나쁘다.
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
 * 프로필에 팀 스킬 ★사본★ 이 있는지 검사한다 (doctor 용).
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
