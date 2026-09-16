export type TodoState = "doing" | "plan" | "done";
export interface TodoItem { state: TodoState; title: string; section: string }

/** Registry default when an entry has no `excludeSections` (docs/PROJECTS_TAB.md §1·§3). */
export const DEFAULT_EXCLUDE_SECTIONS: readonly string[] = ["킵"];

/**
 * Parse TODO.md into current state. A heading containing any of `excludeSections`
 * (substring match on the heading text) hides the `[ ]` items below it — through nested
 * headings, but not its siblings. The list comes from the registry, not from code.
 */
export function parseProjectTodo(md: string, excludeSections: readonly string[] = DEFAULT_EXCLUDE_SECTIONS) {
  const items: TodoItem[] = [];
  const headings: { level: number; text: string; excluded: boolean }[] = [];
  let fence: { char: string; length: number } | undefined;
  for (const line of md.split(/\r?\n/)) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = { char: marker[1]![0]!, length: marker[1]!.length };
      else if (marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      continue;
    }
    if (fence) continue;
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*$/);
    if (h) {
      const level = h[1]!.length;
      while (headings.length && headings.at(-1)!.level >= level) headings.pop();
      headings.push({ level, text: h[2]!, excluded: excludeSections.some(needle => h[2]!.includes(needle)) });
      continue;
    }
    const task = line.match(/^\s*- \[([~ xX])\]\s+(.+)$/);
    if (!task) continue;
    const state: TodoState = task[1] === "~" ? "doing" : task[1] === " " ? "plan" : "done";
    if (state === "plan" && headings.some(h => h.excluded)) continue;
    items.push({ state, title: task[2]!.trim(), section: headings.at(-1)?.text ?? "" });
  }
  return {
    doing: items.filter(x => x.state === "doing").length,
    plan: items.filter(x => x.state === "plan").length,
    done: items.filter(x => x.state === "done").length,
    doingTitles: items.filter(x => x.state === "doing").map(x => [...x.title].slice(0, 60).join("")),
    items,
    excludeSections: [...excludeSections],
  };
}
