/** Keep the visible prefix when a completion contains only the remaining answer. */
export function preserveAnswer(prefix: string, answer: string): string {
  if (!prefix || answer.startsWith(prefix)) return answer;
  if (!answer || prefix.endsWith(answer)) return prefix;
  for (let n = Math.min(prefix.length, answer.length); n > 0; n--) {
    if (prefix.endsWith(answer.slice(0, n))) return prefix + answer.slice(n);
  }
  return prefix + "\n\n" + answer;
}

/** Item insertion order is answer order; phase is retained independently of text. */
export class TurnAnswerText {
  private items = new Map<string, { text: string; phase?: string }>();
  private currentId = "legacy";
  reset(): void { this.items.clear(); this.currentId = "legacy"; }
  observe(id?: string, phase?: string): string {
    if (id) this.currentId = id;
    const key = id ?? this.currentId;
    const entry = this.items.get(key) ?? { text: "" };
    if (phase) entry.phase = phase;
    this.items.set(key, entry);
    return key;
  }
  delta(text: string, id?: string, phase?: string): void {
    this.items.get(this.observe(id, phase))!.text += text;
  }
  complete(text: string, id?: string, phase?: string): void {
    const entry = this.items.get(this.observe(id, phase))!;
    entry.text = preserveAnswer(entry.text, text);
  }
  text(): string { return [...this.items.values()].map(i => i.text).filter(Boolean).join("\n\n"); }
}
