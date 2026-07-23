// ★불변식: 공개 사용자 화면에 특정 팀의 운영 데이터가 박히면 안 된다.★
//
// 실제로 그랬다 (2026-07-12):
//  - searchQualityCases.ts 에 우리 팀 실제 장애·실명 시드가 들어 있었고, TeamSearch 가 그걸
//    '예시 질의' 패널로 렌더링 → 공개 사용자가 남의 팀 내부 이슈를 예시로 보게 됐다.
//  - agentSetup/diagrams.ts 에는 우리 실제 조직도(이름·역할)가 박혀 있어 공개 대시보드에 그대로 떴다.
//
// 누출 이전에 ★제품이 틀린 것★이다 — 공개 사용자에게 남의 팀 조직도는 아무 의미가 없다.
// 이 테스트는 그 두 파일이 다시 실팀 값으로 되돌아가는 것을 막는다.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SEARCH_QUALITY_SEEDS } from "./searchQualityCases";

// 이 저장소를 운영하는 팀의 실제 멤버 id/표시명. 공개 화면 데이터에 나오면 안 된다.
// (README/LICENSE 의 저작·출처 표기는 정당하다 — 문제는 '사용자 화면·기본값'에 박히는 것.)
const REAL_MEMBERS = ["bill", "steve", "demis", "dbak", "codex", "hermes", "devon", "lui", "forin", "ames", "brief"];

function hasRealMember(text: string): string[] {
  const lower = text.toLowerCase();
  // 단어 경계로 검사 — 'codex' 가 'codex-bridge' 같은 기술용어로 쓰이는 건 별개라 화면 데이터에서만 본다.
  return REAL_MEMBERS.filter((m) => new RegExp(`\\b${m}\\b`, "i").test(lower));
}

describe("검색 예시 시드 — 공개 화면 데이터", () => {
  test("★시드에 실팀 멤버명이 없다★", () => {
    for (const seed of SEARCH_QUALITY_SEEDS) {
      const blob = [seed.id, seed.owner, seed.query, seed.intent, seed.expectedHint, seed.mustNotHint].join(" ");
      const found = hasRealMember(blob);
      expect(found, `시드 "${seed.id}" 에 실팀 멤버명이 있다: ${found.join(", ")}`).toEqual([]);
    }
  });

  test("모든 카테고리에 예시가 하나 이상 있다(UI 가 비지 않는다)", () => {
    const cats = new Set(SEARCH_QUALITY_SEEDS.map((s) => s.category));
    for (const c of ["ops", "routing", "tasks", "docs", "quality", "member"]) {
      expect(cats.has(c as never), `카테고리 "${c}" 예시가 없다`).toBe(true);
    }
  });
});

describe("팀 구성 다이어그램 — 공개 화면 데이터", () => {
  test("★조직도에 실팀 이름이 박혀 있지 않다★", () => {
    const src = readFileSync(join(import.meta.dir, "../web/components/agentSetup/diagrams.ts"), "utf-8");
    // agentNode("이름", …) 로 그려지는 노드 라벨만 검사한다(코드 주석·기술용어는 제외).
    const labels = [...src.matchAll(/agentNode\(\s*\d+\s*,\s*\d+\s*,\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(labels.length).toBeGreaterThan(0); // 다이어그램이 실제로 노드를 그리는지 확인
    for (const label of labels) {
      const found = hasRealMember(label);
      expect(found, `조직도 노드 "${label}" 이 실팀 멤버다`).toEqual([]);
    }
  });
});
