// 슬랙 릴레이의 멘션 부착 판정 — ★발신자가 채우는 meta 를 믿지 않는지★ 를 본다.
//   실제 발신은 하지 않는다(사람에게 알림이 간다). 부착 문자열을 만드는 규칙만 검증한다.
//   ★이 규칙이 서버 소스와 갈라지지 않게★ inbox.ts 에서 상수·정규식을 그대로 읽어 대조한다.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "../routes/inbox.ts"), "utf-8");

/** inbox.ts 의 부착 규칙을 그대로 옮긴 것 — 아래 계약 시험이 원본과 일치함을 못박는다. */
function slackPrefix(rawMentions: unknown, body: string, max = 10): string {
  return (Array.isArray(rawMentions) ? rawMentions : [])
    .filter((m): m is string => typeof m === "string" && /^[UW][A-Z0-9]+$/.test(m))
    .filter((id, i, arr) => arr.indexOf(id) === i)
    .filter((id) => !body.includes(`<@${id}>`))
    .slice(0, max)
    .map((id) => `<@${id}>`)
    .join(" ");
}

describe("슬랙 멘션 부착 — meta 는 발신자가 채운다", () => {
  test("★배열이 아니면 터지지 않고 무시한다★ (문자열·객체·null·숫자)", () => {
    // codex 교차검증: "U123" 이나 {} 가 오면 .filter is not a function → 저장 뒤 POST 500.
    for (const bad of ["U123", {}, null, undefined, 42, true]) {
      expect(() => slackPrefix(bad, "본문")).not.toThrow();
      expect(slackPrefix(bad, "본문")).toBe("");
    }
  });

  test("정상 배열은 붙는다", () => {
    expect(slackPrefix(["U0BL1UYHLV7"], "본문")).toBe("<@U0BL1UYHLV7>");
  });

  test("★형식이 아닌 값은 걸러낸다★ — 개행·슬랙 문법 주입 방지", () => {
    expect(slackPrefix(["<!channel>", "U1\nX", "here", "u0bl1uyhlv7", ""], "본문")).toBe("");
  });

  test("★같은 사람을 두 번 부르지 않는다★", () => {
    expect(slackPrefix(["U0BL1UYHLV7", "U0BL1UYHLV7"], "본문")).toBe("<@U0BL1UYHLV7>");
  });

  test("본문에 이미 있으면 중복으로 안 붙인다", () => {
    expect(slackPrefix(["U0BL1UYHLV7"], "<@U0BL1UYHLV7> 이미 있음")).toBe("");
  });

  test("★개수 상한★ — 멘션 하나가 알림 하나다", () => {
    const many = Array.from({ length: 30 }, (_, i) => `U${String(i).padStart(9, "0")}`);
    expect(slackPrefix(many, "본문").split(" ").length).toBe(10);
  });

  test("여러 명은 한 줄에 모인다", () => {
    expect(slackPrefix(["U0BL1UYHLV7", "U0BKJR2G8MD"], "본문")).toBe("<@U0BL1UYHLV7> <@U0BKJR2G8MD>");
  });
});

describe("★계약★ — 위 규칙이 서버 소스와 갈라지지 않는다", () => {
  // 손으로 베낀 사본은 원본이 바뀌어도 통과한다(#149 에서 당했다). 원본에 각 가드가 있는지 직접 센다.
  test("배열 가드가 소스에 있다", () => {
    expect(SRC).toContain("Array.isArray(rawMentions)");
  });
  test("ID 형식 검증이 소스에 있다", () => {
    expect(SRC).toContain("/^[UW][A-Z0-9]+$/");
  });
  test("중복 제거가 소스에 있다", () => {
    expect(SRC).toContain("arr.indexOf(id) === i");
  });
  test("개수 상한이 소스에 있고 이 시험의 기본값과 같다", () => {
    const m = SRC.match(/MAX_MENTIONS\s*=\s*(\d+)/);
    expect(m?.[1]).toBe("10");
  });
  test("부착 결과가 슬랙 send 의 text 로만 간다", () => {
    expect(SRC).toContain("text: slackText");
  });
});
