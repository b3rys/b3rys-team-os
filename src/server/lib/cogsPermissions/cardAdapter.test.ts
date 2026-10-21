import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subscribeCardAdapter } from "./cardAdapter";
import { createCogsPermissionEvents } from "./events";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup(ok = true) {
  const dir = mkdtempSync(join(tmpdir(), "cogs-card-"));
  dirs.push(dir);
  writeFileSync(join(dir, "flo.bot-token"), "TOKEN\n");
  const calls: Array<{ url: string; body: any }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 400 });
  }) as unknown as typeof fetch;
  const events = createCogsPermissionEvents(() => {});
  subscribeCardAdapter(events, { apiBaseOf: (id) => (id === "flo" ? "http://cogs" : null), tokenFileOf: (id) => join(dir, `${id}.bot-token`), fetchFn });
  return { events, calls };
}

const inv = (over: Record<string, unknown> = {}) => ({ type: "approval_invalidated" as const, request_id: "prm_1", agent_id: "flo", room_id: "42", card_message_id: 99, reason: "policy_narrowed", ...over });

test("무효가 되면 그 카드 버튼을 걷는다", async () => {
  const s = setup();
  s.events.emit(inv());
  await Bun.sleep(0);
  expect(s.calls).toEqual([{ url: "http://cogs/botTOKEN/editMessageReplyMarkup", body: { chat_id: "42", message_id: 99, reply_markup: { inline_keyboard: [] } } }]);
});

test("카드 id 를 모르거나 cogs 팀원이 아니면 아무것도 안 보낸다", async () => {
  const s = setup();
  s.events.emit(inv({ card_message_id: null }));
  s.events.emit(inv({ agent_id: "lisa" }));
  await Bun.sleep(0);
  expect(s.calls).toEqual([]);
});

test("걷기 실패해도 던지지 않는다(취소는 이미 저장됨)", async () => {
  const s = setup(false);
  expect(() => s.events.emit(inv())).not.toThrow();
  await Bun.sleep(0);
  expect(s.calls).toHaveLength(1);
});
