// ★신원은 '주장' 이 아니라 '사실' 이다★ (GD 2026-07-14 — 크리티컬 인시던트)
//
// ★무슨 일이 있었나★
//   룰 템플릿이 모델에게 ★"네가 누구인지 적어라"★ 고 시켰다:
//       "send.sh ★--from <you>★ --to <them> --body …"
//   그리고 스킬 문서가 그 자리에 ★codex★ 를 채워서 예시로 보여줬다 (7/12 커밋):
//       "send.sh --from ★codex★ --to steve …"
//   → ★devon 이 <you> 자리에 codex 를 넣었다.★ 7/12 24회 · 7/13 30회 · 7/14 14회 (그 전엔 0)
//   → 서버는 발신자를 ★검증하지 않는다★ (등록된 id 인지만 봄)
//   → ★devon 이 codex 이름으로 말했고, 아무도 몰랐다.★
//      steve 가 devon 에게 위임한 일에 codex 이름으로 답이 왔고, GD 는 "codex 가 남의 메시지를 봤다" 고 봤다.
//      팀 전체가 ★누가 무슨 말을 했는지 모르는 상태★ 가 됐다 (감사로그 provenance 오염).
//
// ★그런데 _me.sh 는 이미 정확히 안다★ — 워크스페이스 경로에서 신원을 유도한다 (devon 폴더 → devon).
//   ★시스템이 아는 사실을, 룰이 모델에게 다시 묻고, 모델이 틀렸다.★ (오늘 하루 종일 잡은 그 패턴)
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dir, "../../..");
const read = (p: string) => readFileSync(join(repo, p), "utf8");

describe("발신자 신원 — ★모델에게 묻지 않는다★", () => {
  test("★룰 템플릿이 '--from <you>' 를 시키지 않는다★ (이게 devon 을 codex 로 만들었다)", () => {
    const t = read("src/server/lib/personaTemplates.ts");
    expect(t).not.toContain("--from <you>");
    expect(t).not.toContain("--from <나>");
  });

  test("★스킬 문서가 '--from codex' 를 예시로 보여주지 않는다★ (devon 이 그대로 베꼈다)", () => {
    const s = read("skills/b3os-team-inbox/SKILL.md");
    expect(s).not.toContain("--from codex");
    expect(s).not.toContain("--from <you>");
  });

  test("★send.sh 가 --from 을 거부한다★ (룰만 고치면 옛 습관·옛 문서에서 다시 쓴다)", () => {
    const sh = read("skills/b3os-team-inbox/scripts/send.sh");
    // 특권 경로(B3OS_FROM_OVERRIDE) 없이는 --from 이 exit 1 로 막혀야 한다
    expect(sh).toContain("B3OS_FROM_OVERRIDE");
    expect(sh).toContain("--from 은 막혀 있다");
  });

  test("★reply.sh 도 --from 을 거부한다★ (steve 지적 — send.sh 만 막으면 반쪽)", () => {
    const sh = read("skills/b3os-team-inbox/scripts/reply.sh");
    expect(sh).toContain("B3OS_FROM_OVERRIDE");
    expect(sh).not.toContain("[--from <override>]"); // 사용법이 광고하면 모델이 읽고 쓴다
  });

  test("★스크립트 사용법·문서 어디에도 --from 을 ★권하지★ 않는다★", () => {
    // ★오늘 사고가 정확히 '예시를 보고 베낀' 것이었다.★ 코드만 막고 문서를 남기면 같은 실수를 반복한다.
    for (const f of [
      "skills/b3os-team-inbox/scripts/send.sh",
      "skills/b3os-team-inbox/scripts/reply.sh",
      "skills/b3os-team-inbox/SKILL.md",
    ]) {
      expect(read(f)).not.toContain("[--from <override>]");
    }
    const skill = read("skills/b3os-team-inbox/SKILL.md");
    for (const name of ["--from codex", "--from bill", "--from hermes", "--from <you>", "--from <id>"]) {
      expect(skill).not.toContain(name); // ★구체적 이름을 예시로 박으면 그대로 베낀다★
    }
  });

  test("send.sh 는 여전히 _me.sh 로 신원을 정한다 (사실에서 유도)", () => {
    expect(read("skills/b3os-team-inbox/scripts/send.sh")).toContain('FROM="${FROM:-$($HERE/_me.sh)}"');
  });
});
