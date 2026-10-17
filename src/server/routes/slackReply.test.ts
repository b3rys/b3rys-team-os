import { expect, test } from "bun:test";
import { join } from "node:path";

// 다른 테스트의 Slack·감사로그 모듈 대체가 실제 라우트 검증을 바꾸지 않도록 별도 프로세스에서 실행한다.
test("Slack reply route and send.sh integration", async () => {
  const p = Bun.spawn([process.execPath, "test", "./src/server/routes/slackReply.fixture.ts"], {
    cwd: join(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  expect(code, `${out}\n${err}`).toBe(0);
  expect(err).toContain("16 pass");
  expect(err).toContain("0 fail");
});
