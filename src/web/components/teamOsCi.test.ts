/**
 * CI 결과 블록의 표시 규칙.
 *
 * ★이 함수에는 테스트가 하나도 없었다★ (2026-07-30 실측) — 교차검증에서 "화면은 이유를 보여준다" 는
 * 판단이 ★코드를 읽어서★ 나왔고, 실행으로 확인된 적이 없었다. 표시 규칙이 이 기능의 핵심이라
 * (초록으로 위장하지 않는다 / 미설정은 오류가 아니다) 여기서 못 박는다.
 */
import { describe, expect, test } from "bun:test";
import { ciBlockHtml } from "./TeamOS";

const base = {
  ok: false,
  reason: "GitHub CI 미설정 — 이 설치본의 git origin 이 GitHub 이 아닙니다. TEAM_CI_REPO=owner/repo",
  runs: [] as never[],
  fetched_at: null,
};

describe("GitHub CI 미설정은 오류가 아니다", () => {
  test("★빨간 오류로 그리지 않는다★ — GitHub 을 안 쓰는 설치본의 정상 상태다", () => {
    const html = ciBlockHtml({ ...base, configured: false });
    expect(html).toContain("미설정");
    expect(html).not.toContain("text-txt-red");
    // 실패용 문구가 새어나오면 안 된다 — 아무 문제 없는 사람에게 고장 신호가 된다
    expect(html).not.toContain("확인 불가");
    // 실패 분기에만 있는 안내문(GitHub Actions 를 직접 보라)이 새어나오면 안 된다
    expect(html).not.toContain("직접 확인하세요");
  });

  test("★설정 방법이 화면에 있다★ — 이유만 적고 방법을 안 적으면 사람이 못 고친다", () => {
    expect(ciBlockHtml({ ...base, configured: false })).toContain("TEAM_CI_REPO");
  });

  test("★진짜 실패는 여전히 빨갛다★ — 미설정 분기가 실패를 삼키지 않는다", () => {
    const html = ciBlockHtml({ ...base, reason: "github 500" });
    expect(html).toContain("text-txt-red");
    expect(html).toContain("확인 불가");
  });

  test("설정돼 있는데 실패한 경우도 빨갛다(configured:true)", () => {
    expect(ciBlockHtml({ ...base, reason: "github 500", configured: true })).toContain("text-txt-red");
  });
});

describe("빈 결과를 초록으로 위장하지 않는다", () => {
  test("아직 안 가져왔으면 '불러오는 중'", () => {
    expect(ciBlockHtml(null)).toContain("불러오는 중");
  });

  test("ok:true 인데 실행이 0건이면 ★없다고 말한다★ (빈 화면 아님)", () => {
    const html = ciBlockHtml({ ok: true, runs: [], fetched_at: "2026-07-30T09:00:00Z" });
    expect(html).toContain("없습니다");
    expect(html).not.toContain("text-txt-red");
  });

  test("실패는 이유를 그대로 보여준다 — 사람이 원인을 알 수 있어야 한다", () => {
    expect(ciBlockHtml({ ...base, reason: "github 403" })).toContain("github 403");
  });

  test("이유에 HTML 이 들어와도 태그로 실행되지 않는다", () => {
    const html = ciBlockHtml({ ...base, reason: '<img src=x onerror="alert(1)">' });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
