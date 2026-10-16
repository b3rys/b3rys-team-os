#!/usr/bin/env bun
import ts from "typescript";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export const MESSAGE = "고정 문구는 상태 코드(cogs_activity_code)로 보내세요";
export type Finding = { file: string; line: number; key: string };
export const ALLOWLIST: Record<string, string> = {
  empty: "Empty text carries status metadata without adding a chat sentence.",
  tests: "Test/spec files are inputs, not production messages.",
  logs: "console/logger calls do not deliver chat text.",
};

export function scanChatLiterals(file: string, source: string): Finding[] {
  if (/(?:\.(?:test|spec)\.[cm]?[jt]sx?$|\/(?:test|tests|__tests__)\/)/.test(file)) return [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // Resolve identifiers by lexical scope, including declarations later in the same scope.
  const host = ts.createCompilerHost({ noResolve: true });
  host.getSourceFile = name => name === file ? sf : undefined;
  const program = ts.createProgram([file], { noResolve: true, noLib: true }, host);
  const checker = program.getTypeChecker();
  const writes = new Map<ts.Symbol, ts.Expression[]>();
  function collectWrites(node: ts.Node) {
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(node.operatorToken.kind) && ts.isIdentifier(node.left)) {
      const symbol = checker.getSymbolAtLocation(node.left);
      if (symbol) writes.set(symbol, [...(writes.get(symbol) ?? []), node.right]);
    }
    ts.forEachChild(node, collectWrites);
  }
  collectWrites(sf);
  function fingerprint(node: ts.Node, seen = new Set<ts.Node>()): string[] {
    if (seen.has(node)) return [];
    seen.add(node);
    if (ts.isStringLiteralLike(node)) return node.text.trim() ? [node.text] : [];
    if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.flatMap(s => [...fingerprint(s.expression, seen), s.literal.text])].filter(s => s.trim());
    if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
      if (!symbol) return [];
      const initial = (symbol.declarations ?? []).flatMap(d => ts.isVariableDeclaration(d) && d.initializer ? fingerprint(d.initializer, seen) : []);
      return [...initial, ...(writes.get(symbol) ?? []).flatMap(e => fingerprint(e, seen))];
    }
    if (ts.isConditionalExpression(node)) return [...fingerprint(node.whenTrue, seen), ...fingerprint(node.whenFalse, seen)];
    if (ts.isCallExpression(node)) return [...(ts.isPropertyAccessExpression(node.expression) ? fingerprint(node.expression.expression, seen) : []), ...node.arguments.flatMap(a => fingerprint(a, seen))];
    if (ts.isPropertyAccessExpression(node)) return [];
    const parts: string[] = [];
    ts.forEachChild(node, child => { parts.push(...fingerprint(child, seen)); });
    return parts;
  }
  const literal = (node: ts.Node) => fingerprint(node).length > 0;
  const found: Finding[] = [];
  const offsets = new Set<number>();
  function report(node: ts.Node) {
    if (offsets.has(node.getStart(sf))) return;
    offsets.add(node.getStart(sf));
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    // Exact source expression + multiplicity ratchet; moving lines does not reset the baseline.
    found.push({ file, line, key: `${file}:${node.getText(sf).replace(/\s+/g, " ")}:${JSON.stringify(fingerprint(node))}` });
  }
  function visit(node: ts.Node) {
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(node.operatorToken.kind)) {
      const left = node.left;
      const property = ts.isPropertyAccessExpression(left) ? left.name.text : ts.isElementAccessExpression(left) && ts.isStringLiteralLike(left.argumentExpression) ? left.argumentExpression.text : undefined;
      if (property === "text" && literal(node.right)) report(node.right);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (/^(?:console|logger|log)\./.test(callee)) return;
      const name = callee.split(".").at(-1);
      const index = ["send", "sendMessage", "buildOpenclawTelegramSendMessageBody"].includes(name ?? "") ? 1 : ["edit", "editMessage", "editMessageText", "sendAsAgentBot", "postTelegramAsHermes", "postTelegramAsOpenclaw"].includes(name ?? "") ? 2 : -1;
      if (index >= 0 && node.arguments[index] && literal(node.arguments[index]!)) report(node.arguments[index]!);
    }
    if (ts.isObjectLiteralExpression(node)) {
      const names = node.properties.map(p => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : "");
      // Bot API bodies, including JSON.stringify payloads and locally named body objects.
      if (names.includes("chat_id")) {
        for (const prop of node.properties) {
          if (!prop.name || prop.name.getText(sf).replace(/["']/g, "") !== "text") continue;
          const value = ts.isPropertyAssignment(prop) ? prop.initializer : ts.isShorthandPropertyAssignment(prop) ? prop.name : undefined;
          if (value && literal(value)) report(value);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

export function newFindings(findings: Finding[], baseline: Record<string, number>): Finding[] {
  const seen: Record<string, number> = {};
  return findings.filter(f => (seen[f.key] = (seen[f.key] ?? 0) + 1) > (baseline[f.key] ?? 0));
}

if (import.meta.main) {
  const files = execFileSync("git", ["ls-files", "src/server"], { encoding: "utf8" }).trim().split("\n").filter(f => f.endsWith(".ts"));
  const all = files.flatMap(f => scanChatLiterals(f, readFileSync(f, "utf8")));
  const baseline = JSON.parse(readFileSync(new URL("./chat-literals-baseline.json", import.meta.url), "utf8")) as { reason: string; counts: Record<string, number> };
  const violations = newFindings(all, baseline.counts);
  for (const f of violations) console.error(`${f.file}:${f.line}: ${MESSAGE}`);
  console.log(`chat literals: existing=${all.length - violations.length}, new=${violations.length}`);
  process.exit(violations.length ? 1 : 0);
}
