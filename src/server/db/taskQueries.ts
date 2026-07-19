import type { Database } from "bun:sqlite";
import { nanoid } from "nanoid";

// busviz-v2 Tasks kanban data layer. Independent of the bus — its own `task`
// table and routes. The DB column is `lane` (plan/doing/done); the API exposes it
// as `column` to match the kanban mental model and the frontend mock shape.
// `description` (free-form, owner-maintained): 목표·범위·계획·완료기준·메모 미니템플릿.

export type TaskLane = "plan" | "doing" | "done";
export const TASK_LANES: TaskLane[] = ["plan", "doing", "done"];

export interface Task {
  id: string;
  title: string;
  column: TaskLane; // kanban column — stored as `lane` in the DB
  owner: string | null;
  description: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: string;
  title: string;
  lane: TaskLane;
  owner: string | null;
  description: string | null;
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
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const LANE_RANK: Record<TaskLane, number> = { plan: 0, doing: 1, done: 2 };

const SELECT_COLS = `id, title, lane, owner, description, sort_order, created_at, updated_at`;

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
  sets.push("updated_at = datetime('now')");

  db.prepare(`UPDATE task SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  return getTask(db, id);
}

/** Returns true if a row was deleted. */
export function deleteTask(db: Database, id: string): boolean {
  const result = db.prepare(`DELETE FROM task WHERE id = ?`).run(id);
  return result.changes > 0;
}
