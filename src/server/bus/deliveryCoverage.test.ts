/**
 * ★계약: 에이전트의 턴 답변을 내보내는 ★모든★ 통로는 배달 기록을 남긴다.★ (2026-07-12)
 *
 * ■ 왜 이 테스트가 있나 — ★내가 통로를 안 셌다★
 * 배달 기록을 만들 때 나는 ʼwakeDispatcherʼ 3곳에 배선하고 "됐다"고 했다. ★틀렸다.★
 *   · ★telegramCapture★ — 팀장이 단톡방에서 부르면 ★여기가 직접 주입★한다. wakeDispatcher 를 안 지난다.
 *     → 팀장이 hermes 를 불렀고, hermes 가 답했고, ★배달 기록은 0건★ 이었다.
 *   · ★slack.ts★ · ★codex adapter★ · ★b3osNative adapter★ — 세어보니 전부 자기 손으로 답을 내보내고 있었다.
 * ★"관측할 수 없으면 검증할 수 없다"를 증명한 코드가, 정작 ★자기 통로를 안 셌다.★★
 *
 * 이 팀이 하루에 ★여섯 번★ 같은 실수를 했다: persona "단일 통로" · 기여자답 "ingress 하나" ·
 * 깨우기 "8곳" · 팬아웃 "자동전파" · slack "2곳" · 그리고 ★배달기록 "wakeDispatcher 3곳"★.
 * ★전부 "세어보지 않고 단정" 이었다. 그래서 세는 걸 테스트로 강제한다.★
 *
 * ■ 이 테스트가 하는 일
 * 에이전트의 답을 내보내는 코드는 반드시 다음 중 하나를 지난다:
 *   · ʼinsertMessage(...)ʼ 로 버스에 답을 넣거나
 *   · 채널(텔레그램)로 직접 게시하거나
 * ★그런 파일은 반드시 ʼrecordReportDeliveryʼ(또는 ʼonDeliveredʼ 훅)를 갖고 있어야 한다.★
 * 새 런타임·새 통로를 추가하면 ★이 테스트가 즉시 빨개진다.★
 *
 * ■ ★이 테스트가 증명하지 ★못하는★ 것 (정직하게)★
 * ★에이전트가 서버를 거치지 않고 자기 손으로 보내면 서버는 아무것도 모른다.★
 *   · claude(tmux) 는 자기 reply 도구로 텔레그램에 직접 답한다 → ★배달 기록이 구조적으로 불가능하다.★
 *   · ★상시세션으로 전환하면 세 런타임 모두 이 상태가 된다★ — 오늘 확인됐다.
 * → ★그때는 "발신 도구가 서버를 거친다" 를 강제하지 않으면 우리는 다시 눈을 감는다.★
 *   그건 코드가 아니라 ★설계 요구사항★ 이라 이 테스트로는 못 잡는다. ★못 잡는 걸 잡는다고 하지 않는다.★
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(SRC, p), "utf-8");

/**
 * ★에이전트의 턴 답변을 내보내는 파일 (registry).★
 * 새 런타임/새 통로를 추가하면 ★여기에도 추가해야 한다★ — 그리고 배달 기록을 배선해야 한다.
 * (이 목록 자체가 "통로를 세었다"는 증거다. ★"하나뿐"이라고 쓰기 전에 세라.★)
 */
const OUTBOUND_FILES = [
  // ★[B] 전환 (GD 2026-07-13: "팀원한테 맡겨. 다 빼.")★
  //   ★서버가 팀원 대신 말하던 통로(자동 게시)를 전부 걷어냈다.★ 그래서 이 목록이 ★줄었다.★
  //   남은 건 ★팀원이 자기 발신 도구로 보낸 것을 서버가 릴레이하는 통로★ 뿐이다.
  //   (예전 목록: wakeDispatcher · openclawBridge · telegramCapture · slack · codex · b3osNative — 6개가
  //    전부 ★턴 본문을 대신 게시★ 했다. 그게 [NO_REPLY] 와 오배송의 근원이었다.)
  "routes/inbox.ts",                // ★[B] 정본★ — send.sh → POST /inbox → 버스 + 텔레그램(방/팀장DM) + 슬랙 릴레이
  // 아래 둘은 ★팀원의 턴 본문은 더 이상 게시하지 않는다★ — 그 팀원 봇으로 ★플랫폼 공지★(턴 실패·지연)만 내보낸다.
  //   공지도 그 팀원 이름으로 나가므로 여전히 '내보내는 통로' 다 → 배달 기록 배선 대상.
  "bus/wakeDispatcher.ts",          // 공지: 만료 통지 등
  "lib/openclawBridge.ts",          // 공지: 턴 실패·지연 notice
  "runtimes/b3osNative/adapter.ts", // ⚠️ 아직 [A] — 이 런타임엔 발신 도구가 없다(팀원 0명). 도구 추가 후 전환
];

