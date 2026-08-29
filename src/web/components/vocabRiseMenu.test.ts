import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "MetricsBar.ts"), "utf8");

describe("dashboard navigation scope", () => {
  it("does not expose Vocab Rise in the b3os global menu", () => {
    expect(source).not.toContain('id="global-vocab-rise-link"');
    expect(source).not.toContain('href="/vocab-rise/"');
    expect(source).not.toContain('>Vocab Rise</a>');
  });
});
