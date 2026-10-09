import { lstatSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const COGS_MODELS = {
  codex: ["gpt-6-luna", "gpt-6.1-sol"],
  claude: ["sonnet", "opus"],
} as const;

export function modelLine(cur: string): string | null {
  return /^model\s*=\s*"([^"\n]+)"/m.exec(cur.split(/^\s*\[/m)[0] ?? "")?.[1] ?? null;
}

// Only the root model setting changes; section-local settings remain intact.
export function setModelLine(cur: string, model: string): string {
  const start = cur.search(/^\s*\[/m);
  const top = start < 0 ? cur : cur.slice(0, start);
  const rest = start < 0 ? "" : cur.slice(start);
  if ((top.match(/^model\s*=/gm) ?? []).length > 1) throw new Error("invalid_config");
  const line = `model = "${model}"`;
  return (/^model\s*=.*$/m.test(top) ? top.replace(/^model\s*=.*$/m, line) : `${line}\n${top}`) + rest;
}

export function readModel(path: string): string | null {
  if (!lstatSync(path).isFile() || !lstatSync(dirname(path)).isDirectory()) throw new Error("invalid_config");
  return modelLine(readFileSync(path, "utf-8"));
}

export function saveModel(path: string, runtime: keyof typeof COGS_MODELS, model: string): void {
  if (!(COGS_MODELS[runtime] as readonly string[]).includes(model)) throw new Error("unsupported_model");
  readModel(path);
  const next = setModelLine(readFileSync(path, "utf-8"), model);
  const temp = `${path}.model-${randomUUID()}`;
  try {
    writeFileSync(temp, next, {mode:lstatSync(path).mode & 0o777, flag:"wx"});
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* Nothing was created. */ }
    throw error;
  }
}
