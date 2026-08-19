import { test, expect, describe } from "bun:test";
import { renderLoadingFile } from "./writeMemberPersona";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ★codex 는 SOUL.md 를 안 읽는다 — 실측이다(2026-08-19).★
 *
 * 임시 작업폴더에 AGENTS.md·SOUL.md 를 두고 각각 다른 표식을 심어 물었더니,
 * ★도구를 한 번도 안 쓰고★ AGENTS.md 표식은 맞히고 SOUL.md 표식은 "모름" 이었다.
 * 그런데 렌더러는 "이 런타임이 SOUL.md 를 함께 로드" 라고 ★단언★ 하고 있었다 —
 * 그래서 dex 는 역할도 말투도 없이 돌았다.
 */
function ws(soul?: string): string {
  const d = mkdtempSync(join(tmpdir(), "persona-"));
  if (soul !== undefined) writeFileSync(join(d, "SOUL.md"), soul);
  return d;
}

const render = (runtime: string, workspace: string) =>
  renderLoadingFile({ id: "dex", display_name: "Dex", role: "runtime", runtime, workspace_path: workspace } as never).content;

describe("codex 로딩파일에 persona 가 실제로 들어간다", () => {
  test("★SOUL 본문이 AGENTS.md 안에 들어간다★ — 참조만 두면 codex 에는 안 닿는다", () => {
    const out = render("codex", ws("적극적이고 꼼꼼한 성격.\n\n## 톤\n- 팀장에게는 존댓말"));
    expect(out).toContain("적극적이고 꼼꼼한 성격");
    expect(out, "말투 기준도 함께 들어가야 한다").toContain("존댓말");
  });

  test("★참조로 될 것처럼 적지 않는다★ — 그 문장이 dex 를 비어 있게 만들었다", () => {
    const out = render("codex", ws("성격 본문"));
    expect(out).not.toContain("이 런타임이 SOUL.md 를 함께 로드");
  });

  test("★SOUL 이 없으면 지어내지 않는다★ — 없는 페르소나를 있는 척하면 원인을 못 찾는다", () => {
    const out = render("codex", ws(undefined));
    expect(out).toContain("## Role & Persona");
    expect(out).not.toContain("undefined");
  });

  test("★대조군 — claude 는 지금까지대로 @import 참조다★ (본문을 두 벌 두면 어긋난다)", () => {
    const out = render("claude_channel", ws("성격 본문"));
    expect(out).toContain("@SOUL.md");
    expect(out, "claude 는 참조가 실제로 닿는다").not.toContain("성격 본문");
  });

  test("★대조군 — openclaw 는 경로 참조 그대로★ (그 런타임은 bootstrap 으로 읽는다)", () => {
    const out = render("openclaw", ws("성격 본문"));
    expect(out).not.toContain("성격 본문");
    expect(out).toContain("SOUL.md");
  });
});
