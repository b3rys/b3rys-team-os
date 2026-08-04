// mdInline — 채팅 말풍선용 인라인 마크다운 렌더 단위 테스트.
//   배경(GD 2026-08-01): 팀원 메시지가 **강조**·`코드` 마크다운을 그대로 별표로 노출.
//   Reports.ts mdToHtml 의 inline 처리를 공유 헬퍼로 추출 — 이 파일이 그 계약의 회귀 가드.
//   ★블록 문법(헤딩·표·리스트)은 다루지 않는다★ — 말풍선은 whitespace-pre-wrap 로 개행을
//   보존하므로 인라인 변환만 안전하다.
import { describe, expect, test } from "bun:test";
import { mdInlineToHtml } from "./mdInline";

describe("mdInlineToHtml — 변환", () => {
  test("**볼드** → <strong>", () => {
    expect(mdInlineToHtml("이건 **중요** 합니다")).toBe("이건 <strong>중요</strong> 합니다");
  });

  test("여러 개의 볼드", () => {
    expect(mdInlineToHtml("**결론부터** 그리고 **왜**")).toBe(
      "<strong>결론부터</strong> 그리고 <strong>왜</strong>",
    );
  });

  test("*이탤릭* → <em> (볼드와 공존)", () => {
    expect(mdInlineToHtml("*기울임* 과 **굵게**")).toBe("<em>기울임</em> 과 <strong>굵게</strong>");
  });

  test("`코드` → <code>", () => {
    expect(mdInlineToHtml("실행: `bun test` 하세요")).toBe(
      "실행: <code>bun test</code> 하세요",
    );
  });

  test("[텍스트](https://...) → 안전한 링크(새 탭·noopener)", () => {
    expect(mdInlineToHtml("[문서](https://example.com/a)")).toBe(
      '<a href="https://example.com/a" target="_blank" rel="noopener">문서</a>',
    );
  });

  test("개행은 건드리지 않는다 (pre-wrap 컨테이너가 처리)", () => {
    expect(mdInlineToHtml("첫 줄\n**둘째** 줄")).toBe("첫 줄\n<strong>둘째</strong> 줄");
  });

  test("마크다운 없는 평문은 이스케이프 외 변화 없음", () => {
    expect(mdInlineToHtml("그냥 평범한 문장")).toBe("그냥 평범한 문장");
  });
});

describe("mdInlineToHtml — 안전(이스케이프·XSS)", () => {
  test("HTML 태그는 이스케이프된다", () => {
    expect(mdInlineToHtml('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
  });

  test("볼드 안의 HTML 도 이스케이프", () => {
    expect(mdInlineToHtml("**<b>x</b>**")).toBe("<strong>&lt;b&gt;x&lt;/b&gt;</strong>");
  });

  test("javascript: 링크는 링크로 만들지 않는다 (http/https 만 허용)", () => {
    const out = mdInlineToHtml("[클릭](javascript:alert(1))");
    expect(out).not.toContain("<a ");
    expect(out).toContain("클릭"); // 텍스트는 남는다(이스케이프된 원문 형태)
  });

  test("불완전한 별표는 그대로 노출 (오변환 금지)", () => {
    expect(mdInlineToHtml("2 * 3 = 6, a*b")).not.toContain("<em>");
    expect(mdInlineToHtml("**닫히지 않음")).toBe("**닫히지 않음");
  });
});
