// rules/TEAM-OS.md 렌더는 ★제자리 수정이 아니라 통째 교체★ 여야 한다.
//
// 왜: 이 파일은 ★전 런타임이 읽는 정본★ 이다(claude 는 워크스페이스 심링크로, openclaw/hermes 는
// AGENTS.md 의 절대경로로 같은 파일을 읽는다). writeFileSync 는 truncate 후 기록이라 원자적이지
// 않아서, 쓰는 도중에 읽는 프로세스는 ★반쪽짜리 룰★ 을 볼 수 있다. 서버 부팅·설정 저장·테스트가
// 동시에 렌더를 부를 수 있으므로 tmp 에 쓰고 rename 으로 갈아끼운다(infra-safety ② 와 같은 규칙).
//
// ★이 테스트가 무엇을 세우고, 무엇은 못 세우나★
//   세우는 것: 렌더가 ★같은 파일을 고쳐 쓰지 않고 새 파일로 교체★ 한다는 것(inode 가 바뀐다).
//     rename 은 같은 파일시스템에서 원자적이므로, 이게 성립하면 읽는 쪽은 옛 내용 아니면 새 내용만
//     본다 — 중간 상태가 존재할 수 없다. 비원자적 writeFileSync 로 되돌리면 inode 가 유지되어
//     ★이 단언이 즉시 깨진다★(= 뮤턴트가 잡힌다).
//   ★못 세우는 것★: "동시 접근에서 찢어진 읽기가 실제로 관측된다" 는 실측으로 보이지 못했다.
//     실제 파일 크기(약 9KB)에서는 창이 너무 좁아 이 플랫폼에선 재현되지 않는다(리뷰의 20/20
//     통과와 같은 이유). 3MB 로 키우면 재현되지만, 실물과 무관한 크기의 스트레스 테스트를 상시로
//     두는 건 비용만 크고 근거는 약하다. 그래서 ★관측 대신 메커니즘★ 을 고정한다.
//
// ★격리★: REPO_ROOT 는 모듈 로드 시점 const 라 이 프로세스에서 바꿀 수 없다. 라이브 트리에서
//   돌 때 정본 rules/TEAM-OS.md 를 잠깐이라도 건드리면 그 순간 런타임이 반쪽 룰을 읽을 수 있으므로
//   (infra-safety ④), ★TEAM_COLLAB_ROOT 를 tmp 로 지정한 하위 프로세스★ 에서만 렌더한다.
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
  expect(r!.after).not.toBe(r!.before);                 // ★핵심: 갈아끼웠다★
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
