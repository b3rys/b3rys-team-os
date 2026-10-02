// rules/SKILLS.md 렌더 — trigger→스킬 목록을 규칙 파일 밖으로 뺀다.
//   왜: 목록이 CLAUDE.md·AGENTS.md 본문에 박혀 있으면 스킬 하나 추가가 12명 규칙 파일 재생성이 된다(팀장 2026-09-18).
//   claude 는 CLAUDE.md 의 `@SKILLS.md`(워크스페이스의 복사본 — ensureSkillsCopy) 로 인라인, 나머지 런타임은 세션 시작 때 경로로 읽는다.
//   TEAM-OS.md 와 같은 방식: 소스는 skills/*/SKILL.md 의 trigger 줄, 산출물은 rules/SKILLS.md(gitignore).
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSkillTable, SKILLS_MD_PATH } from "./personaTemplates";

export function buildSkillsMd(): string {
  return [
    "# SKILLS — trigger → 스킬",
    "",
    "> 자동 생성(skills/*/SKILL.md 의 `trigger:` 줄). 손으로 고치지 않는다 — 스킬을 추가·수정하면 서버가 다시 만든다.",
    "",
    buildSkillTable(),
    "",
    "**여러 trigger 가 맞으면 전부 적용한다 — 하나만 고르지 않는다.** 순서는 격리·안전이 먼저, 절차가 그다음: 예를 들어 b3os 자체를 고쳐 PR 을 내는 일은 `b3os-infra-safety`(워크트리 격리) → `b3os-github-workflow`(브랜치·PR·머지).",
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

// ── 팀원 워크스페이스의 SKILLS.md 복사본 ─────────────────────────────────────────────
//   왜 심링크가 아니라 복사본인가: Claude Code 는 작업 폴더 밖 파일을 @import 하지 않는다(외부 include 승인 전).
//   rules/SKILLS.md 를 가리키는 심링크는 대상이 폴더 밖이라 `@SKILLS.md` 가 조용히 빈다. 폴더 안의 실파일은 읽힌다.
//   복사본이므로 rules/SKILLS.md 가 바뀌면 다시 써야 한다 — 부팅 렌더 직후 syncSkillsCopies 가 그 일을 한다.

/** 복사본 첫 줄. 이 줄로 시작하는 파일만 서버가 덮는다. 표식 없는 일반 파일은 사람이 쓴 것으로 보고 건드리지 않는다. */
export const SKILLS_COPY_MARKER_PREFIX = "<!-- b3os:generated from rules/SKILLS.md";
export const SKILLS_COPY_MARKER = `${SKILLS_COPY_MARKER_PREFIX} — 손으로 고치지 않는다. 서버가 다시 쓴다 -->`;

export function buildSkillsCopy(source: string): string {
  return `${SKILLS_COPY_MARKER}\n${source}`;
}

export type SkillsCopyResult = "written" | "unchanged" | "kept_user_file" | "no_source" | "error";

/**
 * 워크스페이스의 SKILLS.md 를 rules/SKILLS.md 의 복사본으로 맞춘다.
 *   없음 → 만든다 · 옛 심링크(원본을 가리키거나 깨진 것) → 복사본으로 바꾼다 · 표식 파일 → 내용이 다르면 갱신
 *   다른 곳을 가리키는 살아 있는 심링크·표식 없는 일반 파일·디렉터리 → 그대로 둔다(사람이 둔 것일 수 있다)
 *   원본을 못 읽으면 아무것도 바꾸지 않는다.
 */
export function ensureSkillsCopy(workspace: string, source: string = SKILLS_MD_PATH): SkillsCopyResult {
  let src: string;
  try { src = readFileSync(source, "utf-8"); } catch { return "no_source"; }
  const dest = join(workspace, "SKILLS.md");
  const text = buildSkillsCopy(src);
  try {
    let st: ReturnType<typeof lstatSync> | null = null;
    try { st = lstatSync(dest); } catch { st = null; }
    if (st?.isSymbolicLink()) {
      let target = "";
      try { target = readlinkSync(dest); } catch { /* 못 읽으면 아래 existsSync 로 판정 */ }
      if (target !== source && existsSync(dest)) return "kept_user_file";
    } else if (st) {
      if (!st.isFile()) return "kept_user_file";
      const cur = readFileSync(dest, "utf-8");
      if (!cur.startsWith(SKILLS_COPY_MARKER_PREFIX)) return "kept_user_file";
      if (cur === text) return "unchanged";
    }
    mkdirSync(workspace, { recursive: true });
    // rename 은 심링크 자체를 갈아끼운다(대상 파일을 따라가 덮지 않는다) — rules/SKILLS.md 원본은 안전하다.
    const tmp = `${dest}.tmp-${process.pid}`;
    try { writeFileSync(tmp, text, "utf-8"); renameSync(tmp, dest); }
    catch (e) { try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* keep original error */ } throw e; }
    return "written";
  } catch {
    return "error";
  }
}

/** 부팅 렌더 직후 호출 — 있는 워크스페이스만 대상(없는 폴더를 새로 만들지 않는다). */
export function syncSkillsCopies(workspaces: string[], source: string = SKILLS_MD_PATH): Record<string, SkillsCopyResult> {
  const out: Record<string, SkillsCopyResult> = {};
  for (const ws of workspaces) {
    if (!ws || !existsSync(ws)) continue;
    out[ws] = ensureSkillsCopy(ws, source);
  }
  return out;
}

/**
 * rules/SKILLS.md 렌더 + 팀원 복사본 동기화를 한 번에 한다. 렌더하는 곳(부팅·설정 저장)은 전부 이 함수를 쓴다 —
 * 렌더만 하고 동기화를 빠뜨리면 복사본이 옛 목록으로 남는다.
 */
export function refreshSkillsMd(
  workspaces: string[],
  target: string = SKILLS_MD_PATH,
): { render: ReturnType<typeof renderSkillsMd>; copies: Record<string, SkillsCopyResult> } {
  const render = renderSkillsMd(target);
  const copies = render.ok ? syncSkillsCopies(workspaces, target) : {};
  return { render, copies };
}
