import { describe, expect, test } from "bun:test";
import { checkGatewayLiveness, gatewayLabel, type LaunchdProbe } from "./gatewayLiveness";

const probeOf = (state: ReturnType<LaunchdProbe>): LaunchdProbe => () => state;

describe("gatewayLabel — 팀원이 기대는 게이트웨이", () => {
  test("openclaw 는 공용 게이트웨이, hermes 는 프로필별, 그 밖은 없음", () => {
    expect(gatewayLabel({ id: "devon", runtime: "openclaw", hermes_profile: null })).toBe("ai.openclaw.gateway");
    expect(gatewayLabel({ id: "hermes", runtime: "hermes_agent", hermes_profile: "b3ryshermes" })).toBe("ai.hermes.gateway-b3ryshermes");
    expect(gatewayLabel({ id: "ames", runtime: "hermes_agent", hermes_profile: null })).toBe("ai.hermes.gateway-ames");
    expect(gatewayLabel({ id: "bill", runtime: "claude_channel", hermes_profile: null })).toBeNull();
    expect(gatewayLabel({ id: "dex", runtime: "codex", hermes_profile: null })).toBeNull();
  });
});

describe("checkGatewayLiveness", () => {
  const devon = { id: "devon", runtime: "openclaw", hermes_profile: null } as const;

  test("떠 있으면 빠진 항목 없음", () => {
    expect(checkGatewayLiveness(devon, probeOf({ loaded: true, pid: 4242 }))).toEqual([]);
  });

  test("★launchd 에서 내려가 있으면 잡는다★ (설정 파일은 그대로인 경우)", () => {
    expect(checkGatewayLiveness(devon, probeOf({ loaded: false, pid: null }))).toEqual([
      "gateway:ai.openclaw.gateway launchd 미로드",
    ]);
  });

  test("로드돼 있지만 프로세스가 없으면 잡는다", () => {
    expect(checkGatewayLiveness(devon, probeOf({ loaded: true, pid: null }))).toEqual([
      "gateway:ai.openclaw.gateway 프로세스 없음",
    ]);
  });

  test("★잴 수 없으면 고장으로 보고하지 않는다★", () => {
    expect(checkGatewayLiveness(devon, probeOf(null))).toEqual([]);
  });

  test("게이트웨이가 없는 런타임은 재지도 않는다", () => {
    let called = 0;
    const probe: LaunchdProbe = () => {
      called++;
      return { loaded: false, pid: null };
    };
    expect(checkGatewayLiveness({ id: "bill", runtime: "claude_channel", hermes_profile: null }, probe)).toEqual([]);
    expect(called).toBe(0);
  });
});
