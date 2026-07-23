import { describe, expect, test } from "bun:test";
import { shouldShowClaudePairingPanel } from "./Settings";

describe("Settings Claude pairing panel visibility", () => {
  test("shows only when the server reports a pending pairing input for a claude OT", () => {
    expect(shouldShowClaudePairingPanel("claude_channel", { kind: "claude_pairing_code" })).toBe(true);
    expect(shouldShowClaudePairingPanel("claude_channel", { kind: "telegram_plugin_pairing" })).toBe(true);
  });

  test("hides for joined or auto-inherited claude members without pending pairing state", () => {
    expect(shouldShowClaudePairingPanel("claude_channel", null)).toBe(false);
    expect(shouldShowClaudePairingPanel("claude_channel", { kind: "bot_token" })).toBe(false);
    expect(shouldShowClaudePairingPanel("openclaw", { kind: "claude_pairing_code" })).toBe(false);
  });
});
