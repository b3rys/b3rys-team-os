/**
 * 태그 관리 입력 해석 — ★팀장님이 실측으로 잡아준 두 결함을 못 박는다★ (2026-07-30).
 *
 * ① `aaa->bbb` 를 넣었더니 이름이 바뀌는 대신 `#aaa->bbb` 태그가 새로 생겼다.
 *    원인: rename 판정이 U+2192(`→`) 한 종류만 봤다. 키보드로 흔히 치는 `->` 는 create 로 떨어졌다.
 * ② 내가 ①을 "`->` 를 전부 `→` 로 치환" 으로 고쳤다가 ★그 자체가 결함★ 이었다.
 *    그러면 `-aaa->bbb`(그 쓰레기 태그를 지우려는 입력)가 `-aaa→bbb` 가 되어 실제 이름과 달라지고
 *    ★삭제가 실패한다.★ 치환하지 않고 rename 판정에서만 두 화살표를 받아야 한다.
 */
import { describe, expect, test } from "bun:test";
import { parseTagAction } from "./Reports";

describe("parseTagAction — 한 줄 입력이 무슨 동작인가", () => {
  test("이름만 적으면 만들기", () => {
    expect(parseTagAction("주간보고")).toEqual({ kind: "create", name: "주간보고" });
  });

  test("★-> 로도 이름 바꾸기가 된다★ (팀장님 실측 회귀 — 전에는 create 로 떨어졌다)", () => {
    expect(parseTagAction("aaa->bbb")).toEqual({ kind: "rename", from: "aaa", to: "bbb" });
    expect(parseTagAction("주간보고 -> 주간리포트")).toEqual({ kind: "rename", from: "주간보고", to: "주간리포트" });
  });

  test("U+2192 화살표도 그대로 받는다 (기존 사용자 입력 보존)", () => {
    expect(parseTagAction("주간보고 → 주간리포트")).toEqual({ kind: "rename", from: "주간보고", to: "주간리포트" });
  });

  test("빼기표로 시작하면 지우기", () => {
    expect(parseTagAction("-주간보고")).toEqual({ kind: "delete", name: "주간보고" });
    expect(parseTagAction("- 주간보고")).toEqual({ kind: "delete", name: "주간보고" });
  });

  test("★이름에 -> 가 들어간 태그도 지울 수 있다★ (치환 방식이면 여기서 깨진다)", () => {
    // 팀장님 화면에 실제로 생긴 쓰레기 태그가 'aaa->bbb' 다. 그걸 지우려면 이름이 그대로 살아야 한다.
    expect(parseTagAction("-aaa->bbb")).toEqual({ kind: "delete", name: "aaa->bbb" });
    expect(parseTagAction("-aaa → bbb")).toEqual({ kind: "delete", name: "aaa → bbb" });
  });

  test("빈 입력·공백·빼기표만 = 아무것도 안 한다", () => {
    for (const v of ["", "   ", null, undefined, "-", "-   "]) {
      expect(parseTagAction(v as string | null | undefined).kind, JSON.stringify(v)).toBe("none");
    }
  });

  test("한쪽만 적은 이름 바꾸기는 rename 으로 잡고 호출부가 거절한다", () => {
    // 여기서 create 로 흘리면 '주간보고 ->' 라는 태그가 조용히 생긴다 — 그게 원래 사고의 모양이다.
    expect(parseTagAction("주간보고 ->")).toEqual({ kind: "rename", from: "주간보고", to: "" });
  });

  test("★'-> 이름' 은 삭제로 읽는다★ — 빼기표 우선이 의도다", () => {
    // '-' 로 시작하면 삭제를 먼저 본다. 그래서 '-> 주간리포트' 는 '> 주간리포트' 라는 태그를 지우려는
    //   입력으로 해석되고, 그런 태그가 없으니 ★호출부가 '그런 태그가 없습니다' 로 시끄럽게 실패★ 한다.
    //   rename 으로 읽어 빈 from 을 만드는 것보다, 또 create 로 흘려 쓰레기 태그를 만드는 것보다 낫다.
    expect(parseTagAction("-> 주간리포트")).toEqual({ kind: "delete", name: "> 주간리포트" });
  });

  test("화살표가 여러 번 나오면 ★첫 번째★ 를 구분자로 본다", () => {
    expect(parseTagAction("a->b->c")).toEqual({ kind: "rename", from: "a", to: "b->c" });
  });
});
