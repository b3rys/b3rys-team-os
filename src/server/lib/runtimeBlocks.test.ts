import { describe, expect, test, beforeEach } from "bun:test";
import { clearRuntimeBlock, getRuntimeBlock, recordRuntimeBlock } from "./runtimeBlocks";

describe("runtimeBlocks", () => {
  beforeEach(() => {
    clearRuntimeBlock("codex");
    clearRuntimeBlock("cody");
  });

  test("openclaw response timeout blocks expire quickly", () => {
    recordRuntimeBlock("codex", "openclaw runtime openclaw response timeout: openclaw response timeout", 1_000);
    expect(getRuntimeBlock("codex", 1_000 + 10 * 60_000)?.line).toContain("openclaw response timeout");
    expect(getRuntimeBlock("codex", 1_000 + 10 * 60_000 + 1)).toBe(null);
  });

  test("hard runtime failures keep the longer diagnostic window", () => {
    recordRuntimeBlock("cody", "codex runtime failed: 429 rate limit", 1_000);
    expect(getRuntimeBlock("cody", 1_000 + 6 * 60 * 60_000)?.line).toContain("429 rate limit");
    expect(getRuntimeBlock("cody", 1_000 + 6 * 60 * 60_000 + 1)).toBe(null);
  });
});
