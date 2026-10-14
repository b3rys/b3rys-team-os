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

const activityLine = (verb: string, target = ""): string => target ? `${verb} · ${target}` : verb;

function commandLine(command: string): string {
  // Only the executable and known subcommands are safe to display; arbitrary arguments can be secrets.
  const words = command.trim().match(/(?:[^\s"'\\]|\\.|"[^"]*"|'[^']*')+/g) ?? [];
  while (words[0] === "env" || /^[A-Za-z_]\w*=/.test(words[0] ?? "")) words.shift();
  const executable = words.shift() ?? "";
  if (!/^(?:[\w./\\-]+)$/.test(executable)) return "실행";
  const name = filename(executable);
  if (["cat", "head", "tail", "less"].includes(name)) {
    const target = words.find(word => !word.startsWith("-"));
    return activityLine("읽기", target && /^[\w./\\-]+$/.test(target) ? filename(target) : "");
  }
  const subcommand = /^(?:status|diff|log|test|run|build|check|install)$/.test(words[0] ?? "") ? ` ${words[0]}` : "";
  return activityLine("실행", `${name}${subcommand}`);
}

export function cogsActivityLine(item: unknown): string {
  const it = (item ?? {}) as {
    type?: string; command?: string | string[]; cmd?: string | string[];
    changes?: { path?: string; kind?: { type?: string } }[];
    fileChanges?: Record<string, unknown>; name?: string;
    action?: { type?: string; url?: string; pattern?: string; queries?: string[]; query?: string };
    url?: string; pattern?: string; queries?: string[]; query?: string;
  };
  const type = it.type;
  const command = it.command ?? it.cmd;
  if (typeof command === "string" || Array.isArray(command)) return commandLine(Array.isArray(command) ? command.join(" ") : command);
  const changes: NonNullable<typeof it.changes> = Array.isArray(it.changes) ? it.changes : Object.keys(it.fileChanges ?? {}).map(path => ({ path }));
  if (changes.length) {
    const verb = changes[0]?.kind?.type === "add" ? "새로 쓰기" : "수정";
    return activityLine(verb, changes.length === 1 ? filename(String(changes[0]?.path ?? "")) : `파일 ${changes.length}개`);
  }
  if (type === "webSearch" || type === "web_search") {
    const action = it.action ?? {};
    const url = action.url ?? it.url;
    if (action.type === "openPage" || (!action.type && url)) {
      try { return activityLine("페이지 열기", clip(new URL(url ?? "").hostname)); } catch { return "페이지 열기"; }
    }
    const query = action.pattern ?? it.pattern ?? action.queries ?? action.query ?? it.queries ?? it.query ?? "";
    return activityLine("검색", safeText(Array.isArray(query) ? query.join(" · ") : String(query)));
  }
  if (type === "mcpToolCall") return activityLine("도구", safeText(String(it.name ?? "").split("__").pop() ?? ""));
  return "도구";
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
    const line = commandLine(Array.isArray(command) ? command.join(" ") : String(command));
    if (line.startsWith("읽기")) return "read_files";
    return /\b(test|pytest|vitest|jest)\b/.test(line) ? "run_tests" : "run_command";
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
