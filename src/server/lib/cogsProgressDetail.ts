import { safeText } from "../runtimes/codex/cogsActivity";

export const COGS_PROGRESS_DETAIL_MAX = 45;
const FILE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|swift|go|rs|java|[ch]|cpp|hpp|cs|sh|rb|php|html|css|scss|md|txt|rst|adoc|json|ya?ml|toml|xml|csv|ipynb|png|jpe?g|gif|svg|webp|pdf)$/i;
const SENSITIVE_FILE = /(?:^|[ ._-])(?:config|kubeconfig|wallet|shadow|netrc|npmrc|keystore)(?:$|[ ._-])|\.(?:p12|pfx|ppk|keystore|tfstate|dat)$/i;

/** Fail closed on credentials, paths and shell syntax; never recover detail from commands. */
export function safeProgressDetail(value: unknown, file = false): string {
  if (typeof value !== "string" || value.length > 4096) return "";
  if (/[\p{Cc}\p{Cf}]/u.test(value)) return "";
  const text = value.trim().replace(/\s+/g, " ");
  if (!text || SENSITIVE_FILE.test(text) || (file && !FILE_EXTENSIONS.test(text))
    || /(?:\.env\b|credentials?|secrets?|tokens?|password|passwd|pass[-_ ]?phrase|api[-_ ]?key|private[-_ ]?key|\.pem\b|\.key\b|\bid_rsa\b|\bid_ed25519\b)/i.test(text)
    || /\b(?:pw|pass|key|private|BEGIN|OPENSSH|RSA)\b/i.test(text)
    || /[\/\\`$|;&<>:=@*]/.test(text)) return "";
  for (const word of text.match(/[\p{L}\p{N}_+-]+/gu) ?? []) {
    if (/^(?:gh[pousr]_|xox|sk-|AKIA|eyJ)/i.test(word)
      || (Array.from(word).length >= 8 && /\p{L}/u.test(word) && /\p{N}/u.test(word))) return "";
  }
  const clipped = Array.from(text).slice(0, COGS_PROGRESS_DETAIL_MAX).join("");
  return safeText(text) === clipped ? clipped : "";
}
