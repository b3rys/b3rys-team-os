import { describe, expect, test } from "bun:test";
import { contentTypeForMediaFile, mediaIdFor, mediaUrlFor, resolveMediaPath } from "./mediaStore";

describe("mediaStore", () => {
  test("creates stable media ids without exposing Telegram file ids", () => {
    expect(mediaIdFor({ file_id: "telegram-file-id", file_unique_id: "same-file" })).toMatch(/^tg_[a-f0-9]{16}$/);
    expect(mediaIdFor({ file_id: "other-id", file_unique_id: "same-file" })).toBe(
      mediaIdFor({ file_id: "telegram-file-id", file_unique_id: "same-file" }),
    );
  });

  test("resolves only media-id files inside the media directory", () => {
    const root = "/tmp/team-media";
    expect(resolveMediaPath(root, "tg_0123456789abcdef.jpg")).toBe("/tmp/team-media/tg_0123456789abcdef.jpg");
    expect(resolveMediaPath(root, "../secret.txt")).toBeNull();
    expect(resolveMediaPath(root, "tg_0123456789abcdef/secret.jpg")).toBeNull();
    expect(resolveMediaPath(root, "not-a-media-id.jpg")).toBeNull();
  });

  test("builds media URLs without duplicate slashes", () => {
    expect(mediaUrlFor("tg_0123456789abcdef.jpg", "https://your-team.example.com/team/media/")).toBe(
      "https://your-team.example.com/team/media/tg_0123456789abcdef.jpg",
    );
  });

  test("returns conservative content types", () => {
    expect(contentTypeForMediaFile("tg_0123456789abcdef.jpg")).toBe("image/jpeg");
    expect(contentTypeForMediaFile("tg_0123456789abcdef.bin")).toBe("application/octet-stream");
  });
});
