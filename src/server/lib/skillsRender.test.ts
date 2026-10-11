// rules/SKILLS.md 렌더 — 목록은 규칙 파일 밖, 파일은 원자적으로, 같으면 안 건드린다.
import { describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillsCopy, buildSkillsMd, ensureSkillsCopy, refreshSkillsMd, renderSkillsMd, SKILLS_COPY_MARKER, syncSkillsCopies } from "./skillsRender";
import { SKILLS_MD_PATH, buildSkillTable } from "./personaTemplates";

describe("rules/SKILLS.md 렌더", () => {
  it("본문 = 헤더 + 자동 생성 표. 표는 personaTemplates 의 것과 같은 함수에서 나온다", () => {
    const md = buildSkillsMd();
    expect(md.startsWith("# SKILLS")).toBe(true);
    expect(md).toContain(buildSkillTable());
    expect(md).toContain("손으로 고치지 않는다");
    // 겹쳐 쓰기 규칙은 Core Rules 에서 뺐다(팀장 09-18) — 목록 파일이 대신 품는다. 순서까지 고정(codex 리뷰 #435).
    expect(md).toContain("여러 trigger 가 맞으면 전부 적용한다");
    expect(md).toMatch(/`b3os-infra-safety`[^\n]*→[^\n]*`b3os-github-workflow`/);
  });
  it("renderSkillsMd 는 파일을 만들고, 두 번째 호출은 changed=false (내용 동일이면 안 건드림) — 시험은 라이브 rules/ 를 건드리지 않는다", () => {
    const target = join(mkdtempSync(join(tmpdir(), "skills-md-")), "SKILLS.md");
    const first = renderSkillsMd(target);
    expect(first.ok, first.error).toBe(true);
    expect(existsSync(target)).toBe(true);
    const mtime = statSync(target).mtimeMs;
    const second = renderSkillsMd(target);
    expect(second).toEqual({ ok: true, changed: false });
    expect(statSync(target).mtimeMs).toBe(mtime);
    expect(readFileSync(target, "utf-8")).toBe(buildSkillsMd());
    expect(SKILLS_MD_PATH.endsWith("/rules/SKILLS.md")).toBe(true);  // 기본 타깃은 라이브 렌더 경로
  });
});

