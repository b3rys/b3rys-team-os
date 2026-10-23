/**
 * cogs 클로드 팀원 정책 → 이번 턴의 실행 설정, 그리고 승인 카드의 [항상] 규칙. 순수 함수(파일·DB·시간을 읽지 않는다).
 *
 *   absent  → legacy: 지금 동작 그대로(cogs_tool_scope folder/full). 자동 전환하지 않는다.
 *   invalid → blocked: 넓혀서 돌지 않고 턴을 막는다.
 *   CLI 가 실측한 버전보다 낮다 → blocked: 샌드박스·승인 동작을 확인하지 않은 CLI 로 돌지 않는다.
 *   valid   → auto 모드 + 승인 카드(--permission-prompts host) + OS 샌드박스.
 *
 * 보장 범위(claude 2.1.287, macOS 샌드박스, 작업 폴더 안 실측): Write/Edit 도구와 Bash·스크립트가 보호 파일(SOUL.md·
 * CLAUDE.md·.claude·제어 경로)에 쓰지 못한다. deny 는 allow·[항상]·카드 허용보다 우선이고, 샌드박스 밖 실행 요청은
 * 카드 없이 거절된다(allowUnsandboxedCommands:false). 대가로 Bash 는 작업 폴더 밖에 쓰지 못한다.
 * 미검증(보장하지 않는다): 시크릿 읽기·유출 차단, 심링크 우회. network.allowedDomains ["*"] 는 인터넷 전체 허용이지
 * 유출 방지 장치가 아니다.
 */
import { isAbsolute, join, normalize } from "node:path";
import type { PolicyState } from "../../lib/cogsPermissions/policy";
import { policyStamp } from "../../lib/cogsPermissions/policy";

/** 샌드박스·승인 동작을 실측한 가장 낮은 CLI 버전. */
export const COGS_CLAUDE_MIN_CLI = [2, 1, 287] as const;

export type CogsClaudeRun =
  | { mode: "legacy" }
  | { mode: "blocked"; reason: string }
  | {
      mode: "enforced";
      /** 이 설정을 만든 정책 도장 — 카드·세션 허용을 이 도장에 묶는다. */
      stamp: string;
      /** 카드 없이 하는 일: 기본(작업 폴더 안·웹) + 정책 allow. */
      allowed: string[];
      /** --settings 로 넘길 값(훅·플러그인·자동 메모리 끔, deny, 샌드박스). */
      settings: Record<string, unknown>;
    };

export interface ClaudeRunContext {
  /** 실제 작업 폴더(realpath). */
  workspace: string;
  /** `claude --version` 출력. */
  cliVersion: string;
  /** 쓰기·읽기를 막을 제어 파일 경로(agents.json, b3os 저장소 등) — 정확한 절대 경로. */
  controlPaths: string[];
}

export function resolveCogsClaudeRun(state: PolicyState, ctx: ClaudeRunContext): CogsClaudeRun {
  if (state.state === "absent") return { mode: "legacy" };
  if (state.state === "invalid") return { mode: "blocked", reason: state.reason };
  const p = state.policy;
  if (p.runtime !== "claude") return { mode: "blocked", reason: "runtime_mismatch" };
  if (!cliSupported(ctx.cliVersion)) return { mode: "blocked", reason: "cli_unsupported" };
  if (!isAbsolute(ctx.workspace) || normalize(ctx.workspace) !== ctx.workspace || ctx.workspace === "/") {
    return { mode: "blocked", reason: "workspace" };
  }
  const root = ctx.workspace;
  const base = ["WebFetch", "WebSearch", ...["Read", "Glob", "Grep", "Write", "Edit"].map((tool) => `${tool}(/${root}/**)`)];
  return {
    mode: "enforced",
    stamp: policyStamp(p),
    allowed: [...base, ...p.allow.filter((rule) => !base.includes(rule))],
    settings: {
      disableAllHooks: true, enabledPlugins: {}, autoMemoryEnabled: false,
      sandbox: { enabled: true, allowUnsandboxedCommands: false, network: { allowedDomains: ["*"] } },
      permissions: { deny: protectedDeny(root, ctx.controlPaths) },
    },
  };
}

export function cliSupported(versionOutput: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\s/.exec(versionOutput);
  if (!m) return false;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [minMajor, minMinor, minPatch] = COGS_CLAUDE_MIN_CLI;
  if (major !== minMajor) return major > minMajor;
  if (minor !== minMinor) return minor > minMinor;
  return patch >= minPatch;
}

