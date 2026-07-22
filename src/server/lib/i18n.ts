// 팀 메시지/UI 로케일 — 한국어 기본, 'en' 토글로 영어. (OWNER 2026-06-30 결정)
//   영문화는 롤백이 아니라 'ko·en 둘 다 보유, 기본 ko'. locale 설정으로 선택한다.
//   owner_name 치환과는 직교(locale 무관하게 ${owner} 치환은 그대로).
//   규모가 커지면 messages.ts 키맵으로 승격 가능 — 지금은 inline pick() 으로 ko·en colocate.

export type Locale = "ko" | "en";

/** locale 에 맞는 문자열 선택. 기본(ko)·미지정 = ko. */
export function pick(locale: Locale | undefined, ko: string, en: string): string {
  return locale === "en" ? en : ko;
}
