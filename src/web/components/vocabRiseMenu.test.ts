import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "MetricsBar.ts"), "utf8");

describe("Vocab Rise global menu", () => {
  it("links to the canonical published app", () => {
    expect(source).toContain('id="global-vocab-rise-link"');
    expect(source).toContain('href="/vocab-rise/"');
    expect(source).toContain('>Vocab Rise<');
  });

  it("is the final item in the left global navigation", () => {
    const settings = source.indexOf('id="global-settings-tab"');
    const vocab = source.indexOf('<a id="global-vocab-rise-link"');
    const clusterEnd = source.indexOf('</div>\n          <div class="flex items-center justify-end', settings);
    const finalFragment = source.slice(vocab, clusterEnd);
    expect(settings).toBeGreaterThan(-1);
    expect(vocab).toBeGreaterThan(settings);
    expect(vocab).toBeLessThan(clusterEnd);
    expect(finalFragment.match(/<(?:a|button)\b/g)).toHaveLength(1);
    expect(finalFragment).not.toContain('target=');
    expect(finalFragment).toContain('min-h-10');
    expect(finalFragment).toContain('[touch-action:manipulation]');
  });
});
