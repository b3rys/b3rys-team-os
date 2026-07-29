import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canSendAsBot } from "./telegramBotSend";

/**
 * ★런타임마다 봇 토큰을 두는 자리가 다르다★ — 2026-07-29 Demis S7 이 잡은 라이브 결함.
 *
 * codex 팀원(dex)은 토큰이 <repo>/var/secrets/<id>.bot-token 에 있는데
 * botTokenFor 는 claude 규약(~/.claude/channels/telegram-<id>/.env)만 봤다.
 * → canSendAsBot=false → hermes CLI 폴백 → ★dex 는 hermes 가 아니라 실패★
 * → ★dex 의 팀장 보고가 도달하지 않았다.★ 파일 머리말이 2026-07-14 에 예고한 그 패턴이다.
 *
 * ※ 이 테스트는 ★실제 홈 디렉토리를 읽지 않는다★ — claude 경로가 없는 상태를 전제로
 *   codex 경로만 검증한다(테스트가 이 기계 상태를 타면 안 된다).
 */
describe("botTokenFor — 런타임별 토큰 경로", () => {
  let repo: string;
  let prev: string | undefined;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "tokenfix-"));
    mkdirSync(join(repo, "var", "secrets"), { recursive: true });
    prev = process.env.TEAM_COLLAB_ROOT;
    process.env.TEAM_COLLAB_ROOT = repo;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.TEAM_COLLAB_ROOT; else process.env.TEAM_COLLAB_ROOT = prev;
    rmSync(repo, { recursive: true, force: true });
  });

  test("★codex 는 var/secrets 의 raw 토큰을 찾는다★ (이게 없으면 dex 보고가 유실된다)", () => {
    writeFileSync(join(repo, "var", "secrets", "zz-codex.bot-token"), "123:ABC\n");
    expect(canSendAsBot({ id: "zz-codex", runtime: "codex" })).toBe(true);
  });

  test("★hermes 는 일부러 안 본다★ — 지금 CLI 경로로 정상 동작 중인 걸 건드리지 않는다", () => {
    writeFileSync(join(repo, "var", "secrets", "zz-hermes.bot-token"), "123:ABC\n");
    expect(canSendAsBot({ id: "zz-hermes", runtime: "hermes_agent" })).toBe(false);
  });

  test("runtime 을 안 주면 claude 규약만 본다 (기존 동작 유지)", () => {
    writeFileSync(join(repo, "var", "secrets", "zz-none.bot-token"), "123:ABC\n");
    expect(canSendAsBot({ id: "zz-none" })).toBe(false);
  });

  test("파일이 없으면 false — 조용히 true 가 되면 안 된다", () => {
    expect(canSendAsBot({ id: "zz-missing", runtime: "codex" })).toBe(false);
  });

  test("★빈 파일은 토큰 없음으로 친다★ — 빈 문자열로 Bot API 를 부르면 이유 모를 실패가 된다", () => {
    writeFileSync(join(repo, "var", "secrets", "zz-empty.bot-token"), "   \n");
    expect(canSendAsBot({ id: "zz-empty", runtime: "codex" })).toBe(false);
  });
});
