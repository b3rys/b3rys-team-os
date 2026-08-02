/**
 * ★팀원 id 를 코드에 박지 않는다.★ 공개 설치에는 우리 팀원 이름이 없다.
 *
 * 두 곳이 이름을 박고 있었다:
 *   · "전원 정지" 요약이 `id !== "bill"` 로 코디네이터를 골랐다
 *   · 대화창이 받는 사람을 못 찾으면 `?? "bill"` 로 보냈다
 *
 * ★그래서 명부에 그런 이름이 아예 없는 설치로도 잰다★ — 우리 팀 이름으로만 재면
 * "공개에서 깨진다" 는 축을 못 잡는다.
 */
import { describe, expect, test } from "bun:test";
import { stoppedIds, keptIds, threadRecipient } from "./stopAllSummary";

describe("전원 정지 요약 — 이름이 아니라 서버 표시를 읽는다", () => {
  test("★kept 로 표시된 멤버는 정지 목록에서 빠진다★", () => {
    const results = [
      { id: "alpha", ok: true, detail: "정지" },
      { id: "coord", ok: true, detail: "제외(복구 코디용)", kept: true },
      { id: "beta", ok: true, detail: "정지" },
    ];
    expect(stoppedIds(results)).toEqual(["alpha", "beta"]);
  });

  test("★코디네이터 이름이 무엇이든 맞게 돈다★ — 명부가 바뀌어도 낡지 않는다", () => {
    // 우리 팀 이름이 하나도 없는 명부. 예전 구현은 여기서 ★아무도 못 걸렀다.★
    const results = [
      { id: "kim", ok: true, detail: "정지" },
      { id: "park", ok: true, detail: "제외(복구 코디용)", kept: true },
    ];
    expect(stoppedIds(results)).toEqual(["kim"]);
    expect(stoppedIds(results)).not.toContain("park");
  });

  test("실패한 멤버는 '정지됨' 으로 세지 않는다", () => {
    const results = [
      { id: "alpha", ok: false, detail: "실패" },
      { id: "beta", ok: true, detail: "정지" },
    ];
    expect(stoppedIds(results)).toEqual(["beta"]);
  });
});

describe("대화창 받는 사람 — 못 정하면 안 보낸다", () => {
  test("★받는 사람이 없으면 null★ — 예전엔 특정 팀원에게 보냈다", () => {
    expect(threadRecipient(["user"])).toBeNull();
    expect(threadRecipient([])).toBeNull();
    expect(threadRecipient(undefined)).toBeNull();
  });

  test("팀원이 있으면 그 팀원 — 우리 팀 이름이 아니어도 된다", () => {
    expect(threadRecipient(["user", "kim"])).toBe("kim");
    expect(threadRecipient(["kim", "user", "park"])).toBe("kim");
  });
});

describe("유지된 팀원 — 이름을 서버 결과에서 읽는다", () => {
  test("★kept 로 표시된 사람을 그대로 돌려준다★ — 화면이 코디를 다시 판정하지 않는다", () => {
    const results = [
      { id: "kim", ok: true, detail: "정지" },
      { id: "park", ok: true, detail: "제외(복구 코디용)", kept: true },
    ];
    expect(keptIds(results)).toEqual(["park"]);
  });

  test("아무도 제외되지 않으면 빈 배열", () => {
    expect(keptIds([{ id: "kim", ok: true, detail: "정지" }])).toEqual([]);
  });
});
