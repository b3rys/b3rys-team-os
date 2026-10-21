/**
 * cogs 권한 정책의 단일 쓰기 진입점 — 권한 API 와 '항상 허용' 이 모두 여기로 쓴다.
 *
 * 원본 = agents.json 의 팀원별 cogs_permissions. 쓰기 순서:
 *   잠금 → 원본 다시 읽기 → revision 대조 → 안전 쓰기(writeRegistrySafely) → 잠금 풀기
 *   → 아직 실행에 넘기지 않은 승인 무효화 → policy_changed 이벤트.
 * 원본을 쓴 뒤 무효화 전에 죽어도 옛 카드는 결정·실행되지 않는다(결정·인계 때 원본 revision 을 다시 읽는다).
 * 서버 시작 때 reconcile() 이 남은 것을 정리한다.
 * 브리지(다른 프로세스)도 '항상 허용' 으로 같은 파일을 쓰므로, 읽고-고치고-쓰기는 파일 잠금 안에서 한다.
 */
import type { Database } from "bun:sqlite";
import { closeSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { writeRegistrySafely } from "../registrySafety";
import { invalidateCogsApprovals } from "./approvals";
import type { CogsPermissionEvents } from "./events";
import { isNarrowing, nextPolicy, policyRuntimeOf, readPolicy, type CogsPolicy, type CogsPolicyRuntime, type PolicyState } from "./policy";

export interface CogsMember {
  id: string;
  runtime: CogsPolicyRuntime;
  /** 그 팀원 1:1 방(channel.owner_chat). 권한 요청은 이 방에서만 받는다. */
  roomId: string;
}

export type ReadResult =
  | { ok: true; member: CogsMember; policy: PolicyState }
  | { ok: false; code: "not_found" | "unsupported_runtime" | "registry_unreadable" };

export type UpdateResult =
  | { ok: true; policy: CogsPolicy; narrowed: boolean; invalidated: number }
  | { ok: false; code: "not_found" | "unsupported_runtime" | "registry_unreadable" | "revision_conflict" | "unsupported_field" | "bad_policy" | "write_failed" | "busy" | "invalid_policy" };

export interface CogsPolicyServiceDeps {
  registryPath: string;
  db: Database;
  events?: CogsPermissionEvents;
  onRegistryChanged?: () => void;
  /** 시험 주입 */
  lockTimeoutMs?: number;
}

const ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const STALE_LOCK_MS = 10_000;

function readList(registryPath: string): any[] {
  const raw = JSON.parse(readFileSync(registryPath, "utf-8")) as unknown;
  if (!Array.isArray(raw)) throw new Error("registry_not_array");
  return raw;
}

/** cogs 앱이 만든 팀원만(b3chat 채널, 정식 팀원 아님). 텔레그램 팀원은 대상이 아니다. */
function asCogsMember(a: any): CogsMember | "not_found" | "unsupported_runtime" {
  if (!a || a.team_official_member !== false || a.channel?.kind !== "b3chat") return "not_found";
  const runtime = policyRuntimeOf(a.runtime);
  if (!runtime) return "unsupported_runtime";
  const room = a.channel?.owner_chat;
  if (room === undefined || room === null || String(room) === "") return "not_found";
  return { id: String(a.id), runtime, roomId: String(room) };
}

/** 원본에서 그 팀원의 지금 revision — 결정·실행 인계 직전에 부른다. 없음·깨짐·못 읽음은 null. */
export function currentCogsRevision(registryPath: string, memberId: string): number | null {
  try {
    const a = readList(registryPath).find((x) => x?.id === memberId);
    const m = asCogsMember(a);
    if (typeof m === "string") return null;
    const p = readPolicy(a.cogs_permissions, m.runtime);
    return p.state === "valid" ? p.policy.revision : null;
  } catch {
    return null;
  }
}

/** 프로세스 사이 잠금(O_EXCL 파일). 오래된 잠금은 죽은 쓰기로 보고 치운다. */
function withRegistryLock<T>(registryPath: string, timeoutMs: number, fn: () => T): T | "busy" {
  const lock = `${registryPath}.cogs-permissions.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      closeSync(fd);
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) { unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() >= deadline) return "busy";
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch { /* 이미 없음 */ } }
}

function revisionOf(p: PolicyState): number {
  return p.state === "valid" ? p.policy.revision : 0;
}

export function createCogsPolicyService(deps: CogsPolicyServiceDeps) {
  const { registryPath, db, events } = deps;
  const lockTimeout = deps.lockTimeoutMs ?? 2_000;

  function read(memberId: string): ReadResult {
    if (!ID_RE.test(memberId)) return { ok: false, code: "not_found" };
    let a: any;
    try { a = readList(registryPath).find((x) => x?.id === memberId); } catch { return { ok: false, code: "registry_unreadable" }; }
    const m = asCogsMember(a);
    if (typeof m === "string") return { ok: false, code: m };
    return { ok: true, member: m, policy: readPolicy(a.cogs_permissions, m.runtime) };
  }

  /**
   * 원본을 바꾼다. build 는 지금 상태를 받아 다음 정책을 만든다(또는 거절 코드).
   * 없음·깨짐의 지금 revision 은 0 으로 친다 — 복구·첫 설정은 expected 0 으로 한다.
   */
  function write(
    memberId: string,
    expectedRevision: number | null,
    build: (state: PolicyState, member: CogsMember, currentRevision: number) => { ok: true; policy: CogsPolicy } | { ok: false; code: "unsupported_field" | "bad_policy" | "invalid_policy" },
    exceptRequestId?: string,
  ): UpdateResult {
    if (!ID_RE.test(memberId)) return { ok: false, code: "not_found" };
    let before: PolicyState = { state: "absent" };
    const r = withRegistryLock(registryPath, lockTimeout, (): UpdateResult | { ok: true; policy: CogsPolicy } => {
      let list: any[];
      try { list = readList(registryPath); } catch { return { ok: false, code: "registry_unreadable" }; }
      const a = list.find((x) => x?.id === memberId);
      const m = asCogsMember(a);
      if (typeof m === "string") return { ok: false, code: m };
      before = readPolicy(a.cogs_permissions, m.runtime);
      const current = before.state === "valid" ? before.policy.revision : 0;
      if (expectedRevision !== null && expectedRevision !== current) return { ok: false, code: "revision_conflict" };
      const next = build(before, m, current);
      if (!next.ok) return next;
      a.cogs_permissions = next.policy; // 다른 팀원·다른 칸은 그대로 둔다
      try { writeRegistrySafely(registryPath, list); } catch { return { ok: false, code: "write_failed" }; }
      return { ok: true, policy: next.policy };
    });
    if (r === "busy") return { ok: false, code: "busy" };
    if (!r.ok) return r;
    const narrowed = isNarrowing(before, r.policy);
    const invalidated = invalidateCogsApprovals(db, {
      agentId: memberId, reason: narrowed ? "policy_narrowed" : "policy_changed", newRevision: r.policy.revision, events,
      ...(exceptRequestId !== undefined ? { exceptRequestId } : {}),
    });
    events?.emit({
      type: "policy_changed", change_id: randomUUID(), agent_id: memberId,
      old_revision: revisionOf(before),
      new_revision: r.policy.revision, narrowed,
    });
    try { deps.onRegistryChanged?.(); } catch { /* 명부 재적재 실패가 저장을 되돌리지 않는다 */ }
    return { ok: true, policy: r.policy, narrowed, invalidated };
  }

  /** 권한 API 의 PUT. */
  function update(memberId: string, expectedRevision: number, input: unknown): UpdateResult {
    return write(memberId, expectedRevision, (_state, m, current) => nextPolicy(input, m.runtime, current));
  }

  /**
   * '항상 허용' — 지금 정책에 규칙 하나를 더한다. 정책이 정상일 때만(없음·깨짐이면 승인하지 않는다).
   * 클로드는 allow 규칙, 코덱스는 쓰기 경로. 이미 있으면 revision 만 올리지 않고 그대로 돌려준다.
   */
  function addAlways(memberId: string, rule: string, requestId?: string): { ok: true; revision: number } | { ok: false } {
    const cur = read(memberId);
    if (!cur.ok || cur.policy.state !== "valid") return { ok: false };
    const p = cur.policy.policy;
    const has = p.runtime === "claude" ? p.allow.includes(rule) : p.writable_roots.includes(rule);
    if (has) return { ok: true, revision: p.revision };
    const r = write(memberId, p.revision, (state, m, current) => {
      if (state.state !== "valid") return { ok: false, code: "invalid_policy" };
      const q = state.policy;
      const body = q.runtime === "claude"
        ? { mode: q.mode, allow: [...q.allow, rule] }
        : { full: q.full, network: q.network, writable_roots: [...q.writable_roots, rule] };
      return nextPolicy(body, m.runtime, current);
    }, requestId);
    return r.ok ? { ok: true, revision: r.policy.revision } : { ok: false };
  }

  /**
   * 서버 시작 때: 원본 revision 과 다른 revision 에 묶인 미인계 승인을 정리한다
   * (원본 저장 뒤 무효화 전에 죽은 경우).
   */
  function reconcile(): number {
    const agents = db.prepare(
      `SELECT DISTINCT b.agent_id AS agent_id FROM cogs_permission_binding b JOIN permission_request r ON r.id = b.request_id
        WHERE b.invalidation_reason IS NULL AND b.handed_off_at_ms IS NULL AND r.status IN ('pending','allowed_once','allowed_always')`,
    ).all() as Array<{ agent_id: string }>;
    let n = 0;
    for (const { agent_id } of agents) {
      const rev = currentCogsRevision(registryPath, agent_id);
      n += invalidateCogsApprovals(db, { agentId: agent_id, reason: "policy_changed", events, ...(rev === null ? {} : { keepRevision: rev }) });
    }
    return n;
  }

  return { read, update, addAlways, reconcile };
}

export type CogsPolicyService = ReturnType<typeof createCogsPolicyService>;
