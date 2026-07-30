/**
 * 분류는 세 개로만 — 보고서·리서치·교육자료. (팀장님 지시 2026-07-30)
 *
 * 왜 못 박나: `report.category` 가 자유 문자열이라 같은 뜻이 표기별로 갈렸다. 실측 48건에서
 * 리서치 9 · research 4 · AI 리서치 1 · AI Research 1 이 ★각각 따로★ 세어져 화면 알약이 9개가 됐고,
 * 팀장님이 그것을 태그로 오인해 "팀원이 등록한 태그는 내가 삭제/수정도 안돼" 로 신고하셨다.
 * 표를 고치면 여기가 먼저 빨개진다.
 */
import { describe, expect, test } from "bun:test";
import {
  canonicalCategory,
  knownCategoryAliases,
  REPORT_CATEGORIES,
  DEFAULT_REPORT_CATEGORY,
} from "./reportCategory";

describe("canonicalCategory", () => {
  test("정본 세 개는 그대로 통과한다", () => {
    for (const c of REPORT_CATEGORIES) expect(canonicalCategory(c)).toBe(c);
  });

  test("★같은 뜻의 표기를 하나로 접는다★ — 실제로 갈려 있던 값들", () => {
    for (const v of ["리서치", "research", "AI 리서치", "AI Research", "ai리서치"]) {
      expect(canonicalCategory(v), v).toBe("리서치");
    }
    for (const v of ["교육자료", "english-learning", "가이드"]) {
      expect(canonicalCategory(v), v).toBe("교육자료");
    }
  });

  test("대소문자·앞뒤공백·연속공백이 달라도 같게 본다", () => {
    for (const v of ["  RESEARCH ", "AI  RESEARCH", "ai research"]) {
      expect(canonicalCategory(v), JSON.stringify(v)).toBe("리서치");
    }
  });

  test("빈 값은 기본 분류 — 분류를 안 적은 것은 정상이다", () => {
    for (const v of ["", "   ", null, undefined]) {
      expect(canonicalCategory(v as string | null | undefined)).toBe(DEFAULT_REPORT_CATEGORY);
    }
  });

  test("★빈 값에는 경고 훅을 부르지 않는다★ — 미지의 표기와 다르다", () => {
    const seen: string[] = [];
    canonicalCategory("", (o) => seen.push(o));
    canonicalCategory(null, (o) => seen.push(o));
    expect(seen).toEqual([]);
  });

  test("★모르는 표기는 기본값으로 접되 조용히 하지 않는다★", () => {
    const seen: string[] = [];
    expect(canonicalCategory("마케팅", (o) => seen.push(o))).toBe(DEFAULT_REPORT_CATEGORY);
    // 원본을 그대로 넘겨야 사람이 무엇이 사라졌는지 안다.
    expect(seen).toEqual(["마케팅"]);
  });

  test("표에 등록된 별칭은 모두 정본 세 개 중 하나로만 간다", () => {
    for (const [alias, target] of knownCategoryAliases()) {
      expect(REPORT_CATEGORIES as readonly string[], alias).toContain(target);
      // 별칭 키는 소문자·공백정리된 형태여야 한다 — 아니면 영원히 매칭되지 않는다.
      expect(alias, alias).toBe(alias.trim().toLowerCase().replace(/\s+/g, " "));
    }
  });

  test("정본이 세 개다 (늘리려면 팀장님 결정이 필요하다)", () => {
    expect(REPORT_CATEGORIES).toEqual(["보고서", "리서치", "교육자료"]);
  });
});
