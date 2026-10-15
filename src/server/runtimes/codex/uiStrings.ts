import { readFileSync } from "node:fs";

/** Text is only rendered at channels without an application localization layer. */
export function uiText(key: string, args: Record<string, unknown> = {}, locale = process.env.B3OS_UI_LOCALE ?? "ko"): string {
  const load = (language: string): Record<string, string> => {
    try { return JSON.parse(readFileSync(new URL(`./locales/${language}.json`, import.meta.url), "utf8")); }
    catch { return {}; }
  };
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
