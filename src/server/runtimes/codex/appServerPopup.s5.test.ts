import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../db/migrate";
import { decidePermissionRequest, evaluatePermission, requestPermission, scopeKeyForOperation, targetForOperation, tierDReasons } from "../../lib/permissionGate";
import { buildOperationFromApproval, oversizedForReview, requestApprovalPopup } from "./appServerPopup";
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

  test("★모양이 같아도 method 가 다르면 다시 묻는다★ — 세대 표식이 하는 일", () => {
    // 위 '세대가 다르면' 시험은 배열 vs 문자열이라 ★모양 차이만으로도 통과한다★ — 세대 표식의 역할을 못 잰다.
    // (뮤턴트로 확인: 표식을 지워도 그 시험은 초록이었다.)
    // 실제로 파싱은 method 가 아니라 ★payload 모양으로 분기★ 하므로, 구세대 method 가 문자열을 실어 오는
    // 입력이 도달 가능하다. 그때 표식이 없으면 두 세대가 ★완전히 같은 재료★ 가 되어 열쇠가 합쳐진다.
    const oldGenString: ApprovalRequest = { method: "execCommandApproval", params: { command: "git status", cwd: "/tmp" } };
    expect(decisionAfterAllowAlways(oldGenString, newGen("git status"))).toBe("approval_required");
  });

  test("★같은 명령은 계속 허용된다★ — '항상 허용' 을 망가뜨리지 않았다", () => {
    // ★이 시험이 없으면 위 네 개는 '전부 다시 묻기' 로도 통과한다.★ 즉 기능을 죽여도 초록이 된다.
    expect(decisionAfterAllowAlways(newGen("npm test"), newGen("npm test"))).toBe("allow");
    expect(decisionAfterAllowAlways(oldGen(["npm", "test"]), oldGen(["npm", "test"]))).toBe("allow");
  });
});

describe("S5 — 규격 밖 payload 를 해석 성공으로 받지 않는다", () => {
  // 아메스가 DB 경로에서 재현: String(x) 강제변환이 ★서로 다른 payload 를 한 열쇠로★ 묶었다.
  // 규격에 없는 값이 오면 ★넓게 통과가 아니라 좁게 묻는다★ — 해석 실패 경로로 보낸다.
  const pairs: Array<[unknown[], unknown[], string]> = [
    [[1], ["1"], "숫자 1 과 문자열 '1'"],
    [[null], ["null"], "null 과 문자열 'null'"],
    [[{}], ["[object Object]"], "객체와 그 toString 결과"],
  ];
  for (const [first, second, label] of pairs) {
    test(`★${label} 은 같은 승인으로 묶이지 않는다★`, () => {
      expect(decisionAfterAllowAlways(oldGen(first as string[]), oldGen(second as string[]))).toBe("approval_required");
    });
  }
});

