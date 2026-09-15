import type { Database } from "bun:sqlite";
import { nanoid } from "nanoid";

// busviz-v2 Tasks kanban data layer. Independent of the bus — its own `task`
// table and routes. The DB column is `lane` (plan/doing/done); the API exposes it
// as `column` to match the kanban mental model and the frontend mock shape.
// `description` (free-form, owner-maintained): 목표·범위·계획·완료기준·메모 미니템플릿.

export type TaskLane = "plan" | "doing" | "done";
export const TASK_LANES: TaskLane[] = ["plan", "doing", "done"];
export const DEFAULT_PROJECT_PREFIXES = ["infra", "codex", "scheduler", "pm"] as const;

export interface Task {
  id: string;
  title: string;
  column: TaskLane; // kanban column — stored as `lane` in the DB
  owner: string | null;
  description: string | null;
  held_at: string | null;
  hold_reason: string | null;
  review_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectSummary {
  name: string;
  counts: Record<TaskLane, number>;
  next_action: string | null;
  owner: string | null;
}

function taskPrefix(title: string): string | null {
  const match = title.match(/^\[([^\]]+)\]/);
  return match ? match[1]!.trim().toLowerCase() : null;
}

function nextAction(description: string | null): string | null {
  if (!description) return null;
  const line = description.split(/\r?\n/).find((item) => /^\s*다음 액션\s*:/i.test(item));
  return line?.replace(/^\s*다음 액션\s*:\s*/i, "").trim() || null;
}

/** Read-only projection over task rows. Prefix matching is case-insensitive. */
export function summarizeProjects(tasks: Task[], promotedPrefixes: string[]): ProjectSummary[] {
  const promoted = [...new Set(promotedPrefixes.map((p) => p.trim().toLowerCase()).filter(Boolean))];
  return promoted.map((name) => {
    const matching = tasks.filter((task) => taskPrefix(task.title) === name);
    const doing = matching.filter((task) => task.column === "doing");
    const projectCard = [...doing, ...matching.filter((task) => task.column === "plan"), ...matching.filter((task) => task.column === "done")]
      .find((task) => nextAction(task.description));
    return {
      name,
      counts: {
        done: matching.filter((task) => task.column === "done").length,
        doing: doing.length,
        plan: matching.filter((task) => task.column === "plan").length,
      },
      next_action: projectCard ? nextAction(projectCard.description) : null,
      owner: doing.find((task) => task.owner)?.owner ?? null,
    };
  });
}

interface TaskRow {
  id: string;
  title: string;
  lane: TaskLane;
  owner: string | null;
  description: string | null;
  held_at: string | null;
  hold_reason: string | null;
  review_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    column: row.lane,
    owner: row.owner,
    description: row.description ?? null,
    held_at: row.held_at ?? null,
    hold_reason: row.hold_reason ?? null,
    review_at: row.review_at ?? null,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const LANE_RANK: Record<TaskLane, number> = { plan: 0, doing: 1, done: 2 };

const SELECT_COLS = `id, title, lane, owner, description, held_at, hold_reason, review_at, sort_order, created_at, updated_at`;

/** All tasks, ordered plan→doing→done then by sort_order within each lane. */
export function listTasks(db: Database): Task[] {
  const rows = db.prepare(`SELECT ${SELECT_COLS} FROM task`).all() as TaskRow[];
  return rows
    .map(toTask)
    .sort(
      (a, b) =>
        LANE_RANK[a.column] - LANE_RANK[b.column] ||
        a.sort_order - b.sort_order ||
        a.created_at.localeCompare(b.created_at),
    );
}

export function getTask(db: Database, id: string): Task | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLS} FROM task WHERE id = ?`)
    .get(id) as TaskRow | undefined;
  return row ? toTask(row) : null;
}

export interface CreateTaskInput {
  title: string;
  column?: TaskLane;
  owner?: string | null;
  description?: string | null;
}

export function createTask(db: Database, input: CreateTaskInput): Task {
  const id = nanoid();
  const lane: TaskLane = input.column ?? "plan";
  // append to the end of the target lane
  const next = db
    .prepare(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM task WHERE lane = ?`,
    )
    .get(lane) as { next: number };
  db.prepare(
    `INSERT INTO task (id, title, lane, owner, description, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.title, lane, input.owner ?? null, input.description ?? null, next.next);
  return getTask(db, id)!;
}

export interface UpdateTaskInput {
  title?: string;
  column?: TaskLane;
  owner?: string | null;
  description?: string | null;
  sort_order?: number;
  held?: boolean;
  hold_reason?: string | null;
  review_at?: string | null;
}

/** Partial update. Returns the updated task, or null if the id does not exist. */
export function updateTask(
  db: Database,
  id: string,
  input: UpdateTaskInput,
): Task | null {
  if (!getTask(db, id)) return null;

  const sets: string[] = [];
  const args: Array<string | number | null> = [];
  if (input.title !== undefined) {
    sets.push("title = ?");
    args.push(input.title);
  }
  if (input.column !== undefined) {
    sets.push("lane = ?");
    args.push(input.column);
    // ★lane 이동 시 sort_order를 target lane 끝으로 재계산(명시 sort_order 없을 때) — 안 하면 이전 lane의 sort_order를 유지해 목적 lane서 충돌(하네스 MEDIUM). create의 append 로직과 동일.
    if (input.sort_order === undefined) {
      const next = db
        .prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM task WHERE lane = ?`)
        .get(input.column) as { next: number };
      sets.push("sort_order = ?");
      args.push(next.next);
    }
  }
  if (input.owner !== undefined) {
    sets.push("owner = ?");
    args.push(input.owner);
  }
  if (input.description !== undefined) {
    sets.push("description = ?");
    args.push(input.description);
  }
  if (input.sort_order !== undefined) {
    sets.push("sort_order = ?");
    args.push(input.sort_order);
  }
  if (input.held !== undefined) {
    sets.push(input.held ? "held_at = datetime('now')" : "held_at = NULL");
    if (!input.held) {
      sets.push("hold_reason = NULL", "review_at = NULL");
    }
  }
  if (input.hold_reason !== undefined) {
    sets.push("hold_reason = ?");
    args.push(input.hold_reason);
  }
  if (input.review_at !== undefined) {
    sets.push("review_at = ?");
    args.push(input.review_at);
  }
  sets.push("updated_at = datetime('now')");

  db.prepare(`UPDATE task SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  return getTask(db, id);
}

/** Returns true if a row was deleted. */
export function deleteTask(db: Database, id: string): boolean {
  const result = db.prepare(`DELETE FROM task WHERE id = ?`).run(id);
  return result.changes > 0;
}
