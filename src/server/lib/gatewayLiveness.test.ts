import { describe, expect, test } from "bun:test";
import { checkGatewayLiveness, gatewayLabel, interpretLaunchctlList, openclawGatewayLabel, type LaunchdProbe } from "./gatewayLiveness";

const probeOf = (state: ReturnType<LaunchdProbe>): LaunchdProbe => () => state;

describe("gatewayLabel — 팀원이 기대는 게이트웨이", () => {
  test("openclaw 는 공용 게이트웨이, hermes 는 프로필별, 그 밖은 없음", () => {
    expect(gatewayLabel({ id: "devon", runtime: "openclaw", hermes_profile: null }, {})).toBe("ai.openclaw.gateway");
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

describe("openclawGatewayLabel — openclaw 자신의 라벨 규칙과 같게", () => {
  test("기본", () => expect(openclawGatewayLabel({})).toBe("ai.openclaw.gateway"));
  test("이름 있는 프로필 → ai.openclaw.<profile>", () =>
    expect(openclawGatewayLabel({ OPENCLAW_PROFILE: "work" })).toBe("ai.openclaw.work"));
  test("'default'·공백 프로필은 기본으로", () => {
    expect(openclawGatewayLabel({ OPENCLAW_PROFILE: "Default" })).toBe("ai.openclaw.gateway");
    expect(openclawGatewayLabel({ OPENCLAW_PROFILE: "  " })).toBe("ai.openclaw.gateway");
  });
  test("OPENCLAW_LAUNCHD_LABEL 이 프로필보다 앞선다", () =>
    expect(openclawGatewayLabel({ OPENCLAW_LAUNCHD_LABEL: "com.me.claw", OPENCLAW_PROFILE: "work" })).toBe("com.me.claw"));
  test("라벨 문자 규칙에 안 맞으면 null(잴 수 없음 → 침묵)", () =>
    expect(openclawGatewayLabel({ OPENCLAW_LAUNCHD_LABEL: "bad label;rm" })).toBeNull());
  test("라벨을 정할 수 없으면 probe 를 부르지 않고 빈 목록", () => {
    let called = 0;
    const r = checkGatewayLiveness({ id: "devon", runtime: "openclaw", hermes_profile: null },
      () => { called++; return { loaded: false, pid: null }; }, { OPENCLAW_LAUNCHD_LABEL: "bad label" });
    expect(r).toEqual([]);
    expect(called).toBe(0);
  });
});

describe("interpretLaunchctlList — 종료 코드를 상태로", () => {
  const listed = `{\n\t"Label" = "ai.openclaw.gateway";\n\t"PID" = 68296;\n};`;
  test("0 + PID → 로드·실행 중", () =>
    expect(interpretLaunchctlList({ status: 0, stdout: listed })).toEqual({ loaded: true, pid: 68296 }));
  test("0 + PID 없음 → 로드됐지만 프로세스 없음", () =>
    expect(interpretLaunchctlList({ status: 0, stdout: `{\n\t"Label" = "x";\n};` })).toEqual({ loaded: true, pid: null }));
  test("★113(그런 서비스 없음)만 미로드★", () =>
    expect(interpretLaunchctlList({ status: 113, stdout: "" })).toEqual({ loaded: false, pid: null }));
  test("★그 밖의 0 아닌 값은 판정 보류(null)★ — 권한·domain 오류를 장애로 바꾸지 않는다", () => {
    for (const status of [1, 3, 5, 37, 112, 150]) expect(interpretLaunchctlList({ status, stdout: "" })).toBeNull();
  });
  test("실행 실패·종료 코드 없음은 판정 보류", () => {
    expect(interpretLaunchctlList({ status: null })).toBeNull();
    expect(interpretLaunchctlList({ status: 0, error: new Error("ENOENT") })).toBeNull();
  });
});
