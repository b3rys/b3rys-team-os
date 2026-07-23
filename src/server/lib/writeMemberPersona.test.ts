// ★모델(GD 2026-07-17): persona 값이 사는 곳은 SOUL.md 단 하나.★ agents.json 의 purpose 필드는 제거됨.
//   · writeMemberPersona = ★룰 렌더러★ (CLAUDE.md/AGENTS.md). SOUL.md 는 읽지도 쓰지도 않는다.
//   · savePersonaFile   = ★persona 저장의 유일한 지점★ (대시보드 저장·영입이 호출).
//   "그걸 어디다 붙이던 그건 분리된 트랜잭션이잖아" — GD
//
// ═══ 왜 이렇게 됐나 (2026-07-17 실측) ═══
//   옛 구조는 purpose(agents.json)=정본, SOUL=렌더 출력이었다. 렌더마다 SOUL 을 purpose 로 덮었다.
//   결과: 12명 중 7명이 어긋났고 — GD 가 손질한 5명은 ★렌더 한 번에 되돌아갈 위치★,
//   lui·forin 은 purpose 가 비어 찍힌 24자 껍데기가 굳어 ★페르소나가 실제로 없었다.★
//   ★렌더는 플래그 토글로도 돈다.★ → 소스를 하나(SOUL)로 두면 이 문제가 아예 생기지 않는다.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, lstatSync, readlinkSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeMemberPersona, savePersonaFile } from "./writeMemberPersona";

describe("writeMemberPersona — 룰 렌더러(SOUL 은 안 건드린다)", () => {
  const mk = () => mkdtempSync(join(tmpdir(), "wmp-"));
  const CUSTOM = "## Role\nAI 리서치·개발\n\n## Persona\n나는 꼼꼼하고 데이터 중심. English mixed 也可以.";
  const args = (ws: string, over: Record<string, unknown> = {}) =>
    ({ id: "lui", display_name: "Lui", role: "AI", runtime: "openclaw", workspace_path: ws, persona_file: join(ws, "SOUL.md"), ...over }) as Parameters<typeof writeMemberPersona>[0];

  test("★렌더는 SOUL.md 를 만들지 않는다★ — persona 저장은 렌더의 일이 아니다", () => {
    const ws = mk();
    const r = writeMemberPersona(args(ws));
    expect(existsSync(join(ws, "SOUL.md"))).toBe(false);   // ★껍데기조차 안 만든다★
    expect(r.written).not.toContain(join(ws, "SOUL.md"));
    expect(existsSync(join(ws, "AGENTS.md"))).toBe(true);  // 로딩파일(룰)은 렌더
  });

  test("★렌더를 몇 번 돌려도 기존 SOUL.md 는 한 글자도 안 변한다★ (플래그 토글 시나리오)", () => {
    const ws = mk();
    const 사용자가쓴것 = "# 내가 직접 쓴 페르소나\n각인 #1: 코드가 지우면 안 된다\n";
    writeFileSync(join(ws, "SOUL.md"), 사용자가쓴것, "utf-8");
    writeMemberPersona(args(ws));
    writeMemberPersona(args(ws, { role: "역할이 바뀜" }));   // 토글/재렌더 반복
    writeMemberPersona(args(ws, { runtime: "openclaw" }));
    expect(readFileSync(join(ws, "SOUL.md"), "utf-8")).toBe(사용자가쓴것);  // ★불변★
    expect(existsSync(join(ws, "SOUL.md.bak"))).toBe(false);               // 덮은 적이 없으니 .bak 도 없다
  });

  test("★로딩파일(AGENTS.md openclaw) = 자동 정체성 없음 + 직접경로 참조(@ 아님) + 룰★", () => {
    const ws = mk();
    savePersonaFile(join(ws, "SOUL.md"), CUSTOM);
    writeMemberPersona(args(ws));
    const agents = readFileSync(join(ws, "AGENTS.md"), "utf-8");
    expect(agents).not.toContain("You are");            // 자동 정체성 없음
    expect(agents).not.toContain(CUSTOM);               // ★custom 을 로딩파일에 주입하지 않는다 — 참조만★
    expect(agents).toContain("## Role & Persona");
    expect(agents).toContain("SOUL.md");               // 직접 경로
    expect(agents).not.toContain("@SOUL.md");          // openclaw는 @ 미지원
    expect(agents).toMatch(/Core Rules|핵심 룰/);
  });

  test("★claude CLAUDE.md = @SOUL.md 참조 + 룰, 자동 정체성 없음★", () => {
    const ws = mk();
    savePersonaFile(join(ws, "SOUL.md"), CUSTOM);
    writeMemberPersona(args(ws, { id: "bill", display_name: "Bill", role: "dev", runtime: "claude_channel" }));
    const claude = readFileSync(join(ws, "CLAUDE.md"), "utf-8");
    expect(claude).toContain("@SOUL.md");              // 참조(로드는 Claude Code 가)
    expect(claude).not.toContain(CUSTOM);              // ★본문에 주입 안 함★
    expect(claude).not.toContain("You are");
    expect(claude).toMatch(/Core Rules|핵심 룰/);
  });

  test("★backup-first — 내용이 바뀌면 .bak 후 덮음★", () => {
    const ws = mk();
    writeMemberPersona(args(ws, { display_name: "이름하나" }));
    const 첫렌더 = readFileSync(join(ws, "AGENTS.md"), "utf-8");
    writeMemberPersona(args(ws, { display_name: "이름둘" }));  // ★렌더 출력이 바뀜★ → 백업+덮기
    expect(existsSync(join(ws, "AGENTS.md.bak"))).toBe(true);
    expect(readFileSync(join(ws, "AGENTS.md.bak"), "utf-8")).toBe(첫렌더);  // .bak = 덮기 직전 내용
  });

  test("★skip-if-unchanged — 내용 동일하면 재작성·백업 생략★ (GD 2026-07-19)", () => {
    const ws = mk();
    const r1 = writeMemberPersona(args(ws));
    expect(r1.written).toContain(join(ws, "AGENTS.md"));   // 첫 렌더 = write
    const r2 = writeMemberPersona(args(ws));               // ★동일 내용★
    expect(r2.written).not.toContain(join(ws, "AGENTS.md")); // 스킵 = write 안 함
    expect(r2.backedUp).not.toContain(join(ws, "AGENTS.md"));
    expect(existsSync(join(ws, "AGENTS.md.bak"))).toBe(false); // .bak 미생성
  });
});

