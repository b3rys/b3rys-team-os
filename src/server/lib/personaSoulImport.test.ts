import { test, expect, describe } from "bun:test";
import { renderLoadingFile } from "./writeMemberPersona";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ★claude 의 @import 는 맨 줄에 홀로 있어야 확장된다.★ (2026-08-19 실측)
 *
 * 전에는 "역할·persona 는 `@SOUL.md` 참조" 처럼 ★문장 안 백틱★ 에 넣어뒀다.
 * 백틱은 코드 표기라 확장되지 않는다 — 그래서 ★모든 claude 팀원의 persona 가 한 번도 로드된 적이 없다.★
 * 그런데 그 문장은 "자동 inline 로드" 라고 ★단언★ 하고 있었다.
 *
 * 실측(같은 CLAUDE.md 안에 두 형태를 넣고 표식을 물었다):
 *   `@BACKTICK.md` → ★"모름"★     ·     @BARE.md → ★표식을 맞힘★
 */
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

  test("★같은 파일의 다른 import 도 맨 줄이다★ — @TEAM-OS.md 가 잘 되던 이유가 그것이다", () => {
    const lines = render("claude_channel").split("\n");
    expect(lines).toContain("@TEAM-OS.md");
  });

  test("★대조군 — codex 는 @import 를 쓰지 않는다★ (본문을 직접 싣는다)", () => {
    const out = render("codex");
    expect(out).not.toContain("@SOUL.md");
    expect(out).toContain("성격 본문");
  });
});
