/**
 * cogs AI 팀원 권한 정책 — 스키마·판정만 있는 순수 모듈(파일·DB·시간을 읽지 않는다).
 *
 * 원본은 agents.json 의 팀원별 `cogs_permissions` 하나다. 저장·취소·이벤트는 service.ts 가 한다.
 * 런타임이 실제로 집행할 수 있다고 확인된 칸만 둔다 — 못 막는 것을 막는 것처럼 보이면 안 된다.
 * (코덱스 '폴더 밖 읽기'·'명령 끄기'는 집행 시험 전이라 칸이 없다.)
 */
import { isAbsolute, normalize } from "node:path";

export const POLICY_SCHEMA_VERSION = 1;
export type CogsPolicyRuntime = "claude" | "codex";

export interface ClaudePolicy {
  runtime: "claude";
  schema_version: number;
  revision: number;
  /** 승인 방식. 지금은 auto 하나 — 위험한 일만 묻는다. */
  mode: "auto";
  /** 승인 없이 하는 일(Claude 권한 규칙 문자열, 예: `Bash(git push:*)`). */
  allow: string[];
}

export interface CodexPolicy {
  runtime: "codex";
  schema_version: number;
  revision: number;
  /** 전체 허용 = 승인 없이 디스크·인터넷 전부(지금 덱스와 같다). */
  full: boolean;
  network: boolean;
  /** 작업 폴더 밖에서 쓸 수 있는 정확한 경로들. 상위 폴더로 넓히지 않는다. */
  writable_roots: string[];
}

export type CogsPolicy = ClaudePolicy | CodexPolicy;

export type PolicyState =
  | { state: "absent" }
  | { state: "valid"; policy: CogsPolicy }
  | { state: "invalid"; reason: string };

const MAX_RULES = 100;
const MAX_RULE_LEN = 200;
const MAX_ROOTS = 50;
const MAX_PATH_LEN = 400;
// Claude 권한 규칙: 도구 이름, 또는 도구(내용). 줄바꿈·제어문자 없이.
const CLAUDE_RULE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:__[A-Za-z0-9_-]+)*(?:\([^\u0000-\u001f()]*(?:\([^\u0000-\u001f()]*\)[^\u0000-\u001f()]*)*\))?$/;
const FIELDS: Record<CogsPolicyRuntime, readonly string[]> = {
  claude: ["runtime", "schema_version", "revision", "mode", "allow"],
  codex: ["runtime", "schema_version", "revision", "full", "network", "writable_roots"],
};
// 사람이 PUT 으로 보내는 칸(서버가 정하는 runtime·schema_version·revision 은 뺀다).
const EDITABLE: Record<CogsPolicyRuntime, readonly string[]> = {
  claude: ["mode", "allow"],
  codex: ["full", "network", "writable_roots"],
};

/** agents.json 런타임 이름 → 정책 런타임. cogs 정책이 없는 런타임은 null. */
export function policyRuntimeOf(agentRuntime: unknown): CogsPolicyRuntime | null {
  return agentRuntime === "claude_channel" ? "claude" : agentRuntime === "codex" ? "codex" : null;
}

/** 새 팀원 기본값(revision 1). 클로드 auto + 빈 제외 목록, 코덱스 인터넷 켬·전체 허용 끔. */
export function defaultPolicy(runtime: CogsPolicyRuntime): CogsPolicy {
  return runtime === "claude"
    ? { runtime, schema_version: POLICY_SCHEMA_VERSION, revision: 1, mode: "auto", allow: [] }
    : { runtime, schema_version: POLICY_SCHEMA_VERSION, revision: 1, full: false, network: true, writable_roots: [] };
}

