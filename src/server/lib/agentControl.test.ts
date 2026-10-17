import { describe, expect, test } from "bun:test";
import { claudeTelegramLaunchdLabel, hermesLaunchdLabel } from "./agentControl";

// 기동과 정지가 같은 LaunchAgent 라벨을 사용해야 bootout한 서비스를 복구할 수 있다.
describe("hermesLaunchdLabel", () => {
  test("gateway_service 가 없으면 프로필 기반으로 도출한다", () => {
    expect(hermesLaunchdLabel(undefined, "herm")).toBe("ai.hermes.gateway-herm");
    expect(hermesLaunchdLabel({ gateway_service: null }, "mes")).toBe("ai.hermes.gateway-mes");
  });

  test("★gateway_service 가 있으면 그것이 정본★ — 라벨과 프로필이 다른 설치본에서 정지·기동이 엇갈리지 않는다", () => {
    expect(hermesLaunchdLabel({ gateway_service: "ai.hermes.custom-gw" }, "herm")).toBe("ai.hermes.custom-gw");
  });

  test("빈 문자열·공백은 미설정으로 본다 (빈 라벨로 bootout 하면 엉뚱한 대상이 된다)", () => {
    expect(hermesLaunchdLabel({ gateway_service: "" }, "herm")).toBe("ai.hermes.gateway-herm");
    expect(hermesLaunchdLabel({ gateway_service: "   " }, "herm")).toBe("ai.hermes.gateway-herm");
  });
});

describe("claudeTelegramLaunchdLabel", () => {
  test("기본 prefix 는 현재 USER 기반 com.${USER}", () => {
    const oldPrefix = process.env.TEAMOS_LAUNCHD_PREFIX;
    const oldUser = process.env.USER;
    try {
      delete process.env.TEAMOS_LAUNCHD_PREFIX;
      process.env.USER = "alice";
      expect(claudeTelegramLaunchdLabel("bill")).toBe("com.alice.claude-telegram-bill");
    } finally {
      if (oldPrefix === undefined) delete process.env.TEAMOS_LAUNCHD_PREFIX;
      else process.env.TEAMOS_LAUNCHD_PREFIX = oldPrefix;
      if (oldUser === undefined) delete process.env.USER;
      else process.env.USER = oldUser;
    }
  });

  test("TEAMOS_LAUNCHD_PREFIX override 를 우선한다", () => {
    const oldPrefix = process.env.TEAMOS_LAUNCHD_PREFIX;
    try {
      process.env.TEAMOS_LAUNCHD_PREFIX = "com.example.";
      expect(claudeTelegramLaunchdLabel("steve")).toBe("com.example.claude-telegram-steve");
    } finally {
      if (oldPrefix === undefined) delete process.env.TEAMOS_LAUNCHD_PREFIX;
      else process.env.TEAMOS_LAUNCHD_PREFIX = oldPrefix;
    }
  });
});
