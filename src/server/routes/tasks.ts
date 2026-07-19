import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  getTask,
  TASK_LANES,
  type TaskLane,
} from "../db/taskQueries";
import { appendAudit } from "../db/queries";
import { appendAuditFile } from "../lib/auditFile";
import { emitLoopEventSafe, EVENT, makeEpisodeId } from "../metrics/loopEvent";
import { ensureThread, insertMessage } from "../db/inbox/messages";

interface TaskRouteDeps {
  db: Database;
}

function isLane(v: unknown): v is TaskLane {
  return typeof v === "string" && (TASK_LANES as string[]).includes(v);
}

// Dashboard ✕/edit carries no auth, so actor is often unknown — label it so the owner can
// still infer "someone (likely OWNER) did this from the dashboard" and confirm.
function actorLabel(actor: string): string {
  return actor === "unknown" ? "대시보드(작성자 미상 — 팀장일 가능성)" : actor;
}

// Card-change notification (2026-06-14, OWNER): on delete or owner-reassign, wake the affected
// card owner over the bus so they learn immediately ("your card was deleted by X") and can
// confirm with OWNER — instead of silently discovering it gone (the dbak incident). Scope per
// OWNER = delete + reassign only (not general edits). Self-actions (actor === owner) skipped.
// Uses the same insertMessage path as POST /inbox, so the wake dispatcher delivers it.
function notifyCardOwner(
  db: Database,
  opts: { to: string | null | undefined; actor: string; body: string },
): void {
  const to = opts.to;
  if (!to || to === opts.actor) return; // no owner, or owner acted on their own card
  const RESERVED = new Set(["user", "system", "moderator", "broadcast"]);
  if (RESERVED.has(to)) return;
  const exists = db.prepare(`SELECT id FROM agent WHERE id = ?`).get(to);
  if (!exists) return; // unknown/free-text owner — nothing to wake
  try {
    const { thread_id } = ensureThread(db, {
      thread_id: `card-notify-${to}`,
      from_agent_id: "system",
      to_agent_id: to,
      type: "dm",
      body: opts.body,
    });
    const stored = insertMessage(db, {
      from_agent_id: "system",
      to_agent_id: to,
      type: "dm",
      body: opts.body,
      source: "system",
      // ★알림이 "누구 일인지" 를 실어 보낸다★ — 담당자의 답/완료보고는 ★배정한 사람★ 에게 간다.
      //   예전엔 이게 없어서 디스패처가 "보낸 사람(system)에게 답해라" 라고 했고 → ★--to system = 블랙홀★.
      //   실측(30일) 40건이 그렇게 사라졌다: "처리 완료: 카드 2건 갱신했습니다" …
      //   ★본인은 보고했다, 아무도 못 받았다.★ (하네스 D1)
      meta: { reply_to: opts.actor },
      hop_count: 0,
      priority: "normal",
      thread_id,
    });
    appendAudit(db, "system", "card_change_notified", stored.id, { to, actor: opts.actor });
  } catch (e) {
    console.error("[tasks] card owner notify failed:", e);
  }
}

/**
 * Tasks kanban routes (busviz-v2). Independent of the bus — own table/routes,
 * no dispatcher hot-path interaction. Task JSON shape matches the frontend mock:
 *   { id, title, column: 'plan'|'doing'|'done', owner, description, sort_order, created_at, updated_at }
 */
