import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMatchers, headerPath, lintDiff, readJsonArray } from "./public-content-lint";

const agents = [
  { id: "bill", display_name: "Bill", telegram_bot_username: "team_bill_bot" },
  { id: "devon", display_name: "Devon", telegram_bot_username: "team_devon_bot" },
  { id: "codex", display_name: "Codex", telegram_bot_username: "team_codex_bot" },
  { id: "brief", display_name: "Brief", telegram_bot_username: "team_brief_bot" },
];
const projects = [{ id: "acme", name: "Acme" }];
const m = buildMatchers({ agents, projects });

const diffOf = (file: string, added: string[]) =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -1,0 +10,${added.length} @@`, ...added.map((l) => `+${l}`)].join("\n");

const kinds = (file: string, lines: string[], mm = m, allow: RegExp[] = []) => lintDiff(diffOf(file, lines), mm, allow).map((f) => f.kind);

describe("member — 팀원 이름·봇", () => {
  test("표시이름(대소문자 그대로)과 봇 username 을 잡는다", () => {
    expect(kinds("docs/a.md", ["(Devon, 2026-09-14) 이 표를 정리"])).toEqual(["member"]);
    expect(kinds("docs/a.md", ["@team_bill_bot 로 보내면"])).toEqual(["member"]);
  });
  test("코드 식별자·소문자 id 는 잡지 않는다", () => {
    expect(kinds("src/x.ts", ["const bill = billing(devonMode);"])).toEqual([]);
  });
  test("런타임 이름과 같은 이름(Codex)·흔한 낱말(Brief)은 기본 제외", () => {
    expect(kinds("docs/a.md", ["Codex 런타임으로 돌린다", "Brief summary"])).toEqual([]);
  });
});

describe("lead — 팀장 호칭·인용", () => {
  test("낱말 GD·'팀장님 (날짜'·'GD (' 를 잡는다", () => {
    expect(kinds("docs/a.md", ["`GD 답 대기` 절"])).toEqual(["lead"]);
    expect(kinds("docs/a.md", ["팀장님 (2026-09-14) 지시"])).toEqual(["lead"]);
  });
  test("GD_AGENT_ID·--direct-to-gd·direct_to_gd 는 잡지 않는다", () => {
    expect(kinds("x.sh", ["GD_AGENT_ID=bill send.sh --direct-to-gd", 'meta.reply_mode === "direct_to_gd"'])).toEqual([]);
  });
  test("인용 뒤 '라고' 는 그 줄에 팀장·GD 가 있을 때만", () => {
    expect(kinds("docs/a.md", ['팀장이 "todo 리스트 줘" 라고 하면'])).toEqual(["lead"]);
    expect(kinds("docs/a.md", ['그 팀원은 건너뛰고 "손으로" 라고 적는다'])).toEqual([]);
  });
  test("owner_name 이 주어지면 그 이름도 잡는다", () => {
    const mm = buildMatchers({ agents, projects, ownerName: "Kim Lead" });
    expect(kinds("docs/a.md", ["Kim Lead 가 정했다"], mm)).toEqual(["lead"]);
  });
});

describe("project — 등록된 프로젝트", () => {
  test("id·이름을 대소문자 무관 낱말로 잡는다", () => {
    expect(kinds("docs/a.md", ["(예: Acme)", "[acme] 핵심코드 리뷰"])).toEqual(["project", "project"]);
  });
  test("term 허용 목록에 있으면 잡지 않는다", () => {
    const mm = buildMatchers({ agents, projects, allowTerms: new Set(["acme"]) });
    expect(kinds("docs/a.md", ["Acme 로 보낸다"], mm)).toEqual([]);
  });
});

describe("경로·줄", () => {
  test("등록 파일(agents.json·projects.json)과 허용 경로는 건너뛴다", () => {
    expect(kinds("projects.json", ['"name": "Acme"'])).toEqual([]);
    expect(kinds("fixtures/x.md", ["Devon"], m, [/^fixtures\//])).toEqual([]);
  });
  test("추가된 줄만 본다 — 지운 줄·문맥 줄은 무시, 줄 번호는 새 파일 기준", () => {
    const diff = ["--- a/d.md", "+++ b/d.md", "@@ -5,3 +5,3 @@", " 문맥 Devon", "-지운 줄 Devon", "+새 줄 Devon"].join("\n");
    const f = lintDiff(diff, m);
    expect(f.length).toBe(1);
    expect(f[0]).toMatchObject({ file: "d.md", line: 6, kind: "member" });
  });
});

describe("경계·하한 (steve 뮤턴트 보강)", () => {
  test("GD 앞의 - . / 는 낱말이 아니다 — 플래그·경로·확장자", () => {
    expect(kinds("x.sh", ["run --x-GD", "open docs/GD", "file.GD"])).toEqual([]);
    expect(kinds("x.md", ["(GD 확인)"])).toEqual(["lead"]);
  });
  test("세 글자 미만 표시이름은 이름으로 쓰지 않는다", () => {
    const mm = buildMatchers({ agents: [{ id: "al", display_name: "Al" }], projects: [] });
    expect(mm.coverage.members).toBe(0);
    expect(kinds("x.md", ["Al said"], mm)).toEqual([]);
  });
  test("빈 명단이면 팀원 검사가 꺼졌음을 coverage 로 드러낸다", () => {
    const mm = buildMatchers({ agents: [], projects: [] });
    expect(mm.member).toBeNull();
    expect(mm.coverage).toEqual({ members: 0, projects: 0, owner: false });
    expect(buildMatchers({ agents, projects, ownerName: "Kim Lead" }).coverage).toEqual({ members: 6, projects: 1, owner: true });
  });
});

describe("diff 파싱 (steve 7)", () => {
  test("내용이 '++' 로 시작하는 추가 줄도 검사하고 줄 번호를 센다", () => {
    const diff = ["--- a/d.md", "+++ b/d.md", "@@ -1,0 +1,2 @@", "+++ Devon 메모", "+보통 줄 Devon"].join("\n");
    const f = lintDiff(diff, m);
    expect(f.map((x) => [x.file, x.line])).toEqual([["d.md", 1], ["d.md", 2]]);
  });
  test("따옴표로 감싼 경로를 푼다", () => {
    expect(headerPath('+++ "b/docs/a b.md"')).toBe("docs/a b.md");
    expect(headerPath("+++ b/docs/x.md\t")).toBe("docs/x.md");
  });
});

describe("readJsonArray — 못 읽으면 숨기지 않는다 (steve 2)", () => {
  test("없는 파일·JSON 아님·모양 다름은 error 를 돌려준다", () => {
    expect(readJsonArray("/no/such/file.json").error).toContain("파일 없음");
    // 소스 폴더가 아니라 OS 임시 폴더에 쓰고, 실패해도 지운다.
    const dir = mkdtempSync(join(tmpdir(), "lint-test-"));
    const tmp = join(dir, "roster.json");
    try {
      writeFileSync(tmp, "<html>");
      expect(readJsonArray(tmp, "agents").error).toContain("JSON 아님");
      writeFileSync(tmp, JSON.stringify({ other: [] }));
      expect(readJsonArray(tmp, "agents").error).toContain("모양이 다름");
      writeFileSync(tmp, JSON.stringify({ agents: [{ id: "x" }] }));
      expect(readJsonArray(tmp, "agents")).toEqual({ items: [{ id: "x" }] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  });
});
