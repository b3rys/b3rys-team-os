import { describe, expect, test } from "bun:test";
import { isTeammateDirected } from "./wakeDispatcher";

/**
 * ★팀원끼리 보낸 메시지는 꼬리표가 무엇이든 버스로 답해야 한다 (2026-07-12).★
 *
 * 버그: "답을 어디에 쓸지" 를 ★thread 이름(tg- 접두사)★ 으로 정했다. 그런데 텔레그램에서 시작된 대화는
 * 전부 tg- 를 달고, ★그 꼬리표가 재위임을 따라다닌다.★ → 팀장이 단톡방에서 시킨 일을 빌이 스티브에게
 * 재위임하면 스티브는 ★"단톡방에 답해라"★ 로 지시되고, ★봇이 방에 올린 답은 캡처가 무시해 증발한다.★
 * 라이브 실측: 팀 단톡방 thread 의 팀원간 directed 메시지 ★155건★ 이 이 경로를 탔다.
 *
 * [버그 재현법] wakeDispatcher 의 3곳(source 매핑 · openclaw 분기 · hermes surface)에서
 *   isTeammateDirected 를 isCollectFanout 으로 되돌리거나 조건을 지우면 아래가 빨개진다.
 */
const row = (o: Partial<Record<string, unknown>>) =>
  ({ source: "agent", to_agent_id: "steve", thread_id: "tg--100394", meta_json: null, ...o }) as never;

describe("라우팅 판정 — 팀원간 directed 는 버스로", () => {
  test("★팀원 → 팀원 (그룹 발원 thread) → 버스★  ← 이게 fix", () => {
    expect(isTeammateDirected(row({ source: "agent", to_agent_id: "steve", thread_id: "tg--100394" }))).toBe(true);
  });

  test("팀원 → 팀원 (일반 thread) → 버스 (기존 유지)", () => {
    expect(isTeammateDirected(row({ source: "agent", to_agent_id: "steve", thread_id: "task-42" }))).toBe(true);
  });

  test("★팀장 → 팀원 (telegram) → 그룹 경로 유지★  ← 회귀 0 이어야 한다", () => {
    expect(isTeammateDirected(row({ source: "user", to_agent_id: "bill", thread_id: "tg--100394" }))).toBe(false);
  });

  test("★broadcast (공지) → 그룹 게시 유지★  ← 모두가 봐야 하는 것", () => {
    expect(isTeammateDirected(row({ source: "agent", to_agent_id: "broadcast", thread_id: "tg--100394" }))).toBe(false);
  });

  // ★2026-07-13 계약 변경★ — 옛 테스트는 "system → 그룹 경로 유지" 를 고정했다.
  //   ★그건 요구사항이 아니라 그때 코드가 그랬을 뿐이다.★ 그리고 그게 버그였다:
  //   [마감]·[전달 실패] 같은 시스템 알림이 ★단톡방에 그대로 게시됐다★ (팀장이 그 노이즈를 봤다).
  //   ★그 알림은 그 팀원에게만 하는 말이다.★ 팀장 방에 뿌릴 내용이 아니다.
  test("★system 알림도 특정 팀원에게 가면 directed★ — 단톡방에 게시하지 않는다", () => {
    expect(isTeammateDirected(row({ source: "system", to_agent_id: "bill", thread_id: "tg--100394" }))).toBe(true);
  });

  test("★system broadcast 는 여전히 그룹 게시★ (모두가 봐야 하는 공지)", () => {
    expect(isTeammateDirected(row({ source: "system", to_agent_id: "broadcast", thread_id: "tg--100394" }))).toBe(false);
  });

  test("★팀장(user) 대상 메시지는 directed 가 아니다★ — 채널 경로 그대로", () => {
    expect(isTeammateDirected(row({ source: "system", to_agent_id: "user", thread_id: "tg--100394" }))).toBe(false);
  });

  test("★--collect 와 무관하다★ — 그게 반창고였다는 증거", () => {
    // 예전엔 meta.collect 가 붙어야만 버스로 갔다. 이제는 붙든 안 붙든 팀원간 directed 면 버스다.
    const withCollect = row({ meta_json: JSON.stringify({ collect: true }) });
    const without = row({ meta_json: null });
    expect(isTeammateDirected(withCollect)).toBe(true);
    expect(isTeammateDirected(without)).toBe(true); // ★이게 예전엔 false 경로로 샜다★
  });
});

/**
 * ★--direct-to-gd 는 "팀원간 directed" 라도 팀장께 나가야 한다 (Steve 가 라이브에서 잡은 회귀).★
 *
 * 내 라우팅 fix 는 "팀원간 directed 의 답은 그룹에 게시하지 않는다" 를 넣었다. 그건 옳다.
 * 그런데 ★hermes 의 팀장 DM 릴레이가 바로 그 게시 함수(surfaceReplyOnChannel)로 구현돼 있었다.★
 * → 팀원이 보낸 --direct-to-gd 위임의 보고가 ★통째로 막혔다.★
 * → audit 엔 "message_sent to=direct_to_gd" 라고 찍히는데 ★실제로는 아무 데도 안 갔다.★
 *
 * ★"함수호출의 리턴값"(그룹에 안 올린다)과 "팀장께 내는 명시적 보고"(반드시 나간다)는 성격이 다르다.★
 *
 * [버그 재현법] wakeDispatcher 의 `|| hermesDirectToGd` 를 지우면 hermes 의 팀장 보고가 증발한다.
 *   (배달기록 audit 에 report_delivered 가 0건이 된다 — 그게 이 회귀의 지문이다)
 */
describe("--direct-to-gd 는 막히면 안 된다", () => {
  test("팀원간 directed 여도 --direct-to-gd 면 팀장께 나간다", () => {
    // isTeammateDirected 는 참이지만(팀원→팀원), direct_to_gd 면 게시(=DM 릴레이)를 해야 한다.
    const r = row({ source: "agent", to_agent_id: "hermes", thread_id: "task-9",
                    meta_json: JSON.stringify({ reply_mode: "direct_to_gd" }) });
    expect(isTeammateDirected(r)).toBe(true);   // 팀원간 directed 인 것은 맞고
    // → 그래서 코드가 `!isTeammateDirected(row) || hermesDirectToGd` 로 예외를 둬야 한다.
    //   (여기서는 판정 함수만 검증. 실제 분기는 라이브 comm-suite 의 individual 케이스가 지킨다)
  });
});
