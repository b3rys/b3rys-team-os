import { describe, expect, test } from "bun:test";
import { shouldShowLiveBadge } from "./LiveBadge";

describe("LiveBadge host gating", () => {
  test("shows only on the private live dashboard", () => {
    expect(shouldShowLiveBadge("dev.b3rys.com")).toBe(true);
    expect(shouldShowLiveBadge("studio.b3rys.com")).toBe(false);
    expect(shouldShowLiveBadge("localhost")).toBe(false);
  });
});
