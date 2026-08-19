import { test, expect, describe } from "bun:test";
import { tgFailureReason, tgEdit } from "./bridge";

/**
 * ★텔레그램이 왜 거절했는지를 남긴다.★
 *
 * 라이브에서 한 턴에 20번 넘게 편집이 막히는데 ★이유를 몰랐다★ —
 * 로그에 "재전송했다" 만 있었기 때문이다. rate limit · 글자 모양 · 내용 그대로,
 * 셋이 로그에서 같은 모양이면 ★고쳐도 고쳐졌는지 모른다.★
 */
describe("거절 사유 만들기", () => {
  test("★rate limit 이면 retry_after 가 보인다★ — 이게 있으면 한 번에 갈린다", () => {
    const r = tgFailureReason({ error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } });
    expect(r).toContain("429");
    expect(r).toContain("retry_after=7s");
  });

  test("글자 모양 문제면 그 문장이 그대로 보인다", () => {
    const r = tgFailureReason({ error_code: 400, description: "Bad Request: can't parse entities: ..." });
    expect(r).toContain("parse entities");
  });

  test("★내용이 그대로라 막힌 경우도 구별된다★ — 이건 사실 고칠 게 없는 경우다", () => {
    expect(tgFailureReason({ error_code: 400, description: "Bad Request: message is not modified" })).toContain("not modified");
  });

  test("★대조군 — 사유가 없으면 없다고 말한다★ (지어내지 않는다)", () => {
    expect(tgFailureReason({})).toContain("사유 없음");
  });
});

describe("편집 — 두 번 다 막히면 그 사실이 남는다", () => {
  const reply = (bodies: unknown[], results: object[]): typeof fetch =>
    (async (_u: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { json: async () => results[bodies.length - 1] ?? { ok: true } };
    }) as unknown as typeof fetch;

  test("한 번에 되면 재전송하지 않는다", async () => {
    const bodies: unknown[] = [];
    const edit = tgEdit("t", reply(bodies, [{ ok: true }]));
    expect(await edit(1, 2, "안녕")).toBe(true);
    expect(bodies).toHaveLength(1);
  });

  test("★1차가 막히면 표시를 걷고 한 번 더★", async () => {
    const bodies: any[] = [];
    const edit = tgEdit("t", reply(bodies, [{ ok: false, error_code: 400, description: "can't parse entities" }, { ok: true }]));
    expect(await edit(1, 2, "*굵게*")).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].parse_mode).toBe("MarkdownV2");
    expect(bodies[1].parse_mode, "2차는 표시를 걷는다").toBeUndefined();
  });

  test("★둘 다 막히면 false — 여기서 화면이 갈라진다★", async () => {
    const bodies: any[] = [];
    const edit = tgEdit("t", reply(bodies, [
      { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } },
      { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } },
    ]));
    expect(await edit(1, 2, "x")).toBe(false);
    expect(bodies).toHaveLength(2);
  });

  test("통신 자체가 터져도 던지지 않는다 — 표시가 턴을 죽이면 안 된다", async () => {
    const edit = tgEdit("t", (async () => { throw new Error("연결 끊김"); }) as unknown as typeof fetch);
    expect(await edit(1, 2, "x")).toBe(false);
  });
});
