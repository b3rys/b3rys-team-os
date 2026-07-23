import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { initGroupOwnerStore, setGroupOwner, getGroupOwner, getGroupOwners } from "./groupOwner";

describe("groupOwner — DB 영속화 (재시작 유지)", () => {
  test("setGroupOwner → DB 기록 → 재시작(initGroupOwnerStore) 후 복원", () => {
    const db = new Database(":memory:");
    migrate(db); // group_owner 테이블 생성
    initGroupOwnerStore(db);

    // owner 설정 (멀티)
    setGroupOwner(["bill", "codex"]);
    expect(getGroupOwners()).toEqual(["bill", "codex"]);
    expect(getGroupOwner()).toBe("bill");

    // DB에 실제 기록됐나
    const row = db.prepare("SELECT owner_ids_json FROM group_owner WHERE thread_id='group'").get() as { owner_ids_json: string };
    expect(JSON.parse(row.owner_ids_json)).toEqual(["bill", "codex"]);

    // 재시작 시뮬: 같은 db로 다시 init → 복원되는지
    initGroupOwnerStore(db);
    expect(getGroupOwners()).toEqual(["bill", "codex"]);
  });

  test("owner 변경도 DB 반영 (덮어쓰기)", () => {
    const db = new Database(":memory:");
    migrate(db);
    initGroupOwnerStore(db);
    setGroupOwner(["bill"]);
    setGroupOwner(["demis"]);
    initGroupOwnerStore(db); // 재로드
    expect(getGroupOwners()).toEqual(["demis"]);
  });

  test("DB 미주입(init 안 함)이어도 in-memory는 동작 (write 실패 무시)", () => {
    // 새 init 없이 set/get — db가 이전 테스트 것일 수 있으나 in-memory 동작 보장
    setGroupOwner(["steve"]);
    expect(getGroupOwner()).toBe("steve");
  });
});
