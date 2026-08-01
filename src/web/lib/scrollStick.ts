// scrollStick — 채팅형 컨테이너의 스크롤 유지 규칙 (단일 출처).
//   문제: ThreadView/Chat 이 폴링 재렌더마다 무조건 scrollTop=scrollHeight 로 끌어내려,
//   위로 스크롤해 이전 보고를 읽는 중에도 바닥으로 튕겼다 (GD 리포트 2026-08-01).
//   규칙(채팅 UX 관례): ★독자가 바닥 근처일 때만 재렌더 후 바닥으로 따라가고(stick),
//   위에서 읽는 중이면 읽던 위치를 그대로 보존한다.★
//   사용법: innerHTML 재작성 ★직전에★ captureScrollStick(el) → 재작성 ★직후에★ applyScrollStick(el, saved).
//   레이아웃에 의존하지 않도록 메트릭 인터페이스만 받는다(happy-dom 테스트 가능).

/** "바닥 근처" 판정 여유(px). 마지막 줄 일부가 걸쳐 보이는 정도는 바닥으로 취급한다. */
export const NEAR_BOTTOM_SLACK_PX = 48;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface ScrollStick {
  /** true = 재렌더 후 바닥으로 따라감, false = 읽던 scrollTop 복원 */
  stick: boolean;
  scrollTop: number;
}

/** 바닥에서 slackPx 이내면 true. 빈/미레이아웃 컨테이너(0/0/0)와 스크롤 불가 컨테이너는
 *  true — 첫 렌더·스레드 전환이 기존처럼 바닥에서 시작하게 하기 위해서다. */
export function isNearBottom(el: ScrollMetrics, slackPx: number = NEAR_BOTTOM_SLACK_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slackPx;
}

/** innerHTML 재작성 ★직전★ 호출 — 옛 높이 기준으로 독자의 위치를 캡처한다.
 *  컨테이너가 아직 없으면 stick 기본(첫 렌더 = 바닥). */
export function captureScrollStick(
  el: ScrollMetrics | null | undefined,
  slackPx: number = NEAR_BOTTOM_SLACK_PX,
): ScrollStick {
  if (!el) return { stick: true, scrollTop: 0 };
  return { stick: isNearBottom(el, slackPx), scrollTop: el.scrollTop };
}

/** innerHTML 재작성 ★직후★ 호출 — stick 이면 새 바닥으로, 아니면 읽던 위치로 복원.
 *  (scrollTop=scrollHeight 는 브라우저가 최대 스크롤로 클램프한다.) */
export function applyScrollStick(el: ScrollMetrics | null | undefined, saved: ScrollStick): void {
  if (!el) return;
  el.scrollTop = saved.stick ? el.scrollHeight : saved.scrollTop;
}

/** "무조건 바닥" ScrollStick — 내가 방금 보낸 메시지는 위에서 읽던 중이어도 바닥에서 확인해야 한다.
 *  (호출부가 {stick:true,...} 리터럴을 복제해 구조가 드리프트하는 것 방지 — 이 모듈이 단일 출처.) */
export function stickToBottom(): ScrollStick {
  return { stick: true, scrollTop: 0 };
}
