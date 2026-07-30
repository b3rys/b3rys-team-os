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
    // ★클래스를 붙어 있는 순서로 단정하지 않는다★ — 사이에 하나 끼우면 깨진다(실제로 깨졌다).
    //   'group' 이 있고 'opacity-0 group-hover:opacity-100' 쌍이 있다는 것만 본다.
    const wrapper = html.slice(0, html.indexOf(">") + 1);
    expect(wrapper).toContain("group");
    expect(html).toContain("opacity-0 group-hover:opacity-100");
  });

  test("★아이콘이 자리를 차지하지 않는다★ — 쉬는 상태에 빈칸이 생기면 안 된다", () => {
    // 팀장님 실측(2026-07-30): "너무 떨어져 있어. 이럴 바엔 예전 UI 가 더 나아."
    //   흐름 안에 두고 opacity 로만 숨기면 마우스를 안 올려도 아이콘 두 개 만큼 빈칸이 항상 남는다.
    //   ★그리고 우리 검증은 "줄이 흔들리지 않는다" 를 통과시켰다★ — 흔들리지 않는 이유가 그 빈칸이었다.
    //   absolute 로 흐름에서 빼야 쉬는 상태가 예전 UI 와 같아진다.
    const html = tagPillsHtml([tag("t1", "a")], new Set(), pillCls);
    const wrapper = html.slice(0, html.indexOf(">") + 1);
    expect(wrapper, "아이콘을 띄우려면 래퍼가 relative 여야 한다").toContain("relative");
    const iconBox = html.slice(html.indexOf("<span", html.indexOf("</button>")));
    expect(iconBox, "아이콘 묶음이 absolute 가 아니면 자리를 차지한다").toContain("absolute");
    // 흐름 안에 두던 옛 방식의 흔적(알약 뒤 margin) 이 남아 있으면 빈칸이 다시 생긴다.
    expect(iconBox).not.toContain("ml-0.5 inline-flex");
  });

  test("★안 보일 때는 눌리지도 않는다★ — opacity 만으로는 클릭이 안 막힌다", () => {
    // 투명한 요소도 그 자리는 클릭을 받는다. 마우스가 없는 환경(터치·아이패드 웹뷰)에서
    // 태그 옆을 탭하면 안 보이는 연필·휴지통이 눌려 "누르지도 않은 창" 이 뜬다.
    const html = tagPillsHtml([tag("t1", "a")], new Set(), pillCls);
    expect(html).toContain("pointer-events-none");
    expect(html).toContain("group-hover:pointer-events-auto");
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
