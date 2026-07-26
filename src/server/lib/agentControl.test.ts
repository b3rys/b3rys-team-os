import { describe, expect, test } from "bun:test";
import { claudeTelegramLaunchdLabel, hermesLaunchdLabel } from "./agentControl";

/* 2026-07-26 맥스튜디오 실측: 비상정지 뒤 대시보드 '기동' 으로 hermes 가 안 살아났다. 정지는 LaunchAgent 를
 * bootout 하는데 기동은 게이트웨이만 띄우고 bootstrap 을 안 해서다. 그 비대칭을 고치면서, 두 경로가 ★같은
 * 라벨★ 을 보도록 한 곳으로 모았다(예전엔 정지가 프로필 기반 문자열을 직접 만들어 gateway_service 를 무시했다). */
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