export function createTaskRoutes(deps: TaskRouteDeps): Hono {
  const r = new Hono();

  // GET /api/tasks — all tasks, ordered plan→doing→done then sort_order.
  r.get("/tasks", (c) => {
    return c.json({ tasks: listTasks(deps.db) });
  });

  // POST /api/tasks — { title, column?, owner? }. column defaults to 'plan'.
  r.post("/tasks", async (c) => {
    let body: { title?: unknown; column?: unknown; owner?: unknown; description?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid json body" }, 400);
    }
    if (typeof body.title !== "string" || body.title.trim() === "") {
      return c.json({ ok: false, error: "title required" }, 400);
    }
    if (body.column !== undefined && !isLane(body.column)) {
      return c.json({ ok: false, error: "invalid column" }, 400);
    }
    const owner =
      typeof body.owner === "string" ? body.owner : body.owner == null ? null : null;
    const task = createTask(deps.db, {
      title: body.title.trim(),
      column: body.column as TaskLane | undefined,
      owner,
      description: typeof body.description === "string" ? body.description : undefined,
    });
    return c.json({ ok: true, task }, 201);
  });

  // PATCH /api/tasks/:id — partial update { title?, column?, owner?, sort_order? }.
  r.patch("/tasks/:id", async (c) => {
    const id = c.req.param("id");
    let body: {
      title?: unknown;
      column?: unknown;
      owner?: unknown;
      description?: unknown;
      sort_order?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid json body" }, 400);
    }
    if (body.title !== undefined && (typeof body.title !== "string" || body.title.trim() === "")) {
      return c.json({ ok: false, error: "invalid title" }, 400);
    }
    if (body.column !== undefined && !isLane(body.column)) {
      return c.json({ ok: false, error: "invalid column" }, 400);
    }
    if (body.sort_order !== undefined && typeof body.sort_order !== "number") {
      return c.json({ ok: false, error: "invalid sort_order" }, 400);
    }
    const before = getTask(deps.db, id); // capture owner BEFORE update to detect reassignment
    const task = updateTask(deps.db, id, {
      title: typeof body.title === "string" ? body.title.trim() : undefined,
      column: body.column as TaskLane | undefined,
      owner:
        body.owner === undefined
          ? undefined
          : typeof body.owner === "string"
            ? body.owner
            : null,
      description:
        body.description === undefined
          ? undefined
          : typeof body.description === "string"
            ? body.description
            : null,
      sort_order: typeof body.sort_order === "number" ? body.sort_order : undefined,
    });
    if (!task) return c.json({ ok: false, error: "not found" }, 404);

    // Reassignment notify (scope per OWNER = delete + reassign only): when owner changes, audit
    // it and wake BOTH the previous owner ("removed from you") and the new owner ("assigned").
    if (before && before.owner !== task.owner) {
      const actor = c.req.query("actor") || c.req.header("x-actor") || "unknown";
      const detail = {
        from: before.owner,
        to: task.owner,
        title: task.title,
        user_agent: c.req.header("user-agent") ?? null,
        referer: c.req.header("referer") ?? null,
      };
      try {
        appendAudit(deps.db, actor, "task_reassigned", id, detail);
        appendAuditFile(actor, "task_reassigned", id, detail);
      } catch (e) {
        console.error("[tasks] reassign audit failed:", e);
      }
      notifyCardOwner(deps.db, {
        to: before.owner,
        actor,
        body: `[카드 담당자 변경] 담당이던 카드 '${task.title}'이(가) ${actorLabel(actor)}에 의해 ${task.owner ?? "미지정"}에게 재배정됐습니다.`,
      });
      notifyCardOwner(deps.db, {
        to: task.owner,
        actor,
        body: `[카드 배정] 카드 '${task.title}'이(가) ${actorLabel(actor)}에 의해 당신에게 배정됐습니다. 상태: ${task.column}.`,
      });
    }

    // ④ [측정 W1] lane 전이 loop_event emit — ★best-effort(측정 실패가 카드 업데이트 절대 안 깸)★.
    //   →done = task.closed · done→(plan/doing) = closure.corrected(사후 재오픈) · plan↔doing 이동은 이 슬라이스 미발행(최소).
    if (before && before.column !== task.column) {
      const emitActor = c.req.query("actor") || c.req.header("x-actor") || "system";
      const evName =
        task.column === "done"
          ? EVENT.task_closed
          : before.column === "done"
            ? EVENT.closure_corrected
            : null;
      if (evName) {
        emitLoopEventSafe(deps.db, {
          event_id: `evt:task:${id}:${evName}:${task.updated_at}`,
          event_name: evName,
          schema_version: "0.2",
          occurred_at: new Date().toISOString(),
          episode_id: makeEpisodeId("task", { taskId: id }),
          thread_id: "",
          task_id: id,
          actor: emitActor,
          owner: task.owner ?? undefined,
          reason: `lane ${before.column}→${task.column}`,
          metric_scope: "both",
        });
      }
    }

    return c.json({ ok: true, task });
  });

  // DELETE /api/tasks/:id
  // Audited (2026-06-14): card deletions previously left no trace, so a recurring
  // disappearance of non-done cards (dbak plan cards) could not be attributed. We now
  // snapshot the full card before deleting and record actor + request fingerprint
  // (user-agent/referer) so the next deletion is caught red-handed and recoverable.
  r.delete("/tasks/:id", (c) => {
    const id = c.req.param("id");
    const snapshot = getTask(deps.db, id); // capture BEFORE delete for attribution + recovery
    const deleted = deleteTask(deps.db, id);
    if (!deleted) return c.json({ ok: false, error: "not found" }, 404);

    const actor =
      c.req.query("actor") || c.req.header("x-actor") || "unknown";
    const detail = {
      snapshot,
      lane: snapshot?.column ?? null,
      owner: snapshot?.owner ?? null,
      user_agent: c.req.header("user-agent") ?? null,
      referer: c.req.header("referer") ?? null,
    };
    try {
      appendAudit(deps.db, actor, "task_deleted", id, detail);
      appendAuditFile(actor, "task_deleted", id, detail);
    } catch (e) {
      console.error("[tasks] delete audit failed:", e);
    }
    // Notify the card owner their card was deleted (skip if they deleted it themselves).
    notifyCardOwner(deps.db, {
      to: snapshot?.owner,
      actor,
      body:
        `[카드 삭제 알림] 담당 카드 '${snapshot?.title ?? id}'이(가) ${actorLabel(actor)}에 의해 삭제됐습니다. ` +
        `내용: ${snapshot?.description || "(없음)"}. 의도와 다르면 팀장께 확인하세요.`,
    });
    return c.json({ ok: true, deleted: id });
  });

  return r;
}
