#!/usr/bin/env bun
// public-content-lint — 공개 저장소에 들어가는 diff 의 ★추가된 줄★ 에서 팀 내부 정보를 찾아 경고한다.
//
// 찾는 것(리뷰어가 손으로 grep 하던 것을 그대로 옮겼다):
//   member   팀원 표시이름·봇 username (agents.json). 런타임 이름과 같은 이름(Codex·Hermes)과
//            흔한 영어 낱말인 이름은 기본 제외 목록에 둔다.
//   lead     팀장 발언 인용·호칭 패턴 — '팀장님 (2026-…', 'GD (', 'GD 가/는/께…', 인용 뒤 '라고'.
//   project  projects.json 에 등록된 프로젝트 id·이름.
//
// ★경고만 한다 — 머지를 막지 않는다.★ 정당한 경우(등록 파일·이 도구 자신)는 허용 목록으로 뺀다.
// 막는 가드는 정당한 변경을 막는 순간 지워진다. 위치를 보여주고 판단은 사람이 한다.
//
// 사용:
//   git diff origin/main...HEAD | bun public-content-lint.ts [--agents agents.json] [--projects projects.json]
//                                                           [--owner-name 이름] [--allow 파일] [--json]
// 종료 코드는 항상 0(입력을 못 읽으면 2).
import { existsSync, readFileSync } from "node:fs";

type Finding = { file: string; line: number; kind: "member" | "lead" | "project"; match: string; text: string };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 런타임 이름이거나 흔한 낱말이라 이름으로 쓰면 오탐만 내는 것. */
const DEFAULT_NAME_EXCLUDE = new Set(["codex", "hermes", "openclaw", "brief", "claude"]);

/** 이 경로는 원래 이름·id 를 담는 곳이다. */
const DEFAULT_PATH_ALLOW = [/^agents\.json$/, /^projects\.json$/, /(^|\/)public-content-lint(\.test)?\.ts$/, /(^|\/)public-lint-allow\.txt$/];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildMatchers(opts: {
  agents: Array<{ id?: string; display_name?: string; telegram_bot_username?: string }>;
  projects: Array<{ id?: string; name?: string }>;
  ownerName?: string;
  excludeNames?: Set<string>;
  /** 공개해도 되는 낱말(예: 제품에 통합돼 공개된 프로젝트 이름) — 소문자로 비교. */
  allowTerms?: Set<string>;
}) {
  const exclude = new Set([...(opts.excludeNames ?? DEFAULT_NAME_EXCLUDE), ...(opts.allowTerms ?? [])]);
  const names = new Set<string>();
  const bots = new Set<string>();
  for (const a of opts.agents) {
    const dn = a.display_name?.trim();
    if (dn && dn.length >= 3 && !exclude.has(dn.toLowerCase())) names.add(dn);
    const bot = a.telegram_bot_username?.trim();
    if (bot) bots.add(bot);
  }
  // 표시이름은 대소문자를 지켜 낱말 경계로 — 'bill' 은 코드에 흔하지만 'Bill' 은 사람 이름이다.
  const member = names.size || bots.size
    ? new RegExp(
        [
          ...[...names].map((n) => `(?<![A-Za-z0-9_])${escapeRe(n)}(?![A-Za-z0-9_])`),
          ...[...bots].map((b) => `@?${escapeRe(b)}`),
        ].join("|"),
      )
    : null;
  const projectTerms = new Set<string>();
  for (const p of opts.projects) {
    for (const t of [p.id, p.name]) if (t && t.trim().length >= 3 && !exclude.has(t.trim().toLowerCase())) projectTerms.add(t.trim());
  }
  const project = projectTerms.size
    ? new RegExp([...projectTerms].map((t) => `(?<![A-Za-z0-9_])${escapeRe(t)}(?![A-Za-z0-9_])`).join("|"), "i")
    : null;
  const leadParts = [
    String.raw`팀장님?\s*\(\s*20\d\d`, // 팀장님 (2026-…  — 발언·결정 날짜 꼬리표
    String.raw`(?<![A-Za-z0-9_])GD\s*\(`, // GD (2026… · GD (지시)
    String.raw`(?<![A-Za-z0-9_\-/.])GD(?![A-Za-z0-9_\-])`, // 낱말로 쓴 GD(팀장 호칭). GD_AGENT_ID·direct_to_gd·--direct-to-gd 는 제외
  ];
  // 인용 뒤 '라고' 는 그 줄에 팀장·GD 가 함께 있을 때만 — 일반 인용("손으로" 라고)은 흔하다.
  const quoteRe = /["“”'][^"“”']{2,120}["“”']\s*(라고|라는|라며)/;
  const leadWordRe = /팀장|(?<![A-Za-z0-9_\-])GD(?![A-Za-z0-9_])/;
  if (opts.ownerName && opts.ownerName.trim().length >= 2 && opts.ownerName.trim() !== "GD") {
    leadParts.push(escapeRe(opts.ownerName.trim()));
  }
  const leadBase = new RegExp(leadParts.join("|"));
  const lead = {
    exec(text: string): RegExpExecArray | null {
      const hit = leadBase.exec(text);
      if (hit) return hit;
      return leadWordRe.test(text) ? quoteRe.exec(text) : null;
    },
  };
  return { member, project, lead };
}

