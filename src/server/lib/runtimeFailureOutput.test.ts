/**
 * ★실측 근거★ (team.db, 2026-07-13)
 *   11:43:48  hermes → bill       종합 결과입니다. - devon: 김치찌개 …            ← ★정상 종합★
 *   11:44:20  hermes → bill       Codex response remained incomplete after 3 … ← ★실패가 답변으로★
 *   11:44:46  hermes → bill       (또)
 *   07-07     hermes → broadcast  API call failed after 3 retries: HTTP 429 …  ← ★팀 전체에★
 *
 * ★1차 fix 는 적대 리뷰에서 반증됐다★ — 문장 정규식은 실패 분기 24개 중 1개만 잡고, 재시도는
 * hermes 턴이 비멱등(턴 도중 send.sh 로 이미 팬아웃)이라 ★중복 위임★ 을 낳는다. 그래서:
 *   1차 판정 = ★구조화 신호★ (usage-file 의 completed:false) — 24개 분기를 한 번에
 *   실패 정책 = ★expire_no_retry★ (openclaw 와 같은 이유)
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRuntimeFailureOutput, readTurnFailure } from "./runtimeFailureOutput";

function usageFile(obj: unknown): string {
  const p = join(mkdtempSync(join(tmpdir(), "usage-")), "u.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe("★1차 — 구조화 신호(usage-file)가 실패를 판정한다★", () => {
  it("★completed:false 면 실패★ — 실패 분기 24개가 전부 이 값이다 (문장이 뭐든 상관없다)", () => {
    // 실제 incomplete 분기: {completed:false, partial:true, error:"…"} — ★failed 키가 없다★
    // ★usage-file 은 error·partial 키를 안 쓴다★ (completed/failed/failure 만) — 그래서 사유는 폴백 문구다.
    const f = readTurnFailure(usageFile({ completed: false }));
    expect(f).not.toBeNull();
    expect(f?.reason).toContain("completed=false");
  });

  it("★failed:true 도 실패★ (429 분기는 completed:false + failed:true 를 함께 준다)", () => {
    const f = readTurnFailure(usageFile({ completed: false, failed: true, failure: "HTTP 429: usage limit" }));
    expect(f?.reason).toContain("429");
  });

  it("★성공 턴을 절대 죽이지 않는다★ — 성공 경로는 completed 키를 아예 안 쓴다(undefined)", () => {
    expect(readTurnFailure(usageFile({ total_tokens: 1234, model: "x" }))).toBeNull();
    expect(readTurnFailure(usageFile({ completed: true, failed: false }))).toBeNull();
  });

  it("★모르면 실패로 몰지 않는다★ — 파일이 없거나 깨졌으면 null (정상 답을 죽이는 게 더 나쁘다)", () => {
    expect(readTurnFailure(join(tmpdir(), "does-not-exist-" + process.pid + ".json"))).toBeNull();
    const broken = usageFile("");
    writeFileSync(broken, "{not json");
    expect(readTurnFailure(broken)).toBeNull();
  });

  it("★읽고 나면 지운다★ (턴마다 tmp 가 쌓이지 않게)", () => {
    const p = usageFile({ completed: false });
    readTurnFailure(p);
    expect(existsSync(p)).toBe(false);
  });
});

describe("★2차 그물 — usage-file 을 못 읽었을 때만 의미가 있다★", () => {
  it("라이브에서 실제 발행된 문장 2종을 잡는다", () => {
    expect(isRuntimeFailureOutput("Codex response remained incomplete after 3 continuation attempts")).toBe(true);
    expect(isRuntimeFailureOutput("API call failed after 3 retries: HTTP 429: The usage limit has been reached")).toBe(true);
  });

  it("★정상 답변·에러 인용은 막지 않는다★ (실패로 오판하면 진짜 답이 사라진다 — 더 나쁘다)", () => {
    expect(isRuntimeFailureOutput("종합 결과입니다.\n- devon: 김치찌개")).toBe(false);
    expect(isRuntimeFailureOutput("가을이요.")).toBe(false);
    expect(isRuntimeFailureOutput("로그에 'API call failed after 3 retries' 가 3건 있었습니다.")).toBe(false);
    expect(isRuntimeFailureOutput("")).toBe(false);
  });
});

describe("★배선 — 모듈만 있고 안 쓰면 아무것도 안 고쳐진다★", () => {
  const BRIDGE = readFileSync(join(import.meta.dir, "hermesBridge.ts"), "utf8");
  const DISPATCH = readFileSync(join(import.meta.dir, "../bus/wakeDispatcher.ts"), "utf8");

  it("브리지가 ★--usage-file 을 실제로 넘긴다★ (안 넘기면 구조화 신호가 영영 안 생긴다)", () => {
    expect(BRIDGE).toContain('"--usage-file", usagePath');
    expect(BRIDGE).toContain("readTurnFailure(usagePath)");
  });

  it("★reject 로 넘긴다★ — proc.on('close') 콜백 안이라 throw 하면 Promise 가 안 죽고 uncaught 로 샌다", () => {
    expect(BRIDGE).toMatch(/reject\(new Error\("hermes_incomplete_turn:"/);
    expect(BRIDGE).not.toMatch(/failure \|\| isRuntimeFailureOutput\(out\)\) \{[\s\S]{0,80}throw /);
  });

  it("★억제한 본문을 audit 에 남긴다★ — max_iterations 소진 턴이면 진짜 내용일 수 있다(조용히 유실 금지)", () => {
    expect(BRIDGE).toContain("turn_failed_output_suppressed");
    expect(BRIDGE).toContain("suppressed_body: out.slice(0, 500)");
  });

  it("★hermes 는 재시도하지 않는다★ — 턴이 비멱등(도중에 팬아웃을 이미 보냄)이라 재시도 = 중복 위임", () => {
    expect(DISPATCH).toMatch(/\["hermes_agent", "expire_no_retry"\]/);
  });
});
