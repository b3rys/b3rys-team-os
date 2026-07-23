import { describe, expect, test } from "bun:test";
import { claudeTelegramLaunchdLabel } from "./agentControl";

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
