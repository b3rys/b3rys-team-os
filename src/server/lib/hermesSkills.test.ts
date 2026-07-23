import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, lstatSync, readlinkSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkHermesTeamSkill, findHermesSkillCopies, TEAM_INBOX_SKILL } from "./hermesSkills";

/** 실 파일시스템(라이브 ~/.hermes)을 절대 건드리지 않는다 — 전부 tmp 격리. */
function fixture(): { hermesRoot: string; repoRoot: string } {
  const base = mkdtempSync(join(tmpdir(), "hermes-skills-"));
  const hermesRoot = join(base, "hermes");
  const repoRoot = join(base, "repo");
  mkdirSync(join(repoRoot, "skills", TEAM_INBOX_SKILL, "scripts"), { recursive: true });
  writeFileSync(join(repoRoot, "skills", TEAM_INBOX_SKILL, "scripts", "send.sh"), "#!/bin/sh\n");
  return { hermesRoot, repoRoot };
}

describe("linkHermesTeamSkill", () => {
  test("★영입 시 정본 심링크를 건다 (사본을 만들지 않는다)★", () => {
    const { hermesRoot, repoRoot } = fixture();
    const r = linkHermesTeamSkill("newbie", { hermesRoot, repoRoot });
    expect(r.linked).toBe(true);
    const st = lstatSync(r.path);
    expect(st.isSymbolicLink()).toBe(true);
    expect(readlinkSync(r.path)).toBe(join(repoRoot, "skills", TEAM_INBOX_SKILL));
    // 정본을 고치면 팀원이 즉시 따라온다 = 링크 너머로 파일이 보인다
    expect(existsSync(join(r.path, "scripts", "send.sh"))).toBe(true);
  });

  test("멱등 — 두 번 걸어도 그대로", () => {
    const { hermesRoot, repoRoot } = fixture();
    linkHermesTeamSkill("newbie", { hermesRoot, repoRoot });
    const r2 = linkHermesTeamSkill("newbie", { hermesRoot, repoRoot });
    expect(r2.linked).toBe(true);
    expect(r2.detail).toContain("이미");
  });

  test("★사본이 이미 있으면 지우지 않고 비켜놓는다★ (백업 우선)", () => {
    const { hermesRoot, repoRoot } = fixture();
    const dir = join(hermesRoot, "profiles", "ames", "skills", "claude-imports", TEAM_INBOX_SKILL, "scripts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "send.sh"), "#!/bin/sh\n# 낡은 사본 — --from 차단 없음\n");

    const r = linkHermesTeamSkill("ames", { hermesRoot, repoRoot, now: 111 });
    expect(r.linked).toBe(true);
    expect(lstatSync(r.path).isSymbolicLink()).toBe(true);

    // 옛 사본은 살아있다 (삭제 금지)
    const parent = join(hermesRoot, "profiles", "ames", "skills", "claude-imports");
    const stale = readdirSync(parent).filter((f) => f.includes(".stale-"));
    expect(stale.length).toBe(1);
    expect(existsSync(join(parent, stale[0]!, "scripts", "send.sh"))).toBe(true);
  });

  test("★정본이 없으면 링크를 걸지 않는다★ — 깨진 링크는 사본보다 나쁘다", () => {
    const { hermesRoot } = fixture();
    const r = linkHermesTeamSkill("newbie", { hermesRoot, repoRoot: "/nonexistent/repo" });
    expect(r.linked).toBe(false);
    expect(r.detail).toContain("정본");
    expect(existsSync(r.path)).toBe(false);
  });

  test("프로필 이름 검증 (경로 탈출 차단)", () => {
    const { hermesRoot, repoRoot } = fixture();
    const r = linkHermesTeamSkill("../../etc", { hermesRoot, repoRoot });
    expect(r.linked).toBe(false);
  });
});

describe("findHermesSkillCopies (doctor)", () => {
  test("★사본을 잡아낸다 — 심링크면 통과, 실제 디렉토리면 경고★", () => {
    const { hermesRoot, repoRoot } = fixture();
    // 정상 프로필: 심링크
    linkHermesTeamSkill("good", { hermesRoot, repoRoot });
    // 나쁜 프로필: 사본
    mkdirSync(join(hermesRoot, "profiles", "bad", "skills", "claude-imports", TEAM_INBOX_SKILL), { recursive: true });
    // 옛 이름 사본
    mkdirSync(join(hermesRoot, "profiles", "old", "skills", "claude-imports", "gd-team-inbox"), { recursive: true });

    const found = findHermesSkillCopies(["good", "bad", "old"], { hermesRoot });
    const profiles = found.map((f) => f.profile).sort();
    expect(profiles).toEqual(["bad", "old"]);
  });

  test("스킬이 아예 없는 프로필은 사본이 아니다 (경고 안 함)", () => {
    const { hermesRoot } = fixture();
    mkdirSync(join(hermesRoot, "profiles", "empty", "skills"), { recursive: true });
    expect(findHermesSkillCopies(["empty"], { hermesRoot })).toEqual([]);
  });

  test("옛 이름이지만 심링크면 사본이 아니다", () => {
    const { hermesRoot, repoRoot } = fixture();
    const dir = join(hermesRoot, "profiles", "p", "skills", "claude-imports");
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(repoRoot, "skills", TEAM_INBOX_SKILL), join(dir, "gd-team-inbox"));
    expect(findHermesSkillCopies(["p"], { hermesRoot })).toEqual([]);
  });
});
