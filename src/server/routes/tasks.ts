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

/** PATCH /tasks/:id 가 받는 키 — 이 밖의 키는 요청 전체를 400 으로 거절한다. */
export const TASK_PATCH_FIELDS = ["title", "column", "owner", "description", "sort_order", "held", "hold_reason", "review_at"];

interface TaskRouteDeps {
  db: Database;
}

function isLane(v: unknown): v is TaskLane {
  return typeof v === "string" && (TASK_LANES as string[]).includes(v);
}

// Dashboard ✕/edit carries no auth, so actor is often unknown — label it so the owner can
// still infer "someone (likely GD) did this from the dashboard" and confirm.
function actorLabel(actor: string): string {
  return actor === "unknown" ? "대시보드(작성자 미상 — 팀장일 가능성)" : actor;
}

// 삭제·재배정은 영향받는 기존 담당자에게 버스 알림을 보낸다. 일반 편집과 본인 작업은 제외한다.
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
      // system은 답장을 받을 수 없으므로 카드 알림의 reply_to에 배정자를 기록한다.
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

/** 칸반은 독립 task 테이블과 라우트를 사용하며 JSON에는 lane·담당자·설명·정렬·시각을 포함한다. */
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

  // PATCH /api/tasks/:id — partial update. 허용 키 밖의 키가 있으면 400(unsupported_fields).
  r.patch("/tasks/:id", async (c) => {
    const id = c.req.param("id");
    let body: {
      title?: unknown;
      column?: unknown;
      owner?: unknown;
      description?: unknown;
      sort_order?: unknown;
      held?: unknown;
      hold_reason?: unknown;
      review_at?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid json body" }, 400);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ ok: false, error: "body must be a JSON object" }, 400);
    }
    // 모르는 키는 버리지 않고 요청 전체를 거절한다 — 버리고 ok 를 주면 이름을 틀린 쪽이
    // 아무것도 안 바뀐 카드를 바뀐 것으로 믿는다. 거절은 어떤 변경·알림·audit 보다 먼저다.
    const unknownFields = Object.keys(body).filter((k) => !TASK_PATCH_FIELDS.includes(k));
    if (unknownFields.length) {
      return c.json(
        {
          ok: false,
          error: `unsupported_fields: ${unknownFields.join(",")}`,
          unknown_fields: unknownFields,
          allowed_fields: TASK_PATCH_FIELDS,
          hint: "레인은 column, 본문은 description 으로 보낸다 (DB 칸 이름 lane 이 아니다).",
        },
        400,
      );
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
    if (body.held !== undefined && typeof body.held !== "boolean") {
      return c.json({ ok: false, error: "invalid held" }, 400);
    }
    if (body.hold_reason !== undefined && body.hold_reason !== null && typeof body.hold_reason !== "string") {
      return c.json({ ok: false, error: "invalid hold_reason" }, 400);
    }
    if (body.review_at !== undefined && body.review_at !== null && typeof body.review_at !== "string") {
      return c.json({ ok: false, error: "invalid review_at" }, 400);
    }
    if (body.held === true) {
      if (typeof body.hold_reason !== "string" || body.hold_reason.trim() === "") {
        return c.json({ ok: false, error: "hold_reason required" }, 400);
      }
      if (typeof body.review_at !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.review_at)) {
        return c.json({ ok: false, error: "review_at required (YYYY-MM-DD)" }, 400);
      }
    }
    if (body.held === false && (body.hold_reason !== undefined || body.review_at !== undefined)) {
      return c.json({ ok: false, error: "hold metadata not allowed when resuming" }, 400);
    }
    if (body.held === undefined && (body.hold_reason !== undefined || body.review_at !== undefined)) {
      return c.json({ ok: false, error: "held required with hold metadata" }, 400);
    }
    const before = getTask(deps.db, id); // capture owner/state BEFORE update
    if (!before) return c.json({ ok: false, error: "not found" }, 404);
    // Repeating hold on an already-held task updates its metadata/other requested fields,
    // but must not reset held_at or emit a second hold audit event.
    const held = body.held === true && before.held_at
      ? undefined
      : typeof body.held === "boolean" ? body.held : undefined;
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
      held,
      hold_reason:
        body.hold_reason === undefined ? undefined : typeof body.hold_reason === "string" ? body.hold_reason.trim() || null : null,
      review_at:
        body.review_at === undefined ? undefined : typeof body.review_at === "string" ? body.review_at.trim() || null : null,
    });
    if (!task) return c.json({ ok: false, error: "not found" }, 404);

    if (before && before.held_at !== task.held_at) {
      const actor = c.req.query("actor") || c.req.header("x-actor") || "unknown";
      const action = task.held_at ? "task_held" : "task_resumed";
      const detail = {
        title: task.title,
        lane: task.column,
        hold_reason: task.hold_reason,
        review_at: task.review_at,
      };
      try {
        appendAudit(deps.db, actor, action, id, detail);
        appendAuditFile(actor, action, id, detail);
      } catch (e) {
        console.error("[tasks] hold audit failed:", e);
      }
    }

    // Reassignment notify (scope per GD = delete + reassign only): when owner changes, audit
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

    // ④ [측정 W1] lane 전이 loop_event emit — best-effort(측정 실패가 카드 업데이트 절대 안 깸).
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

  // 삭제 전 카드 전체 스냅샷과 작성자·요청 경로를 감사 기록에 남겨 원인 확인과 복구가 가능하게 한다.
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
