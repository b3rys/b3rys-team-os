/**
 * `scripts/send-tools-honesty.test.sh` 를 ★우리가 실제로 돌리는 수트에 묶는다.★
 *
 * 왜 이 파일이 있나 — 검증은 셸 시험에 있는데 ★`.test.sh` 는 아무것도 자동으로 돌리지 않는다★
 * (CI 는 타입체크만 · `bun test` 는 `.test.sh` 를 안 잡는다). 그대로 두면 인자 검증 회귀 시험이
 * 누가 손으로 부를 때만 도는 장식이 된다 — 회귀를 막는다는 목적이 성립하지 않는다.
 * `inboxDeliveryTime.test.ts` 가 같은 이유로 먼저 만들어졌고, 그 형태를 그대로 쓴다.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const SCRIPT = join(REPO, "scripts", "send-tools-honesty.test.sh");

describe("send.sh / reply.sh 인자 검증·정직성", () => {
  test("셸 시험을 수트 안에서 돌린다", async () => {
    const p = Bun.spawn(["bash", SCRIPT], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    // 실패하면 ★어느 항목이 깨졌는지★ 가 보여야 한다 — 종료코드만 보면 원인을 다시 찾아야 한다.
    expect(code, `셸 시험 실패:\n${out}\n${err}`).toBe(0);
    expect(out, "항목이 실제로 돌았는지(빈 통과 방지)").toContain("✓");
    // A4 블록이 실제로 실행됐는지 — 파일이 잘려도 종료코드 0 이면 위 단정은 통과한다.
    expect(out, "A4(인자 검증) 블록이 안 돌았다").toContain("A4-1");
  }, 60_000);
});
