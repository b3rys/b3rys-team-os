import { afterEach, describe, expect, test } from "bun:test";
import type { AgentRecord } from "../types";
import { __setOpenclawBridgeTestDeps, injectOpenclawTelegramTurn } from "./openclawBridge";
import { clearRuntimeBlock } from "./runtimeBlocks";

const codex: AgentRecord = {
  id: "codex",
  display_name: "Codex",
  role: "Step",
  runtime: "openclaw",
  status_provider: "openclaw_gateway",
  tmux_session: null,
  telegram_bot_username: "example_openclaw_bot",
  workspace_path: "",
  persona_file: "",
  moderator_eligible: true,
  avatar_emoji: "",
};

const devon: AgentRecord = {
  ...codex,
  id: "devon",
  display_name: "Devon",
  telegram_bot_username: "example_devon_bot",
};

const originalToken = process.env.CODEX_TELEGRAM_BOT_TOKEN;
const originalDevonToken = process.env.DEVON_TELEGRAM_BOT_TOKEN;
const originalVisibleTimeout = process.env.OPENCLAW_VISIBLE_REPLY_TIMEOUT_MS;
const originalTimeoutNotice = process.env.OPENCLAW_TIMEOUT_NOTICE;

afterEach(() => {
  __setOpenclawBridgeTestDeps();
  // 실패 경로(injectOpenclawTelegramTurn catch)가 module-level runtimeBlocks Map에
  // codex/devon 블록을 남긴다 → 뒤 테스트 파일(statusProbe 등)로 누수. 좋은 시민: 정리.
  clearRuntimeBlock("codex");
  clearRuntimeBlock("devon");
  if (originalToken === undefined) delete process.env.CODEX_TELEGRAM_BOT_TOKEN;
  else process.env.CODEX_TELEGRAM_BOT_TOKEN = originalToken;
  if (originalDevonToken === undefined) delete process.env.DEVON_TELEGRAM_BOT_TOKEN;
  else process.env.DEVON_TELEGRAM_BOT_TOKEN = originalDevonToken;
  if (originalVisibleTimeout === undefined) delete process.env.OPENCLAW_VISIBLE_REPLY_TIMEOUT_MS;
  else process.env.OPENCLAW_VISIBLE_REPLY_TIMEOUT_MS = originalVisibleTimeout;
  if (originalTimeoutNotice === undefined) delete process.env.OPENCLAW_TIMEOUT_NOTICE;
  else process.env.OPENCLAW_TIMEOUT_NOTICE = originalTimeoutNotice;
  delete process.env.OPENCLAW_TURN_FAIL_GRACE_MS;
});