const SECRET_READS = ["Read(~/.claude/**)", "Read(~/.secrets/**)", "Read(**/.env)", "Read(**/.env.*)"];
const SECRET_WRITES = ["**/.env", "**/.env.*"];

/** 보호 파일·제어 파일·시크릿. deny 는 allow 보다 우선한다. */
export function protectedDeny(root: string, controlPaths: string[]): string[] {
  const own = ["SOUL.md", "CLAUDE.md", ".claude"].map((name) => join(root, name));
  const writes = [...own, ...controlPaths].flatMap((path) => [`/${path}`, `/${path}/**`]);
  return [
    ...writes.flatMap((path) => [`Write(${path})`, `Edit(${path})`]),
    ...SECRET_WRITES.flatMap((path) => [`Write(${path})`, `Edit(${path})`]),
    ...controlPaths.flatMap((path) => [`Read(/${path})`, `Read(/${path}/**)`]),
    ...SECRET_READS,
  ];
}

// Bash 로 범위를 확정할 수 없는 모양: 복합·파이프·리다이렉션·치환·백그라운드·줄바꿈·이스케이프·글롭·변수.
const BASH_UNSAFE = /[;&|<>`$\\\n\r*?{}()[\]!#~'"]/;
// [항상]을 줄 수 있는 명령(첫 토큰). 목록 밖은 판별하지 못한 것으로 보고 버튼을 숨긴다 — 금지 목록이 아니라 허용 목록.
const ALWAYS_COMMANDS = new Set(["ls", "pwd", "cat", "head", "tail", "wc", "grep", "rg", "diff", "git", "go", "swift", "xcodebuild"]);
const MAX_RULE = 200;

export type AlwaysRule = { rule: string } | { rule: null; why: string };

/**
 * 승인 카드의 [항상] 규칙. 서버가 실제 요청에서 최소 범위로 만든다(모델이 제안한 규칙·원시 입력을 그대로 쓰지 않는다).
 * 정확한 규칙을 못 만들거나 보호 대상과 겹치면 null — 카드는 [항상] 버튼을 숨긴다.
 */
export function alwaysRuleFor(toolName: string, input: unknown, ctx: { workspace: string; controlPaths: string[] }): AlwaysRule {
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (toolName === "Bash") {
    if (args.dangerouslyDisableSandbox === true) return { rule: null, why: "unsandboxed" };
    const raw = typeof args.command === "string" ? args.command : "";
    // 원문으로 먼저 본다 — 공백을 접으면 줄바꿈(명령 둘)이 한 명령처럼 보인다.
    if (BASH_UNSAFE.test(raw) || /[^\S ]/.test(raw.trim())) return { rule: null, why: "compound_or_expansion" };
    const command = raw.trim().replace(/ +/g, " ");
    if (!command) return { rule: null, why: "no_command" };
    const first = command.split(" ")[0] ?? "";
    if (!ALWAYS_COMMANDS.has(first)) return { rule: null, why: "not_allowlisted" };
    return bounded(`Bash(${command})`);
  }
  if (toolName === "Write" || toolName === "Edit" || toolName === "Read") {
    const path = typeof args.file_path === "string" ? args.file_path : "";
    if (!isAbsolute(path) || normalize(path) !== path || path.endsWith("/") || /[\u0000-\u001f()*?[\]{}]/.test(path)) {
      return { rule: null, why: "path" };
    }
    if (touchesProtected(path, ctx)) return { rule: null, why: "protected" };
    return bounded(`${toolName}(/${path})`);
  }
  if (toolName === "WebFetch") {
    try {
      const url = new URL(String(args.url ?? ""));
      if (url.protocol !== "https:" && url.protocol !== "http:") return { rule: null, why: "url" };
      return bounded(`WebFetch(domain:${url.hostname})`);
    } catch { return { rule: null, why: "url" }; }
  }
  return { rule: null, why: "unsupported_tool" };
}

function bounded(rule: string): AlwaysRule {
  return rule.length <= MAX_RULE ? { rule } : { rule: null, why: "too_long" };
}

function touchesProtected(path: string, ctx: { workspace: string; controlPaths: string[] }): boolean {
  const own = ["SOUL.md", "CLAUDE.md", ".claude"].map((name) => join(ctx.workspace, name));
  const under = (root: string) => path === root || path.startsWith(root + "/");
  const base = path.split("/").pop() ?? "";
  return [...own, ...ctx.controlPaths].some(under) || base === ".env" || base.startsWith(".env.")
    || path.includes("/.claude/") || path.includes("/.secrets/");
}
