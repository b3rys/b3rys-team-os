/** Protocol summaries are string arrays; older callers may supply a string or text. */
export function reasoningSummaryOf(item: unknown): string {
  const it = (item ?? {}) as { type?: unknown; summary?: unknown; text?: unknown };
  if (it.type !== "reasoning") return "";
  const summary = Array.isArray(it.summary)
    ? it.summary.filter((part): part is string => typeof part === "string").join("\n")
    : typeof it.summary === "string" ? it.summary : typeof it.text === "string" ? it.text : "";
  return summary.split("\n").map(line => line.trim()).find(Boolean) ?? "";
}