describe("injectOpenclawTelegramTurn visible reply bridge", () => {
  /**
   * ★[B] — 브릿지는 턴 본문을 ★게시하지 않는다.★★ (GD 2026-07-13: "팀원한테 맡겨. 다 빼.")
   *
   * ═══ 예전 계약 [A] (이 테스트가 지키던 것) ═══
   *   브릿지가 세션을 만들고 → 주입하고 → preview 로 ★게이트웨이가 뱉은 최종 텍스트를 긁어★ →
   *   ★그 팀원의 봇으로 단톡방에 대신 게시★했다 (sendMessage, reply_parameters 로 원본에 답글).
   *   즉 ★턴 본문 = 발행물★. codex 는 ★뭘 쓰든 나갔다.★
   *
   * ═══ 왜 뒤집혔나 ═══
   *   ★침묵이 불가능했다★ → `[NO_REPLY]` 우회 토큰 → 발행 지점마다 가드 → ★하나 놓침★ →
   *   ★"GD Step Codex: [NO_REPLY]" 가 팀장 단톡방에 문자 그대로 찍혔다★ (2026-07-13 라이브).
   *   그리고 수신자를 서버가 ★추측★ 했다 → 종합이 엉뚱한 사람에게 갔다.
   *
   * ═══ 지금 계약 [B] ═══
   *   브릿지는 ★나머지 전부★ 를 그대로 한다 (세션 생성 · 👀 리액션 · 주입 · preview 로 턴 완료 확인 · true 반환).
   *   ★단 하나, 턴 본문을 텔레그램에 게시하지 않는다.★ 말하려면 codex 가 자기 손으로 envelope API 로 보낸다.
   *   ★플랫폼 공지(턴 실패·지연)는 여전히 게시된다★ — 그건 팀원의 말이 아니라 ★시스템의 말★ 이기 때문이다
   *   (아래 failure/delay notice 테스트가 그걸 고정한다).
   */
  test("★세션 생성·리액션·주입·preview 는 그대로 — 그러나 턴 본문은 게시하지 않는다★ ([B] 자동게시 제거)", async () => {
    process.env.CODEX_TELEGRAM_BOT_TOKEN = "test-token";
    const openclawCalls: string[][] = [];
    const telegramCalls: Array<{ url: string; body: unknown }> = [];
    const events: string[] = [];

    __setOpenclawBridgeTestDeps({
      runOpenclawJson: async (args) => {
        openclawCalls.push(args);
        const method = args[0];
        events.push(`openclaw:${method}`);
        const params = JSON.parse(args[2] ?? "{}") as { message?: string };
        const stdout =
          method === "sessions.preview"
            ? {
                previews: [
                  {
                    items: [
                      {
                        role: "user",
                        text: `<external_message source="telegram" thread="tg--1009999999999" msg="router-2108">`,
                      },
                      { role: "assistant", text: "Codex sticky reply" },
                    ],
                  },
                ],
              }
            : { ok: true };

        if (method === "sessions.send") {
          // ★[A] 문구 = 사라졌다★ — "너는 보내지 마라, 브릿지가 대신 보낸다" 는 이제 codex 를 벙어리로 만든다
          expect(params.message).not.toContain("직접 message 도구를 호출하지 마세요");
          expect(params.message).not.toContain("브릿지가 최종 답변을 원본 Telegram 메시지의 reply 로 전송합니다");
          // ★[B] 불변식 + 배송처★ — 룰이 '어디로' 를 말 안 하면 LLM 은 턴 본문에 쓰고, 그건 아무 데도 안 간다
          expect(params.message).toContain("★말하려면 직접 보내세요. 안 보내면 아무 말도 안 한 것입니다.★");
          expect(params.message).toContain("당신의 메모일 뿐, 아무 데도 안 갑니다");
          expect(params.message).toContain("할 말이 없으면 그냥 안 보내면 됩니다"); // 침묵 = 안 보내기 (토큰 없음)
          expect(params.message).not.toContain("[NO_REPLY]");
          // 배송처 = 이 방의 thread id. 팀원이 알 수 없는 ★사실★ 이므로 주입문이 준다.
          // 보내는 ★법★(send.sh --to broadcast --thread) 은 룰(AGENTS.md)이 말한다 — 주입문은 반복하지 않는다.
          expect(params.message).toContain('thread="tg--1009999999999"');
          // ★두 번째 입구 금지 (GD 2026-07-14)★ — 예전 주입문은 envelope API(POST /team/api/inbox)를 안내해
          //   룰의 send.sh 와 입구가 둘이 됐다. 입구가 둘이면 언젠가 한쪽으로 샌다 → 회귀 가드.
          expect(params.message).not.toContain("api/inbox");
          expect(params.message).not.toContain("envelope API");
          // 첨부는 그대로 (자동게시 제거와 무관)
          expect(params.message).toContain("첨부 파일");
          expect(params.message).toContain("http://127.0.0.1:7878/team/media/tg-2108-photo.jpg");
        }

        return stdout;
      },
      fetch: (async (url, init) => {
        events.push(String(url).includes("setMessageReaction") ? "telegram:reaction" : "telegram:sendMessage");
        telegramCalls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });

    await expect(
      injectOpenclawTelegramTurn({
        agent: codex,
        groupId: "-1009999999999",
        threadId: "tg--1009999999999",
        messageId: "router-2108",
        body: "이번엔 sticky 테스트야. 누가 대답할까?",
        attachments: [
          {
            kind: "url",
            value: "http://127.0.0.1:7878/team/media/tg-2108-photo.jpg",
            note: "telegram photo",
          },
        ],
        fromLabel: "GD",
        origTgMessageId: "2108",
      }),
    ).resolves.toBe(true);

    // ★브릿지의 나머지 일은 전부 그대로다★ — 세션 생성 → 주입 → preview(턴 완료 확인)
    expect(openclawCalls.map((args) => args[0])).toEqual([
      "sessions.create",
      "sessions.send",
      "sessions.preview",
    ]);
    expect(events).toEqual([
      "openclaw:sessions.create",
      "telegram:reaction",   // 👀 = "받았다" 신호. 이건 팀원의 ★말★ 이 아니라 수신 확인이라 유지.
      "openclaw:sessions.send",
      "openclaw:sessions.preview",
    ]);

    // ★★핵심: 텔레그램 호출은 리액션 ★하나뿐★ 이다.★★
    //   preview 가 "Codex sticky reply" 를 읽어냈지만 ★서버는 그걸 게시하지 않는다★ — 그건 codex 의 메모다.
    //   말하려면 codex 가 직접 POST /team/api/inbox (to=broadcast) 로 보낸다 → routes/inbox.ts 가 릴레이한다.
    expect(telegramCalls).toEqual([
      {
        url: "https://api.telegram.org/bottest-token/setMessageReaction",
        body: {
          chat_id: "-1009999999999",
          message_id: 2108,
          reaction: [{ type: "emoji", emoji: "👀" }],
        },
      },
    ]);
    // 회귀 가드(명시): 턴 본문이 sendMessage 로 새어나가면 ★[NO_REPLY] 사고가 그대로 재현된다★
    expect(
      telegramCalls.filter((c) => c.url.includes("/sendMessage")),
      "★서버가 codex 의 턴 본문을 대신 게시했다★ — [A] 회귀. 침묵이 다시 불가능해지고 우회 토큰이 팀장방에 찍힌다.",
    ).toEqual([]);
    expect(JSON.stringify(telegramCalls)).not.toContain("Codex sticky reply");
  });

  test("finds the assistant reply when tool output pushes the user marker out of a tiny preview", async () => {
    process.env.CODEX_TELEGRAM_BOT_TOKEN = "test-token";
    const previewParams: Array<{ limit?: number; maxChars?: number }> = [];

    __setOpenclawBridgeTestDeps({
      runOpenclawJson: async (args) => {
        const method = args[0];
        if (method === "sessions.preview") {
          const params = JSON.parse(args[2] ?? "{}") as { limit?: number; maxChars?: number };
          previewParams.push(params);
          return {
            previews: [
              {
                items: [
                  {
                    role: "user",
                    text: `<external_message source="telegram" thread="tg--1009999999999" msg="router-tool-heavy">`,
                  },
                  ...Array.from({ length: 20 }, (_, i) => ({
                    role: "tool",
                    text: `tool output ${i}`,
                  })),
                  { role: "assistant", text: "Tool-heavy Codex reply" },
                ],
              },
            ],
          };
        }
        return { ok: true };
      },
      fetch: (async (_url, _init) =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch,
    });

    await expect(
      injectOpenclawTelegramTurn({
        agent: codex,
        groupId: "-1009999999999",
        threadId: "tg--1009999999999",
        messageId: "router-tool-heavy",
        body: "도구를 많이 쓰는 응답 테스트",
        fromLabel: "GD",
        origTgMessageId: "2110",
      }),
    ).resolves.toBe(true);

    expect(previewParams[0]?.limit).toBeGreaterThanOrEqual(80);
    expect(previewParams[0]?.maxChars).toBeGreaterThanOrEqual(24000);
  });

  test("does not post a visible delay notice on plain timeout by default", async () => {
    process.env.DEVON_TELEGRAM_BOT_TOKEN = "test-token";
    const telegramCalls: Array<{ url: string; body: unknown }> = [];

    __setOpenclawBridgeTestDeps({
      runOpenclawJson: async (args) => {
        const method = args[0];
        if (method === "sessions.preview") {
          throw new Error("openclaw response timeout");
        }
        return { ok: true };
      },
      fetch: (async (url, init) => {
        telegramCalls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });

    await expect(
      injectOpenclawTelegramTurn({
        agent: devon,
        groupId: "-1009999999999",
        threadId: "tg--1009999999999",
        messageId: "router-timeout",
        body: "timeout test",
        fromLabel: "GD",
        origTgMessageId: "2111",
      }),
    ).resolves.toBe(false);

    const notice = telegramCalls.find((call) => call.url.includes("/sendMessage"));
    expect(notice).toBeUndefined();
  });

  test("posts an agent-specific visible delay notice when timeout notices are explicitly enabled", async () => {
    process.env.DEVON_TELEGRAM_BOT_TOKEN = "test-token";
    process.env.OPENCLAW_TIMEOUT_NOTICE = "1";
    const telegramCalls: Array<{ url: string; body: unknown }> = [];

    __setOpenclawBridgeTestDeps({
      runOpenclawJson: async (args) => {
        const method = args[0];
        if (method === "sessions.preview") {
          throw new Error("openclaw response timeout");
        }
        return { ok: true };
      },
      fetch: (async (url, init) => {
        telegramCalls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });

    await expect(
      injectOpenclawTelegramTurn({
        agent: devon,
        groupId: "-1009999999999",
        threadId: "tg--1009999999999",
        messageId: "router-timeout",
        body: "timeout test",
        fromLabel: "GD",
        origTgMessageId: "2111",
      }),
    ).resolves.toBe(false);

    const notice = telegramCalls.find((call) => call.url.includes("/sendMessage"))?.body as { text?: string; reply_parameters?: { message_id?: number } } | undefined;
    expect(notice?.text).toContain("Devon 응답이 지연");
    expect(notice?.text).not.toContain("Codex 응답");
    expect(notice?.text).not.toContain("이어서 새 메시지");
    expect(notice?.reply_parameters?.message_id).toBe(2111);
  });

  // B (2026-06-13): 확정된 죽은 턴(session status=failed, 본문 없음)은 침묵하지 않고 visible notice 를 띄운다.
  test("posts a visible failure notice when the turn dies (session status=failed, no assistant text)", async () => {
    process.env.CODEX_TELEGRAM_BOT_TOKEN = "test-token";
    process.env.OPENCLAW_TURN_FAIL_GRACE_MS = "0"; // 테스트 즉시 terminal-failed 인정
    const telegramCalls: Array<{ url: string; body: { text?: string } }> = [];

    __setOpenclawBridgeTestDeps({
      runOpenclawJson: async (args) => {
        const method = args[0];
        if (method === "sessions.preview") {
          // user 마커는 있지만 assistant 본문이 끝까지 안 나온다 = 죽은 턴.
          return {
            previews: [
              {
                items: [
                  {
                    role: "user",
                    text: `<external_message source="telegram" thread="tg--1009999999999" msg="router-dead">`,
                  },
                ],
              },
            ],
          };
        }
        if (method === "sessions.describe") {
          return { session: { status: "failed", abortedLastRun: false } };
        }
        return { ok: true };
      },
      fetch: (async (url, init) => {
        telegramCalls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9001 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });

    await expect(
      injectOpenclawTelegramTurn({
        agent: codex,
        groupId: "-1009999999999",
        threadId: "tg--1009999999999",
        messageId: "router-dead",
        body: "이 작업은 idle timeout 으로 죽는다",
        fromLabel: "GD",
        origTgMessageId: "2112",
      }),
    ).resolves.toBe(false);

    const notice = telegramCalls.find((call) => call.url.includes("/sendMessage"));
    expect(notice).toBeDefined();
    expect(notice?.body.text).toContain("중단됐습니다");
    expect(notice?.body.text).toContain("failed");
  });
});
