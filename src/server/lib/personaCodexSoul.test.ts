import { test, expect, describe } from "bun:test";
import { renderLoadingFile } from "./writeMemberPersona";
import { buildAgentsMd } from "./personaTemplates";
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

describe("★비어 있을 때야말로 비었다고 말한다★ (리뷰 지적 — 새 팀원 영입 직후가 그 경우다)", () => {
  test("★codex 인데 SOUL 이 없으면 옛 거짓말로 돌아가지 않는다★", () => {
    const out = render("codex", ws(undefined));
    expect(out, "참조로 될 것처럼 적으면 조용히 비어 있다").not.toContain("이 런타임이 SOUL.md 를 함께 로드");
    expect(out).toContain("자동으로 읽지 않는다");
    expect(out, "비었다는 사실을 말해야 한다").toContain("아직 비어 있다");
  });

  test("SOUL 이 공백뿐이어도 같다 — 있는 척하지 않는다", () => {
    const out = render("codex", ws("   \n  "));
    expect(out).toContain("아직 비어 있다");
  });

  test("★runtime 조건이 실제로 지킨다★ — soul_text 가 와도 codex 가 아니면 본문을 안 싣는다(두 벌 방지)", () => {
    // ★두 번째 겹을 직접 부른다★ — 호출부(writeMemberPersona)가 codex 에만 넘겨서 도달 불가라
    //   이 조건을 지워도 아무도 모르는 상태였다(리뷰 지적).
    //
    // ★런타임 고르기가 중요하다.★ 처음엔 claude_channel 로 불렀는데, personaPointer 의 ★첫 줄★ 이
    //   claude 를 먼저 걸러 return 한다 — 그래서 codex 조건에 ★도달조차 못 했고★, 조건을 지워도 초록이었다.
    //   ★시험이 주장하는 것을 재고 있지 않았다.★ openclaw 는 앞 분기를 안 타고 여기까지 내려온다.
    for (const runtime of ["openclaw", "hermes_agent"]) {
      const out = buildAgentsMd({
        id: "x", display_name: "X", role: "r", runtime, soul_text: "성격 본문",
      } as never);
      expect(out, `${runtime} 은 bootstrap 으로 SOUL 을 읽는다 — 본문을 또 두면 어긋난다`).not.toContain("성격 본문");
    }
  });

  test("★대조군 — 같은 호출을 codex 로 하면 본문이 들어간다★ (위가 '아무 때도 안 넣는다' 가 아님을 보인다)", () => {
    const out = buildAgentsMd({
      id: "x", display_name: "X", role: "r", runtime: "codex", soul_text: "성격 본문",
    } as never);
    expect(out).toContain("성격 본문");
  });
});
