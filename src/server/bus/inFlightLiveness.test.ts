/**
 * ★in-flight 잠금은 '시작한 지 오래' 가 아니라 '조용한 지 오래' 로 푼다.★
 *
 * ★이 파일이 있는 이유★ — 이 판정을 되돌려도(quietSince → startedAt) 수트가 ★전부 초록★ 이었다.
 * 지금 코드가 맞는 것과, 다음 사람이 깨뜨렸을 때 알아차리는 것은 다른 문제다. 여기서 그 축을 고정한다.
 *
 * ★키가 맞물리는지도 함께 잰다★ — 생존신호를 쓰는 키와 자가치유가 읽는 키가 어긋나면
 * ★오류 없이 조용히 옛 동작★ 이 된다(신호가 영영 안 보이므로 '시작 시각' 만으로 판정).
 */
import { describe, expect, test } from "bun:test";
import { noteTurnAlive, forgetTurnAlive, inFlightKey, shouldReleaseInFlight } from "./wakeDispatcher";

const GRACE = 60_000;

describe("in-flight 해제 판정", () => {
  test("★대조군 — 신호가 없으면 시작 시각 기준으로 grace 를 넘길 때 푼다★ (상한을 없앤 게 아니다)", () => {
    const key = inFlightKey("m-quiet", "hermes");
    forgetTurnAlive(key);
    const now = 1_000_000;
    expect(shouldReleaseInFlight(key, now - GRACE - 1, GRACE, now), "조용한 턴은 푼다").toBe(true);
    expect(shouldReleaseInFlight(key, now - GRACE + 1, GRACE, now), "아직 grace 안이면 안 푼다").toBe(false);
  });

  test("★살아 있다는 신호가 오면 시작한 지 아무리 오래돼도 안 푼다★ (핵심 한 줄)", () => {
    const key = inFlightKey("m-alive", "hermes");
    forgetTurnAlive(key);
    noteTurnAlive("m-alive", "hermes"); // 방금 살아 있다고 알림
    const now = Date.now();
    const startedLongAgo = now - GRACE * 10; // 시작한 지 grace 의 10배

    expect(
      shouldReleaseInFlight(key, startedLongAgo, GRACE, now),
      "★신호가 방금 왔는데 풀면, 일하는 중인 턴의 잠금을 놓는 것이다★",
    ).toBe(false);
  });

  test("★신호가 끊기면 그때부터 다시 센다★ — 한 번 살아있었다고 영원히 잡고 있지 않는다", () => {
    const key = inFlightKey("m-stopped", "hermes");
    forgetTurnAlive(key);
    noteTurnAlive("m-stopped", "hermes");
    const aliveAt = Date.now();

    expect(shouldReleaseInFlight(key, 0, GRACE, aliveAt + GRACE - 1), "아직 조용한 지 얼마 안 됐다").toBe(false);
    expect(shouldReleaseInFlight(key, 0, GRACE, aliveAt + GRACE + 1000), "★신호 이후로 grace 를 넘겼다★").toBe(true);
  });

  test("★생존신호와 자가치유가 같은 키를 쓴다★ (어긋나면 오류 없이 옛 동작이 된다)", () => {
    forgetTurnAlive(inFlightKey("m-key", "hermes"));
    noteTurnAlive("m-key", "hermes");
    const now = Date.now();
    const startedLongAgo = now - GRACE * 10;

    expect(
      shouldReleaseInFlight(inFlightKey("m-key", "hermes"), startedLongAgo, GRACE, now),
      "★같은 (메시지, 팀원) 으로 물어보면 방금 온 신호가 보여야 한다★",
    ).toBe(false);
    expect(
      shouldReleaseInFlight(inFlightKey("m-key", "steve"), startedLongAgo, GRACE, now),
      "다른 팀원의 키에는 그 신호가 없다 — 키가 실제로 구분된다",
    ).toBe(true);
  });

  test("★턴이 끝나면 신호 기록을 버린다★ (안 버리면 프로세스 수명 내내 자란다)", () => {
    const key = inFlightKey("m-done", "hermes");
    noteTurnAlive("m-done", "hermes");
    const now = Date.now();
    expect(shouldReleaseInFlight(key, now - GRACE * 10, GRACE, now), "버리기 전에는 신호가 산다").toBe(false);

    forgetTurnAlive(key);
    expect(
      shouldReleaseInFlight(key, now - GRACE * 10, GRACE, now),
      "★버린 뒤에는 시작 시각 기준으로 돌아간다★",
    ).toBe(true);
  });
});
