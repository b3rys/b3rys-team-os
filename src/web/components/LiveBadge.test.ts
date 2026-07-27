import { describe, expect, test } from "bun:test";
import { shouldShowLiveBadge, APP_VERSION } from "./LiveBadge";

describe("LiveBadge host gating", () => {
  test("shows only on the private live dashboard", () => {
    expect(shouldShowLiveBadge("dev.b3rys.com")).toBe(true);
    expect(shouldShowLiveBadge("studio.b3rys.com")).toBe(false);
    expect(shouldShowLiveBadge("localhost")).toBe(false);
  });
});

/* ★버전이 두 곳에 손으로 적혀 있다★ — package.json 과 여기. 주석에 "맞춰 관리" 라고만 돼 있고
 * 어긋나도 아무것도 안 잡았다. 배지가 옛 버전을 표시해도 테스트는 초록이다.
 * 릴리즈마다 사람이 두 번 고쳐야 하는 구조라, 한 번 빠지면 조용히 어긋난 채로 배포된다. */
describe("APP_VERSION — package.json 과 어긋나면 실패한다", () => {
  test("★대시보드 배지 버전 = package.json 버전★", async () => {
    const pkg = await Bun.file(`${import.meta.dir}/../../../package.json`).json();
    expect(APP_VERSION).toBe(pkg.version);
  });

  test("버전 형식은 x.y.z 다", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
