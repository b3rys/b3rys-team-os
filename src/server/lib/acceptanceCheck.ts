import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { captureConfigStatus } from "./captureConfig";
import { loadRegistry } from "./registry";
import { teamOsSnapshot, type TeamOsSnapshot } from "./teamosProbe";
import type { AgentRecord } from "../types";

export type AcceptanceStatus = "pass" | "fail" | "info";

export interface AcceptanceItem {
  label: string;
  status: AcceptanceStatus;
  detail: string;
  fix?: string;
}

export interface AcceptanceStep {
  key: "settings" | "rules" | "ot" | "portability" | "infra";
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
  teamOsSnapshot?: (db: Database) => Pick<TeamOsSnapshot, "scheduled">;
}

// 누출/포터빌리티 탐지는 ★포맷 기반★(토큰 shape · 절대경로)만 쓴다. 특정 팀의 실값(chat_id·봇핸들·
// 사용자명)을 소스에 리터럴로 박지 않는다 — 공개 repo 가 정본이므로 어느 팀의 값도 하드코딩되면 안 되고,
// 각 팀 고유값은 자기 머신의 gitignore(.env·team.db·agents.json)에만 존재한다. 절대경로(/Users/<사용자>/)
// 탐지가 머신특화 하드코딩(주 포터빌리티 이슈)을 계속 잡고, SECRET_RE 가 토큰 shape 를 잡는다. (public=source)
const BLOCKER_RE =
  /xox[bap]-[0-9]|bot[0-9]{8,}:[A-Za-z0-9_-]{30,}|sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN[^-]*PRIVATE KEY|\/Users\/[A-Za-z0-9][A-Za-z0-9._-]*\//i;
const REVIEW_RE = /\bGD\b|GD 팀장|팀장님/;
const SECRET_RE =
  /xox[bap]-[0-9]|bot[0-9]{8,}:[A-Za-z0-9_-]{30,}|sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN[^-]*PRIVATE KEY/i;
const ABSOLUTE_PATH_RE = /\/Users\/[A-Za-z0-9][A-Za-z0-9._-]*\//i;

function getSetting(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM setting WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 팀 고유 실값(운영자 ★자기★ 값)을 settings 에서 읽어 렌더 멤버파일 누출을 동적으로 탐지한다.
// ★소스에 리터럴로 박지 않는다★(public=source) — 각 팀은 자기 값만 config 에 두고, 가드는 그걸 읽어
// escape 후 숫자경계 exact-match 한다. 미설정 값은 skip(공개 이식성 보존). 대상은 렌더 파일에 있으면
// 안 되는 ★숫자 id★(owner_chat_id·capture_group_id)만 — owner_name 은 persona 가 정당히 포함하므로
// 제외(false-positive 방지). (Codex 적대리뷰 반영: 포맷+경로만으로는 chat_id/group_id 누출 미탐지)
function buildInternalIdRe(db: Database): RegExp | null {
  const digits: string[] = [];
  const push = (v: string | null | undefined) => {
    // 그룹 chat_id 는 음수(-100…)라 부호를 떼고 숫자런만 본다 → signed/unsigned 둘 다 매칭.
    const d = v?.trim().replace(/^-/, "");
    if (d && /^\d{6,}$/.test(d) && !digits.includes(d)) digits.push(d);
  };
  push(getSetting(db, "owner_chat_id"));
  push(captureConfigStatus(db).capture_group_id);
  if (digits.length === 0) return null;
  // 숫자경계 exact-match(더 긴 숫자의 부분열 오검출 방지). digits 는 순수 숫자라 escape 무해하지만 안전상 유지.
  return new RegExp(`(?<![0-9])(?:${digits.map(escapeRegExp).join("|")})(?![0-9])`);
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

function blockerCategory(line: string, internalIdRe: RegExp | null): string {
  if (SECRET_RE.test(line)) return "secret";
  if (ABSOLUTE_PATH_RE.test(line)) return "absolute-path";
  if (internalIdRe !== null && internalIdRe.test(line)) return "internal-id";
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

function portabilityStep(
  rootDir: string,
  membersRoot: string,
  member: string | null,
  internalIdRe: RegExp | null,
): AcceptanceStep {
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
      if (BLOCKER_RE.test(line) || (internalIdRe !== null && internalIdRe.test(line))) {
        blockerTotal += 1;
        items.push(item("fail", "BLOCKER", `${rel}:${index + 1} (${blockerCategory(line, internalIdRe)} 패턴 검출)`));
      }
      if (REVIEW_RE.test(line)) {
        reviewTotal += 1;
      }
    });
  }

  if (blockerTotal === 0) {
    items.unshift(item("pass", "BLOCKER", "0 (시크릿/절대경로/설정값-누출 없음)"));
  }
  items.push(item("info", "REVIEW", `${reviewTotal} (팀장명 리터럴 - 파라미터화 확인)`));

  return { key: "portability", label: "포터빌리티 / 누출", checks: items };
}