// 팀원 워크스페이스 복사본 — 시험은 tmp 의 원본·워크스페이스만 쓴다(라이브 rules/·members/ 를 건드리지 않는다).
describe("워크스페이스 SKILLS.md 복사본", () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "skills-copy-"));
    const source = join(root, "rules-SKILLS.md");
    const ws = join(root, "ws");
    mkdirSync(ws);
    writeFileSync(source, "# v1\n");
    return { source, ws, dest: join(ws, "SKILLS.md") };
  };

  it("없으면 만든다 — 첫 줄 표식, 나머지 = 원본", () => {
    const { source, ws, dest } = setup();
    expect(ensureSkillsCopy(ws, source)).toBe("written");
    const text = readFileSync(dest, "utf-8");
    expect(text.split("\n")[0]).toBe(SKILLS_COPY_MARKER);
    expect(text).toBe(buildSkillsCopy("# v1\n"));
    expect(ensureSkillsCopy(ws, source)).toBe("unchanged");
  });

  it("옛 심링크 → 실파일로 교체, 원본은 그대로", () => {
    const { source, ws, dest } = setup();
    symlinkSync(source, dest);
    expect(ensureSkillsCopy(ws, source)).toBe("written");
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(dest, "utf-8")).toBe(buildSkillsCopy("# v1\n"));
    expect(readFileSync(source, "utf-8"), "★rename 이 심링크를 따라가 원본을 덮었다★").toBe("# v1\n");
  });

  it("표식 파일 → 원본이 바뀌면 갱신", () => {
    const { source, ws, dest } = setup();
    ensureSkillsCopy(ws, source);
    writeFileSync(source, "# v2\n");
    expect(ensureSkillsCopy(ws, source)).toBe("written");
    expect(readFileSync(dest, "utf-8")).toBe(buildSkillsCopy("# v2\n"));
  });

  it("표식 없는 일반 파일 → 그대로", () => {
    const { source, ws, dest } = setup();
    writeFileSync(dest, "사람이 쓴 목록\n");
    expect(ensureSkillsCopy(ws, source)).toBe("kept_user_file");
    expect(readFileSync(dest, "utf-8")).toBe("사람이 쓴 목록\n");
  });

  it("원본을 못 읽으면 아무것도 바꾸지 않는다(옛 심링크도 그대로)", () => {
    const { source, ws, dest } = setup();
    symlinkSync(source, dest);
    expect(ensureSkillsCopy(ws, join(ws, "없음.md"))).toBe("no_source");
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
  });

  it("renderSkillsMd 후 syncSkillsCopies → 복사본 내용 = 표식 + rules/SKILLS.md · 없는 워크스페이스는 만들지 않는다", () => {
    const { ws, dest } = setup();
    const rendered = join(mkdtempSync(join(tmpdir(), "skills-md-")), "SKILLS.md");
    expect(renderSkillsMd(rendered).ok).toBe(true);
    const ghost = join(ws, "..", "ghost");
    const r = syncSkillsCopies([ws, ghost], rendered);
    expect(r[ws]).toBe("written");
    expect(ghost in r).toBe(false);
    expect(existsSync(ghost)).toBe(false);
    expect(readFileSync(dest, "utf-8")).toBe(buildSkillsCopy(readFileSync(rendered, "utf-8")));
    expect(readFileSync(dest, "utf-8")).toBe(buildSkillsCopy(buildSkillsMd()));
  });

  it("다른 파일을 가리키는 살아 있는 심링크 → 그대로(사람이 둔 것)", () => {
    const { source, ws, dest } = setup();
    const mine = join(ws, "my-list.md");
    writeFileSync(mine, "내 목록\n");
    symlinkSync(mine, dest);
    expect(ensureSkillsCopy(ws, source)).toBe("kept_user_file");
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(readFileSync(mine, "utf-8")).toBe("내 목록\n");
  });

  it("SKILLS.md 자리에 디렉터리 → 그대로", () => {
    const { source, ws, dest } = setup();
    mkdirSync(dest);
    expect(ensureSkillsCopy(ws, source)).toBe("kept_user_file");
    expect(lstatSync(dest).isDirectory()).toBe(true);
  });

  it("refreshSkillsMd = 렌더 + 복사본 동기화 (렌더 실패면 복사본을 건드리지 않는다)", () => {
    const { ws, dest } = setup();
    const target = join(mkdtempSync(join(tmpdir(), "skills-md-")), "SKILLS.md");
    const r = refreshSkillsMd([ws], target);
    expect(r.render.ok).toBe(true);
    expect(r.copies[ws]).toBe("written");
    expect(readFileSync(dest, "utf-8")).toBe(buildSkillsCopy(buildSkillsMd()));
    const bad = refreshSkillsMd([ws], join(ws, "없는폴더", "SKILLS.md"));
    expect(bad.render.ok).toBe(false);
    expect(bad.copies).toEqual({});
  });

  it("렌더하는 곳(부팅·설정 저장)은 refreshSkillsMd 를 쓴다 — renderSkillsMd 직접 호출이면 복사본이 옛 목록으로 남는다", () => {
    for (const rel of ["../index.ts", "../routes/settings.ts"]) {
      const src = readFileSync(join(import.meta.dir, rel), "utf-8");
      expect(src, `${rel} 가 refreshSkillsMd 를 안 부른다`).toMatch(/refreshSkillsMd\(/);
      expect(src, `${rel} 가 renderSkillsMd 를 직접 부른다`).not.toMatch(/renderSkillsMd\(/);
    }
  });

  it("임시 파일 경로에 다른 파일을 가리키는 심링크가 미리 있으면 → 따라가지 않고 error, 그 파일·SKILLS.md 는 그대로", () => {
    const { source, ws, dest } = setup();
    const soul = join(ws, "SOUL.md");
    writeFileSync(soul, "페르소나\n");
    const fixed = "fixed";
    symlinkSync(soul, `${dest}.tmp-${process.pid}-${fixed}`);
    expect(ensureSkillsCopy(ws, source, { tmpSuffix: () => fixed })).toBe("error");
    expect(readFileSync(soul, "utf-8"), "★tmp 심링크를 따라가 다른 파일을 덮었다★").toBe("페르소나\n");
    expect(existsSync(dest)).toBe(false);
    expect(lstatSync(`${dest}.tmp-${process.pid}-${fixed}`).isSymbolicLink(), "★미리 놓인 경로를 건드렸다★").toBe(true);
  });

  it("임시 파일 이름은 호출마다 다르다(무작위 꼬리) — 정상 경로는 written", () => {
    const { source, ws } = setup();
    const seen: string[] = [];
    const r = ensureSkillsCopy(ws, source, { tmpSuffix: () => { const v = Math.random().toString(36).slice(2); seen.push(v); return v; } });
    expect(r).toBe("written");
    expect(seen.length).toBe(1);
  });
});
