/**
 * Legacy auto-detectors — topic-shift / closure.
 *
 * GD 2026-06-05: routeTeamMessage / routeTeamMessageHybrid 에서 topic_shift·closure
 * 자동감지를 제거했다(sticky 는 명시 @멘션/답장으로만 바뀐다). 이 모듈은 그 격리 결과로,
 * hasTopicShift 는 characterization 안전판으로만 테스트되고, isClosure 는 현재 라우팅 경로에서
 * 호출되지 않는 dead code 다(분리 시 behavior-neutral 로 보존 — 삭제는 별도 cleanup 카드).
 */
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

// 종료/그만(closure) 신호 — 스레드 종료, 아무도 안 깸 (GD 설계 2026-05-24).
// 주제전환("됐고/다음")과 구분: closure 는 "됐어/그만/처리했어/대답 안 해도" 처럼 끝내는 말.
const CLOSURE_MARKERS = /(그만(\s|$|해|하)|대답\s*(은|는)?\s*(안|않)\s*해도|더\s*(이상\s*)?[^.!?]{0,12}(안|않)\s*해도|해결(했|됐|돼)|처리(했|됐|돼)|마무리(했|됐|돼)|끝났|이제\s*그만|이건?\s*됐어|됐어[.!\s]*$)/;

// 종료 신호이면서 새 작업 요청이 없을 때만 closure (실행/논의 의도가 있으면 새 작업이므로 제외).
// NOTE (2026-06-06 split): dead code — no caller in the current routing path. Preserved as-is.
export function isClosure(text: string): boolean {
  return CLOSURE_MARKERS.test(text) && classifyIntent(text) === "other";
}