describe("savePersonaFile — persona 저장의 유일한 지점", () => {
  const mk = () => mkdtempSync(join(tmpdir(), "spf-"));
  const CUSTOM = "## Persona\n꼼꼼하고 데이터 중심";

  test("★입력 그대로 SOUL.md 에 쓴다 (verbatim — wrapper·변형 없음)★", () => {
    const ws = mk();
    savePersonaFile(join(ws, "SOUL.md"), CUSTOM);
    const got = readFileSync(join(ws, "SOUL.md"), "utf-8");
    expect(got.trim()).toBe(CUSTOM);
    expect(got.endsWith("\n")).toBe(true);       // 개행 보장(중복 안 붙임)
    expect(got).not.toContain("You are");
  });

  test("★backup-first — 덮기 전 .bak 에 직전 내용★", () => {
    const ws = mk();
    savePersonaFile(join(ws, "SOUL.md"), "첫 내용");
    savePersonaFile(join(ws, "SOUL.md"), "둘째 내용");
    expect(readFileSync(join(ws, "SOUL.md"), "utf-8").trim()).toBe("둘째 내용");
    expect(readFileSync(join(ws, "SOUL.md.bak"), "utf-8").trim()).toBe("첫 내용");
  });

  test("★디렉토리가 없어도 만든다★ (영입 직후)", () => {
    const ws = mk();
    const nested = join(ws, "new", "member", "SOUL.md");
    savePersonaFile(nested, CUSTOM);
    expect(readFileSync(nested, "utf-8").trim()).toBe(CUSTOM);
  });
});

