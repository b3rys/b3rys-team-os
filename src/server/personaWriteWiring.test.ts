// ★persona 를 쓰는 통로가 하나로 유지되는지★ 회귀 (2026-07-27, Codex 리뷰 적발).
//
// 사고: `PUT /agents/:id/persona` 가 writeFileSync 로 직행해 live-fs 가드도 backup-first(.bak)도
// 건너뛰고 있었다. 가드를 아무리 넓혀도 ★가드를 안 거치는 writer 가 하나 있으면 그 길로 다 새어나간다.★
//
// ★한계를 분명히 한다 — 이건 소스 수준 검사다.★ index.ts 는 서버 엔트리(임포트만 해도 DB 를 열고
// 워커를 띄운다)라 실제 API 호출로 태울 수 없다. 실제 쓰기 차단은 savePersonaFile 자체의 배선
// 테스트(personaTemplates.test.ts)가 검증하고, 여기서는 ★그 함수를 계속 거치는지★ 만 지킨다.
// 라우트를 테스트 가능한 팩토리로 뽑으면 이 파일은 실호출 테스트로 승격해야 한다.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const indexSrc = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");

test("persona PUT 라우트가 savePersonaFile 을 거친다 (writeFileSync 직행 금지)", () => {
  expect(indexSrc).toContain("savePersonaFile(agent.persona_file");
  // persona_file 에 직접 쓰는 코드가 되살아나면 잡는다.
  expect(indexSrc).not.toMatch(/writeFileSync\(\s*agent\.persona_file/);
});