/** 원본 값 판정. 없음(옛 팀원)과 깨짐을 섞지 않는다. */
export function readPolicy(raw: unknown, runtime: CogsPolicyRuntime): PolicyState {
  if (raw === undefined || raw === null) return { state: "absent" };
  if (typeof raw !== "object" || Array.isArray(raw)) return { state: "invalid", reason: "not_object" };
  const r = raw as Record<string, unknown>;
  if (r.runtime !== runtime) return { state: "invalid", reason: "runtime_mismatch" };
  if (r.schema_version !== POLICY_SCHEMA_VERSION) return { state: "invalid", reason: "schema_version" };
  if (!Number.isSafeInteger(r.revision) || (r.revision as number) < 1) return { state: "invalid", reason: "revision" };
  if (Object.keys(r).some((k) => !FIELDS[runtime].includes(k))) return { state: "invalid", reason: "unknown_field" };
  const body = checkBody(r, runtime);
  if (!body.ok) return { state: "invalid", reason: body.reason };
  return { state: "valid", policy: { ...body.value, runtime, schema_version: POLICY_SCHEMA_VERSION, revision: r.revision as number } as CogsPolicy };
}

/** PUT 본문 → 다음 정책(revision 은 이전 +1). 모르는 칸·잘못된 형식은 거절한다. */
export function nextPolicy(
  input: unknown,
  runtime: CogsPolicyRuntime,
  currentRevision: number,
): { ok: true; policy: CogsPolicy } | { ok: false; code: "bad_policy" | "unsupported_field" } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, code: "bad_policy" };
  const r = input as Record<string, unknown>;
  if (Object.keys(r).some((k) => !EDITABLE[runtime].includes(k))) return { ok: false, code: "unsupported_field" };
  const body = checkBody(r, runtime);
  if (!body.ok) return { ok: false, code: "bad_policy" };
  return { ok: true, policy: { ...body.value, runtime, schema_version: POLICY_SCHEMA_VERSION, revision: currentRevision + 1 } as CogsPolicy };
}

type Body = { ok: true; value: Record<string, unknown> } | { ok: false; reason: string };

function checkBody(r: Record<string, unknown>, runtime: CogsPolicyRuntime): Body {
  if (runtime === "claude") {
    if (r.mode !== "auto") return { ok: false, reason: "mode" };
    const allow = stringList(r.allow, MAX_RULES, MAX_RULE_LEN, (s) => CLAUDE_RULE_RE.test(s));
    return allow ? { ok: true, value: { mode: "auto", allow } } : { ok: false, reason: "allow" };
  }
  if (typeof r.full !== "boolean") return { ok: false, reason: "full" };
  if (typeof r.network !== "boolean") return { ok: false, reason: "network" };
  const roots = stringList(r.writable_roots, MAX_ROOTS, MAX_PATH_LEN, isExactAbsolutePath);
  return roots ? { ok: true, value: { full: r.full, network: r.network, writable_roots: roots } } : { ok: false, reason: "writable_roots" };
}

/** 중복 없는 문자열 목록. 하나라도 틀리면 전체를 거절한다(일부만 받아들이지 않는다). */
function stringList(v: unknown, max: number, maxLen: number, ok: (s: string) => boolean): string[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || !item || item.length > maxLen || !ok(item) || out.includes(item)) return null;
    out.push(item);
  }
  return out;
}

/** 정규화한 절대경로와 글자가 같아야 한다 — `..`·`//`·끝 `/` 로 범위를 흐리지 않는다. */
export function isExactAbsolutePath(p: string): boolean {
  return isAbsolute(p) && p !== "/" && normalize(p) === p && !p.endsWith("/") && !/[\u0000-\u001f]/.test(p);
}

/**
 * 권한이 줄었나. 줄었으면 대기 카드·세션 허용을 즉시 무효화한다.
 * 확실히 넓어지기만 한 경우만 false — 판단할 수 없으면 줄어든 것으로 본다.
 */
export function isNarrowing(before: PolicyState, after: CogsPolicy): boolean {
  if (before.state !== "valid") return true;
  const b = before.policy;
  if (b.runtime !== after.runtime) return true;
  if (b.runtime === "claude" && after.runtime === "claude") {
    return b.allow.some((rule) => !after.allow.includes(rule));
  }
  if (b.runtime === "codex" && after.runtime === "codex") {
    return (b.full && !after.full)
      || (b.network && !after.network)
      || b.writable_roots.some((root) => !after.writable_roots.includes(root));
  }
  return true;
}
