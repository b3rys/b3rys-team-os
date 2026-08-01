// scrollStick — 채팅형 스크롤 유지 규칙 단위 테스트.
//   규칙: 독자가 바닥 근처에 있을 때만 재렌더 후 바닥으로 따라가고(stick),
//   위로 스크롤해 읽는 중이면 읽던 위치를 그대로 보존한다.
//   (ThreadView/Chat 이 폴링 재렌더마다 무조건 바닥으로 끌어내리던 문제의 회귀 가드.)
import { describe, expect, test } from "bun:test";
import {
  NEAR_BOTTOM_SLACK_PX,
  isNearBottom,
  captureScrollStick,
  applyScrollStick,
} from "./scrollStick";

// happy-dom 은 레이아웃이 없어 scrollHeight/clientHeight 가 늘 0 이다 — 헬퍼는
// 순수 메트릭 인터페이스({scrollTop, scrollHeight, clientHeight})만 받게 설계해
// 레이아웃 없이도 실측 시나리오를 그대로 검증한다.
function el(scrollTop: number, scrollHeight: number, clientHeight: number) {
  return { scrollTop, scrollHeight, clientHeight };
}

describe("isNearBottom", () => {
  test("정확히 바닥 = near", () => {
    expect(isNearBottom(el(600, 1000, 400))).toBe(true);
  });

  test("slack 이내로 살짝 위 = near", () => {
    expect(isNearBottom(el(600 - NEAR_BOTTOM_SLACK_PX, 1000, 400))).toBe(true);
  });

  test("slack 보다 위로 올라가 있으면 not near", () => {
    expect(isNearBottom(el(600 - NEAR_BOTTOM_SLACK_PX - 1, 1000, 400))).toBe(false);
  });

  test("맨 위에서 읽는 중이면 not near", () => {
    expect(isNearBottom(el(0, 1000, 400))).toBe(false);
  });

  test("내용이 컨테이너보다 짧으면(스크롤 불가) near", () => {
    expect(isNearBottom(el(0, 300, 400))).toBe(true);
  });

  test("빈/미레이아웃 컨테이너(0/0/0)는 near — 첫 렌더가 바닥 스크롤을 유지하게", () => {
    expect(isNearBottom(el(0, 0, 0))).toBe(true);
  });

  test("커스텀 slack 적용", () => {
    expect(isNearBottom(el(500, 1000, 400), 100)).toBe(true);
    expect(isNearBottom(el(499, 1000, 400), 100)).toBe(false);
  });
});

describe("captureScrollStick / applyScrollStick", () => {
  test("바닥 근처에서 캡처 → 내용이 자라도 새 바닥으로 stick", () => {
    const before = el(600, 1000, 400); // 정확히 바닥
    const saved = captureScrollStick(before);
    expect(saved.stick).toBe(true);

    const after = el(600, 1500, 400); // 재렌더로 내용이 자람
    applyScrollStick(after, saved);
    expect(after.scrollTop).toBe(1500); // scrollTop=scrollHeight (브라우저가 최대치로 클램프)
  });

  test("위로 스크롤해 읽는 중 캡처 → 내용이 자라도 읽던 위치 보존", () => {
    const before = el(120, 1000, 400); // 한참 위에서 읽는 중
    const saved = captureScrollStick(before);
    expect(saved.stick).toBe(false);
    expect(saved.scrollTop).toBe(120);

    const after = el(0, 1500, 400); // innerHTML 재작성 직후 scrollTop 리셋 상태
    applyScrollStick(after, saved);
    expect(after.scrollTop).toBe(120); // ★핵심 회귀 가드: 바닥으로 끌려가지 않는다★
  });

  test("내용 변화가 없어도(폴링 틱) 읽던 위치 보존", () => {
    const before = el(120, 1000, 400);
    const saved = captureScrollStick(before);
    const after = el(0, 1000, 400);
    applyScrollStick(after, saved);
    expect(after.scrollTop).toBe(120);
  });

  test("null/undefined 컨테이너는 캡처=stick 기본, 적용=no-op (throw 금지)", () => {
    const saved = captureScrollStick(null);
    expect(saved.stick).toBe(true);
    expect(() => applyScrollStick(null, saved)).not.toThrow();
    expect(() => applyScrollStick(undefined, { stick: false, scrollTop: 10 })).not.toThrow();
  });

  test("새로 만들어진 컨테이너(0/0/0)에서 캡처 → stick (스레드 전환 시 바닥 스크롤 유지)", () => {
    const fresh = el(0, 0, 0);
    const saved = captureScrollStick(fresh);
    expect(saved.stick).toBe(true);
    const after = el(0, 900, 400);
    applyScrollStick(after, saved);
    expect(after.scrollTop).toBe(900);
  });
});
