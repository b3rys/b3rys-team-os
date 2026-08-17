// mdInline — 채팅 말풍선용 인라인 마크다운 (단일 출처).
// 배경: 팀원 메시지의 **강조**·`코드`·[링크](url) 가 원문 그대로 노출됐다.
//   Reports.ts mdToHtml 의 inline 처리를 추출·공유한다. ★인라인만★ — 블록 문법(헤딩·표·리스트)은
//   말풍선 레이아웃(whitespace-pre-wrap, 개행 보존)을 깨므로 다루지 않는다.
//   Reports 원본 대비 의도적 강화 2건:
//     ① 링크는 http/https 만 <a> 로 (javascript: 등 스킴 주입 차단 — 채팅은 외부 발신 텍스트가 들어온다)
//     ② 이탤릭은 내용 양끝이 공백이 아닐 때만 ("2 * 3 = 6, a*b" 같은 산식 오변환 방지)

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 이스케이프 → `code` → **bold** → *em* → [링크](http…) 순서로 변환한 HTML 을 돌려준다.
 *  ★입력을 통째로 이스케이프한 뒤★ 우리가 만든 고정 태그만 삽입하므로 원문 HTML 은 실행되지 않는다. */
export function mdInlineToHtml(text: string): string {
  let s = escapeHtml(String(text ?? ""));
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // 내용 양끝 비공백(\S) 요구 — 곱셈 기호·불릿 잔재를 기울임으로 오인하지 않는다.
  s = s.replace(/(^|[^*])\*(\S(?:[^*]*\S)?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, txt, href) =>
    `<a href="${href}" target="_blank" rel="noopener">${txt}</a>`);
  return s;
}
