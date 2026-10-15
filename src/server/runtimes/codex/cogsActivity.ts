import { uiText } from "./uiStrings";
/** Compact tool targets for cogs; command arguments and tool output never leave this formatter. */
const clip = (text: string, max = 45): string => Array.from(text).slice(0, max).join("");
const filename = (path: string): string => safeText(path.replace(/\\/g, "/").split("/").pop() ?? "");

function safeText(text: string): string {
  return clip(text
    // Header values may include a scheme plus short credentials or multiple Digest parameters.
    .replace(/\b(?:proxy-)?authorization\s*[:=]\s*[^\r\n]+/gi, "[redacted]")
    .replace(/\b(?:basic|bearer|digest|negotiate|ntlm|oauth|hoba|mutual|scram-sha-256|scram-sha-1|aws4-hmac-sha256)\s+[^\r\n]+/gi, "[redacted]")
    .replace(/\b(?:[A-Za-z_][\w]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+))/g, "[redacted]")
    .replace(/(?:["'](?:token|secret|password|api[-_ ]?key|authorization)["']|\b(?:token|secret|password|api[-_ ]?key|authorization))\s*[:=]?\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}]+)/gi, "[redacted]")
    .replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*/g, "[env]")
    .replace(/https?:\/\/[^\s]+/g, (url) => { try { return new URL(url ?? "").hostname; } catch { return "[url]"; } })
    .replace(/(?:[A-Za-z]:[\\/]|~?\/)[^\s]+/g, "[path]")
    .replace(/\b[A-Za-z0-9_+-]{24,}\b/g, "[redacted]")
    .replace(/[\r\n\t\x00-\x1f]/g, " "));
}

export type CogsActivityArgs = { target?: string; count?: number };

function commandInfo(command: string): { executable: string; target: string; reading: boolean } {
  const words = command.trim().match(/(?:[^\s"'\\]|\\.|"[^"]*"|'[^']*')+/g) ?? [];
  while (words[0] === "env" || /^[A-Za-z_]\w*=/.test(words[0] ?? "")) words.shift();
  const raw = words.shift() ?? "";
  if (!/^(?:[\w./\\-]+)$/.test(raw)) return { executable: "", target: "", reading: false };
  const executable = filename(raw);
  const reading = ["cat", "head", "tail", "less"].includes(executable);
  if (reading) {
    const path = words.find(word => !word.startsWith("-"));
    return { executable, reading, target: path && /^[\w./\\-]+$/.test(path) ? filename(path) : "" };
  }
  const subcommand = /^(?:status|diff|log|test|run|build|check|install)$/.test(words[0] ?? "") ? ` ${words[0]}` : "";
  return { executable, reading, target: `${executable}${subcommand}` };
}

/** Only sanitized tool data crosses the app boundary; apps own every label. */
export function cogsActivityArgs(item: unknown): CogsActivityArgs {
  const it = (item ?? {}) as Record<string, any>;
  const command = it.command ?? it.cmd;
  if (command) return { target: commandInfo(Array.isArray(command) ? command.join(" ") : String(command)).target };
  const changes = Array.isArray(it.changes) ? it.changes : Object.keys(it.fileChanges ?? {}).map(path => ({ path }));
  if (changes.length) return changes.length === 1 ? { target: filename(String(changes[0]?.path ?? "")) } : { count: changes.length };
  if (it.type === "webSearch" || it.type === "web_search") {
    const action = it.action ?? {};
    const url = action.url ?? it.url;
    if (action.type === "openPage" || (!action.type && url)) {
      try { return { target: clip(new URL(url ?? "").hostname) }; } catch { return {}; }
    }
    const query = action.pattern ?? it.pattern ?? action.queries ?? action.query ?? it.queries ?? it.query ?? "";
    return { target: safeText(Array.isArray(query) ? query.join(" · ") : String(query)) };
  }
  if (it.type === "mcpToolCall") return { target: safeText(String(it.name ?? "").split("__").pop() ?? "") };
  return {};
}

/** For Telegram only, which has no application code-to-label renderer. */
export function cogsActivityLine(item: unknown): string {
  const code = cogsActivityCode(item) ?? "tool";
  const args = cogsActivityArgs(item);
  const label = uiText(code, args);
  return args.target ? `${label} · ${args.target}` : label;
}

/** Activity codes describe observed tools; receipt/status notes have no tool code. */
export function cogsActivityCode(item: unknown): string | undefined {
  const it = (item ?? {}) as Record<string, any>;
  if (it.type === "webSearch" || it.type === "web_search") {
    return it.action?.type === "openPage" || it.action?.url || it.url ? "fetch_web" : "search";
  }
  if (it.type === "fileChange" || it.changes || it.fileChanges) {
    const paths = (it.changes ?? []).map((c: any) => c.path ?? "").concat(Object.keys(it.fileChanges ?? {}));
    if (paths.length && paths.every((p: string) => /\.(md|txt|rst|adoc)$/i.test(p))) return "writing";
    if (paths.some((p: string) => /\.(swift|go|py|js|jsx|ts|tsx|rs|java|c|h|cpp|html|css|sh)$/i.test(p))) return "code_edit";
    return "edit_files";
  }
  const command = it.command ?? it.cmd;
  if (command) {
    const info = commandInfo(Array.isArray(command) ? command.join(" ") : String(command));
    if (info.reading) return "read_files";
    return /\b(test|pytest|vitest|jest)\b/.test(info.target) ? "run_tests" : "run_command";
  }
  if (it.type === "mcpToolCall") {
    const name = String(it.name ?? it.tool ?? "");
    if (/update_plan|create_plan/.test(name)) return "plan";
    if (/apply_patch|edit_file/.test(name)) return "code_edit";
    if (/web|browse|fetch/.test(name)) return "fetch_web";
    if (/test/.test(name)) return "run_tests";
    if (/write/.test(name)) return "writing";
    return "run_command";
  }
  return undefined;
}
