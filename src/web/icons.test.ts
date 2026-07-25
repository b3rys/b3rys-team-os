import { afterEach, expect, test } from "bun:test";
import { downloadAgentIconJpg } from "./icons";

const originalDocument = globalThis.document;
const originalImage = globalThis.Image;
const originalWindow = globalThis.window;

afterEach(() => {
  globalThis.document = originalDocument;
  globalThis.Image = originalImage;
  globalThis.window = originalWindow;
});

test("downloadAgentIconJpg uses the saved member icon color when rasterizing JPG", async () => {
  let capturedSvg = "";

  globalThis.Image = class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    set src(value: string) {
      capturedSvg = decodeURIComponent(value.replace(/^data:image\/svg\+xml;charset=utf-8,/, ""));
      queueMicrotask(() => this.onload?.());
    }
  } as unknown as typeof Image;

  globalThis.window = {} as unknown as Window & typeof globalThis;
  globalThis.document = {
    createElement(tag: string) {
      if (tag === "canvas") {
        return {
          width: 0,
          height: 0,
          getContext() {
            return { fillStyle: "", fillRect() {}, drawImage() {} };
          },
          toDataURL() {
            return "data:image/jpeg;base64,stub";
          },
        };
      }
      return { href: "", download: "", click() {}, remove() {} };
    },
    body: { appendChild() {} },
  } as unknown as Document;

  const result = await downloadAgentIconJpg("clo", "layers", "#f59e0b");

  expect(result).toBe("saved");
  expect(capturedSvg).toContain('stroke="#f59e0b"');
});