const INFRA_SERVICES = [
  { name: "team-collab", required: true, matches: (label: string) => label.endsWith(".team-collab") },
  { name: "caffeinate", required: false, matches: (label: string) => label.endsWith(".caffeinate") },
  { name: "gateway", required: false, matches: (label: string) => label === "ai.openclaw.gateway" || label.endsWith(".gateway") },
] as const;

function infraStep(deps: AcceptanceDeps): AcceptanceStep {
  const items: AcceptanceItem[] = [];
  const scheduled = (deps.teamOsSnapshot?.(deps.db) ?? teamOsSnapshot(deps.db)).scheduled;
  const services = scheduled.filter((job) => job.kind === "service");

  for (const expected of INFRA_SERVICES) {
    const service = services.find((job) => expected.matches(job.label));
    const running = service?.running === true;
    const detail = running
      ? `${service.label} running`
      : expected.required
        ? service?.running === false
          ? `${service.label} stopped`
          : service
            ? `${service.label} 상태 미확인`
            : "미등록"
        : "미설정 — 선택";
    items.push(item(running ? "pass" : expected.required ? "fail" : "info", `${expected.required ? "필수" : "선택"} 서비스: ${expected.name}`, detail));
  }

  const failedJobs = deps.db.prepare(
    `SELECT id, last_run_at
       FROM scheduled_job
      WHERE kind = 'recurring' AND status = 'failed' AND enabled = 1
      ORDER BY id`,
  ).all() as Array<{ id: string; last_run_at: string | null }>;
  if (failedJobs.length === 0) {
    items.push(item("pass", "예약 잡 실패", "0개"));
  } else {
    for (const job of failedJobs) {
      items.push(item("fail", "예약 잡 실패", `${job.id} · last_run=${job.last_run_at ?? "-"}`));
    }
  }

  const retired = deps.db.prepare(
    `SELECT COUNT(*) AS count
       FROM scheduled_job
      WHERE enabled = 0 AND status = 'cancelled'`,
  ).get() as { count: number };
  items.push(item("info", "은퇴 잡", `은퇴 ${retired.count}개`));

  const orphanWakes = deps.db.prepare(
    `SELECT COUNT(*) AS count
       FROM message_recipient
      WHERE delivery_state = 'wake_dispatched'
        AND lease_until < datetime('now', '-1 hour')`,
  ).get() as { count: number };
  items.push(item("info", "고아 wake", orphanWakes.count === 0 ? "없음" : `reconcile 후보 ${orphanWakes.count}개`));

  return { key: "infra", label: "인프라/운영", checks: items };
}

export function runAcceptanceCheck(deps: AcceptanceDeps, member: string | null): AcceptanceResult {
  const rootDir = deps.rootDir ?? dirname(dirname(deps.teamOsPath));
  const membersRoot = deps.membersRoot ?? defaultMembersRoot();
  const agents = loadAgents(deps.registryPath);
  const sections = [
    settingsStep(deps.db),
    coreRulesStep(deps.teamOsPath),
    onboardingStep(member, agents, membersRoot),
    portabilityStep(rootDir, membersRoot, member, buildInternalIdRe(deps.db)),
    infraStep(deps),
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
