import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../db/migrate";
import { decidePermissionRequest, evaluatePermission, requestPermission } from "../../lib/permissionGate";
import { buildOperationFromApproval } from "./appServerPopup";
import type { ApprovalRequest } from "./appServerClient";

/**
 * ★S5 회귀시험 — 열쇠 비교가 아니라 '실제로 팝업이 다시 뜨는가' 를 잰다.★
 *
 * 왜 열쇠 비교로 부족한가: 열쇠가 갈려도 저장·조회 경로에서 다시 묶이면 소용이 없다.
 * 그래서 ★인메모리 DB 에 실제로 '항상 허용' 을 저장하고, 두 번째 요청의 판정을 본다.★
 * (아메스가 이 경로로 실측해서 초안의 구멍 두 개를 잡았다 — 둘 다 두 번째가 'allow' 로 통과했다.)
 *
 * 통과 기준은 하나다: ★다른 작업이면 두 번째가 'approval_required'(다시 묻기)★,
 * ★같은 작업이면 두 번째가 'allow'(항상 허용이 계속 유효)★.
 */

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

const oldGen = (command: string[]): ApprovalRequest => ({
  method: "execCommandApproval",
  params: { command, cwd: "/tmp" },
});
const newGen = (command: string): ApprovalRequest => ({
  method: "item/commandExecution/requestApproval",
  params: { command, cwd: "/tmp" },
});

/** 첫 요청을 '항상 허용' 으로 승인한 뒤, 두 번째 요청의 판정을 돌려준다. */
function decisionAfterAllowAlways(first: ApprovalRequest, second: ApprovalRequest): string {
  const db = freshDb();
  const a = requestPermission(db, buildOperationFromApproval(first, "dex"));
  expect(a.decision).toBe("approval_required");
  expect(decidePermissionRequest(db, a.request!.id, "allow_always", { approver: "GD" }).ok).toBe(true);
  return evaluatePermission(db, buildOperationFromApproval(second, "dex")).decision;
}

describe("S5 — '항상 허용' 이 다른 명령으로 새지 않는다 (실제 DB 경로)", () => {
  test("★240자 경계★: 앞 240자가 같아도 뒤가 다르면 다시 묻는다", () => {
    // 이것이 S5 가 닫으러 온 원래 구멍이다. target 은 앞 240자만 보므로 뒤가 잘려 나갔다.
    const prefix = "y".repeat(240);
    expect(decisionAfterAllowAlways(newGen(prefix + "SAFE"), newGen(prefix + "EVIL"))).toBe("approval_required");
  });

  test("★2000자 경계★: 표시용으로 자른 뒤가 달라도 다시 묻는다", () => {
    // 초안이 여기서 뚫렸다 — 지문을 '잘린 본문' 으로 만들어서 2000자 뒤 차이가 지문에 안 들어갔다.
    // ★지문은 자르기 전 원본(material)으로 만든다★ 는 규칙이 살아 있는지 잰다.
    const prefix = "z".repeat(2000);
    expect(decisionAfterAllowAlways(newGen(prefix + "SAFE"), newGen(prefix + "EVIL"))).toBe("approval_required");
  });

  test("★구세대 argv 경계★: ['a b','c'] 를 허용해도 ['a','b c'] 는 다시 묻는다", () => {
    // 인자 하나짜리 실행과 실행 파일이 'a' 인 실행은 ★다른 일★ 인데 이어붙이면 둘 다 "a b c" 다.
    expect(decisionAfterAllowAlways(oldGen(["a b", "c"]), oldGen(["a", "b c"]))).toBe("approval_required");
  });

  test("★세대가 다르면 다시 묻는다★ — 문자열에서 argv 경계를 복원할 수 없기 때문", () => {
    // (여기서 rm -rf 를 쓰면 Tier-D 위험 스캔이 먼저 'deny' 로 끊어 ★이 시험이 재려는 것을 못 잰다.★
    //  다른 조건이 먼저 갈라주면 시험은 초록인데 메커니즘은 안 재진다 — 무해한 명령으로 잰다.)
    expect(decisionAfterAllowAlways(oldGen(["git", "status"]), newGen("git status"))).toBe("approval_required");
  });

  test("★같은 명령은 계속 허용된다★ — '항상 허용' 을 망가뜨리지 않았다", () => {
    // ★이 시험이 없으면 위 네 개는 '전부 다시 묻기' 로도 통과한다.★ 즉 기능을 죽여도 초록이 된다.
    expect(decisionAfterAllowAlways(newGen("npm test"), newGen("npm test"))).toBe("allow");
    expect(decisionAfterAllowAlways(oldGen(["npm", "test"]), oldGen(["npm", "test"]))).toBe("allow");
  });
});
