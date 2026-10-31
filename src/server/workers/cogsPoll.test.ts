import { expect, test } from "bun:test";
import { join } from "node:path";

test("cogs relay with a fake API server and isolated registry/DB/token", async () => {
  const p = Bun.spawn([process.execPath, "test", "./src/server/workers/cogsPoll.fixture.ts"], {
    cwd: join(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(code, `${out}\n${err}`).toBe(0);
  expect(err).toContain("76 pass"); expect(err).toContain("0 fail");
});
