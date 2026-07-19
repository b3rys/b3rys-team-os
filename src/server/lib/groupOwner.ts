// 팀방 현재 owner(들) 저장소. (구 groupSticky — 2026-06-05 OWNER 요청으로 이름 명확화: "sticky"가
// 헷갈려서 setGroupOwner 로. 실제 동작은 "이 그룹의 현재 owner 를 기록".)
//
// capture 워커가 매 OWNER 메시지 라우팅 직후 setGroupOwner(결정된 owner) 를 호출하고,
// /api/route(owner-gate 훅) 와 라우터가 getGroupOwner/getGroupOwners 로 읽어 무-@멘션 메시지에
// "직전 owner" 판정을 적용한다.
//
// 영속화(2026-06-05): in-memory 가 1차, DB(group_owner 행)는 재시작 복원용 백업. write-through +
// 시작 시 1회 load. DB 실패는 무시(라이브 동작 안 깨짐). 저장 시점은 그대로(setGroupOwner 한 곳) —
// blast radius = 이 파일 + index.ts init 한 줄.

import type { Database } from "bun:sqlite";

let groupOwners: string[] = [];
let db: Database | null = null;
const KEY = "group"; // 단일 팀 그룹

/** 서버 시작 시 1회: db 핸들 주입 + 저장된 owner 복원. (index.ts 에서 migrate 직후 호출) */
export function initGroupOwnerStore(database: Database): void {
  db = database;
  try {
    const row = db
      .prepare("SELECT owner_ids_json FROM group_owner WHERE thread_id = ?")
      .get(KEY) as { owner_ids_json?: string } | undefined;
    if (row?.owner_ids_json) {
      const ids = JSON.parse(row.owner_ids_json) as unknown;
      if (Array.isArray(ids)) groupOwners = ids.filter((x): x is string => typeof x === "string");
    }
  } catch {
    // best-effort: 행 없거나 파싱 실패 → 빈 owner 로 시작(지금과 동일).
  }
}

/** 그룹 현재 owner(들) 설정 — 매 OWNER 메시지 라우팅 결과로 호출됨. in-memory + DB write-through. */
export function setGroupOwner(ids: string[] | null | undefined): void {
  groupOwners = [...new Set(ids ?? [])].filter(Boolean);
  if (db) {
    try {
      db.prepare(
        `INSERT INTO group_owner(thread_id, owner_ids_json, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(thread_id) DO UPDATE SET owner_ids_json = excluded.owner_ids_json, updated_at = excluded.updated_at`,
      ).run(KEY, JSON.stringify(groupOwners));
    } catch {
      // DB write 실패는 무시 — in-memory 가 1차라 라이브 동작은 유지.
    }
  }
}

/** 대표 owner 1명(첫 번째). 멀티 owner 면 getGroupOwners 사용. */
export function getGroupOwner(): string | null {
  return groupOwners[0] ?? null;
}

/** 현재 owner 전체(멀티멘션 등). */
export function getGroupOwners(): string[] {
  return [...groupOwners];
}
