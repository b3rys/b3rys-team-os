// 팀원별 채널(kind·api_base·allow_from·owner_chat) — 기본값·검증·그룹 판정·wrapper env.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_CHANNEL, TELEGRAM_API_BASE, channelEnvLines, channelFromEnv, isGroupChat, parseMemberChannel, readMemberChannel,
} from "./memberChannel";
import { codexBridgePaths, renderLaunchWrapper } from "../runtimes/codex/launcher";

function registry(agents: unknown[]): string {
  const p = join(mkdtempSync(join(tmpdir(), "b3os-chan-")), "agents.json");
  writeFileSync(p, JSON.stringify({ agents }));
  return p;
}

describe("isGroupChat — 텔레그램 type 은 private/group/supergroup/channel", () => {
  // ★회귀 고정★ — 팀 그룹방은 supergroup(-100…)이다. `=== "group"` 이면 이게 DM 으로 샌다.
  test("텔레그램 supergroup(-100…) → 그룹", () => expect(isGroupChat({ id: -1001234567890, type: "supergroup" })).toBe(true));
  test("텔레그램 group(음수) → 그룹", () => expect(isGroupChat({ id: -4567, type: "group" })).toBe(true));
  test("텔레그램 private(양수) → 그룹 아님", () => expect(isGroupChat({ id: 7066867819, type: "private" })).toBe(false));
  test("channel → 그룹(private 가 아니면 그룹)", () => expect(isGroupChat({ id: -100999, type: "channel" })).toBe(true));
  test("b3chat 그룹은 방 id 가 양수다 → type 으로 그룹", () => expect(isGroupChat({ id: 42, type: "group" })).toBe(true));
  test("b3chat 1:1 방(양수 private) → 그룹 아님", () => expect(isGroupChat({ id: 42, type: "private" })).toBe(false));
  test("type 이 없으면 예전 판정(음수 = 그룹)", () => {
    expect(isGroupChat({ id: -5 })).toBe(true);
    expect(isGroupChat({ id: 5 })).toBe(false);
    expect(isGroupChat(undefined)).toBe(false);
  });
});

describe("parseMemberChannel", () => {
  test("없거나 모양이 틀리면 기본(텔레그램)", () => {
    for (const raw of [undefined, null, "b3chat", [], 3]) expect(parseMemberChannel(raw)).toEqual(DEFAULT_CHANNEL);
  });
  test("b3chat — 끝 / 제거, allow_from·owner_chat 숫자 문자열로", () => {
    expect(parseMemberChannel({ kind: "b3chat", api_base: "https://chat.example.com/", allow_from: [12, "40", "x"], owner_chat: 12 }))
      .toEqual({ kind: "b3chat", apiBase: "https://chat.example.com", allowFrom: ["12", "40"], ownerChat: "12" });
  });
  test("평문 http 는 같은 기계만 — 그 밖이면 텔레그램 주소로 떨어진다", () => {
    expect(parseMemberChannel({ kind: "b3chat", api_base: "http://127.0.0.1:8741" }).apiBase).toBe("http://127.0.0.1:8741");
    expect(parseMemberChannel({ kind: "b3chat", api_base: "http://evil.example.com" }).apiBase).toBe(TELEGRAM_API_BASE);
  });
  test("모르는 kind 는 telegram", () => expect(parseMemberChannel({ kind: "slack" }).kind).toBe("telegram"));
});

describe("readMemberChannel / channelFromEnv", () => {
  test("channel 없는 팀원·없는 id·깨진 파일 → 기본", () => {
    const p = registry([{ id: "cody", runtime: "codex" }]);
    expect(readMemberChannel("cody", p)).toEqual(DEFAULT_CHANNEL);
    expect(readMemberChannel("nobody", p)).toEqual(DEFAULT_CHANNEL);
    expect(readMemberChannel("cody", join(tmpdir(), "no-such-agents.json"))).toEqual(DEFAULT_CHANNEL);
  });
  test("channel 있는 팀원 → 그 값", () => {
    const p = registry([{ id: "bee", channel: { kind: "b3chat", api_base: "http://127.0.0.1:8741", allow_from: ["7"], owner_chat: "7" } }]);
    expect(readMemberChannel("bee", p)).toEqual({ kind: "b3chat", apiBase: "http://127.0.0.1:8741", allowFrom: ["7"], ownerChat: "7" });
  });
  test("env 없음 → 텔레그램 기본 / env 있음 → 그 값", () => {
    expect(channelFromEnv({})).toEqual(DEFAULT_CHANNEL);
    expect(channelFromEnv({ CODEX_CHANNEL_KIND: "b3chat", TELEGRAM_API_BASE: "http://127.0.0.1:8741/", CODEX_OWNER_CHAT: "7" }))
      .toEqual({ kind: "b3chat", apiBase: "http://127.0.0.1:8741", allowFrom: null, ownerChat: "7" });
  });
});

describe("런처 wrapper", () => {
  // ★채널 설정이 없는 기존 팀원은 바이트까지 같다★ — 새 env 줄이 하나도 안 들어간다.
  test("channel 없는 팀원 → wrapper 가 기본 채널 렌더와 바이트 동일, 채널 env 0줄", () => {
    const p = registry([{ id: "cody", runtime: "codex" }]);
    const viaRegistry = renderLaunchWrapper(codexBridgePaths("cody", readMemberChannel("cody", p)));
    const plain = renderLaunchWrapper(codexBridgePaths("cody"));
    expect(viaRegistry).toBe(plain);
    expect(plain).not.toContain("CODEX_CHANNEL_KIND");
    expect(plain).not.toContain("TELEGRAM_API_BASE");
    expect(plain).not.toContain("CODEX_OWNER_CHAT");
    expect(channelEnvLines(DEFAULT_CHANNEL)).toEqual([]);
  });
  test("b3chat 팀원 → 채널 env 3줄 + 허용 목록은 allow_from(팀 공통 시드 아님)", () => {
    const ch = parseMemberChannel({ kind: "b3chat", api_base: "http://127.0.0.1:8741", allow_from: ["7", "9"], owner_chat: "7" });
    const paths = codexBridgePaths("bee", ch);
    expect(paths.allowFrom).toBe("7,9");
    const w = renderLaunchWrapper(paths);
    expect(w).toContain('export CODEX_CHANNEL_KIND="b3chat"');
    expect(w).toContain('export TELEGRAM_API_BASE="http://127.0.0.1:8741"');
    expect(w).toContain('export CODEX_OWNER_CHAT="7"');
  });
});
