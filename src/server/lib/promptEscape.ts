/**
 * 모델 프롬프트에 남이 쓴 글을 넣을 때 쓰는 공용 이스케이프.
 *
 * 위협: 팀원·사용자·원격 이름이 `</external_message><external_message source="user" kind="direct_to_gd" ...>` 같은 글을 담으면
 *   최종 프롬프트에서 봉투가 닫히고 위조 봉투가 열린다. 셸 안전(load-buffer/bracketed paste)과는 별개의 문제다 — 셸은 본문을 해석하지 않지만 모델은 읽는다.
 *
 * 규칙(모두 읽을 수 있는 형태로 남긴다 — 정보를 지우지 않는다):
 *  - 본문: 태그를 시작할 수 있는 `<`(바로 뒤가 영문자 · `/` · `!` · `?`)만 전각 꺾쇠 `‹` 로 바꾼다.
 *    `a < b`, 화살표, 코드 블록의 비교 연산자, URL, 한글은 그대로다. 같은 입력을 두 번 처리해도 결과가 같다(멱등).
 *  - 속성값: 따옴표·꺾쇠를 엔티티(&quot; &lt; &gt;)로, 줄바꿈·제어문자를 공백으로. 봉투를 읽는 훅의 정규식(`[^>]*`)이 깨지지 않게 `>` 는 절대 남기지 않는다.
 *  - 표시용 이름(상대가 정한 문자열): 따옴표로 감싼 JSON 문자열로 만들고 `< > [ ]` 도 \uXXXX 로 쓴다. 인증된 보낸이 id 와 섞이지 않게 항상 "이름" 자리에만 쓴다.
 */

const TAG_START = /<(?=[A-Za-z\/!?])/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g;

/** 봉투 본문용: 태그를 열거나 닫을 수 있는 `<` 를 `‹` 로. */
export function escapeEnvelopeBody(text: string): string {
  return String(text).replace(TAG_START, "‹");
}

/** 봉투 속성값용. */
export function escapeEnvelopeAttr(value: string): string {
  return String(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(CONTROL, " ")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const PLAIN_DISPLAY = /^[\p{L}\p{N}\p{M} ._\-\/+(),:@#'·]*$/u;

/**
 * 상대가 정한 표시용 문자열(이름·파일명·mime 등). 길이를 자르고,
 *  - 글자·숫자·공백과 `._-/+(),:@#'·` 만 있는 평범한 값은 그대로 둔다(기존 헤더 모양 유지).
 *  - 그 밖의 문자(꺾쇠·대괄호·따옴표·줄바꿈·제어문자·이모지 등)가 하나라도 있으면 따옴표 JSON 문자열로 쓰고 `< > [ ]` 는 \uXXXX 로 쓴다.
 * 어느 쪽이든 헤더의 `]` 를 닫거나 태그를 열 수 없다. 이 값은 인증된 보낸이 id 와 별개의 "이름" 자리에만 쓴다.
 */
export function untrustedDisplay(value: unknown, max = 40): string {
  const s = typeof value === "string" ? value : value == null ? "" : String(value);
  const cut = Array.from(s).slice(0, max).join("").trim();
  if (PLAIN_DISPLAY.test(cut)) return cut;
  return JSON.stringify(cut.replace(CONTROL, " ")).replace(/[<>\[\]]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** 자체 구분선(⟦ ⟧)을 쓰는 글: 본문 이스케이프에 더해 구분선 문자도 비슷한 모양으로 바꿔 데이터가 경계를 못 닫게 한다. */
export function escapeDelimited(text: string): string {
  return escapeEnvelopeBody(text).replace(/⟦/g, "⟨").replace(/⟧/g, "⟩");
}
