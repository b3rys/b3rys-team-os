import { test, expect, describe } from "bun:test";
import { renderLoadingFile } from "./writeMemberPersona";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// claude의 @import는 맨 줄에 홀로 있어야 확장된다. 문장 안 백틱은 코드 표기여서 파일을 로드하지 않는다.
function ws(): string {
  const d = mkdtempSync(join(tmpdir(), "soulimp-"));
  writeFileSync(join(d, "SOUL.md"), "성격 본문");
  return d;
}
const render = (runtime: string) =>
  renderLoadingFile({ id: "x", display_name: "X", role: "r", runtime, workspace_path: ws() } as never).content;

describe("claude persona import", () => {
  test("★@SOUL.md 가 맨 줄에 홀로 있다★ — 이래야 확장된다", () => {
    const lines = render("claude_channel").split("\n");
    expect(lines, "맨 줄 형태가 없으면 persona 가 영영 안 들어온다").toContain("@SOUL.md");
  });

  test("★백틱에 감싸지 않는다★ — 감싸면 코드 표기가 되어 안 불려온다(원래 결함)", () => {
    expect(render("claude_channel")).not.toContain("`@SOUL.md`");
  });

  test("★같은 파일의 다른 import 도 맨 줄이다★ — @SKILLS.md (TEAM-OS 는 2026-09-19 부터 인라인하지 않는다)", () => {
    const lines = render("claude_channel").split("\n");
    expect(lines).toContain("@SKILLS.md");
    expect(lines).not.toContain("@TEAM-OS.md");
  });

  test("★대조군 — codex 는 @import 를 쓰지 않는다★ (본문을 직접 싣는다)", () => {
    const out = render("codex");
    expect(out).not.toContain("@SOUL.md");
    expect(out).toContain("성격 본문");
  });
});
