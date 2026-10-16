#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

export type Finding = { file: string; line: number; rule: string };
export const EXCEPTIONS = [
  { pattern: "src/**/{test,tests,__tests__,fixtures,testdata}/** and *.test/spec.ts(x)", reason: "Synthetic paths in test input do not configure production machines." },
  { pattern: "Shell comments, quoted documentation and quoted heredocs", reason: "These are literal text, not Bash commands or expansions." },
  { pattern: "Markdown outside sh/bash/shell fences; non-shell programs", reason: "These are not executed by the Bash 3.2 shell." },
];

export function scanShell(file: string, source: string, offset = 0): Finding[] {
  const findings: Finding[] = [];
  let quote = "";
  let here: { word: string; strip: boolean; expand: boolean } | undefined;
  for (const [index, row] of source.split("\n").entries()) {
    const add = (rule: string) => findings.push({ file, line: offset + index + 1, rule });
    const expansions = (text: string) => { if (/\$\{[^}\n]*\^\^[^}\n]*\}/.test(text)) add("bash-uppercase"); };
    if (here) {
      if ((here.strip ? row.replace(/^\t+/, "") : row) === here.word) here = undefined;
      else if (here.expand) expansions(row);
      continue;
    }
    let commands = "";
    let expandable = "";
    for (let i = 0; i < row.length; i++) {
      const c = row[i]!;
      if (c === "\\" && quote !== "'") { commands += "  "; expandable += "  "; i++; continue; }
      if (!quote && c === "#" && (i === 0 || /[\s;|&()]/.test(row[i - 1]!))) break;
      if (quote === "'") { if (c === "'") quote = ""; commands += " "; expandable += " "; continue; }
      if (c === "'" && !quote) { quote = "'"; commands += " "; expandable += " "; continue; }
      if (c === '"') { quote = quote === '"' ? "" : '"'; commands += " "; expandable += " "; continue; }
      commands += quote ? " " : c;
      expandable += c;
    }
    expansions(expandable);
    for (const substitution of expandable.matchAll(/\$\(([^)]*)\)/g)) findings.push(...scanShell(file, substitution[1]!, offset + index));
    const commandStart = /(?:^|[;&|({]|\b(?:then|do|if|while|until))\s*(?:builtin\s+)?/;
    if (new RegExp(commandStart.source + "(?:declare|typeset)\\s+(?:-[a-zA-Z]+\\s+)*-[a-zA-Z]*A[a-zA-Z]*(?:\\s|$)").test(commands)) add("bash-associative-array");
    if (new RegExp(commandStart.source + "mapfile(?:\\s|$)").test(commands)) add("bash-mapfile");
    // Heredoc bodies are text; only unquoted delimiters allow shell expansions.
    const marker = /<<(-)?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(row);
    if (marker && commands.includes("<<")) here = { word: marker[2] ?? marker[3] ?? marker[4]!, strip: Boolean(marker[1]), expand: Boolean(marker[4]) };
  }
  return findings.filter((f, i, all) => all.findIndex(other => other.line === f.line && other.rule === f.rule) === i);
}

export function scanPortability(file: string, source: string): Finding[] {
  if (file.startsWith("src/") && /\.[cm]?[jt]sx?$/.test(file)) {
    if (/(?:\.(?:test|spec)\.[jt]sx?$|\/(?:test|tests|__tests__|fixtures|testdata)\/)/.test(file)) return [];
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const findings: Finding[] = [];
    function visit(node: ts.Node) {
      if ([ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail].includes(node.kind) && node.getText(tree).includes("/Users/")) {
        findings.push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, rule: "hardcoded-users-path" });
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    return findings;
  }
  if (!(file.startsWith("scripts/") || file.startsWith("skills/") || file === "install.sh")) return [];
  if (file.endsWith(".sh") || /^#!.*\b(?:ba)?sh\b/.test(source)) return scanShell(file, source);
  if (file.endsWith(".md")) {
    const out: Finding[] = [];
    const rows = source.split("\n");
    let start = -1;
    let fence = "";
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (start < 0) {
        const m = /^\s*(`{3,}|~{3,})(?:bash|sh|shell)\s*$/.exec(row);
        if (m) { start = i + 1; fence = m[1]!; }
      } else if (row.trim().startsWith(fence)) {
        out.push(...scanShell(file, rows.slice(start, i).join("\n"), start)); start = -1;
      }
    }
    if (start >= 0) out.push(...scanShell(file, rows.slice(start).join("\n"), start));
    return out;
  }
  return [];
}

if (import.meta.main) {
  const files = execFileSync("git", ["ls-files", "-z", "--", "src", "scripts", "skills", "install.sh"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const findings = files.flatMap(file => scanPortability(file, readFileSync(file, "utf8")));
  for (const f of findings) console.error(`${f.file}:${f.line}: ${f.rule}: Bash 3.2 문법과 HOME·설정 기반 경로를 사용하세요`);
  console.log(`portability violations: ${findings.length}`);
  process.exit(findings.length ? 1 : 0);
}
