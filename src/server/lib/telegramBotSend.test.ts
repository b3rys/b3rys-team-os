import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canSendAsBot } from "./telegramBotSend";

// codex와 claude는 토큰 저장 위치가 다르다. 임시 루트를 주입하고 claude 경로 없이 codex 토큰만으로 전송 가능한지 검사한다.
describe("botTokenFor — 런타임별 토큰 경로", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "tokenfix-"));
    mkdirSync(join(repo, "var", "secrets"), { recursive: true });
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("★codex 는 var/secrets 의 raw 토큰을 찾는다★ (이게 없으면 dex 보고가 유실된다)", () => {
    writeFileSync(join(repo, "var", "secrets", "zz-codex.bot-token"), "123:ABC\n");
    expect(canSendAsBot({ id: "zz-codex", runtime: "codex" }, repo)).toBe(true);
  });

  test("★hermes 는 일부러 안 본다★ — 지금 CLI 경로로 정상 동작 중인 걸 건드리지 않는다", () => {
    writeFileSync(join(repo, "var", "secrets", "zz-hermes.bot-token"), "123:ABC\n");
    expect(canSendAsBot({ id: "zz-hermes", runtime: "hermes_agent" }, repo)).toBe(false);
  });

  test("runtime 을 안 주면 claude 규약만 본다 (기존 동작 유지)", () => {
    writeFileSync(join(repo, "var", "secrets", "zz-none.bot-token"), "123:ABC\n");
    expect(canSendAsBot({ id: "zz-none" }, repo)).toBe(false);
  });

  test("파일이 없으면 false — 조용히 true 가 되면 안 된다", () => {
    expect(canSendAsBot({ id: "zz-missing", runtime: "codex" }, repo)).toBe(false);
  });

  test("★빈 파일은 토큰 없음으로 친다★ — 빈 문자열로 Bot API 를 부르면 이유 모를 실패가 된다", () => {
    writeFileSync(join(repo, "var", "secrets", "zz-empty.bot-token"), "   \n");
    expect(canSendAsBot({ id: "zz-empty", runtime: "codex" }, repo)).toBe(false);
  });
});
