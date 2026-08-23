import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "MetricsBar.ts"), "utf8");

describe("Vocab Rise global menu", () => {
  it("links to the canonical published app", () => {
    expect(source).toContain('id="global-vocab-rise-link"');
    expect(source).toContain('href="/reports/file/vocab-rise-b2-c1/html"');
    expect(source).toContain('>Vocab Rise<');
  });

  it("is the final item in the left global navigation", () => {
    const settings = source.indexOf('id="global-settings-tab"');
    const vocab = source.indexOf('id="global-vocab-rise-link"');
    const clusterEnd = source.indexOf('</div>\n          <div class="flex items-center justify-end', settings);
    expect(settings).toBeGreaterThan(-1);
    expect(vocab).toBeGreaterThan(settings);
    expect(vocab).toBeLessThan(clusterEnd);
  });
});