describe("S5 — 사람이 보는 한 줄", () => {
  const target = (c: string) => targetForOperation(buildOperationFromApproval(newGen(c), "dex"));

  test("★잘렸으면 잘렸다고 말한다★ — 이게 명령 전부인 줄 알게 두지 않는다", () => {
    // 표시가 없으면 "kubectl delete ns prod" 뒤에 500자가 더 있어도 화면은 그냥 끊긴다(루이 실측).
    // 전문이 op.text 로 빠진 지금은 ★사람 눈에 닿는 경로가 이 한 줄뿐★ 이다.
    const t = target("kubectl delete ns prod " + "z".repeat(500));
    expect(t).toContain("…");
    expect(t).toMatch(/…\s#[0-9a-f]{64}$/);
  });

  test("안 잘렸으면 잘림 표시를 붙이지 않는다", () => {
    expect(target("git status")).toMatch(/^git status #[0-9a-f]{64}$/);
  });

  test("★어떤 입력이든 지문이 240자 안에 온전히 남는다★", () => {
    // 지문이 잘려 나가면 열쇠가 다시 합쳐진다 — 경계마다 확인한다(루이 제안).
    const cases: Array<[string, string]> = [
      ["평범한 장문", "echo " + "a".repeat(1000)],
      ["공백 다발", "echo" + " ".repeat(300) + "x"],
      ["개행", "echo a\n".repeat(200)],
      ["한글 400자", "echo " + "가".repeat(400)],
      ["이모지 40개", "echo " + "🙂".repeat(40)],
      ["탭·CR", "echo\t" + "b\r".repeat(200)],
      ["전각 공백", "echo " + "　".repeat(300)],
      ["장문 7천자(상한 안)", "echo " + "c".repeat(7_000)],
    ];
    for (const [label, cmd] of cases) {
      const t = target(cmd);
      expect(t.length, label).toBeLessThanOrEqual(240);
      expect(t, label).toMatch(/#[0-9a-f]{64}$/);
      // ★고아 서로게이트가 없어야 한다★ — UTF-16 으로 자르면 이모지·한글이 반토막 난다.
      expect([...t].every((ch) => { const c = ch.codePointAt(0)!; return c < 0xd800 || c > 0xdfff; }), label).toBe(true);
    }
  });
});

describe("S5 — 너무 긴 요청은 승인 흐름에 태우지 않는다", () => {
  //
  // 스캔 상한(자르기)은 없앴다 — 자르면 잘린 뒤가 검사에서 빠져서 "얼마면 안전한가" 를 영원히 못 정한다.
  // 대신 ★사람이 읽고 판단할 수 없는 길이는 팝업을 만들지 않는다.★

  test("★2,000자를 넘으면 팝업 없이 거절되고 기록이 남는다★", async () => {
    const db = freshDb();
    const long = "echo " + "a".repeat(2_500);
    expect(oversizedForReview(newGen(long))).toBeGreaterThan(2_000);

    expect(await requestApprovalPopup(db, newGen(long), "dex")).toBe("denied");
    // ★팝업 자체가 안 만들어져야 한다★ — 사람에게 못 읽을 것을 들이밀지 않는다.
    expect((db.query("SELECT COUNT(*) c FROM permission_request").get() as any).c).toBe(0);
    // ★조용히 사라지지도 않아야 한다★ — 따로 검토할 수 있게 기록이 남는다.
    const row = db.query("SELECT action, detail_json FROM audit_event ORDER BY id DESC LIMIT 1").get() as any;
    expect(row.action).toBe("codex_approval_oversized");
    expect(JSON.parse(row.detail_json).length).toBe(long.length);
  });

  test("현실 길이 명령은 그대로 팝업으로 간다", () => {
    // 실측 45자. 이 규칙이 평소 동작을 건드리면 안 된다.
    expect(oversizedForReview(newGen("bun test src/server/runtimes/codex/adapter.ts"))).toBeNull();
    expect(oversizedForReview(oldGen(["npm", "run", "build"]))).toBeNull();
    // ★현실 최대 모양★ — 설정 파일을 heredoc 으로 명령 안에 통째로 써 넣는 경우(루이 실측 724자).
    // 한도를 1,000 에서 2,000 으로 올린 이유가 이것이다. 이 줄이 그 여유를 지킨다.
    expect(oversizedForReview(newGen("bash -c 'cat <<EOF > /tmp/x.yml\n" + "b".repeat(900) + "\nEOF'"))).toBeNull();
  });

  test("★자르지 않으므로 아무리 뒤에 있어도 위험어는 스캔된다★", () => {
    // 예전엔 상한에서 잘라 그 뒤가 검사 밖이었다. 이제 자르지 않는다(길면 위에서 거절된다).
    const op = buildOperationFromApproval(newGen("echo " + "w".repeat(900) + " ; sudo id"), "dex");
    expect(tierDReasons(op)).toContain("sudo");
    expect(op.text!.length).toBeGreaterThan(900);
  });
});

describe("S5 — 해석 실패로 보내도 위험 검사는 면제되지 않는다", () => {
  // ★내가 만든 회귀였다★ (루이가 잡음): 상한 초과·규격 밖 argv 를 해석 실패로 보내면서
  // 그 payload 의 Tier-D 스캔 입력이 0 이 됐다. 열쇠는 좁혔는데 ★검사 범위를 없앴다.★
  // Tier-D 는 사람도 승인 못 하는 등급이라, 스캔이 비면 위험 명령이 '누를 수 있는 팝업' 으로 내려온다.
  const danger = "sudo rm -rf /tmp/x ; ";

  test("★규격 밖 argv 로 해석 실패로 간 payload 도 스캔된다★", () => {
    const op = buildOperationFromApproval(oldGen([1 as unknown as string, "; " + danger]), "dex");
    expect(op.action).toBe("approval_unparsed");
    expect(tierDReasons(op)).toContain("sudo");
  });

  test("팝업 첫 줄은 여전히 사람 말로 시작한다 — payload 는 맨 뒤에만 붙인다", () => {
    const op = buildOperationFromApproval(oldGen([1 as unknown as string, "ls"]), "dex");
    expect(op.text!.startsWith("내용 해석 실패")).toBe(true);
    expect(targetForOperation(op).startsWith("내용 해석 실패")).toBe(true);
  });

  test("해석 실패끼리도 payload 가 다르면 열쇠가 갈린다", () => {
    const a = buildOperationFromApproval(oldGen([1 as unknown as string, "ls"]), "dex");
    const b = buildOperationFromApproval(oldGen([1 as unknown as string, "pwd"]), "dex");
    expect(scopeKeyForOperation(a)).not.toBe(scopeKeyForOperation(b));
  });
});

describe("S5 — 1,000자 규칙은 ★명령에만★ 적용된다", () => {
  // ★내가 잘 되던 기능을 죽였던 자리다★ (아메스 실측): 모든 승인에 길이 규칙을 걸어서
  // 1,200자짜리 파일을 만드는 ★평범한 파일 변경 승인이 거절★ 됐고, 기록까지 '명령이 너무 길다' 로 남았다.
  // 팀 리드가 말한 것은 "1000자를 넘는 ★명령★ 은 이상한거야" 다 — 파일 내용은 길어도 이상하지 않다.
  const patch = (content: string): ApprovalRequest => ({
    method: "applyPatchApproval",
    params: { fileChanges: { "src/x.ts": { type: "add", content } }, cwd: "/tmp" },
  });

  test("★긴 파일을 만드는 변경은 그대로 승인 흐름으로 간다★", async () => {
    const db = freshDb();
    const req = patch("// " + "a".repeat(1_200));
    expect(oversizedForReview(req)).toBeNull();

    // 실제 흐름까지 확인한다 — 판정 함수만 보면 호출부가 딴 짓 해도 초록이다.
    const done = requestApprovalPopup(db, req, "dex", "/tmp", 50);
    expect((db.query("SELECT COUNT(*) c FROM permission_request").get() as any).c).toBe(1);
    await done;  // TTL 로 끝나게 두고 정리(결정은 이 시험의 관심사가 아니다)
  });

  test("명령은 여전히 길이 규칙을 받는다", () => {
    expect(oversizedForReview(newGen("echo " + "a".repeat(2_500)))).toBeGreaterThan(2_000);
  });
});
