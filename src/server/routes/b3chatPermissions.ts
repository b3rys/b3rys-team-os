/**
 * cogs AI 팀원 권한 API — cogs 서버만 부른다(같은 기계 + 공유 비밀, b3chatTeammate 와 같은 guard).
 *
 *   GET /members/b3chat/member/:memberId/permissions?actor_user_id=&owner_user_id=&room_id=
 *   PUT /members/b3chat/member/:memberId/permissions  { actor_user_id, owner_user_id, room_id, expected_revision, policy }
 *
 * 사람 인가는 cogs 서버가 한다: 로그인한 사람 = actor, 그 봇의 DB owner_id = owner, 그 팀원 1:1 방 = room.
 * 여기서는 서버가 실어 보낸 결합이 이 팀원과 맞는지(방)와, 바꾸기는 actor == owner 인지만 본다.
 * 정책 계산·저장은 lib/cogsPermissions/service 가 한다 — 이 파일에 SQL·정책 규칙을 넣지 않는다.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { linkGuard } from "../lib/b3chatLink";
import type { CogsPermissionEvents } from "../lib/cogsPermissions/events";
import { POLICY_SCHEMA_VERSION, type PolicyState } from "../lib/cogsPermissions/policy";
import { createCogsPolicyService, type CogsMember } from "../lib/cogsPermissions/service";
import { defaultRemoteAddress } from "./b3chatTeammate";

export interface B3chatPermissionDeps {
  db: Database;
  registryPath: string;
  events?: CogsPermissionEvents;
  onRegistryChanged?: () => void;
  /** 시험 주입 */
  linkKeyPath?: string;
  remoteAddress?: (c: Context) => string | null;
}

const ERROR_STATUS: Record<string, 400 | 403 | 404 | 409 | 503> = {
  not_found: 404,
  unsupported_runtime: 400,
  bad_request: 400,
  unsupported_field: 400,
  bad_policy: 400,
  invalid_policy: 400,
  forbidden: 403,
  revision_conflict: 409,
  registry_unreadable: 503,
  write_failed: 503,
  busy: 503,
};

const USER_ID_RE = /^[1-9]\d{0,18}$/;

function view(member: CogsMember, policy: PolicyState, canEdit: boolean, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    member_id: member.id,
    runtime: member.runtime,
    state: policy.state,
    policy: policy.state === "valid" ? policy.policy : null,
    ...(policy.state === "invalid" ? { reason: policy.reason } : {}),
    revision: policy.state === "valid" ? policy.policy.revision : 0,
    schema_version: POLICY_SCHEMA_VERSION,
    // 실행 정책은 지금 하는 일이 끝난 뒤(다음 턴)부터. 대기 중인 승인 카드는 바꾸는 즉시 무효.
    applies: "next_turn",
    can_edit: canEdit,
    ...extra,
  };
}

export function createB3chatPermissionRoutes(deps: B3chatPermissionDeps): Hono {
  const app = new Hono();
  const keyPath = deps.linkKeyPath ?? join(dirname(deps.registryPath), "var", "secrets", "b3chat-link.key");
  const guard = linkGuard({ keyPath, remote: deps.remoteAddress ?? defaultRemoteAddress });
  app.use("/members/b3chat/member/:memberId/permissions", guard);
  const svc = createCogsPolicyService({ registryPath: deps.registryPath, db: deps.db, events: deps.events, onRegistryChanged: deps.onRegistryChanged });
  const fail = (c: Context, code: string) => c.json({ ok: false, code }, ERROR_STATUS[code] ?? 400);

  /** 서버가 실어 보낸 사람·방 결합. 형식이 틀리면 null. */
  const binding = (actor: unknown, owner: unknown, room: unknown) => {
    const a = actor == null ? "" : String(actor);
    const o = owner == null ? "" : String(owner);
    const r = room == null ? "" : String(room);
    if (!USER_ID_RE.test(a) || !USER_ID_RE.test(o) || !USER_ID_RE.test(r)) return null;
    return { actor: a, owner: o, room: r };
  };

  app.get("/members/b3chat/member/:memberId/permissions", (c) => {
    const b = binding(c.req.query("actor_user_id"), c.req.query("owner_user_id"), c.req.query("room_id"));
    if (!b) return fail(c, "bad_request");
    const r = svc.read(c.req.param("memberId"));
    if (!r.ok) return fail(c, r.code);
    if (r.member.roomId !== b.room) return fail(c, "forbidden");
    return c.json(view(r.member, r.policy, b.actor === b.owner));
  });

  app.put("/members/b3chat/member/:memberId/permissions", async (c) => {
    let body: Record<string, unknown>;
    try { body = await c.req.json(); } catch { return fail(c, "bad_request"); }
    if (!body || typeof body !== "object") return fail(c, "bad_request");
    const b = binding(body.actor_user_id, body.owner_user_id, body.room_id);
    if (!b || !Number.isSafeInteger(body.expected_revision) || (body.expected_revision as number) < 0) return fail(c, "bad_request");
    const memberId = c.req.param("memberId");
    const cur = svc.read(memberId);
    if (!cur.ok) return fail(c, cur.code);
    if (cur.member.roomId !== b.room || b.actor !== b.owner) return fail(c, "forbidden");
    const r = svc.update(memberId, body.expected_revision as number, body.policy);
    if (!r.ok) return fail(c, r.code);
    return c.json(view(cur.member, { state: "valid", policy: r.policy }, true, { narrowed: r.narrowed, invalidated: r.invalidated }));
  });

  return app;
}
