// Claude 전용 소통 섹션(SECTION_CLAUDE_COMMS) 주입 — idempotency + runtime-split 회귀 가드.
// churn 버그(comms가 마지막 섹션이면 매 실행 재기록) 재발 방지. (GD 2026-06-28)
import { test, expect } from "bun:test";
import { afterEach } from "bun:test";
import { resolveMembersRoot } from "./personaTemplates";
import {
  buildPersona,
  buildAgentsMd,
  extractCustomPersona,
  injectClaudeComms,
  stripClaudeComms,
  injectCoreRule,
  stripCoreRule,
  teamOsPathFor,
  coreRuleFor,
  subOwner,
  SECTION_CLAUDE_COMMS,
  SECTION_CORE_RULE,
  SECTION_CORE_RULE_EN,
} from "./personaTemplates";

const COMMS_HEADER = "## Communication note (Claude runtime)";
const claudeInput = { id: "tester", display_name: "Tester", role: "QA", runtime: "claude_channel" };

test("buildPersona(claude)에 comms 섹션 포함", () => {
  const p = buildPersona(claudeInput);
  expect(p.includes(COMMS_HEADER)).toBe(true);
  expect((p.match(/## Communication note/g) || []).length).toBe(1);
});

test("단순모델: openclaw AGENTS.md엔 claude 전용 comms 미포함 + 자동 정체성 없음", () => {
  const agentsMd = buildAgentsMd({ ...claudeInput, runtime: "openclaw" });
  expect(agentsMd.includes(COMMS_HEADER)).toBe(false); // claude 전용 comms는 AGENTS.md에 없음
  expect(agentsMd.includes("You are")).toBe(false);     // 자동 정체성 wrapper 없음(IDENTITY.md 소유)
  expect(agentsMd.includes("## Role & Persona")).toBe(true); // 참조 링크만
});

test("runtime-split: buildAgentsMd가 Skill Workshop(openclaw 전용)을 hermes엔 미포함", () => {
  const MARKER = "OpenClaw's own Skill Workshop";
  expect(buildAgentsMd({ ...claudeInput, runtime: "openclaw" }).includes(MARKER)).toBe(true);
  expect(buildAgentsMd({ ...claudeInput, runtime: "hermes_agent" }).includes(MARKER)).toBe(false);
});

test("injectClaudeComms idempotent — 일반(뒤에 ## 있음)", () => {
  const base = "# T\n\n## 톤\n\n- a\n\n## 작업 컨텍스트\n\n- b\n";
  const once = injectClaudeComms(base);
  const twice = injectClaudeComms(once);
  expect(once.includes(COMMS_HEADER)).toBe(true);
  expect(twice).toBe(once); // 재적용 무변화
  expect((twice.match(/## Communication note/g) || []).length).toBe(1);
});

test("injectClaudeComms idempotent — comms가 마지막 섹션(churn 버그 케이스)", () => {
  const base = "# T\n\n## 톤\n\n- a\n"; // '## 작업 컨텍스트' 없음 → comms가 끝에 붙음
  const once = injectClaudeComms(base);
  const twice = injectClaudeComms(once);
  const thrice = injectClaudeComms(twice);
  expect(once.includes(COMMS_HEADER)).toBe(true);
  expect(twice).toBe(once); // 마지막 섹션이어도 재적용 무변화(churn 없음)
  expect(thrice).toBe(once);
  expect((thrice.match(/## Communication note/g) || []).length).toBe(1); // 중복 안 생김
});

test("stripClaudeComms로 섹션 제거", () => {
  const withComms = injectClaudeComms("# T\n\n## 톤\n\n- a\n\n## 작업 컨텍스트\n\n- b\n");
  const stripped = stripClaudeComms(withComms);
  expect(stripped.includes(COMMS_HEADER)).toBe(false);
  expect(stripped.includes("## 작업 컨텍스트")).toBe(true); // 다른 섹션 보존
});

test("SECTION_CLAUDE_COMMS는 reply 도구 핵심 문구 포함", () => {
  expect(SECTION_CLAUDE_COMMS.includes("reply tool actually sends")).toBe(true);
});

// ── i18n 영어룰 파일럿 override (GD 2026-06-30) — teamOsPathFor + buildAgentsMd 임베드 경로 ──
const EN_PILOT = "/tmp/b3rys-pilot/rules/TEAM-OS.en.draft.md";
afterEach(() => {
  delete process.env.TEAMOS_PILOT_PATH;
  delete process.env.TEAMOS_PILOT_AGENTS;
});

test("파일럿 off(env 없음): teamOsPathFor 는 항상 정본(rules/TEAM-OS.md)", () => {
  expect(teamOsPathFor("codex").endsWith("/rules/TEAM-OS.md")).toBe(true);
  expect(teamOsPathFor(undefined).endsWith("/rules/TEAM-OS.md")).toBe(true);
});

test("파일럿 on: 대상 에이전트만 영어 드래프트 경로, 비대상/무명은 정본", () => {
  process.env.TEAMOS_PILOT_PATH = EN_PILOT;
  process.env.TEAMOS_PILOT_AGENTS = "codex,steve";
  expect(teamOsPathFor("codex")).toBe(EN_PILOT); // 대상
  expect(teamOsPathFor("steve")).toBe(EN_PILOT); // 대상
  expect(teamOsPathFor("lui").endsWith("/rules/TEAM-OS.md")).toBe(true); // 비대상 → 정본
  expect(teamOsPathFor(undefined).endsWith("/rules/TEAM-OS.md")).toBe(true); // 무명 → 정본
});

test("PILOT_PATH만 있고 대상목록 비면 누구도 override 안 됨(정본)", () => {
  process.env.TEAMOS_PILOT_PATH = EN_PILOT;
  // TEAMOS_PILOT_AGENTS 미설정
  expect(teamOsPathFor("codex").endsWith("/rules/TEAM-OS.md")).toBe(true);
});

test("buildAgentsMd(openclaw codex): 파일럿 on이면 AGENTS 임베드 경로가 영어 드래프트", () => {
  process.env.TEAMOS_PILOT_PATH = EN_PILOT;
  process.env.TEAMOS_PILOT_AGENTS = "codex";
  const md = buildAgentsMd({ id: "codex", display_name: "Codex", role: "PM", runtime: "openclaw" });
  expect(md.includes(EN_PILOT)).toBe(true); // 영어 정본 가리킴
  expect(md.includes("/rules/TEAM-OS.md`")).toBe(false); // 정본 경로는 임베드 안 됨(두 곳 다 override)
});

test("buildAgentsMd(openclaw) 회귀: 파일럿 off면 정본 경로만, 영어 경로 없음", () => {
  const md = buildAgentsMd({ id: "codex", display_name: "Codex", role: "PM", runtime: "openclaw" });
  expect(md.includes("/rules/TEAM-OS.md")).toBe(true); // 정본 임베드
  expect(md.includes(EN_PILOT)).toBe(false);
});

test("buildAgentsMd: 파일럿 on이어도 비대상 에이전트(lui)는 정본 임베드", () => {
  process.env.TEAMOS_PILOT_PATH = EN_PILOT;
  process.env.TEAMOS_PILOT_AGENTS = "codex";
  const md = buildAgentsMd({ id: "lui", display_name: "Lui", role: "dev", runtime: "openclaw" });
  expect(md.includes("/rules/TEAM-OS.md")).toBe(true);
  expect(md.includes(EN_PILOT)).toBe(false);
});

// ── SECTION_CORE_RULE 단일 소스 — persona 핵심룰 요약은 호환 export까지 같은 snippet ──
const PERSONA = "# Steve\n\n" + SECTION_CORE_RULE + "\n\n## 능력\n\n- 풀스택\n\n## 톤\n\n- 친근\n";

test("SECTION_CORE_RULE_EN: 언어 불변(사용자 언어 유지) + 핵심 구조 보존", () => {
  expect(SECTION_CORE_RULE_EN.includes("## ⭐ Core Rules")).toBe(true);
  expect(SECTION_CORE_RULE_EN.includes("reply in the language and register the user wrote in")).toBe(true);
  expect(SECTION_CORE_RULE_EN.includes("Korean in → Korean out")).toBe(true);
  // 언어불변 라인엔 팀-특정(존대 for GD) 하드코딩 누출 없어야 — public-safe(GD 2026-06-30)
  expect(SECTION_CORE_RULE_EN.includes("폴라이트 코리안")).toBe(false);
  expect(SECTION_CORE_RULE_EN.includes("polite Korean (존대) for GD")).toBe(false);
  // 3개 정책 블록 보존 (압축 구조: 기본실행/팀소통협업/안전검증 — GD 2026-07-17 전체압축)
  expect(SECTION_CORE_RULE_EN.includes("**Base execution**")).toBe(true);
  expect(SECTION_CORE_RULE_EN.includes("**Team communication·collaboration**")).toBe(true);
  expect(SECTION_CORE_RULE_EN.includes("**Safety·verification**")).toBe(true);
});

test("SECTION_CORE_RULE compatibility export points to the single core snippet", () => {
  expect(SECTION_CORE_RULE).toBe(SECTION_CORE_RULE_EN);
});

test("injectCoreRule: persona 핵심룰을 단일 snippet으로 교체, 커스텀 보존", () => {
  const en = injectCoreRule(PERSONA, SECTION_CORE_RULE_EN);
  expect(en.includes("## ⭐ Core Rules")).toBe(true);
  expect(en.includes("## 능력")).toBe(true); // 커스텀 보존
  expect(en.includes("## 톤")).toBe(true);
  expect((en.match(/## ⭐ Core Rules/g) || []).length).toBe(1); // 중복 없음
});

test("injectCoreRule(EN) 멱등 — 이미 영어면 재적용해도 중복 없음", () => {
  const once = injectCoreRule(PERSONA, SECTION_CORE_RULE_EN);
  const twice = injectCoreRule(once, SECTION_CORE_RULE_EN);
  expect(twice).toBe(once);
  expect((twice.match(/## ⭐ Core Rules/g) || []).length).toBe(1);
});

test("legacy SECTION_CORE_RULE rollback path still injects the same single snippet", () => {
  const en = injectCoreRule(PERSONA, SECTION_CORE_RULE_EN);
  const again = injectCoreRule(en, SECTION_CORE_RULE);
  expect(again).toBe(en);
  expect(again.includes("## ⭐ Core Rules")).toBe(true);
  expect((again.match(/## ⭐ /g) || []).length).toBe(1); // 핵심룰 섹션 1개만
  expect(again.includes("## 능력")).toBe(true); // 커스텀 보존
});

test("stripCoreRule: 영어 핵심룰도 제거(한·영 헤더 둘 다)", () => {
  const en = injectCoreRule(PERSONA, SECTION_CORE_RULE_EN);
  const stripped = stripCoreRule(en);
  expect(stripped.includes("## ⭐ Core Rules")).toBe(false);
  expect(stripped.includes("## 능력")).toBe(true); // 다른 섹션 보존
});

// ── 재생성 경로 robustness (Codex 권고 A/B/C) — buildPersona/buildAgentsMd 가 파일럿 핵심룰 분기 ──
test("coreRuleFor: 핵심룰은 항상 영어 정본 (GD 2026-07-01 — locale 토글 대상 아님, TEAM-OS.md처럼)", () => {
  expect(coreRuleFor("codex")).toBe(SECTION_CORE_RULE_EN); // pilot env 없어도 EN
  process.env.TEAMOS_PILOT_PATH = EN_PILOT;
  process.env.TEAMOS_PILOT_AGENTS = "codex,steve";
  expect(coreRuleFor("codex")).toBe(SECTION_CORE_RULE_EN); // pilot 무관 항상 EN
  expect(coreRuleFor("steve")).toBe(SECTION_CORE_RULE_EN);
  expect(coreRuleFor("lui")).toBe(SECTION_CORE_RULE_EN); // 비대상도 EN
  expect(coreRuleFor(undefined)).toBe(SECTION_CORE_RULE_EN); // 무명도 EN
});

test("buildAgentsMd(codex, 파일럿 on): 전체 재생성해도 핵심룰 EN 유지(A)", () => {
  process.env.TEAMOS_PILOT_PATH = EN_PILOT;
  process.env.TEAMOS_PILOT_AGENTS = "codex";
  const md = buildAgentsMd({ id: "codex", display_name: "Codex", role: "PM", runtime: "openclaw" });
  expect(md.includes("## ⭐ Core Rules")).toBe(true); // 영어 핵심룰
  expect(md.includes("## ⭐ 핵심 룰")).toBe(false); // 한글 안 돌아옴
});

test("buildAgentsMd(codex): 핵심룰은 항상 영어 (GD 2026-07-01)", () => {
  const md = buildAgentsMd({ id: "codex", display_name: "Codex", role: "PM", runtime: "openclaw" });
  expect(md.includes("## ⭐ Core Rules")).toBe(true);
  expect(md.includes("## ⭐ 핵심 룰")).toBe(false);
});

test("buildPersona(steve claude, 파일럿 on): CLAUDE.md 재생성도 핵심룰 EN(A)", () => {
  process.env.TEAMOS_PILOT_PATH = EN_PILOT;
  process.env.TEAMOS_PILOT_AGENTS = "steve";
  const p = buildPersona({ id: "steve", display_name: "Steve", role: "dev", runtime: "claude_channel" });
  expect(p.includes("## ⭐ Core Rules")).toBe(true);
  expect(p.includes("## ⭐ 핵심 룰")).toBe(false);
});

// ── {{OWNER}} 플레이스홀더화 (안전: 라이브=GD, 퍼블릭/no-owner={{OWNER}}) — GD 2026-06-30 ──
test("subOwner: ownerName 주면 {{OWNER}} 치환, 안 주면 {{OWNER}} 유지", () => {
  expect(subOwner("hi {{OWNER}} bye", "GD")).toBe("hi GD bye");
  expect(subOwner("a {{OWNER}} b {{OWNER}} c", "GD")).toBe("a GD b GD c"); // 전부 치환
  expect(subOwner("hi {{OWNER}} bye")).toBe("hi {{OWNER}} bye"); // 미지정 → 원문
  expect(subOwner("hi {{OWNER}} bye", "")).toBe("hi {{OWNER}} bye"); // 빈 문자열 → 원문(falsy)
});

const countOf = (s: string, sub: string) => s.split(sub).length - 1;

test("핵심룰 compatibility const: {{TEAM}}/{{OWNER}} 각 정확히 1회(상단 선언만) + 본문은 일반어", () => {
  expect(countOf(SECTION_CORE_RULE, "{{OWNER}}")).toBe(1); // 상단 선언 1회만, 본문 누출 0
  expect(countOf(SECTION_CORE_RULE, "{{TEAM}}")).toBe(1);
  expect(SECTION_CORE_RULE.includes("the team lead")).toBe(true); // 본문 일반어
  expect(SECTION_CORE_RULE.includes("GD message")).toBe(false); // 하드코딩 없음
  expect(SECTION_CORE_RULE.includes("GD reconfirms")).toBe(false);
});

test("핵심룰 const(EN): {{TEAM}}/{{OWNER}} 각 정확히 1회(상단 선언만) + 본문은 'the team lead'", () => {
  expect(countOf(SECTION_CORE_RULE_EN, "{{OWNER}}")).toBe(1);
  expect(countOf(SECTION_CORE_RULE_EN, "{{TEAM}}")).toBe(1);
  expect(SECTION_CORE_RULE_EN.includes("the team lead")).toBe(true); // 본문 일반어
  expect(SECTION_CORE_RULE_EN.includes("GD message")).toBe(false);
  expect(SECTION_CORE_RULE_EN.includes("GD reconfirms")).toBe(false);
  expect(SECTION_CORE_RULE_EN.includes("GD specifies")).toBe(false);
});

test("coreRuleFor('bill','GD','b3rys'): 라이브 → 'GD'·'b3rys' 박힘, {{OWNER}}/{{TEAM}} 누출 0", () => {
  const r = coreRuleFor("bill", "GD", "b3rys");
  expect(r.includes("GD")).toBe(true);
  expect(r.includes("b3rys")).toBe(true);
  expect(r.includes("the team lead")).toBe(true); // 본문 일반어(EN) 유지
  expect(r.includes("{{OWNER}}")).toBe(false); // 라이브 페르소나에 placeholder 누출 = 실패
  expect(r.includes("{{TEAM}}")).toBe(false);
});

test("coreRuleFor('bill') (owner/team 미지정): 퍼블릭-safe — {{OWNER}}/{{TEAM}} 각 1회 유지", () => {
  const r = coreRuleFor("bill");
  expect(countOf(r, "{{OWNER}}")).toBe(1);
  expect(countOf(r, "{{TEAM}}")).toBe(1);
  expect(r.includes("the team lead")).toBe(true); // 일반어 본문(EN)은 owner/team 무관하게 항상 존재
});

test("buildAgentsMd(openclaw, owner_name:'GD', team_name:'b3rys'): 'GD'·'b3rys' 박힘, placeholder 누출 0", () => {
  const md = buildAgentsMd({ id: "x", display_name: "X", role: "dev", runtime: "openclaw", owner_name: "GD", team_name: "b3rys" });
  expect(md.includes("GD")).toBe(true);
  expect(md.includes("b3rys")).toBe(true);
  expect(md.includes("the team lead")).toBe(true);
  expect(md.includes("{{OWNER}}")).toBe(false); // 라이브 생성물에 placeholder 누출 금지
  expect(md.includes("{{TEAM}}")).toBe(false);
});

test("buildAgentsMd(openclaw, owner/team 없음): 퍼블릭 템플릿 — 핵심룰에 {{OWNER}}/{{TEAM}} 유지", () => {
  const md = buildAgentsMd({ id: "x", display_name: "X", role: "dev", runtime: "openclaw" });
  expect(md.includes("{{OWNER}}")).toBe(true);
  expect(md.includes("{{TEAM}}")).toBe(true);
  expect(md.includes("the team lead")).toBe(true); // 일반어 본문(EN)
});

// extractCustomPersona 룰섹션 제거 검증 (config GET fallback용, buildPersonaFromCustom 제거로 round-trip 테스트는 폐기 — GD 2026-07-06).
test("extractCustomPersona: 룰섹션 제거 + 커스텀 보존(부분매칭 오제거 없음)", () => {
  // "## 메모리 관리 노하우"는 마커 '메모리' 부분문자열 포함 — 정확매칭이라 오제거 안 돼야 함.
  const rendered = "# Test — Team\n\n## 전문 영역\n\n- LLM 응용\n\n## 메모리 관리 노하우\n\n오제거되면 안 되는 커스텀 섹션\n\n## ⭐ Core Rules\n\n룰\n\n## Global rules\n\n글로벌";
  const re = extractCustomPersona(rendered);
  expect(re).toContain("## 전문 영역");            // 커스텀 보존
  expect(re).toContain("## 메모리 관리 노하우");     // 부분매칭 오제거 없음
  expect(re).not.toContain("## ⭐ Core Rules");    // 룰 걷힘
  expect(re).not.toContain("## Global rules");
});

// ★MEMBERS_ROOT 기본-뒤집기 로직 결정론 검증 (2026-07-12 퍼블릭-안전 기본, Bill 갭 후속).★
//   MEMBERS_ROOT 상수는 import 시점 1회 해석이라 ambient env 에 묶인다 → 우선순위 로직은 resolveMembersRoot()
//   (호출 시점 env 읽기)로 env 를 명시 토글해 검증한다. save/restore 로 다른 테스트 오염 0.
test("resolveMembersRoot — env 우선순위: B3RYS_MEMBERS_ROOT > B3RYS_HOME/members > ~/b3os/members(기본)", () => {
  const save = {
    mr: process.env.B3RYS_MEMBERS_ROOT,
    bh: process.env.B3RYS_HOME,
    home: process.env.HOME,
  };
  try {
    process.env.HOME = "/home/tester";

    // ① 명시 B3RYS_MEMBERS_ROOT 최우선 (OWNER 라이브가 ~/Development 로 레거시 보존하는 경로)
    process.env.B3RYS_MEMBERS_ROOT = "/home/tester/Development";
    process.env.B3RYS_HOME = "/home/tester/b3os";
    expect(resolveMembersRoot()).toBe("/home/tester/Development");

    // ② B3RYS_HOME → $B3RYS_HOME/members (install.sh 데이터루트 관례)
    delete process.env.B3RYS_MEMBERS_ROOT;
    expect(resolveMembersRoot()).toBe("/home/tester/b3os/members");

    // ③ 둘 다 없으면 ★퍼블릭-안전 기본★ ~/b3os/members (예전 ~/Development 아님)
    delete process.env.B3RYS_HOME;
    expect(resolveMembersRoot()).toBe("/home/tester/b3os/members");
    expect(resolveMembersRoot()).not.toBe("/home/tester/Development"); // 기본이 owner-관례로 회귀하지 않음
  } finally {
    // 복원 (ambient 오염 방지 — Bill 갭의 근본원인이 이 격리 누락)
    if (save.mr === undefined) delete process.env.B3RYS_MEMBERS_ROOT; else process.env.B3RYS_MEMBERS_ROOT = save.mr;
    if (save.bh === undefined) delete process.env.B3RYS_HOME; else process.env.B3RYS_HOME = save.bh;
    if (save.home === undefined) delete process.env.HOME; else process.env.HOME = save.home;
  }
});
