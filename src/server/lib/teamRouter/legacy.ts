// hasTopicShift는 특성화 테스트용이다. isClosure는 현재 라우팅에서 호출되지 않으며 owner는 명시 멘션·답장으로만 변경한다.
import { classifyIntent } from "./_shared";

const TOPIC_SHIFT_PATTERNS = [
  /오케이.*됐고/i,
  /\bok\b.*됐고/i,
  /이건\s*됐고/i,
  /이제\s+다른/i,
  /다음\s*(거|것|걸|주제|업무|건)/i, // "다음 거/주제" = 새 주제 (단, "그 다음 단계는?" 같은 이어가기는 제외)
  /넘어가(자|고|면)?/i,
  /주제\s*전환/i,
  /다른\s*(얘기|이야기|업무)/i,
];

export function hasTopicShift(text: string): boolean {
  return TOPIC_SHIFT_PATTERNS.some((rx) => rx.test(text));
}

// 종료/그만(closure) 신호 — 스레드 종료, 아무도 안 깸.
// 주제전환("됐고/다음")과 구분: closure 는 "됐어/그만/처리했어/대답 안 해도" 처럼 끝내는 말.
const CLOSURE_MARKERS = /(그만(\s|$|해|하)|대답\s*(은|는)?\s*(안|않)\s*해도|더\s*(이상\s*)?[^.!?]{0,12}(안|않)\s*해도|해결(했|됐|돼)|처리(했|됐|돼)|마무리(했|됐|돼)|끝났|이제\s*그만|이건?\s*됐어|됐어[.!\s]*$)/;

export function isClosure(text: string): boolean {
  return CLOSURE_MARKERS.test(text) && classifyIntent(text) === "other";
}
