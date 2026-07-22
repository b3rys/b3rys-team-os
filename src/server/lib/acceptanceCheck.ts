import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { captureConfigStatus } from "./captureConfig";
import { loadRegistry } from "./registry";
import type { AgentRecord } from "../types";

export type AcceptanceStatus = "pass" | "fail" | "info";

export interface AcceptanceItem {
  label: string;
  status: AcceptanceStatus;
  detail: string;
  fix?: string;
}

export interface AcceptanceStep {
  key: "settings" | "rules" | "ot" | "portability" | "render";
  label: string;
  checks: AcceptanceItem[];
}

export interface AcceptanceResult {
  ok: boolean;
  member: string | null;
  root: string;
  members_root: string;
  summary: Record<AcceptanceStatus, number>;
  sections: AcceptanceStep[];
}

export interface AcceptanceDeps {
  db: Database;
  registryPath: string;
  teamOsPath: string;
  rootDir?: string;
  membersRoot?: string;
}

const BLOCKER_RE =
  /xox[bap]-[0-9]|bot[0-9]{8,}:[A-Za-z0-9_-]{30,}|sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|-{5}BEGIN[^-]*PRIVATE KEY|\/Users\/[A-Za-z0-9][A-Za-z0-9._-]*\/|example|example|example|example|example_|EXAMPLE_TELEGRAM_BOT_ID|EXAMPLE_TELEGRAM_GROUP_ID/i;
const REVIEW_RE = /\bGD\b|OWNER 팀장|팀장님/;
const SECRET_RE =
  /xox[bap]-[0-9]|bot[0-9]{8,}:[A-Za-z0-9_-]{30,}|sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|-{5}BEGIN[^-]*PRIVATE KEY/i;
const ABSOLUTE_PATH_RE = /\/Users\/[A-Za-z0-9][A-Za-z0-9._-]*\//i;
const INTERNAL_ID_RE = /example|example|example|example|example_|EXAMPLE_TELEGRAM_BOT_ID|EXAMPLE_TELEGRAM_GROUP_ID/i;
// ── 렌더 무결성(2026-07-22 사고 재발방지) ──
// 7/21 사고: 공개판 테스트 렌더가 /private/tmp 스냅샷을 정본으로 박아 팀 전체가 재부팅-소실 경로를 로딩,
//   + sanitize 명칭(--direct-to-owner)이 라이브로 역류(send.sh엔 --direct-to-owner만 → exit 1). 기존 누출 스캔은
//   /Users/ 만 봐서 /private/tmp 를 놓쳤다. 이 3종을 인수테스트에서 잡는다.
const TMP_RENDER_PATH_RE = /\/private\/tmp\/|pubtest-recheck|\/tmp\/[A-Za-z0-9._-]+\/repo\//i;
const PLACEHOLDER_RE = /\{\{[A-Z_]+\}\}/;
const DIRECT_FLAG_RE = /--direct-to-[a-z-]+/g;

