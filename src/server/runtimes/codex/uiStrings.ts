import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Render only where the transport has no code-to-label application layer. */
export function uiText(key: string, args: Record<string, unknown> = {}, locale = process.env.B3OS_UI_LOCALE ?? "ko"): string {
  const read = (source: URL | string): Record<string, string> => {
    try {
      const catalog = JSON.parse(readFileSync(source, "utf8"));
      return Object.fromEntries(Object.entries(catalog).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""));
    } catch { return {}; }
  };
  const load = (language: string): Record<string, string> => ({
    ...read(new URL(`./locales/${language}.json`, import.meta.url)),
    ...(process.env.B3OS_UI_LOCALES_DIR ? read(join(process.env.B3OS_UI_LOCALES_DIR, `${language}.json`)) : {}),
  });
  const fallback = load("ko");
  const selected = locale === "en" ? load("en") : fallback;
  const template = selected[key] || fallback[key] || key;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(args[name] ?? ""));
}

export function renderRuntimeEvent(line: string): string {
  try {
    const event = JSON.parse(line) as { code?: string; args?: Record<string, unknown> };
    if (!event.code) return line;
    const label = uiText(event.code, event.args);
    const target = event.args?.target;
    return typeof target === "string" && target ? `${label} · ${target}` : label;
  } catch { return line; }
}
