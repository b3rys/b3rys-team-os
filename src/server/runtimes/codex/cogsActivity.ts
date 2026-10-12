/** Compact tool targets for cogs; command arguments and tool output never leave this formatter. */
const clip = (text: string, max = 45): string => Array.from(text).slice(0, max).join("");
const filename = (path: string): string => safeText(path.replace(/\\/g, "/").split("/").pop() ?? "");

function safeText(text: string): string {
  return clip(text
    .replace(/\b(?:[A-Za-z_][\w]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+))/g, "[redacted]")
    .replace(/\b(?:authorization\s*[:=]?\s*)?bearer\s+\S+/gi, "[redacted]")
    .replace(/(?:["'](?:token|secret|password|api[-_ ]?key|authorization)["']|\b(?:token|secret|password|api[-_ ]?key|authorization))\s*[:=]?\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}]+)/gi, "[redacted]")
    .replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*/g, "[env]")
    .replace(/https?:\/\/[^\s]+/g, (url) => { try { return new URL(url ?? "").hostname; } catch { return "[url]"; } })
    .replace(/(?:[A-Za-z]:[\\/]|~?\/)[^\s]+/g, "[path]")
    .replace(/\b[A-Za-z0-9_+-]{24,}\b/g, "[redacted]")
    .replace(/[\r\n\t\x00-\x1f]/g, " "));
}

function commandLine(command: string): string {
  // Only the executable and known subcommands are safe to display; arbitrary arguments can be secrets.
  const words = command.trim().match(/(?:[^\s"'\\]|\\.|"[^"]*"|'[^']*')+/g) ?? [];
  while (words[0] === "env" || /^[A-Za-z_]\w*=/.test(words[0] ?? "")) words.shift();
  const executable = words.shift() ?? "";
  if (!/^(?:[\w./\\-]+)$/.test(executable)) return "🛠️ $ command";
  const name = filename(executable);
  if (["cat", "head", "tail", "less"].includes(name)) {
    const target = words.find(word => !word.startsWith("-"));
    return target && /^[\w./\\-]+$/.test(target) ? `📖 read ${filename(target)}` : "📖 read";
  }
  const subcommand = /^(?:status|diff|log|test|run|build|check|install)$/.test(words[0] ?? "") ? ` ${words[0]}` : "";
  return `🛠️ $ ${name || "command"}${subcommand}`;
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
    const verb = changes[0]?.kind?.type === "add" ? "write" : "edit";
    return `${verb === "write" ? "📝" : "✏️"} ${verb} ${changes.length === 1 ? filename(String(changes[0]?.path ?? "")) : `${changes.length} files`}`;
  }
  if (type === "webSearch" || type === "web_search") {
    const action = it.action ?? {};
    const url = action.url ?? it.url;
    if (action.type === "openPage" || (!action.type && url)) {
      try { return `🌐 fetch ${clip(new URL(url ?? "").hostname)}`; } catch { return "🌐 fetch"; }
    }
    const query = action.pattern ?? it.pattern ?? action.queries ?? action.query ?? it.queries ?? it.query ?? "";
    return `🌐 search${query ? ` ${safeText(Array.isArray(query) ? query.join(" · ") : String(query))}` : ""}`;
  }
  if (type === "mcpToolCall") return `🔌 ${safeText(String(it.name ?? "tool").split("__").pop() ?? "tool")}`;
  return "🛠️ tool";
}