function getSetting(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM setting WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

function item(status: AcceptanceStatus, label: string, detail: string, fix?: string): AcceptanceItem {
  return fix ? { label, status, detail, fix } : { label, status, detail };
}

function defaultMembersRoot(): string {
  // 해석 우선순위 = personaTemplates.resolveMembersRoot 와 동일(2026-07-12 퍼블릭-안전 기본 뒤집기):
  //   B3RYS_MEMBERS_ROOT(명시) > B3RYS_HOME/members > ~/b3os/members(퍼블릭-안전 기본).
  if (process.env.B3RYS_MEMBERS_ROOT) return process.env.B3RYS_MEMBERS_ROOT;
  if (process.env.B3RYS_HOME) return join(process.env.B3RYS_HOME, "members");
  return join(process.env.HOME ?? "", "b3os", "members");
}

function loadAgents(registryPath: string): AgentRecord[] {
  try {
    return loadRegistry(registryPath);
  } catch {
    return [];
  }
}

function blockerCategory(line: string): string {
  if (SECRET_RE.test(line)) return "secret";
  if (ABSOLUTE_PATH_RE.test(line)) return "absolute-path";
  if (INTERNAL_ID_RE.test(line)) return "internal-id";
  return "blocker";
}

function settingsStep(db: Database): AcceptanceStep {
  const items: AcceptanceItem[] = [];
  const teamName = getSetting(db, "team_name");
  const ownerName = getSetting(db, "owner_name");
  const systemOp = captureConfigStatus(db);

  items.push(teamName ? item("pass", "팀 이름", teamName) : item("fail", "팀 이름", "미설정"));
  items.push(ownerName ? item("pass", "팀장 이름", ownerName) : item("info", "팀장 이름", "미설정({{OWNER}} 유지)"));
  // ★capture 봇·라우터는 그룹(팀방) 협업 전용 = 선택★ — 1:1 DM 영입엔 불필요하다.
  //   fail 로 두면 정상적인 1:1 영입도 무조건 "검증 실패"로 떠서 사용자가 막힌 걸로 오해한다
  //   (같은 그룹 기능인 바로 아래 '팀 그룹 chat_id' 는 이미 info). → info 로 낮추고 fix 안내를 단다. (PR#1 5c0a564)
  items.push(
    systemOp.has_capture_token
      ? item("pass", "capture 봇 토큰", "설정됨")
      : item("info", "capture 봇 토큰", "미설정 — 그룹(팀방) 협업 시에만 필요(1:1 DM은 정상)", "그룹 협업하려면 Settings 에서 System OP(capture) 봇 토큰을 설정하세요."),
  );
  items.push(
    systemOp.capture_group_id
      ? item("pass", "팀 그룹 chat_id", systemOp.capture_group_id)
      : item("info", "팀 그룹", "미설정(모든 그룹 처리)"),
  );
  items.push(
    systemOp.router_enabled
      ? item("pass", "라우터", "ON (agent 그룹 응답)")
      : item("info", "라우터", "OFF — 그룹 자동응답용(1:1 DM엔 불필요)", "그룹 협업하려면 Settings 에서 라우터를 ON 하세요."),
  );
  items.push(item("info", "관리자 PIN", "System OP PIN 제거됨(현재 설계상 미사용)"));

  return { key: "settings", label: "설정", checks: items };
}

function coreRulesStep(teamOsPath: string): AcceptanceStep {
  const items: AcceptanceItem[] = [];
  if (!existsSync(teamOsPath)) {
    items.push(item("fail", "TEAM-OS.md", "정본 규칙 부재"));
    return { key: "rules", label: "기본 룰", checks: items };
  }
  const content = readFileSync(teamOsPath, "utf-8");
  items.push(item("pass", "TEAM-OS.md", "존재"));
  items.push(
    content.includes("owner") && (content.includes("@멘션") || content.includes("@mention"))
      ? item("pass", "owner 판정 규칙", "§2 있음")
      : item("fail", "owner 판정 규칙", "누락"),
  );
  items.push(content.includes("BWF") ? item("pass", "BWF 정의", "있음") : item("fail", "BWF 정의", "누락"));
  items.push(
    /칸반|Tasks/.test(content)
      ? item("pass", "과제관리", "§10 있음")
      : item("fail", "과제관리", "규칙 누락"),
  );
  return { key: "rules", label: "기본 룰", checks: items };
}

function onboardingStep(member: string | null, agents: AgentRecord[], membersRoot: string): AcceptanceStep {
  const items: AcceptanceItem[] = [];
  if (!member) {
    items.push(item("info", "member", "인자 없음 - OT 단계 스킵"));
    return { key: "ot", label: "OT / 영입", checks: items };
  }

  const agent = agents.find((entry) => entry.id === member);
  if (agent) {
    items.push(item("pass", "agents.json 등록", `runtime=${agent.runtime}`));
  } else {
    items.push(item("fail", "agents.json 등록", `'${member}' 없음 (영입 미완)`));
  }

  const workspacePath = agent?.workspace_path || join(membersRoot, member);
  items.push(
    existsSync(workspacePath) && statSync(workspacePath).isDirectory()
      ? item("pass", "워크스페이스", workspacePath)
      : item("fail", "워크스페이스", `없음: ${workspacePath}`),
  );

  const personaFiles = ["CLAUDE.md", "AGENTS.md", "SOUL.md"].filter((name) => existsSync(join(workspacePath, name)));
  if (personaFiles.length > 0) {
    for (const file of personaFiles) items.push(item("pass", "페르소나 파일", file));
  } else {
    items.push(item("fail", "페르소나 파일", "CLAUDE/AGENTS/SOUL 없음"));
  }

  const agentsPath = join(workspacePath, "AGENTS.md");
  if (existsSync(agentsPath)) {
    const content = readFileSync(agentsPath, "utf-8");
    items.push(
      content.includes("📚 룰 로딩")
        ? item("pass", "룰 로딩 블록", "있음(openclaw 필독)")
        : item("info", "룰 로딩 블록", "없음(claude면 @import라 정상)"),
    );
  }

  return { key: "ot", label: "OT / 영입", checks: items };
}

function collectPortabilityFiles(rootDir: string, membersRoot: string, member: string | null): string[] {
  const files: string[] = [];
  for (const path of [join(rootDir, "rules/TEAM-OS.md"), join(rootDir, "CLAUDE.md"), join(rootDir, "AGENTS.md")]) {
    if (existsSync(path)) files.push(path);
  }

  const collectMember = (id: string) => {
    for (const name of ["AGENTS.md", "SOUL.md", "CLAUDE.md"]) {
      const path = join(membersRoot, id, name);
      if (existsSync(path)) files.push(path);
    }
  };

  if (member) {
    collectMember(member);
  } else if (existsSync(membersRoot)) {
    for (const dirent of readdirSync(membersRoot, { withFileTypes: true })) {
      if (dirent.isDirectory()) collectMember(dirent.name);
    }
  }

  return files;
}

function displayScanPath(path: string, rootDir: string, membersRoot: string): string {
  const fromRoot = relative(rootDir, path);
  if (fromRoot && !fromRoot.startsWith("..")) return fromRoot;
  const fromMembers = relative(membersRoot, path);
  if (fromMembers && !fromMembers.startsWith("..")) return `members/${fromMembers}`;
  return "external-file";
}

function portabilityStep(rootDir: string, membersRoot: string, member: string | null): AcceptanceStep {
  const files = collectPortabilityFiles(rootDir, membersRoot, member);
  const items: AcceptanceItem[] = [];

  if (files.length === 0) {
    items.push(item("info", "스캔 대상", `없음 (MEMBERS_ROOT=${membersRoot}, member=${member ?? "all"})`));
    return { key: "portability", label: "포터빌리티 / 누출", checks: items };
  }

  let blockerTotal = 0;
  let reviewTotal = 0;
  for (const path of files) {
    const rel = displayScanPath(path, rootDir, membersRoot);
    const lines = readFileSync(path, "utf-8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (BLOCKER_RE.test(line)) {
        blockerTotal += 1;
        items.push(item("fail", "BLOCKER", `${rel}:${index + 1} (${blockerCategory(line)} 패턴 검출)`));
      }
      if (REVIEW_RE.test(line)) {
        reviewTotal += 1;
      }
    });
  }

  if (blockerTotal === 0) {
    items.unshift(item("pass", "BLOCKER", "0 (시크릿/절대경로/내부ID 누출 없음)"));
  }
  items.push(item("info", "REVIEW", `${reviewTotal} (팀장명 리터럴 - 파라미터화 확인)`));

  return { key: "portability", label: "포터빌리티 / 누출", checks: items };
}