describe("★계약★ 에이전트 답을 내보내는 모든 통로는 배달 기록을 남긴다", () => {
  test("★registry 의 모든 통로가 배달 기록을 배선했다★ (하나라도 빠지면 그 경로는 서버에 안 보인다)", () => {
    for (const f of OUTBOUND_FILES) {
      const src = read(f);
      const wired = src.includes("recordReportDelivery(") || src.includes("onDelivered");
      expect(
        wired,
        `★${f} 가 에이전트 답을 내보내는데 배달 기록이 없다★ — 이 경로로 나간 답은 ★서버에 기록이 0건★ 이다.\n` +
          `  그러면 "종합이 팀장께 갔나 / 답이 담겼나" 를 ★영영 검증할 수 없다.★ (실제로 telegramCapture 가 그랬다)`,
      ).toBe(true);
    }
  });

  // ★역방향 가드 — 이게 진짜 방지선이다.★
  //   새 파일이 에이전트 답을 내보내기 시작했는데 registry 에 없으면 ★조용히 샌다.★
  //   그래서 "답을 내보내는 코드"를 소스에서 ★기계적으로 찾아★ registry 와 대조한다.
  test("★★registry 밖에서 에이전트 답을 내보내는 통로가 없다★★ (일곱 번째를 막는 장치)", () => {
    // 에이전트가 발신자인 insertMessage = 그 에이전트의 답이 나간 것
    const CANDIDATES = [
      "bus/wakeDispatcher.ts", "lib/openclawBridge.ts", "workers/telegramCapture.ts", "routes/slack.ts",
      "runtimes/codex/adapter.ts", "runtimes/b3osNative/adapter.ts",
      // 아래는 에이전트 답이 아니어야 한다(사람/시스템 발원). 하나라도 에이전트 답을 내보내면 잡힌다.
      "routes/inbox.ts", "routes/tasks.ts", "routes/proposals.ts", "routes/approvals.ts", "routes/portal.ts",
    ];
    const offenders: string[] = [];
    for (const f of CANDIDATES) {
      let src: string;
      try { src = read(f); } catch { continue; }
      // 'from_agent_id: <에이전트 변수>' 로 insertMessage 하는가 (= 에이전트의 답)
      const emitsAgentReply =
        /insertMessage\([^)]*?from_agent_id:\s*(targetAgentId|targetAgent\.id|agent\.id|id)\b/s.test(src) ||
        /getChannel\("telegram"\)[\s\S]{0,120}\.send\(/.test(src) ||
        /postTelegramAsOpenclaw\(/.test(src);
      if (!emitsAgentReply) continue;
      const wired = src.includes("recordReportDelivery(") || src.includes("onDelivered");
      if (!wired) offenders.push(f);
      // 내보내는데 registry 에 없으면 그것도 위반이다
      if (!OUTBOUND_FILES.includes(f)) offenders.push(`${f} (registry 누락)`);
    }
    expect(
      offenders,
      `★에이전트 답을 내보내는데 배달 기록이 없거나 registry 에 없는 통로★:\n  ${offenders.join("\n  ")}\n` +
        `★"세어보지 않고 단정" — 오늘 여섯 번 당한 그것이다. 세라.★`,
    ).toEqual([]);
  });

  // ★[B] 회귀 가드 — 서버가 다시 팀원 대신 말하기 시작하면 잡는다.★
  //   ★이게 오늘 배운 것이다★: 서버가 대신 말하는 순간 침묵이 불가능해지고, 우회로(토큰)가 생기고,
  //   그 우회로가 팀장 단톡방에 새어 나온다. ★한 번 걷어냈으면 다시 들어오면 안 된다.★
  test("★★서버는 팀원 대신 말하지 않는다★★ (자동 게시가 되살아나면 빨개진다)", () => {
    const MIGRATED = [
      "bus/wakeDispatcher.ts", "lib/openclawBridge.ts", "workers/telegramCapture.ts", "runtimes/codex/adapter.ts",
    ];
    const offenders: string[] = [];
    for (const f of MIGRATED) {
      const src = read(f);
      // 턴 본문(reply/result.reply)을 그 팀원 이름으로 버스에 넣거나 텔레그램에 게시하면 위반이다
      if (/insertMessage\([\s\S]{0,300}?body:\s*(reply|result\.reply)\b/.test(src)) offenders.push(`${f} (턴 본문을 버스에 게시)`);
      if (/postTelegramAs(Hermes|Openclaw)\(\s*\w+,\s*\w+,\s*reply\b/.test(src)) offenders.push(`${f} (턴 본문을 텔레그램에 게시)`);
    }
    expect(
      offenders,
      `★서버가 팀원의 턴 본문을 대신 게시하고 있다★:\n  ${offenders.join("\n  ")}\n\n` +
        `★불변식: "보낸 것만 말한 것이다."★ 턴 본문은 그 팀원의 메모다 — 말하려면 팀원이 직접 보낸다.\n` +
        `  이걸 되돌리면 ★침묵이 다시 불가능해지고★, [NO_REPLY] 같은 우회로가 필요해지고,\n` +
        `  그 우회로가 ★팀장 단톡방에 그대로 찍힌다★ (2026-07-13 실제로 일어난 일).`,
    ).toEqual([]);
  });

  test("★통로 수를 고정한다★ — 늘어나면 이 테스트가 알려준다 (그때 배달기록을 배선하라)", () => {
    expect(OUTBOUND_FILES).toHaveLength(4);
  });
});
