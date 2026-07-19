import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

export interface TelegramMediaRef {
  kind: "photo" | "document";
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  width?: number;
  height?: number;
}

export interface StoredMedia {
  media_id: string;
  kind: "photo" | "document";
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  width?: number;
  height?: number;
  file_path: string;
  url_path: string;
}

interface TelegramGetFileResponse {
  ok?: boolean;
  result?: { file_id: string; file_unique_id?: string; file_size?: number; file_path?: string };
  description?: string;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/json": ".json",
  "application/zip": ".zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
};

// 서빙 허용 확장자(안전 문서·이미지 한정 — html/svg/실행파일은 XSS·실행 위험이라 제외).
const ALLOWED_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".pdf",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".yaml",
  ".yml",
  ".log",
  ".xml",
  ".docx",
  ".xlsx",
  ".pptx",
  ".zip",
]);

export const DEFAULT_MEDIA_DIR = process.env.TEAM_MEDIA_DIR ?? join(process.cwd(), "..", "team-media");

export function mediaUrlFor(mediaFile: string, urlBase = "/media"): string {
  return `${urlBase.replace(/\/$/, "")}/${mediaFile}`;
}

export function mediaIdFor(ref: Pick<TelegramMediaRef, "file_id" | "file_unique_id">): string {
  const source = ref.file_unique_id || ref.file_id;
  return `tg_${createHash("sha256").update(source).digest("hex").slice(0, 16)}`;
}

function extensionFor(ref: TelegramMediaRef, telegramFilePath?: string): string {
  const candidates = [
    telegramFilePath ? extname(basename(telegramFilePath)) : "",
    ref.file_name ? extname(basename(ref.file_name)) : "",
    ref.mime_type ? EXT_BY_MIME[ref.mime_type] : "",
  ];
  const ext = candidates.find((v) => v && ALLOWED_EXTENSIONS.has(v.toLowerCase()));
  return (ext || ".bin").toLowerCase();
}

export function resolveMediaPath(mediaDir: string, mediaFile: string): string | null {
  if (mediaFile !== basename(mediaFile)) return null;
  if (!/^tg_[a-f0-9]{16}(?:\.[a-z0-9]+)?$/.test(mediaFile)) return null;
  const root = resolve(mediaDir);
  const full = resolve(root, mediaFile);
  return full === root || !full.startsWith(root + "/") ? null : full;
}

export function contentTypeForMediaFile(file: string): string {
  const ext = extname(file).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".txt") return "text/plain; charset=utf-8";
  if (ext === ".md") return "text/markdown; charset=utf-8";
  if (ext === ".csv") return "text/csv; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".yaml" || ext === ".yml" || ext === ".log" || ext === ".xml") return "text/plain; charset=utf-8";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === ".pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (ext === ".zip") return "application/zip";
  return "application/octet-stream";
}

export async function storeTelegramMedia(
  token: string,
  ref: TelegramMediaRef,
  opts: { mediaDir?: string; urlBase?: string } = {},
): Promise<StoredMedia> {
  const getFile = await fetch(`https://api.telegram.org/bot${token}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: ref.file_id }),
  });
  const info = (await getFile.json().catch(() => ({}))) as TelegramGetFileResponse;
  if (!info.ok || !info.result?.file_path) {
    throw new Error(info.description || "telegram getFile failed");
  }

  const mediaId = mediaIdFor(ref);
  const ext = extensionFor(ref, info.result.file_path);
  const mediaFile = `${mediaId}${ext}`;
  const mediaDir = opts.mediaDir ?? DEFAULT_MEDIA_DIR;
  const localPath = resolveMediaPath(mediaDir, mediaFile);
  if (!localPath) throw new Error("invalid media path");

  mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
  if (!existsSync(localPath)) {
    const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`);
    if (!fileRes.ok) throw new Error(`telegram file download failed: ${fileRes.status}`);
    await Bun.write(localPath, await fileRes.arrayBuffer());
  }

  return {
    media_id: mediaId,
    kind: ref.kind,
    file_id: ref.file_id,
    file_unique_id: ref.file_unique_id,
    file_name: ref.file_name,
    mime_type: ref.mime_type,
    file_size: ref.file_size ?? info.result.file_size,
    width: ref.width,
    height: ref.height,
    file_path: localPath,
    url_path: mediaUrlFor(mediaFile, opts.urlBase),
  };
}
