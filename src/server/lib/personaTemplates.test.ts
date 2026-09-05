// Claude 전용 소통 섹션(SECTION_CLAUDE_COMMS) 주입 — idempotency + runtime-split 회귀 가드.
// churn 버그(comms가 마지막 섹션이면 매 실행 재기록) 재발 방지.
import { describe, test, expect } from "bun:test";
import { afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { resolveMembersRoot, MEMBERS_ROOT, assertNotLiveMemberFsUnderTest } from "./personaTemplates";
import { savePersonaFile } from "./writeMemberPersona";
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

test("openclaw AGENTS.md엔 claude 전용 comms 미포함 + registry 정체성 포함", () => {
  const agentsMd = buildAgentsMd({ ...claudeInput, runtime: "openclaw" });
  expect(agentsMd.includes(COMMS_HEADER)).toBe(false); // claude 전용 comms는 AGENTS.md에 없음
  expect(agentsMd).toContain("You are **Tester** (tester) — QA.");
  expect(agentsMd.includes("## Role & Persona")).toBe(true); // 참조 링크만
});

test("runtime-split: buildAgentsMd가 Skill Workshop(openclaw 전용)을 hermes엔 미포함", () => {
  const MARKER = "OpenClaw's own Skill Workshop";
  expect(buildAgentsMd({ ...claudeInput, runtime: "openclaw" }).includes(MARKER)).toBe(true);
  expect(buildAgentsMd({ ...claudeInput, runtime: "hermes_agent" }).includes(MARKER)).toBe(false);
});

/**
 * ★팀원이 실제로 읽는 파일에 판별 축이 살아 있어야 한다.★
 *
 * 정본(TEAM-OS 템플릿) 쪽만 검사하면 ★여기 문장을 지워도 초록★ 이다 — 리뷰에서 실증됐다
 * (판별 축을 지운 뮤턴트로 60 pass / 0 fail 재현). 정본과 산출물은 다른 파일이고,
 * 팀원 런타임이 읽는 것은 ★산출물★ 이다.
 *
 * 2026-08-17 실측: 기준이 예시 나열뿐이라 한 런타임이 ★우리 저장소 PR 리뷰★ 를 외부 전송으로 읽고
 * 하루에 여러 번 멈춰 섰다. 예시를 더하는 방식은 다음 사례에서 또 멈춘다 — 그래서 축을 박았다:
 * ★누가 받는가★ 이고, 기록이 공개로 보이는지가 아니다.
 */
describe("핵심룰 — '외부 전송' 판별 축", () => {
  const approvalBullet = (md: string): string =>
    md.split("\n").find((l) => l.includes("external send")) ?? "";

  for (const runtime of ["openclaw", "hermes_agent"] as const) {
    test(`${runtime} 산출물에 판별 축이 들어간다 — 단어만 남으면 뜻이 매번 다시 만들어진다`, () => {
      const bullet = approvalBullet(buildAgentsMd({ ...claudeInput, runtime }));
      expect(bullet, "★승인 게이트 줄을 못 찾았다★").toContain("external send");
      expect(bullet, "★판별 축(누가 받는가)이 없다★").toMatch(/who receives|recipient/);
      expect(bullet, "★저장소 안 작업이 외부 전송이 아니라는 것이 빠졌다★").toMatch(/repo|PR/);
    });
  }

  test("★대조군 — 이 검사는 산출물을 본다★ (정본만 고치고 산출물을 안 고치면 빨간불)", () => {
    const bullet = approvalBullet(buildAgentsMd({ ...claudeInput, runtime: "openclaw" }));
    expect(bullet.length, "★산출물에서 그 줄 자체가 사라졌다★").toBeGreaterThan(0);
  });

  /**
   * 정본(TEAM-OS 템플릿) 쪽도 같은 축을 요구한다.
   * ★읽는 파일은 `TEAM-OS.template.md`(git 추적) 다★ — `TEAM-OS.md` 는 gitignore 된 렌더
   * 산출물이라 워크트리·새 클론·CI 에 없다. 산출물을 읽는 검사는 환경에 따라 안 돈다.
   */
  test("정본 템플릿에도 판별 축이 있다 — 산출물만 고치면 다음 렌더에 되돌아간다", () => {
    const template = readFileSync(
      join(import.meta.dir, "../../../rules/TEAM-OS.template.md"),
      "utf8",
    );
    const bullet = template.split("\n").find((l) => l.includes("Approval gate")) ?? "";
    expect(bullet, "★승인 게이트 줄을 못 찾았다★").toContain("external send");
    expect(bullet, "★판별 축(누가 받는가)이 없다★").toMatch(/who receives|recipient/);
  });
});

describe("설명 원칙 — 산출물에 다섯 줄이 다 있나", () => {
  const rule = (md: string): string => {
    const i = md.indexOf("**설명 원칙**");
    return i < 0 ? "" : md.slice(i, md.indexOf("\n\n", i));
  };

  for (const runtime of ["claude_channel", "openclaw", "hermes_agent"] as const) {
    test(`${runtime} 산출물에 설명 원칙 다섯 줄`, () => {
      const md =
        runtime === "claude_channel"
          ? buildPersona(claudeInput)
          : buildAgentsMd({ ...claudeInput, runtime });
      const block = rule(md);
      expect(block, "★설명 원칙 블록 자체가 산출물에서 사라졌다★").not.toBe("");
      expect(block, "★지운 5번이 되살아났다★").not.toContain("5. ");
      for (const n of [1, 2, 3, 4]) {
        expect(block, `★${n}번 줄이 없다★`).toContain(`\n${n}. `);
      }
      // GD 2026-09-05 — 지어낸 낱말(창구·제자리·실물)이 반복돼 2번에 넣은 문장.
      expect(block, "★'단어를 지어내지 않는다' 가 빠졌다★").toContain(
        "단어를 지어내지 않는다",
      );
      expect(block, "★'원문은 그대로 쓴다' 가 빠졌다★").toContain("원문은 그대로 쓴다");
      expect(block, "★'핵심만 얘기한다' 가 빠졌다★").toContain(
        "전달하려고 하는 핵심만 얘기한다",
      );
      expect(block, "★'말을 늘리지 않는다' 가 빠졌다★").toContain("말을 늘리지 않는다");
    });
  }
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

// ── i18n 영어룰 파일럿 override — teamOsPathFor + buildAgentsMd 임베드 경로 ──
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
  // 언어불변 라인엔 팀-특정(존대 for GD) 하드코딩 누출 없어야 — public-safe
  expect(SECTION_CORE_RULE_EN.includes("폴라이트 코리안")).toBe(false);
  expect(SECTION_CORE_RULE_EN.includes("polite Korean (존대) for GD")).toBe(false);
  // 3개 정책 블록 보존 (압축 구조: 기본실행/팀소통협업/안전검증 전체압축)
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

// ── {{OWNER}} 플레이스홀더화 (안전: 라이브=GD, 퍼블릭/no-owner={{OWNER}}) ──
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

// extractCustomPersona 룰섹션 제거 검증 (config GET fallback용, buildPersonaFromCustom 제거로 round-trip 테스트는 폐기).
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

// ─── live-fs 가드가 ★그 머신의 실 팀원 자리★ 를 지키는지 (2026-07-27 맥스튜디오 인시던트 회귀) ───
//   사고: 가드가 `~/Development` 하나만 보고 있어서, 기본값이 퍼블릭-안전(`~/b3os/members`)으로 바뀐 뒤
//   ★신규·공개 유저의 실 팀원이 통째로 가드 밖★ 이었다. 맥스튜디오 실 팀원(jane/lisa/clo)이 그 자리에
//   살아 테스트가 정체성 파일을 덮어썼다. 두 루트 모두 지키는지 못박는다.
// ★HOME 이 없으면 가드는 설계상 무동작★ (보호 대상이 전부 HOME 기준이라 지킬 것이 없다).
//   그 환경(HOME 없는 컨테이너/CI)에서 이 테스트들을 그냥 돌리면 ★수트가 통째로 빨간불★ 이 된다 —
//   결함이 아니라 전제 불성립이므로 명시적으로 건너뛴다. 조용히 통과시키지는 않는다.
const HAS_HOME = Boolean(process.env.HOME);
const guardTest = HAS_HOME ? test : test.skip;

guardTest("live-fs 가드 — 레거시(~/Development)와 퍼블릭 기본(~/b3os/members) 둘 다 막는다", () => {
  const home = process.env.HOME ?? "";
  expect(process.env.NODE_ENV).toBe("test");        // 가드는 test 에서만 — 전제 확인

  // ① 퍼블릭-안전 기본값 = 공개 유저의 실 팀원 자리. ★이게 뚫려 있던 구멍이다.★
  expect(() => assertNotLiveMemberFsUnderTest(`${home}/b3os/members/jane`, "t")).toThrow(/live-fs-guard/);
  // ② OWNER 레거시 레이아웃
  expect(() => assertNotLiveMemberFsUnderTest(`${home}/Development/steve`, "t")).toThrow(/live-fs-guard/);
  // ③ 루트 자기 자신도 (rm -rf <root> 류 차단)
  expect(() => assertNotLiveMemberFsUnderTest(`${home}/b3os/members`, "t")).toThrow(/live-fs-guard/);
  // ④ 에러는 ★어느 루트에 걸렸는지★ 알려줘야 고칠 수 있다
  expect(() => assertNotLiveMemberFsUnderTest(`${home}/b3os/members/jane`, "t")).toThrow(/보호루트/);
});

test("live-fs 가드 — temp 경로는 막지 않는다 (격리된 테스트가 정상 동작해야 함)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "guard-allow-"));
  expect(() => assertNotLiveMemberFsUnderTest(`${tmp}/jane`, "t")).not.toThrow();
  // preload 가 B3RYS_MEMBERS_ROOT 를 temp 로 세팅하므로, 격리 상태의 워크스페이스 생성은 통과해야 한다.
  expect(() => assertNotLiveMemberFsUnderTest(`${MEMBERS_ROOT}/jane`, "t")).not.toThrow();
});

test("live-fs 가드 — 명시 opt-in(B3RYS_TEST_ALLOW_LIVE_FS=1)이면 통과", () => {
  const home = process.env.HOME ?? "";
  const save = process.env.B3RYS_TEST_ALLOW_LIVE_FS;
  try {
    process.env.B3RYS_TEST_ALLOW_LIVE_FS = "1";
    expect(() => assertNotLiveMemberFsUnderTest(`${home}/b3os/members/jane`, "t")).not.toThrow();
  } finally {
    if (save === undefined) delete process.env.B3RYS_TEST_ALLOW_LIVE_FS; else process.env.B3RYS_TEST_ALLOW_LIVE_FS = save;
  }
});

// ★배선 테스트★ — 가드 함수가 옳아도 writer 가 부르지 않으면 소용없다. 실제 writer 를 태워 확인한다.
//   (savePersonaFile 은 SOUL.md 를 쓰는 유일한 통로인데 2026-07-27 까지 가드가 없었다.)
guardTest("live-fs 가드 배선 — savePersonaFile 이 실 팀원 경로를 거부한다(파일 안 만듦)", () => {
  const home = process.env.HOME ?? "";
  // ★경로를 실행마다 고유하게★ — 고정 이름이면 이전 실행이 남긴 흔적에 판정이 흔들린다
  //   (실제로 겪음: 가드를 되돌린 뮤테이션 실행이 폴더를 만들자 이후 정상 실행까지 실패).
  //   테스트가 머신의 과거 상태를 타면 그 테스트는 못 믿는다.
  const target = `${home}/b3os/members/__guard_probe_${process.pid}_${Date.now()}__/SOUL.md`;
  expect(existsSync(dirname(target))).toBe(false);   // 전제: 아직 없다
  expect(() => savePersonaFile(target, "should never be written")).toThrow(/live-fs-guard/);
  expect(existsSync(target)).toBe(false);
  expect(existsSync(dirname(target))).toBe(false);   // 빈 폴더조차 남기지 않는다
});

// ★격리가 실제로 걸렸는지★ — preload 회귀 감지. ambient B3RYS_HOME/B3RYS_MEMBERS_ROOT 가 새어들어오면
//   MEMBERS_ROOT 가 실 경로가 되고, 그 순간 가드가 정당한 테스트 쓰기를 막는다(Codex 재현 케이스).
test("preload 격리 — MEMBERS_ROOT 는 항상 temp (ambient env 가 새어들지 않는다)", () => {
  // ★opt-in 모드는 예외★ — B3OS_TEST_MEMBERS_ROOT 로 특정 루트를 겨냥한 실행은 temp 가 아닐 수 있다.
  //   그 경우까지 "항상 temp" 를 요구하면 테스트가 opt-in 자체를 거짓 실패로 만든다(Codex 재리뷰).
  if (process.env.B3OS_TEST_MEMBERS_ROOT) {
    expect(MEMBERS_ROOT).toBe(process.env.B3OS_TEST_MEMBERS_ROOT);
    expect(() => assertNotLiveMemberFsUnderTest(`${MEMBERS_ROOT}/anyone`, "t")).not.toThrow();
    return;
  }
  const t = tmpdir();
  const underTemp = MEMBERS_ROOT === t || MEMBERS_ROOT.startsWith(`${t}/`)
    || MEMBERS_ROOT.startsWith("/tmp/") || MEMBERS_ROOT.startsWith("/var/folders/");
  expect(underTemp).toBe(true);
  // 격리된 루트는 보호목록에 들어가면 안 된다 — 들어가면 테스트가 자기 워크스페이스를 못 만든다.
  expect(() => assertNotLiveMemberFsUnderTest(`${MEMBERS_ROOT}/anyone`, "t")).not.toThrow();
});

// ★경계 없는 prefix 비교 회귀★ (Codex 지적) — 이름이 겹치는 형제 폴더까지 막으면 오탐이다.
test("live-fs 가드 — 이름만 겹치는 형제 경로는 막지 않는다", () => {
  const home = process.env.HOME ?? "";
  expect(() => assertNotLiveMemberFsUnderTest(`${home}/b3os/members-evil/jane`, "t")).not.toThrow();
  expect(() => assertNotLiveMemberFsUnderTest(`${home}/Development-old/steve`, "t")).not.toThrow();
});

// `..` 로 우회되면 가드가 무의미하다.
guardTest("live-fs 가드 — 상대경로/.. 로 우회되지 않는다", () => {
  const home = process.env.HOME ?? "";
  expect(() => assertNotLiveMemberFsUnderTest(`${home}/b3os/members/../members/jane`, "t")).toThrow(/live-fs-guard/);
});

// ★opt-in override 실검증 (subprocess)★ — MEMBERS_ROOT 는 import 시점 상수라, 같은 프로세스 안에서는
//   "다른 루트로 뜬 상태" 를 만들 수 없다. 그래서 별도 프로세스를 띄워 실제로 확인한다(Codex 재리뷰 요청).
//   확인할 것 두 가지: ①지정한 non-temp 루트는 통과한다 ②그래도 실 팀원 루트는 여전히 막힌다.
guardTest("opt-in override — 지정 루트는 통과하되 실 팀원 루트 보호는 그대로", () => {
  const optRoot = "/workspace/isolated-optin";           // non-temp. 존재하지 않아도 가드 판정엔 무관
  const mod = join(import.meta.dir, "personaTemplates.ts");
  const script = `
    const m = await import(${JSON.stringify(mod)});
    const home = process.env.HOME;
    const r = { optIn: "?", legacy: "?", publicDefault: "?" };
    try { m.assertNotLiveMemberFsUnderTest(process.env.B3RYS_MEMBERS_ROOT + "/jane", "p"); r.optIn = "pass"; }
    catch { r.optIn = "blocked"; }
    try { m.assertNotLiveMemberFsUnderTest(home + "/Development/steve", "p"); r.legacy = "pass"; }
    catch { r.legacy = "blocked"; }
    try { m.assertNotLiveMemberFsUnderTest(home + "/b3os/members/jane", "p"); r.publicDefault = "pass"; }
    catch { r.publicDefault = "blocked"; }
    console.log(JSON.stringify(r));
  `;
  const out = Bun.spawnSync({
    cmd: ["bun", "-e", script],
    env: { ...process.env, NODE_ENV: "test", B3OS_TEST_MEMBERS_ROOT: optRoot, B3RYS_MEMBERS_ROOT: optRoot },
    stdout: "pipe", stderr: "pipe",
  });
  const stdout = out.stdout.toString().trim();
  expect(out.exitCode, `stderr: ${out.stderr.toString().slice(0, 400)}`).toBe(0);
  const r = JSON.parse(stdout.split("\n").pop() ?? "{}");
  expect(r.optIn).toBe("pass");            // 지정 루트엔 쓸 수 있어야 opt-in 이 의미가 있다
  expect(r.legacy).toBe("blocked");        // ★override 로도 실 팀원 보호는 안 풀린다★
  expect(r.publicDefault).toBe("blocked");
});

// override 가 ★실 팀원 루트를 가리켜도★ 보호가 풀리면 안 된다 (이 변수로 우회 금지).
guardTest("opt-in override — 실 팀원 루트를 가리키면 무시하고 계속 막는다", () => {
  const home = process.env.HOME ?? "";
  const real = `${home}/b3os/members`;
  const mod = join(import.meta.dir, "personaTemplates.ts");
  const script = `
    const m = await import(${JSON.stringify(mod)});
    try { m.assertNotLiveMemberFsUnderTest(process.env.HOME + "/b3os/members/jane", "p"); console.log("pass"); }
    catch { console.log("blocked"); }
  `;
  const out = Bun.spawnSync({
    cmd: ["bun", "-e", script],
    env: { ...process.env, NODE_ENV: "test", B3OS_TEST_MEMBERS_ROOT: real, B3RYS_MEMBERS_ROOT: real },
    stdout: "pipe", stderr: "pipe",
  });
  expect(out.exitCode, `stderr: ${out.stderr.toString().slice(0, 400)}`).toBe(0);
  expect(out.stdout.toString().trim().split("\n").pop()).toBe("blocked");
});
