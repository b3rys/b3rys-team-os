import { test, expect, describe } from "bun:test";
import { buildTurnInput } from "./appServerClient";

/** localImage는 CLI 0.147.0의 path 필드를 사용한다. imageUrl은 거절되므로 실제 입력 조립을 검증해 첨부가 조용히 빠지지 않게 한다. */
describe("턴 입력 조립", () => {
  test("★그림이 글자보다 앞선다★ — 뒤에 두면 '이 그림' 이 앞 문장을 못 가리킨다", () => {
    const input = buildTurnInput("이거 뭐야", ["/m/a.jpg"]);
    expect(input.map((i) => i.type)).toEqual(["localImage", "text"]);
  });

  test("★localImage 는 path 로 준다★ — imageUrl 로 주면 codex 가 거부한다(실측)", () => {
    const [img] = buildTurnInput("q", ["/m/a.jpg"]);
    expect(img).toEqual({ type: "localImage", path: "/m/a.jpg" });
  });

  test("여러 장이면 ★순서대로 전부★ 실린다 — 하나만 보내면 나머지를 못 본다", () => {
    const input = buildTurnInput("q", ["/m/a.jpg", "/m/b.png"]);
    expect(input.filter((i) => i.type === "localImage").map((i) => i.path)).toEqual(["/m/a.jpg", "/m/b.png"]);
  });

  test("★대조군 — 그림이 없으면 글자 하나뿐★ (빈 아이템을 지어내지 않는다)", () => {
    expect(buildTurnInput("안녕")).toEqual([{ type: "text", text: "안녕", text_elements: [] }]);
    expect(buildTurnInput("안녕", [])).toHaveLength(1);
  });

  test("글자는 그림이 있어도 그대로 간다 — 사람 말이 첨부에 밀리면 안 된다", () => {
    const input = buildTurnInput("이 화면 왜 이래?", ["/m/a.jpg"]);
    expect(input.at(-1)).toEqual({ type: "text", text: "이 화면 왜 이래?", text_elements: [] });
  });
});
