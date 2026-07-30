/**
 * 태그 알약 마크업 — ★이름 바꾸기·삭제가 태그 옆에 실제로 붙는지★ (팀장님 지시 2026-07-30).
 *
 * 왜 마크업을 시험하나: 이 UI 는 ★마우스를 올렸을 때만 보인다.★ 나는 브라우저를 띄워 확인하지 못했고
 * (그래서 PR 에 '미검증' 으로 적었다), 오늘 이미 ★시험은 통과했는데 실제 화면이 깨진 일★ 을
 * 팀 전체가 네 번 겪었다. 최소한 "버튼이 존재하고 어느 태그를 가리키는가" 는 코드로 못 박는다.
 * 육안 확인(아이콘이 실제로 hover 에 나타나는지)은 사람이 따로 해야 끝난다.
 */
import { describe, expect, test } from "bun:test";
import { tagPillsHtml } from "./Reports";

const pillCls = (active: boolean) => (active ? "ACTIVE" : "IDLE");
const tag = (id: string, name: string, count = 0) => ({ id, name, color: "blue", report_count: count });

describe("tagPillsHtml", () => {
  test("태그마다 ★이름바꾸기·삭제 버튼이 하나씩★ 붙는다", () => {
    const html = tagPillsHtml([tag("t1", "주간보고", 3), tag("t2", "인프라")], new Set(), pillCls);
    expect((html.match(/reports-tag-edit/g) ?? []).length).toBe(2);
    expect((html.match(/reports-tag-del/g) ?? []).length).toBe(2);
    expect((html.match(/reports-tag-pill/g) ?? []).length).toBe(2);
  });

  test("★어느 태그인지 버튼이 알고 있다★ — id·이름이 둘 다 실린다", () => {
    const html = tagPillsHtml([tag("t1", "주간보고")], new Set(), pillCls);
    expect(html).toContain('class="reports-tag-edit');
    expect(html).toContain('data-tag-id="t1"');
    expect(html).toContain('data-tag-name="주간보고"');
  });

  test("hover 로만 보이게 하는 클래스가 실려 있다 (group + opacity 전환)", () => {
    const html = tagPillsHtml([tag("t1", "a")], new Set(), pillCls);
    expect(html).toContain('class="group inline-flex');
    expect(html).toContain("opacity-0 group-hover:opacity-100");
  });

  test("★태그 이름이 속성을 깨지 않는다★ — 이름은 사용자 입력이다", () => {
    const html = tagPillsHtml([tag("t1", '따옴표" <b>태그</b>')], new Set(), pillCls);
    // 원문 그대로 속성에 들어가면 data-tag-name 이 조기 종료돼 마크업이 깨진다.
    expect(html).not.toContain('data-tag-name="따옴표" <b>');
    expect(html).toContain("&quot;");
    expect(html).toContain("&lt;b&gt;");
  });

  test("선택된 태그는 pillCls(true) 를 받는다 (필터 토글 표시 유지)", () => {
    const html = tagPillsHtml([tag("t1", "a"), tag("t2", "b")], new Set(["t2"]), pillCls);
    const first = html.slice(0, html.indexOf("t2"));
    expect(first).toContain("IDLE");
    expect(html.slice(html.indexOf('data-tag-id="t2"') - 200)).toContain("ACTIVE");
  });

  test("보고서 수를 보여준다 (없으면 0)", () => {
    expect(tagPillsHtml([tag("t1", "a", 7)], new Set(), pillCls)).toContain(">7<");
    expect(tagPillsHtml([{ id: "t2", name: "b", color: "blue" }], new Set(), pillCls)).toContain(">0<");
  });

  test("태그가 없으면 빈 문자열 (호출부가 '등록된 태그 없음' 을 띄운다)", () => {
    expect(tagPillsHtml([], new Set(), pillCls)).toBe("");
  });
});