function renderIntegrityStep(rootDir: string, membersRoot: string, member: string | null): AcceptanceStep {
  const files = collectPortabilityFiles(rootDir, membersRoot, member);
  const items: AcceptanceItem[] = [];

  // send.sh 플래그 사전 — 참조된 --direct-to-* 가 실제 파서에 있는지 대조한다.
  const sendPath = join(rootDir, "skills/b3os-team-inbox/scripts/send.sh");
  const sendContent = existsSync(sendPath) ? readFileSync(sendPath, "utf-8") : "";

  let tmpHits = 0;
  let flagHits = 0;
  let placeholderHits = 0;
  for (const path of files) {
    const rel = displayScanPath(path, rootDir, membersRoot);
    const lines = readFileSync(path, "utf-8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (TMP_RENDER_PATH_RE.test(line)) {
        tmpHits += 1;
        items.push(item("fail", "임시 렌더 경로", `${rel}:${index + 1} — /private/tmp 등 재부팅 소실 경로(테스트 렌더 유출)`, "라이브 루트에서 rerender-personas 재실행 + 심링크 재지정"));
      }
      if (PLACEHOLDER_RE.test(line)) {
        placeholderHits += 1;
      }
      if (sendContent) {
        for (const m of line.matchAll(DIRECT_FLAG_RE)) {
          if (!sendContent.includes(m[0])) {
            flagHits += 1;
            items.push(item("fail", "미존재 플래그", `${rel}:${index + 1} — ${m[0]} 는 send.sh 파서에 없음`, "send.sh 실존 플래그(--direct-to-owner)로 재렌더 통일"));
          }
        }
      }
    });
  }

  // TEAM-OS.md 심링크가 소실 경로(/private/tmp)를 가리키는지 — 재부팅 시 룰 전면 소실.
  let symlinkHits = 0;
  const memberDirs = member
    ? [join(membersRoot, member)]
    : existsSync(membersRoot)
      ? readdirSync(membersRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(membersRoot, d.name))
      : [];
  for (const dir of memberDirs) {
    const teamos = join(dir, "TEAM-OS.md");
    try {
      if (existsSync(teamos) && lstatSync(teamos).isSymbolicLink() && /\/private\/tmp\//.test(readlinkSync(teamos))) {
        symlinkHits += 1;
        items.push(item("fail", "소실경로 심링크", `${relative(membersRoot, teamos)} → ${readlinkSync(teamos)}`, "라이브 rules/TEAM-OS.md 로 재지정"));
      }
    } catch {
      /* 심링크 해석 실패는 무시 */
    }
  }

  if (tmpHits === 0 && flagHits === 0 && symlinkHits === 0) {
    items.unshift(item("pass", "렌더 무결성", "임시경로·미존재플래그·소실심링크 0"));
  }
  if (placeholderHits > 0) {
    items.push(item("info", "미치환 placeholder", `${placeholderHits}건 {{...}} (owner 미설정이면 정상 — 렌더 확인)`));
  }
  if (!sendContent) {
    items.push(item("info", "플래그 대조", "send.sh 미발견 — 플래그 실존검사 스킵"));
  }

  return { key: "render", label: "렌더 무결성", checks: items };
}

export function runAcceptanceCheck(deps: AcceptanceDeps, member: string | null): AcceptanceResult {
  const rootDir = deps.rootDir ?? dirname(dirname(deps.teamOsPath));
  const membersRoot = deps.membersRoot ?? defaultMembersRoot();
  const agents = loadAgents(deps.registryPath);
  const sections = [
    settingsStep(deps.db),
    coreRulesStep(deps.teamOsPath),
    onboardingStep(member, agents, membersRoot),
    portabilityStep(rootDir, membersRoot, member),
    renderIntegrityStep(rootDir, membersRoot, member),
  ];
  const summary = sections.flatMap((section) => section.checks).reduce<Record<AcceptanceStatus, number>>(
    (acc, entry) => {
      acc[entry.status] += 1;
      return acc;
    },
    { pass: 0, fail: 0, info: 0 },
  );

  return {
    ok: summary.fail === 0,
    member,
    root: rootDir,
    members_root: membersRoot,
    summary,
    sections,
  };
}
