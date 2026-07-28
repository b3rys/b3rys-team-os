import { describe, expect, test } from "bun:test";
import { awaitingPollPlan, isPairingCodeWellFormed, shouldShowClaudePairingPanel } from "./Settings";

describe("Settings Claude pairing panel visibility", () => {
  test("shows only when the server reports a pending pairing input for a claude OT", () => {
    expect(shouldShowClaudePairingPanel("claude_channel", { kind: "claude_pairing_code" })).toBe(true);
    expect(shouldShowClaudePairingPanel("claude_channel", { kind: "telegram_plugin_pairing" })).toBe(true);
  });

  test("hides for joined or auto-inherited claude members without pending pairing state", () => {
    expect(shouldShowClaudePairingPanel("claude_channel", null)).toBe(false);
    expect(shouldShowClaudePairingPanel("claude_channel", { kind: "bot_token" })).toBe(false);
    expect(shouldShowClaudePairingPanel("openclaw", { kind: "claude_pairing_code" })).toBe(false);
  });
});

// ★폴링 정지 판정 (2026-07-28 · Demis 리뷰 + 하네스 2건이 독립 지적)★
//
// pollOt 는 `awaiting_input.fields?.length` 가 있으면 폴링을 멈춘다. 근거 주석은
// "서버는 제출 전엔 진행 안 함" 인데, ★그 전제는 봇 토큰 마커에만 참★ 이다.
// 페어링 마커는 access.json 에서 파생된 상태라 이 패널을 거치지 않고도 바뀐다
// (설치 동반자가 access.json 을 직접 편집해 승인 · promote-pending.sh 등).
// 그때 서버는 마커를 내리는데 폴링이 멈춰 있으면 ★화면이 코드 입력칸에 굳는다★ —
// 새로고침 전까지, 그리고 새로고침하라는 신호는 어디에도 없다.
// ★첫 claude 멤버는 access.json 이 페어링 대기로 시드되는 게 설계상 정상★ 이라
// 이 창은 클로드 코드 경로에서도 실제로 열린다.
describe("awaitingPollPlan — 어떤 마커가 폴링을 멈추나", () => {
  test("★페어링 마커는 폴링을 멈추지 않는다★ — 밖에서 승인되면 화면이 따라와야 한다", () => {
    expect(awaitingPollPlan({ kind: "claude_pairing_code" }).stopPolling).toBe(false);
  });

  test("봇 토큰 마커는 종전대로 멈춘다 — 제출로만 풀리는 상태다", () => {
    expect(awaitingPollPlan({ kind: "bot_token" }).stopPolling).toBe(true);
  });

  test("마커가 없으면 종전 동작", () => {
    expect(awaitingPollPlan(null).stopPolling).toBe(true);
    expect(awaitingPollPlan(undefined).stopPolling).toBe(true);
  });

  test("★패널마다 찾는 요소가 다르다★ — 틀리면 매 폴링마다 재렌더돼 입력칸이 날아간다", () => {
    expect(awaitingPollPlan({ kind: "claude_pairing_code" }).panelSelector).toBe("#ot-claude-pair-code");
    expect(awaitingPollPlan({ kind: "bot_token" }).panelSelector).toBe("#ot-provision-submit");
  });
});

// ★코드 형식 — 16진수 6자리다. 숫자 6자리가 아니다 (2026-07-28 적대적 하네스 발견).★
//
// 플러그인: randomBytes(3).toString('hex') → `a4f91c` 같은 값.
// 이 화면의 검사는 오래도록 /^\d{6}$/ (숫자만) 이었고 서버는 /^[a-f0-9]{6}$/ 로 받았다.
// ★클라이언트가 먼저 막아 POST 조차 안 나갔다★ — 글자가 하나도 안 섞일 확률 (10/16)^6 ≈ 6%,
// 즉 ★약 94% 의 사용자가 맞는 코드를 넣고도 "코드가 틀렸다" 를 본다.★
// 재요청도 안 통한다: 플러그인은 미만료 코드가 있으면 같은 코드를 다시 주고 DM 2회부터 침묵한다.
describe("isPairingCodeWellFormed — 코드는 16진수다", () => {
  test("★글자가 섞인 hex 를 받는다★ — 이게 실제로 오는 코드다", () => {
    expect(isPairingCodeWellFormed("a4f91c")).toBe(true);
    expect(isPairingCodeWellFormed("abcdef")).toBe(true);
    expect(isPairingCodeWellFormed("ffffff")).toBe(true);
  });

  test("숫자만인 코드도 받는다 — hex 의 부분집합이라 종전 동작 유지", () => {
    expect(isPairingCodeWellFormed("123456")).toBe(true);
  });

  test("대문자·공백은 정규화해서 받는다 — 서버가 소문자로 맞춘다", () => {
    expect(isPairingCodeWellFormed("A4F91C")).toBe(true);
    expect(isPairingCodeWellFormed("  a4f91c  ")).toBe(true);
  });

  test("hex 가 아닌 것은 거른다", () => {
    expect(isPairingCodeWellFormed("a4f91g")).toBe(false); // g 는 hex 아님
    expect(isPairingCodeWellFormed("a4f91")).toBe(false);  // 5자리
    expect(isPairingCodeWellFormed("a4f91cc")).toBe(false); // 7자리
    expect(isPairingCodeWellFormed("")).toBe(false);
  });
});
