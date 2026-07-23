import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("runtime activation safety", () => {
  test("Hermes reactivation force-corrects stale false TELEGRAM_REQUIRE_MENTION", () => {
    const script = readFileSync(
      join(import.meta.dir, "../runtimes/hermes/activate-hermes-agent.sh"),
      "utf-8",
    );
    expect(script).toContain('env["TELEGRAM_REQUIRE_MENTION"] = "true"');
    expect(script).not.toContain('env.setdefault("TELEGRAM_REQUIRE_MENTION"');
  });

  test("OpenClaw preflight detail documents both supported auth layouts", () => {
    const source = readFileSync(join(import.meta.dir, "runtimeAuth.ts"), "utf-8");
    expect(source).toContain("openclaw 인증 확인됨(전역 openclaw.json auth.profiles 또는 per-agent auth-profiles.json)");
    expect(source).toContain("openclaw 미인증(전역 openclaw.json auth.profiles가 비어 있고 per-agent auth-profiles.json도 없음)");
  });
});
