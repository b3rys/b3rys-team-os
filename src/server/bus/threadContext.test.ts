/**
 * ★깨워진 스레드의 대화는 항상 받는다.★ (2026-07-13)
 *
 * ═══ 무엇이 잘못됐었나 ═══
 * `teamContextForAgent` 는 `full_context` capability 가 없는 팀원에게 ★빈 문자열★ 을 줬다.
 * ★hermes 에겐 그 권한이 없다.★ → 기여자 둘이 각각 답해도 hermes 는 ★자기를 깨운 한 건만★ 봤다.
 * → ★"현재 전달된 답변은 스티브 1건뿐"★ (hermes 가 실제로 한 말) → ★종합 불가.★
 *
 * ★codex 가 종합을 잘한 건 자가발신 때문만이 아니라 ★이 권한이 있어서★ 였다.★
 * → 즉 "종료 판단 실패" 는 ★기억 문제도, 런타임 문제도 아니었다.★ ★서버가 안 준 것이다.★
 *   (그래서 ★상시세션(tmux)이 유일한 해법★ 이라는 결론도 틀렸다 — 이 게이트가 원인이다)
 *
 * ═══ 왜 게이트를 없애지 않고 ★갈랐나★ ═══
 * 게이트가 두 가지를 한 덩어리로 막고 있었다:
 *   · `tg-` 그룹 스레드 = ★팀방 전체 대화★ → 광범위 가시성 → ★게이트가 맞다★ (유지)
 *   · 위임/과제 스레드   = ★자기가 참여 중인 그 대화★ → ★막을 이유가 없다★ (항상 준다)
 * 우리 룰도 그렇게 말한다: "버스 문맥은 ★네가 깨워진 스레드에 대해서만★ 온다."
 * ★그 최소한마저 안 주고 있었다.★
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "wakeDispatcher.ts"), "utf8");

/**
 * ★깨워진 스레드의 문맥은 ★전 팀원★ 에게, ★같은 형식★ 으로.★ (GD 2026-07-13: "그룹방도 풀면 안돼?")
 *
 * ═══ 예전 ═══
 *   그룹방(tg-) 문맥은 `full_context` capability 가 있는 3명(bill·steve·codex)만 봤다.
 *   나머지(hermes·ames·devon·lui·demis·dbak)는 ★대체 문맥★ 을 받았는데,
 *   그건 ★방향 표시도 '네가 보낸 것' 마커도 없는 옛 형식★ 이었다.
 *
 * ═══ 게이트를 걸 이유가 없었다 ═══
 *   · ★그룹방은 어차피 다 같이 있는 방이다.★ 그 방 사람에게 그 방 대화를 숨길 이유가 없다.
 *   · 토큰 부담? ★실측: 최근 12건 = 총 761자.★ 부담이 아니다.
 *   · 게이트에 걸린 팀원들이 ★오늘 고친 그 문제(자기 보고가 안 보임)를 그대로 갖고 있었다.★
 */
describe("★스레드 문맥 — 전 팀원, 같은 형식★", () => {
  it("★깨워진 스레드는 권한 게이트를 안 탄다★ (그룹방 포함 — GD 결정)", () => {
    expect(SRC).toContain("const teamContext = buildTeamContext(db, row.thread_id, row.agent_id);");
    // ★런타임·권한으로 갈라지지 않는다★ — 갈라지는 순간 누군가는 못 보고, 못 보면 룰을 못 지킨다
    expect(SRC).not.toContain("teamContextForAgent(row.agent_id, buildTeamContext");
    expect(SRC).not.toContain("buildOwnConversationContext");
  });

  it("★관점 인자를 넘긴다★ — 누구 눈으로 보는지 알아야 '네가 보낸 것' 을 표시한다", () => {
    expect(SRC).toContain("buildTeamContext(db, row.thread_id, row.agent_id)");
  });

  it("★스레드 밖은 여전히 안 준다★ — '깨워진 그 대화' 만이다 (팀 전체 가시성과는 다른 얘기)", () => {
    // B fix(2026-07-16): 여전히 threadId 스코프로만 조회한다(스레드 밖 안 줌). 단 그룹방이면 창을 좁힌다.
    expect(SRC).toContain("recentThreadMessages(db, threadId, fetchLimit, fetchHours)");
  });

  // ★2026-07-16 (GD "전부 5개, 분기 타지 말고"): 참고용 주입을 그룹·버스 통일 = 자기것만·5건★
  it("★자기것만 · 5건 통일★ — from=나 OR to=나, CTX_MSGS_OWN, count 분기 없음", () => {
    expect(SRC).toContain("m.from_agent_id === agentId || m.to_agent_id === agentId"); // 자기것 + 나에게 온 것
    expect(SRC).toContain("CTX_MSGS_OWN"); // 5건 통일 상수
    expect(SRC).not.toContain("CTX_MSGS_GROUP"); // 그룹/버스 count 분기 제거됨
    expect(SRC).toContain('resolveThreadKind(threadId) === "telegram_group"'); // 시간창(fetchHours)에만 남음
    expect(SRC).toContain("CTX_HOURS_GROUP"); // 그룹 6시간 창은 유지
  });
});

