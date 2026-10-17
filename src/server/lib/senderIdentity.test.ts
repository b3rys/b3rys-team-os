// 발신자는 모델의 자기 신고가 아니라 워크스페이스 등에서 해석한다. --from 예시는 다른 팀원 ID의 복사를 유도할 수 있어 금지한다.
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
    // 문서에 신원 추측 예시가 남으면 잘못된 발신을 유도할 수 있어 코드와 문서를 함께 검사한다.
    for (const f of [
      "skills/b3os-team-inbox/scripts/send.sh",
      "skills/b3os-team-inbox/scripts/reply.sh",
      "skills/b3os-team-inbox/SKILL.md",
    ]) {
      expect(read(f)).not.toContain("[--from <override>]");
    }
    const skill = read("skills/b3os-team-inbox/SKILL.md");
    for (const name of ["--from codex", "--from bill", "--from hermes", "--from <you>", "--from <id>"]) {
      expect(skill).not.toContain(name); // 구체적 이름을 예시로 박으면 그대로 베낀다
    }
  });

  test("send.sh 는 여전히 _me.sh 로 신원을 정한다 (사실에서 유도)", () => {
    expect(read("skills/b3os-team-inbox/scripts/send.sh")).toContain('FROM="${FROM:-$($HERE/_me.sh)}"');
  });
});
