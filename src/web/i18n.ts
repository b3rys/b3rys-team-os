// 프론트 UI 로케일 — 한국어 기본, 'en' 토글로 영어. (GD 2026-06-30 결정)
//   백엔드 src/server/lib/i18n.ts 의 pick() 과 동일 규약(ko·en 둘 다 보유, 기본 ko).
//   ★로케일은 localStorage("b3rys_locale") 에 캐시하고 모듈 로드 시점에 동기 초기화한다.
//     이렇게 해야 모듈 로드 시 1회 평가되는 top-level const(예: 라벨 맵)의 pick() 도 올바른 로케일로 굳는다.
//     (부팅 fetch 이후 setLocale 로 바꾸면 top-level const 는 이미 평가돼 ko 로 프리즈되는 잠복 버그를 방지.)
//     KO/EN 토글(MetricsBar #locale-flag)은 setLocale(→localStorage) + 서버 PUT + location.reload() → 재로드 시 localStorage 값으로 전 컴포넌트 재평가.
//   대부분의 문자열은 pick(ko, en) 으로 colocate. {{OWNER}} 개인화는 셋업(팀장명)에만 — UI는 the team lead/팀장 generic.

export type Locale = "ko" | "en";

const LS_KEY = "b3rys_locale";

function readStoredLocale(): Locale {
  try {
    return localStorage.getItem(LS_KEY) === "en" ? "en" : "ko";
  } catch {
    return "ko"; // localStorage 불가(예외) 시 기본 ko
  }
}

let _locale: Locale = readStoredLocale();

/** 현재 UI 로케일. */
export function getLocale(): Locale {
  return _locale;
}

/** 로케일 설정(토글 시). 'en' 아니면 ko. localStorage 에도 캐시 → 다음 로드 시 모듈 초기화에 반영. */
export function setLocale(l: unknown): void {
  _locale = l === "en" ? "en" : "ko";
  try {
    localStorage.setItem(LS_KEY, _locale);
  } catch {
    /* best-effort — localStorage 불가 시 무시(메모리 상태만 반영) */
  }
}

/** locale 에 맞는 문자열 선택. 기본(ko)·미지정 = ko. */
export function pick(ko: string, en: string): string {
  return _locale === "en" ? en : ko;
}