describe("★내가 이미 보낸 것이 눈에 띄는가★", () => {
  it("★방향을 표시한다★ — [너 → bill] / [dbak → 너] (누가 누구에게인지)", () => {
    expect(SRC).toContain('const who = (id: string | null | undefined): string => (id && id === agentId ? "너" : (id ?? "?"));');
  });

  it("★내 메시지에 마커를 붙인다★ — 나열에 묻히지 않게", () => {
    expect(SRC).toContain("const mine = m.from_agent_id === agentId;");
    expect(SRC).toContain('${mine ? "★" : " "}(${timeAgo(m.created_at)})[');   // ★마커 + 시각★
  });

  it("★내가 이미 한 일을 맨 아래 못박는다★ (읽다 놓치지 않게)", () => {
    expect(SRC).toContain("네가 이 스레드에서 이미 보낸 것");
    expect(SRC).toContain("같은 요청에 두 번 보고하지 마라");
  });

  it("★'물어본 사람' 을 지어내지 않는다★ — 수신자만으로는 질문/보고를 못 가른다", () => {
    // 요청자(bill)를 '이미 물어본 사람' 이라고 하면 ★그게 또 다른 거짓말이다★
    expect(SRC).not.toContain("이미 물어본 사람:");
  });
});

/**
 * ★문맥의 크기·잘림·빈 문맥 — 팀장이 세 가지를 다 짚었다.★ (GD 2026-07-13)
 *   "토큰비용이 크진 않겠지? 만약 6시간 메시지가 없으면? 메시지가 크면? 일단 그냥 붙이나?"
 *   ★셋 다 실재하는 문제였다.★
 */
describe("★문맥의 크기·잘림·빈 문맥★", () => {
  it("★24시간 넘으면 문맥 없음★ — 옛 대화를 붙이면 '지금 일' 로 착각한다 (GD 2026-07-13 결정)", () => {
    // ★내가 처음엔 반대로 했다★: "비면 나이 무시하고라도 준다".
    //   ★GD: "오래된걸 주면 안좋은거 아냐?" → 맞다.★ 3일 전 대화를 지금 일로 읽으면 엉뚱한 걸 실행한다.
    //   ★빈 문맥보다 나쁠 수 있다.★ 필요하면 팀원이 thread.sh 로 직접 꺼내 본다(능력은 이미 있다).
    expect(SRC).toContain("const CTX_HOURS = Number(process.env.CTX_HOURS ?? 24);");
    expect(SRC).not.toContain("recentThreadMessages(db, threadId, CTX_MSGS, 24 * 365)");   // ★폴백 없음★
  });

  it("★대신 '꺼내 보는 법' 을 한 줄로 알려준다★ (GD: \"찾아보는법은 간단히 한줄로\")", () => {
    expect(SRC).toContain("(더 이전 이력이 필요하면: thread.sh ${threadId})");
  });

  it("★모든 줄에 '언제인지' 를 붙인다★ — 없으면 3분 전인지 3일 전인지 모른다", () => {
    expect(SRC).toContain("${timeAgo(m.created_at)}");
  });

  it("★시각은 정본 함수로만★ (GD: \"시간 잘못쓰면 완전 꼬이니 붙이는 건 다 함수로 처리\")", () => {
    // DB 는 UTC. 손으로 파싱하면 KST 머신에서 ★정확히 9시간 거짓말★ 한다 (오늘 실제로 났다)
    expect(SRC).toMatch(/import \{ timeAgo(, toDbUtc)? \} from "\.\.\/lib\/timeAgo";/);
    expect(SRC).not.toMatch(/new Date\(m\.created_at\)/);
  });

  it("★잘리면 잘렸다고 말한다★ — 조용히 자르면 collector 는 그게 전부인 줄 안다", () => {
    // 실측: 200자 상한이 ★웹조사 답변(258자·219자)을 잘랐다★ → 출처 URL 이 날아간 채로 종합됐다
    expect(SRC).toMatch(/…\(잘림: 원문 \$\{full\.length\}자\)/);
    expect(SRC).toContain("const CTX_MSG_CHARS = Number(process.env.CTX_MSG_CHARS ?? 800);");
  });

  it("★전체 예산으로 폭주를 막는다★ (상한 없으면 언젠가 터진다)", () => {
    expect(SRC).toContain("const CTX_TOTAL_CHARS = Number(process.env.CTX_TOTAL_CHARS ?? 8000);");
    expect(SRC).toContain("if (budget - line.length < 0 && lines.length > 0) break;");
  });
});
