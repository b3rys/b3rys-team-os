// rules/SKILLS.md 렌더 — trigger→스킬 목록을 규칙 파일 밖으로 뺀다.
//   왜: 목록이 CLAUDE.md·AGENTS.md 본문에 박혀 있으면 스킬 하나 추가가 12명 규칙 파일 재생성이 된다(팀장 2026-09-18).
//   claude 는 CLAUDE.md 의 `@SKILLS.md`(워크스페이스 심링크 → 이 파일) 로 인라인, 나머지 런타임은 세션 시작 때 경로로 읽는다.
//   TEAM-OS.md 와 같은 방식: 소스는 skills/*/SKILL.md 의 trigger 줄, 산출물은 rules/SKILLS.md(gitignore).
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { buildSkillTable, SKILLS_MD_PATH } from "./personaTemplates";

export function buildSkillsMd(): string {
  return [
    "# SKILLS — trigger → 스킬",
    "",
    "> 자동 생성(skills/*/SKILL.md 의 `trigger:` 줄). 손으로 고치지 않는다 — 스킬을 추가·수정하면 서버가 다시 만든다.",
    "",
    buildSkillTable(),
    "",
  ].join("\n");
}

/** 원자적 쓰기(임시파일 → rename). 내용이 같으면 건드리지 않는다. */
export function renderSkillsMd(target: string = SKILLS_MD_PATH): { ok: boolean; changed: boolean; error?: string } {
  try {
    const text = buildSkillsMd();
    if (existsSync(target) && readFileSync(target, "utf-8") === text) return { ok: true, changed: false };
    const tmp = `${target}.tmp-${process.pid}`;
    try { writeFileSync(tmp, text, "utf-8"); renameSync(tmp, target); }
    catch (e) { try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* keep original error */ } throw e; }
    return { ok: true, changed: true };
  } catch (e) {
    return { ok: false, changed: false, error: e instanceof Error ? e.message : String(e) };
  }
}