describe("writeMemberPersona — 기타", () => {
  const mk = () => mkdtempSync(join(tmpdir(), "wmp2-"));
  const CUSTOM = "## Role\nAI 리서치·개발";

  test("★IDENTITY.md 는 절대 안 건드림(GD 2026-07-06) — 렌더는 로딩파일만★", () => {
    const ws = mk();
    writeFileSync(join(ws, "IDENTITY.md"), "# 기존 IDENTITY.md 내용\n건드리면 안 됨\n", "utf-8");
    savePersonaFile(join(ws, "SOUL.md"), CUSTOM);
    writeMemberPersona({ id: "lui", display_name: "Lui", role: "AI", runtime: "openclaw", workspace_path: ws, persona_file: join(ws, "SOUL.md") });
    expect(readFileSync(join(ws, "SOUL.md"), "utf-8").trim()).toBe(CUSTOM);   // SOUL 은 저장 경로가 쓴 그대로
    // ★IDENTITY.md 는 그대로 유지(안 건드림), .bak 도 안 생김★
    expect(readFileSync(join(ws, "IDENTITY.md"), "utf-8")).toContain("건드리면 안 됨");
    expect(existsSync(join(ws, "IDENTITY.md.bak"))).toBe(false);
  });

  /**
   * ★옛 테스트 교체★ — 원래 이 자리엔 "purpose 없으면 SOUL.md 최소 스캐폴드" 가 있었다.
   *   그 스캐폴드(`# Role\n\n{role}\n\n# Persona\n\n`)가 ★lui·forin 의 페르소나를 삼킨 그 껍데기★ 다.
   *   이제 렌더는 SOUL 을 아예 안 만든다 — '자동 persona 생성 안 함' 의도가 더 강해졌다.
   */
  test("렌더는 SOUL.md 를 만들지 않는다 (자동 persona 생성 안 함 — 껍데기조차)", () => {
    const ws = mk();
    writeMemberPersona({ id: "lui", display_name: "Lui", role: "AI 리서치", runtime: "openclaw", workspace_path: ws, persona_file: join(ws, "SOUL.md") });
    expect(existsSync(join(ws, "SOUL.md"))).toBe(false);   // ★껍데기도 안 만든다★
    const agents = readFileSync(join(ws, "AGENTS.md"), "utf-8");
    expect(agents).not.toContain("You are");               // 자동 persona 생성 없음(원래 의도 유지)
    expect(agents).toContain("SOUL.md");                   // 참조는 그대로(대상 없으면 조용히 증발)
  });
});

/**
 * ★TEAM-OS.md 심링크 — 영입 때부터★ (GD 2026-07-13: "team-os 심링크는 영입때도 체크")
 *
 * 루이가 잡은 실측: 11명 중 ★6명에게 TEAM-OS.md 가 아예 없었다★ (steve·hermes·codex·ames·devon·dex).
 *   심링크 코드가 ★런타임 스왑 경로에만★ 있어서, 스왑을 겪은 5명만 갖고 있었다.
 *   → ★팀 룰 정본을 절반이 못 읽고 있었다.★ 그 상태로 "룰대로 해라" 고 시키고 있었던 것이다.
 */
describe("★TEAM-OS.md 심링크 — persona 를 쓰면 항상 걸린다★", () => {
  const mk = () => mkdtempSync(join(tmpdir(), "wmp-link-"));
  const base = (ws: string, runtime: string) => ({
    id: "newbie", display_name: "Newbie", role: "QA", runtime,
    purpose: "## Role\nQA", workspace_path: ws, persona_file: join(ws, "SOUL.md"),
  });

  test("★영입(claude) → TEAM-OS.md 심링크가 생긴다★", () => {
    const ws = mk();
    writeMemberPersona(base(ws, "claude_channel"));
    const link = join(ws, "TEAM-OS.md");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toContain("TEAM-OS.md");
  });

  test("★런타임 무관★ — 브릿지 런타임(hermes)도 똑같이 걸린다 (여기 6명이 빠져 있었다)", () => {
    const ws = mk();
    writeMemberPersona(base(ws, "hermes_agent"));
    expect(lstatSync(join(ws, "TEAM-OS.md")).isSymbolicLink()).toBe(true);
  });

  test("★사람이 쓴 일반 파일은 건드리지 않는다★ (백업 먼저 원칙 — 덮어쓰기 금지)", () => {
    const ws = mk();
    const link = join(ws, "TEAM-OS.md");
    mkdirSync(ws, { recursive: true });
    writeFileSync(link, "손으로 쓴 내용");
    writeMemberPersona(base(ws, "claude_channel"));
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(link, "utf-8")).toBe("손으로 쓴 내용");   // 그대로
  });

  test("★깨진 심링크는 고쳐준다★ (있는 척만 하고 정본을 못 읽는 상태가 제일 나쁘다)", () => {
    const ws = mk();
    const link = join(ws, "TEAM-OS.md");
    mkdirSync(ws, { recursive: true });
    symlinkSync(join(ws, "없는파일.md"), link);
    expect(existsSync(link)).toBe(false);                  // 깨져 있다
    writeMemberPersona(base(ws, "claude_channel"));
    expect(existsSync(link)).toBe(true);                   // ★살아났다★
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});
