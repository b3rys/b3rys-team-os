/**
 * reply-guard 는 ★1:1 텔레그램 DM 만★ 지킨다. 단톡방에는 관여하지 않는다.
 *
 * 단톡방은 답하는 방법이 다르다 — `send.sh --to broadcast` 다. 가드가 "reply 로 보내라" 고 막으면
 * 시키는 대로 한 봇이 ★자기 글을 방에 올리고 캡처가 못 봐서 기록이 0건★ 이 된다.
 *
 * ★1:1 방어가 죽는 것이 단톡방 오탐보다 훨씬 나쁘다★ — 퍼블릭 사용자는 주로 1:1 을 쓴다.
 * 그래서 2번 케이스(1:1 + 미전송 → 여전히 막힘)가 이 파일의 핵심이다.
 *
 * ★훅을 실제로 실행해서 잰다★ — 소스 문자열이 아니라 exit 출력으로 판정한다.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "reply-guard.py");
const GROUP_CHAT = "-1009999999999"; // 텔레그램 그룹은 음수
const DM_CHAT = "9999999999";        // 1:1 은 양수

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  dirs = [];
});

/** transcript(jsonl)를 만들고 훅을 돌린다. 반환: block 이면 true. */
function guardBlocks(events: unknown[]): boolean {
  const dir = mkdtempSync(join(tmpdir(), "b3os-guard-"));
  dirs.push(dir);
  const tp = join(dir, "transcript.jsonl");
  writeFileSync(tp, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const out = execFileSync("python3", [HOOK], {
    input: JSON.stringify({ transcript_path: tp }),
    encoding: "utf-8",
  });
  return out.includes('"block"');
}

const userTurn = (chatId: string) => ({
  type: "user",
  message: {
    role: "user",
    content: `<channel source="plugin:telegram:telegram" chat_id="${chatId}" message_id="1" user="gd">테스트</channel>`,
  },
});

/** send.sh 로 답한 턴 — Bash 툴콜이지 reply 툴콜이 아니다. */
const answeredViaSendSh = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", name: "Bash", input: { command: "send.sh --to broadcast --thread tg--1 --body '답'" } }],
  },
};

const answeredViaReply = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", name: "mcp__plugin_telegram_telegram__reply", input: { text: "답" } }],
  },
};

const answeredOnlyInTranscript = {
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "답을 여기에만 썼다" }] },
};

describe("reply-guard 는 1:1 만 지킨다", () => {
  test("① 단톡방 글 + send.sh 로 답 → ★통과★ (예전엔 막혔다)", () => {
    expect(guardBlocks([userTurn(GROUP_CHAT), answeredViaSendSh])).toBe(false);
  });

  test("② ★1:1 글 + 아무것도 안 보냄 → 여전히 막힌다★ (이 방어가 죽으면 안 된다)", () => {
    expect(guardBlocks([userTurn(DM_CHAT), answeredOnlyInTranscript])).toBe(true);
  });

  test("③ 1:1 글 + reply 로 보냄 → 통과", () => {
    expect(guardBlocks([userTurn(DM_CHAT), answeredViaReply])).toBe(false);
  });

  test("④ ★1:1 인데 send.sh 로만 답한 것은 답이 아니다★ — 여전히 막힌다", () => {
    // 1:1 DM 은 reply 툴콜만 도달한다. send.sh 는 그 방에 안 간다.
    expect(guardBlocks([userTurn(DM_CHAT), answeredViaSendSh])).toBe(true);
  });

  test("⑤ 단톡방 글 + 아무것도 안 보냄 → 통과 (오너 아니면 침묵이 정상)", () => {
    expect(guardBlocks([userTurn(GROUP_CHAT), answeredOnlyInTranscript])).toBe(false);
  });

  test("⑥ ★chat_id 를 못 읽으면 1:1 로 친다★ — 모를 땐 1:1 방어 쪽으로 기운다", () => {
    const noChatId = {
      type: "user",
      message: { role: "user", content: `<channel source="plugin:telegram:telegram" message_id="1">테스트</channel>` },
    };
    expect(guardBlocks([noChatId, answeredOnlyInTranscript])).toBe(true);
  });
});
