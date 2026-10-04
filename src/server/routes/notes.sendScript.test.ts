import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../../skills/b3os-team-inbox/scripts/steno-send.sh");
let home: string;
let outbox: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "steno-send-"));
  outbox = join(home, "Library/Application Support/b3os/steno-outbox");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

async function run(args: string[]) {
  const p = Bun.spawn(["bash", SCRIPT, ...args], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "", HOME: home },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out.trim(), err };
}

describe("steno-send.sh", () => {
  test("md 파일을 0700 outbox에 원문 그대로 넣는다", async () => {
    const file = join(home, "보고서.md");
    writeFileSync(file, "# 제목\n`코드` 와 $HOME 은 그대로\n");
    const result = await run([file]);
    expect(result.code).toBe(0);
    expect(result.out).toBe("보고서.md");
    expect(readFileSync(join(outbox, "보고서.md"), "utf8")).toBe("# 제목\n`코드` 와 $HOME 은 그대로\n");
    expect(statSync(outbox).mode & 0o777).toBe(0o700);
  });

  test("기존 파일을 덮지 않고 번호를 붙인다", async () => {
    const first = join(home, "first.md");
    const second = join(home, "second.md");
    writeFileSync(first, "old");
    writeFileSync(second, "new");
    expect((await run([first, "--name", "같은.md"])).code).toBe(0);
    expect((await run([second, "--name", "같은.md"])).out).toBe("같은 2.md");
    expect(readFileSync(join(outbox, "같은.md"), "utf8")).toBe("old");
    expect(readFileSync(join(outbox, "같은 2.md"), "utf8")).toBe("new");
  });

  test("경로 이름, 형식 밖, 빈 파일, 1MB 초과를 거절한다", async () => {
    const md = join(home, "x.md");
    writeFileSync(md, "x");
    expect((await run([md, "--name", "../x.md"])).code).toBe(1);
    const txt = join(home, "x.txt");
    writeFileSync(txt, "x");
    expect((await run([txt])).code).toBe(1);
    const empty = join(home, "empty.md");
    writeFileSync(empty, "");
    expect((await run([empty])).code).toBe(1);
    const big = join(home, "big.md");
    writeFileSync(big, Buffer.alloc(1_048_577));
    expect((await run([big])).code).toBe(1);
  });
});
