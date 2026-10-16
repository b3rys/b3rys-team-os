// 동시 독자가 반쪽 룰을 읽지 않도록 새 파일 작성 후 rename으로 교체한다. inode 변경을 검사하며 라이브 정본은 임시 루트의 하위 프로세스로 보호한다.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
const TEMPLATE_TEXT = "# TEAM-OS (fixture)\n\nowner={{OWNER}}\n\n본문 몇 줄.\n";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "b3os-render-"));
  mkdirSync(join(root, "rules"), { recursive: true });
  writeFileSync(join(root, "rules", "TEAM-OS.template.md"), TEMPLATE_TEXT, "utf-8");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** 격리 repo 루트에서 renderTeamOs 를 n회 실행하고, 매회 렌더 전/후 inode 를 돌려준다. */
function renderInIsolation(times: number, seed?: string): Array<{ before: number; after: number; text: string }> {
  const entry = join(import.meta.dir, "teamOsRender.ts");
  const script = `
    const { statSync, writeFileSync, readFileSync } = require("node:fs");
    const LIVE = ${JSON.stringify(join(root, "rules", "TEAM-OS.md"))};
    ${seed === undefined ? "" : `writeFileSync(LIVE, ${JSON.stringify(seed)}, "utf-8");`}
    const { renderTeamOs } = await import(${JSON.stringify(entry)});
    const out = [];
    for (let i = 0; i < ${times}; i++) {
      const before = statSync(LIVE).ino;
      const r = renderTeamOs(null);
      if (!r.ok) throw new Error("render failed: " + r.error);
      out.push({ before, after: statSync(LIVE).ino, text: readFileSync(LIVE, "utf-8") });
    }
    console.log(JSON.stringify(out));
  `;
  const p = Bun.spawnSync(["bun", "-e", script], { env: { ...process.env, TEAM_COLLAB_ROOT: root } });
  const stdout = p.stdout.toString().trim();
  if (p.exitCode !== 0) throw new Error(`subprocess failed: ${p.stderr.toString().slice(-500)}`);
  return JSON.parse(stdout.slice(stdout.lastIndexOf("[")));
}

test("★렌더는 제자리 수정이 아니라 파일 교체다★ (inode 가 바뀐다 = rename 경로)", () => {
  const [r] = renderInIsolation(1, "SENTINEL-BEFORE\n");
  expect(r!.text).not.toBe("SENTINEL-BEFORE\n");        // 실제로 다시 썼는가(헛통과 방지)
  expect(r!.text).toBe(TEMPLATE_TEXT);                  // owner 없음 → 템플릿 그대로
  expect(r!.after).not.toBe(r!.before);                 // 핵심: 갈아끼웠다
});

test("내용이 같으면 아예 쓰지 않는다 (skip-if-unchanged 유지 — 매 부팅 렌더 방지)", () => {
  const [first, second] = renderInIsolation(2, "SENTINEL-BEFORE\n");
  expect(first!.after).not.toBe(first!.before);         // 1회차: 교체
  expect(second!.after).toBe(second!.before);           // 2회차: 같은 결과 → 교체조차 안 함
});

test("임시파일을 남기지 않는다", () => {
  renderInIsolation(2, "SENTINEL-BEFORE\n");
  expect(readdirSync(join(root, "rules")).filter((f) => f.includes("TEAM-OS.md.tmp-"))).toEqual([]);
});
