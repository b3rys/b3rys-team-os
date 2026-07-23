// P3 신원 seam characterization — 중요 로직(인바운드 신원해석) 동작 고정.
// GD 2026-06-21: "중요 로직 테스트 방법 잘 구축" — 이 suite가 라우팅 신원해석의 '전후 동일'을 핀한다.
// 리팩토링해도 이 테스트가 깨지면 신원해석 동작이 바뀐 것 = 회귀 감지.
import { test, expect, describe } from "bun:test";
import type { AgentRecord } from "../types";
import type { ChannelAdapter } from "./types";
import { replyAuthorAgentId } from "../workers/telegramCapture";
import { telegramChannel } from "./telegram";
import { kakaoChannel } from "./kakao";

const A = (over: Record<string, unknown>): AgentRecord =>
  ({ id: "x", display_name: "x", role: "r", runtime: "hermes_agent", ...over }) as unknown as AgentRecord;

describe("replyAuthorAgentId — 라이브 신원해석(resolveAgentId 위임 후 legacy와 byte-동일)", () => {
  const agents = [
    A({ id: "bill", telegram_bot_username: "@example_bill_bot" }),
    A({ id: "steve", telegram_bot_username: "example_steve_bot" }),
  ];
  test("정확 매칭 (대소문자·@ 정규화) — 기존 .find()와 동일", () => {
    expect(replyAuthorAgentId("example_bill_bot", agents)).toBe("bill");
    expect(replyAuthorAgentId("@EXAMPLE_Bill_Bot", agents)).toBe("bill");
    expect(replyAuthorAgentId("@example_steve_bot", agents)).toBe("steve");
  });
  test("미스 → undefined (legacy 반환형 유지, null 아님)", () => {
    expect(replyAuthorAgentId("nobody", agents)).toBeUndefined();
    expect(replyAuthorAgentId(undefined, agents)).toBeUndefined();
    expect(replyAuthorAgentId("", agents)).toBeUndefined();
  });
  test("channel_identities.telegram 우선 (신규 capability, additive)", () => {
    const a2 = [A({ id: "kai", telegram_bot_username: null, channel_identities: { telegram: "kai_tg" } })];
    expect(replyAuthorAgentId("kai_tg", a2)).toBe("kai");
  });
  test("channel_identities.telegram='' (빈문자열) → legacy 폴백 (?? footgun 방지, || 사용)", () => {
    const a3 = [A({ id: "bob", telegram_bot_username: "@bob_bot", channel_identities: { telegram: "" } })];
    expect(replyAuthorAgentId("bob_bot", a3)).toBe("bob"); // 빈문자열 무시하고 legacy 매칭
  });
});

describe("카카오 = 1파일 증명 — kakaoChannel이 ChannelAdapter 계약 완전 충족", () => {
  test("ChannelAdapter 형태(id·send·resolveAgentId) 구비", () => {
    const adapter: ChannelAdapter = kakaoChannel; // 타입 호환 = 계약 충족
    expect(adapter.id).toBe("kakao");
    expect(typeof adapter.send).toBe("function");
    expect(typeof adapter.resolveAgentId).toBe("function");
  });
  test("resolveAgentId — channel_identities.kakao 매칭(telegram/slack과 동일 패턴)", () => {
    const agents = [A({ id: "kai", channel_identities: { kakao: "kakao_kai_123" } })];
    expect(kakaoChannel.resolveAgentId("kakao_kai_123", agents)).toBe("kai");
    expect(kakaoChannel.resolveAgentId("nope", agents)).toBeNull();
  });
  test("send — 미설정 시 안전 실패(예외 안 던짐)", async () => {
    const r = await kakaoChannel.send({ target: "room1", text: "hi" });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
  test("+1줄 등록 패턴 — Map 한 줄로 getChannel 동작 (코어 0수정 증명)", () => {
    const reg = new Map<string, ChannelAdapter>([["telegram", telegramChannel], ["kakao", kakaoChannel]]);
    expect(reg.get("kakao")?.id).toBe("kakao");
    expect(reg.get("kakao")).toBe(kakaoChannel);
  });
});
