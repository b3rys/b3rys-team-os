import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNewSessionContext, memorySection, otherThreadsSection, withNewSessionContext } from "./newSessionContext";

function db(): Database {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE message (id TEXT, thread_id TEXT, from_agent_id TEXT, body TEXT, created_at TEXT)`);
  return d;
}

function ws(): string {
  const w = mkdtempSync(join(tmpdir(), "codex-nsc-"));
  mkdirSync(join(w, "memory"));
  return w;
}

describe("codex new-session context", () => {
  test("기억 파일: MEMORY.md + 최근 날짜 메모 2개, 오래된 것은 뺀다", () => {
    const w = ws();
    writeFileSync(join(w, "MEMORY.md"), "# MEMORY\n- 장기 교훈 A\n");
    for (const d of ["2026-10-22", "2026-10-23", "2026-10-24"]) writeFileSync(join(w, "memory", `${d}.md`), `메모 ${d}`);
    writeFileSync(join(w, "memory", "2026-09-01.md"), "옛 메모");
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    utimesSync(join(w, "memory", "2026-09-01.md"), old, old);
    writeFileSync(join(w, "memory", "notes.json"), "{}");
    const text = memorySection(w);
    expect(text).toContain("장기 교훈 A");
    expect(text).toContain("메모 2026-10-24");
    expect(text).toContain("메모 2026-10-23");
    expect(text).not.toContain("메모 2026-10-22");
    expect(text).not.toContain("옛 메모");
    expect(text.indexOf("2026-10-23")).toBeLessThan(text.indexOf("2026-10-24"));
  });

  test("길면 끝부분(최근 기록)을 남긴다", () => {
    const w = ws();
    writeFileSync(join(w, "MEMORY.md"), "앞" + "x".repeat(5000) + "끝줄");
    const text = memorySection(w);
    expect(text).toContain("끝줄");
    expect(text).toContain("앞부분 생략");
    expect(text.length).toBeLessThan(1700);
  });

  test("다른 스레드: 내가 24시간 안에 보낸 글, 스레드마다 최신 1개, 지금 스레드·남의 글·옛 글 제외", () => {
    const d = db();
    const ins = d.prepare("INSERT INTO message VALUES (?,?,?,?,datetime('now', ?))");
    ins.run("1", "t-a", "dex", "A 옛 글", "-2 hours");
    ins.run("2", "t-a", "dex", "A 최신 글\n둘째 줄", "-1 hours");
    ins.run("3", "t-cur", "dex", "지금 스레드", "-1 hours");
    ins.run("4", "t-b", "bill", "남의 글", "-1 hours");
    ins.run("5", "t-c", "dex", "어제 그제 글", "-30 hours");
    const text = otherThreadsSection(d, "dex", "t-cur");
    expect(text).toContain("[t-a]");
    expect(text).toContain("A 최신 글");
    expect(text).not.toContain("둘째 줄");
    expect(text).not.toContain("A 옛 글");
    expect(text).not.toContain("지금 스레드");
    expect(text).not.toContain("남의 글");
    expect(text).not.toContain("어제 그제");
  });

  test("붙일 것이 없으면 빈 글이고 프롬프트는 그대로", () => {
    const w = mkdtempSync(join(tmpdir(), "codex-nsc-empty-"));
    expect(buildNewSessionContext(db(), "dex", w, "t")).toBe("");
    expect(withNewSessionContext("본문", "")).toBe("본문");
  });

  test("토큰 모양은 가리고, 끄면 붙이지 않는다", () => {
    const w = ws();
    writeFileSync(join(w, "MEMORY.md"), "bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA 를 쓰지 마");
    const text = buildNewSessionContext(db(), "dex", w, "t");
    expect(text).toContain("bot<redacted>");
    expect(text).not.toContain("AAAAAAAAAAAAAAAA");
    expect(withNewSessionContext("본문", text).endsWith("본문")).toBe(true);
    process.env.CODEX_NEW_SESSION_CONTEXT = "0";
    try {
      expect(buildNewSessionContext(db(), "dex", w, "t")).toBe("");
    } finally {
      delete process.env.CODEX_NEW_SESSION_CONTEXT;
    }
  });

  test("DB 를 못 읽어도 던지지 않는다", () => {
    const d = new Database(":memory:");
    expect(otherThreadsSection(d, "dex", "t")).toBe("");
  });
});

describe("redact — 리뷰 #613 회귀", () => {
  test("JSON·따옴표 형태 비밀값도 가린다", async () => {
    const { redactSecrets } = await import("../../lib/redactSecrets");
    const fake = "Zq9" + "w".repeat(20);
    for (const s of [`{"api_key":"${fake}"}`, `{"password": "${fake}"}`, `api_key = ${fake}`, `'db_token':'${fake}'`]) {
      expect(redactSecrets(s)).not.toContain(fake);
    }
  });

  test("자르기 전에 가린다 — 끝 1,500자 경계에 걸린 비밀값 꼬리가 남지 않는다", () => {
    const w = ws();
    const fake = "Qx7" + "v".repeat(30);
    const secretLine = `password = ${fake}`;
    // 끝 1,500자가 값 중간에서 시작하도록 배치
    const tailText = "z".repeat(1500 - 10);
    writeFileSync(join(w, "MEMORY.md"), "앞\n" + secretLine + tailText);
    const text = memorySection(w);
    expect(text).not.toContain(fake.slice(-10));
  });
});

describe("redact — 리뷰 #613 r2: 따옴표 안 공백·쉼표 값", () => {
  const cases = [
    { input: `{"password":"correct horse battery staple"}`, leftovers: ["correct", "horse", "battery", "staple"] },
    { input: `{"password":"hello world"}`, leftovers: ["hello", "world"] },
    { input: `{"password":"SYNTHETIC_HEAD,TAIL_SYNTHETIC_ONLY"}`, leftovers: ["SYNTHETIC_HEAD", "TAIL_SYNTHETIC_ONLY"] },
    { input: `{'api_key': 'a b\\'c d'}`, leftovers: ["a b", "c d"] },
    { input: `{"db_token":"x\\"y z"}`, leftovers: ["y z"] },
  ];

  test("가리기 함수", async () => {
    const { redactSecrets } = await import("../../lib/redactSecrets");
    for (const c of cases) {
      const out = redactSecrets(c.input);
      for (const l of c.leftovers) expect(out).not.toContain(l);
      expect(out).toContain("<redacted>");
    }
  });

  test("클로드 인계 출력(render) 끝까지", async () => {
    const { render } = await import("../claude/session-handoff");
    for (const c of cases) {
      const out = render(c.input, [{ role: "사람/팀원", text: c.input }], 6000, "s.jsonl");
      for (const l of c.leftovers) expect(out).not.toContain(l);
    }
  });

  test("코덱스 인계 출력(MEMORY.md → buildNewSessionContext) 끝까지", () => {
    for (const c of cases) {
      const w = ws();
      writeFileSync(join(w, "MEMORY.md"), `메모\n${c.input}\n끝`);
      const out = buildNewSessionContext(db(), "dex", w, "t");
      for (const l of c.leftovers) expect(out).not.toContain(l);
    }
  });
});
