// ★시스템 알림에 답하면 --to system 으로 가서 사라졌다★ (하네스 D1 — 2026-07-14)
//
// ★무엇이 조용히 깨져 있었나★
//   서버가 팀원에게 알림을 보낸다: from_agent_id = "system"
//     system → devon : "[카드 배정] mac앱 서명"
//     system → codex : "[마감] 지금 종합해서 보고하세요"
//   그런데 답 주소가 ★"보낸 사람에게"★ 로 정해져 있었다 → from 이 system 이니 ★--to system★.
//   ★system 은 사람이 아니다★ → message_recipient 행이 안 생긴다 → ★아무도 못 받는다.★
//   그런데 서버는 201 ok 를 돌려준다 → ★본인은 "보고했다", 아무도 못 받았다.★
//
//   ★실측(30일) 40건이 증발했다:★
//     devon "처리 완료: Devon 실행중 카드 2건(#41 mac앱 서명, #43 헬스오버레이) 상태 갱신했습니다"
//     codex "진단 완료: bill·dbak·demis·steve의 runtime blocked 원인 파악했습니다"
//     codex "완료 통과: 카드 2건 완료 처리했습니다"
//   ★전부 완료 보고다.★ 오늘 고친 단톡방 26% 유실과 ★같은 병, 두 번째 장소★.
//
// ★고침★: 알림은 ★자기가 누구 일인지 안다★ — meta.reply_to 로 실어 보낸다(추측 아님).
//   실을 게 없는 순수 통지는 ★"답할 곳이 없다" 고 사실대로 말한다★ — 없는 주소를 지어내지 않는다.
import { describe, expect, test } from "bun:test";
import { buildPrompt } from "../lib/hermesBridge";
import type { AgentRecord } from "../types";

const base = {
  agent: { id: "hermes", display_name: "Hermes" } as AgentRecord,
  threadId: "card-notify-devon",
  messageId: "MSGab12cd34",
  body: "[카드 배정] 카드 'mac앱 서명'",
  fromLabel: "system", // ★알림은 system 이 보낸다★
  locale: "ko" as const,
};
// ★2026-07-15 kind 전환★: 봉투는 이제 "답: send.sh …" 명령을 찍지 않는다. 대신 ★봉투 kind★ 를 싣고,
//   팀원이 AGENTS.md 룰로 주소를 정한다. system 알림에 reply_to 가 있으면 디스패처가 kind=teammate 로,
//   순수 통지면 kind=notice 로 넘긴다(resolveSystemReplyTo, 아래 배선 테스트). buildPrompt 는 그 kind 를 싣는다.
/** 봉투 kind 속성 */
const envKind = (p: string) => p.match(/<external_message[^>]*\bkind="([^"]*)"/)?.[1] ?? null;

describe("시스템 알림 — ★--to system 블랙홀★ (kind 로 표현)", () => {
  test("★카드 배정 → kind=teammate (배정한 사람에게 — system 이 아니라)★", () => {
    const p = buildPrompt({ ...base, replyRoute: { kind: "teammate", to: "bill" } });
    expect(envKind(p)).toBe("teammate");
    expect(p).not.toContain("--to system");
    expect(p).not.toContain("send.sh"); // 봉투는 주소 명령을 찍지 않는다
  });

  test("★마감 알림 → kind=teammate (수집을 시킨 사람에게)★", () => {
    const p = buildPrompt({ ...base, replyRoute: { kind: "teammate", to: "steve" } });
    expect(envKind(p)).toBe("teammate");
    expect(p).not.toContain("--to system");
  });

  test("★★순수 통지 → kind=notice (답할 주소를 지어내지 않는다)★★", () => {
    const p = buildPrompt({ ...base, replyRoute: { kind: "notice" } });
    expect(envKind(p)).toBe("notice"); // ★룰: kind=notice → about 없으면 안 보냄★
    expect(p).not.toContain("send.sh"); // 봉투에 send.sh 명령 자체가 없다
    expect(p).not.toContain("--to system");
    expect(p).not.toContain("--to undefined"); // 첫 시도에서 실제로 이게 나왔다
  });

  test("★어떤 경우에도 --to system 이 나오지 않는다★ (블랙홀 재발 방지)", () => {
    for (const r of [
      { kind: "teammate" as const, to: "bill" },
      { kind: "group" as const },
      { kind: "direct_to_gd" as const },
      { kind: "slack" as const },
      { kind: "notice" as const },
    ]) {
      const p = buildPrompt({ ...base, replyRoute: r });
      expect(p).not.toContain("--to system");
      expect(p).not.toContain("--to undefined");
    }
  });
});

// ★배선 자체를 테스트한다★ — 하네스 지적: "구조로 막는다는 배선에 테스트가 0"
//   주입문(buildPrompt)만 테스트하면 ★디스패처가 어느 분기를 고르는지는 아무도 안 본다.★
//   실제로 뮤테이션(디스패처가 다시 from_agent_id 를 쓰게 함)이 ★어떤 테스트에도 안 걸렸다.★
import { resolveSystemReplyTo } from "./wakeDispatcher";

describe("배선 — ★디스패처가 system 알림을 알아보나★", () => {
  test("★일반 팀원 메시지 → system 아님★ (기존 경로 그대로)", () => {
    expect(resolveSystemReplyTo({ from_agent_id: "steve", source: "agent" })).toEqual({ system: false });
  });

  test("★카드 배정 알림 → meta.reply_to(배정한 사람) 를 꺼낸다★", () => {
    const r = resolveSystemReplyTo({
      from_agent_id: "system",
      source: "system",
      meta_json: JSON.stringify({ reply_to: "bill", card_id: "42" }),
    });
    expect(r).toEqual({ system: true, replyTo: "bill" });
  });

  test("★★순수 통지(reply_to 없음) → null★★ — 없는 주소를 지어내지 않는다", () => {
    expect(resolveSystemReplyTo({ from_agent_id: "system", source: "system", meta_json: null })).toEqual({
      system: true,
      replyTo: null,
    });
  });

  test("meta_json 이 깨져도 죽지 않는다 (null 로 degrade)", () => {
    expect(resolveSystemReplyTo({ from_agent_id: "system", meta_json: "{깨진 json" })).toEqual({
      system: true,
      replyTo: null,
    });
  });

  test("★source='system' 만 있어도 알아본다★ (from 이 다른 경우)", () => {
    const r = resolveSystemReplyTo({ from_agent_id: "moderator", source: "system", meta_json: '{"reply_to":"steve"}' });
    expect(r).toEqual({ system: true, replyTo: "steve" });
  });
});
