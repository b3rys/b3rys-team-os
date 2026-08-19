import { test, expect, describe } from "bun:test";
import { buildTurnInput } from "./appServerClient";

/**
 * ★codex 에 보낼 입력 아이템 조립.★
 *
 * 여기서 틀리면 ★그림이 조용히 빠진 채★ 글자만 간다 — 사람은 보냈는데 "안 보인다" 는 답을 받는다.
 * 모양은 실측으로 고정했다(CLI 0.147.0 app-server):
 *   · localImage 는 ★path 를 요구★ 한다 — imageUrl 로 주면 `missing field \`path\`` 로 거부
 *   · 글자가 든 그림을 태워 codex 가 그 글자를 읽었고, 같은 질문을 그림 없이 주면 "안보임" 이 나왔다
 */
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
