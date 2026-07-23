// ★불변식: 팀 리드 = coordinator + full_context.★
//
// 원래는 첫 영입 멤버가 coordinator 만 받았다. 그래서 '팀 리드'인데도 팀방 맥락(full_context)을 못 봤고,
// full_context 는 부여하는 코드가 아예 없어서 agents.json 을 손으로 고치지 않는 한 아무도 못 받았다
// (= 퍼블릭 사용자는 팀 맥락을 보는 멤버가 0명). GD 2026-07-12 결정으로 둘을 한 묶음으로 만든다.
//
// 첫 영입과 승계(heir)가 ★같은 단일 출처★를 쓰는지도 함께 고정한다 — 따로 관리하면 한쪽만 붙는 갭이 생긴다.
import { describe, test, expect } from "bun:test";
import { LEAD_CAPABILITIES, withLeadCapabilities, withInitialLeadCapabilities } from "./activation";

describe("LEAD_CAPABILITIES — 팀 리드 능력 묶음", () => {
  test("coordinator 와 full_context 를 둘 다 포함한다", () => {
    expect(LEAD_CAPABILITIES).toContain("coordinator");
    expect(LEAD_CAPABILITIES).toContain("full_context");
  });
});

describe("withInitialLeadCapabilities — 첫 영입", () => {
  test("★첫 영입 멤버는 coordinator + full_context 를 받는다★ (팀 리드로서 팀 맥락을 본다)", () => {
    const entry = withInitialLeadCapabilities([], { id: "alice" });
    expect(entry.capabilities).toContain("coordinator");
    expect(entry.capabilities).toContain("full_context");
  });

  test("두 번째 이후 영입은 리드 능력을 받지 않는다", () => {
    const entry = withInitialLeadCapabilities([{ id: "alice" }], { id: "bob" });
    // 기존 동작 유지: 첫 멤버가 아니면 건드리지 않는다.
    expect((entry as { capabilities?: string[] }).capabilities).toBeUndefined();
  });

  test("이미 가진 능력은 보존한다(덮어쓰지 않음)", () => {
    const entry = withInitialLeadCapabilities([], { id: "alice", capabilities: ["recovery"] });
    expect(entry.capabilities).toContain("recovery");
    expect(entry.capabilities).toContain("coordinator");
    expect(entry.capabilities).toContain("full_context");
  });
});

describe("withLeadCapabilities — 승계(heir)도 같은 규칙", () => {
  test("★승계자도 coordinator + full_context 를 받는다★ (첫 영입 리드와 권한이 같아야 한다)", () => {
    const caps = withLeadCapabilities(["restricted_mention"]);
    expect(caps).toContain("coordinator");
    expect(caps).toContain("full_context");
    expect(caps).toContain("restricted_mention"); // 기존 능력 보존
  });

  test("중복을 만들지 않는다", () => {
    const caps = withLeadCapabilities(["coordinator", "full_context"]);
    expect(caps.filter((c) => c === "coordinator")).toHaveLength(1);
    expect(caps.filter((c) => c === "full_context")).toHaveLength(1);
  });

  test("빈/비배열 입력도 안전하다", () => {
    expect(withLeadCapabilities(undefined)).toEqual(expect.arrayContaining(["coordinator", "full_context"]));
    expect(withLeadCapabilities(null)).toEqual(expect.arrayContaining(["coordinator", "full_context"]));
  });
});
