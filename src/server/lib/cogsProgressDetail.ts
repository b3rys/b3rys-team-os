import { safeText } from "../runtimes/codex/cogsActivity";

export const COGS_PROGRESS_DETAIL_MAX = 45;

/** Fail closed on credentials, paths and shell syntax; never recover detail from commands. */
export function safeProgressDetail(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096) return "";
  const text = value.trim().replace(/\s+/g, " ");
  if (!text || /[\x00-\x1f\x7f]/.test(value)
    || /(?:\.env\b|credentials?|secrets?|tokens?|password|passwd|pass[-_ ]?phrase|api[-_ ]?key|private[-_ ]?key|\.pem\b|\.key\b|\bid_rsa\b|\bid_ed25519\b)/i.test(text)
    || /[\/\\`$|;&<>:=]/.test(text)) return "";
  const clipped = Array.from(text).slice(0, COGS_PROGRESS_DETAIL_MAX).join("");
  return safeText(text) === clipped ? clipped : "";
}