export function lintDiff(diff: string, m: { member: RegExp | null; project: RegExp | null; lead: { exec(t: string): RegExpExecArray | null } }, allow: RegExp[] = []): Finding[] {
  const out: Finding[] = [];
  let file = "";
  let line = 0;
  let skip = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "");
      skip = file === "/dev/null" || [...DEFAULT_PATH_ALLOW, ...allow].some((re) => re.test(file));
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      if (!skip) {
        const text = raw.slice(1);
        for (const [kind, re] of [["member", m.member], ["lead", m.lead], ["project", m.project]] as const) {
          const hit = re?.exec(text);
          if (hit) out.push({ file, line, kind, match: hit[0], text: text.trim().slice(0, 160) });
        }
      }
      line++;
    } else if (!raw.startsWith("-") && !raw.startsWith("\\")) {
      line++;
    }
  }
  return out;
}

function readJsonArray(path: string | undefined, key?: string): any[] {
  if (!path || !existsSync(path)) return [];
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(v)) return v;
    if (key && Array.isArray(v?.[key])) return v[key];
  } catch {}
  return [];
}

if (import.meta.main) {
  let diff = "";
  try {
    diff = await Bun.stdin.text();
  } catch {
    console.error("public-content-lint: diff 를 읽지 못했다");
    process.exit(2);
  }
  // 허용 목록 파일: 한 줄에 하나. 'term:<낱말>' 은 공개해도 되는 이름, 그 밖은 경로 정규식.
  const allowFile = arg("--allow");
  const allowLines = allowFile && existsSync(allowFile)
    ? readFileSync(allowFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    : [];
  const allow = allowLines.filter((l) => !l.startsWith("term:")).map((l) => new RegExp(l));
  const allowTerms = new Set(allowLines.filter((l) => l.startsWith("term:")).map((l) => l.slice(5).trim().toLowerCase()).filter(Boolean));
  const matchers = buildMatchers({
    agents: readJsonArray(arg("--agents") ?? "agents.json", "agents"),
    projects: readJsonArray(arg("--projects") ?? "projects.json", "projects"),
    ownerName: arg("--owner-name"),
    allowTerms,
  });
  const findings = lintDiff(diff, matchers, allow);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(findings));
  } else if (findings.length === 0) {
    console.log("✓ public content lint: 추가된 줄에 팀원 이름·팀장 인용·내부 프로젝트명 없음");
  } else {
    console.log(`⚠ public content lint: ${findings.length}건 — 공개 저장소에 들어가도 되는지 확인하세요(막지 않음)`);
    for (const f of findings) console.log(`  ${f.file}:${f.line} [${f.kind}] "${f.match}" — ${f.text}`);
  }
  process.exit(0);
}
