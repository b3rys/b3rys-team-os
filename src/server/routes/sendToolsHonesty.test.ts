/** bun test는 .test.sh를 찾지 않으므로 발신 도구의 인자 검증 셸 시험을 여기서 호출해 자동 수트에 포함한다. */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const SCRIPT = join(REPO, "scripts", "send-tools-honesty.test.sh");

describe("send.sh / reply.sh 인자 검증·정직성", () => {
  test("셸 시험을 수트 안에서 돌린다", async () => {
    const p = Bun.spawn(["bash", SCRIPT], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    // 실패하면 어느 항목이 깨졌는지 가 보여야 한다 — 종료코드만 보면 원인을 다시 찾아야 한다.
    expect(code, `셸 시험 실패:\n${out}\n${err}`).toBe(0);
    expect(out, "항목이 실제로 돌았는지(빈 통과 방지)").toContain("✓");
    // A4 블록이 실제로 실행됐는지 — 파일이 잘려도 종료코드 0 이면 위 단정은 통과한다.
    expect(out, "A4(인자 검증) 블록이 안 돌았다").toContain("A4-1");
  }, 60_000);
});
