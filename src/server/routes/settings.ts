// settings — 팀 셀프 커스터마이즈 API (대시보드 Settings 탭).
//   팀명/태그라인(setting 테이블) · Mission(TEAM-OS §1) · 팀원 추가/퇴사(agents.json).
// 안전: 파일 쓰기 전 .bak 백업 + 0600 권한 유지 + 퇴사는 이름 정확 입력 가드 + audit.
// agents.json 쓰면 watchRegistry 가 자동 리로드 → in-memory agents 갱신.
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, copyFileSync, chmodSync, existsSync, mkdirSync, symlinkSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { writeMemberPersona, savePersonaFile } from "../lib/writeMemberPersona";
import { memberPaths, personaTargetsForRuntime, injectCoreRule, stripCoreRule, coreRuleFor, injectClaudeComms, stripClaudeComms } from "../lib/personaTemplates";
import { captureConfigStatus, setCaptureToken, setCaptureGroupId, setRouterEnabled, getCaptureToken } from "../lib/captureConfig";
import { configureLeadActorDb, leadActorId, leadActorSource } from "../lib/opAuth";

type PersonaRuleTarget = { file: string; op: "inject" | "strip" };
const uniqueTargets = (targets: PersonaRuleTarget[]): PersonaRuleTarget[] =>
  targets.filter((t, i, arr) => arr.findIndex((x) => x.file === t.file && x.op === t.op) === i);

// 핵심룰 적용 대상 파일 + 연산(런타임별).
//   claude  → CLAUDE.md(loadingFile) 에 핵심룰 주입, SOUL.md(persona_file)는 strip.
//   openclaw/hermes/codex → 로딩 정본 AGENTS.md 에만 주입, SOUL.md(persona_file)에선 제거(중복/2배 가중 방지).
function coreRuleTargets(personaFile: string, wsPath: string, runtime: string): PersonaRuleTarget[] {
  const targets = personaTargetsForRuntime(runtime, wsPath, personaFile);
  return uniqueTargets([
    { file: targets.loadingFile, op: "inject" },
    { file: targets.personaFile, op: "strip" },
  ]);
}

// Claude 전용 소통 섹션 타깃 — claude_channel CLAUDE.md만 inject. 비-Claude는 혹시 있으면 strip(절대 안 남게).
function claudeCommsTargets(personaFile: string, wsPath: string, runtime: string): PersonaRuleTarget[] {
  const targets = personaTargetsForRuntime(runtime, wsPath, personaFile);
  if (runtime === "claude_channel") return uniqueTargets([
    { file: targets.loadingFile, op: "inject" },
    { file: targets.personaFile, op: "strip" },
  ]);
  return uniqueTargets([
    { file: targets.loadingFile, op: "strip" },
    { file: targets.personaFile, op: "strip" },
  ]);
}
import { isAgentOff, restartAgent, setAgentEnabled, restartAll, stopAll, clearAgentOff } from "../lib/agentControl";
import { removeCodexBridgeFiles } from "../runtimes/codex/launcher";
import { removeClaudeBridgeFiles } from "../runtimes/claude/launcher";
import { rotateBotToken, validateBotToken } from "../lib/rotateToken";
import {
  activateMember, approveOpenclawPairing, withInitialLeadCapabilities, withLeadCapabilities, archiveWorkspace, removeBusWake,
  RUNTIMES, STATUS_BY_RUNTIME, teardownRuntime, swapRuntime,
} from "../lib/activation";
import { checkRuntimeAuth } from "../lib/runtimeAuth";
import { verifyFirstModelCall, type FirstModelCallResult } from "../lib/runtimeSubscription";
import { hasCapability } from "../lib/capabilities";
import { getNormalApprovers } from "../lib/approvals";
import { hasSlackTokenFile, loadAgentCreds, saveAgentCreds, removeAgentCreds, slackTokensDir, postMessage } from "../lib/slack";
import { renderAndRepoint, TEAM_OS_TEMPLATE_PATH, LIVE_TEAM_OS_PATH } from "../lib/teamOsRender";
import { latestCaptureNonBotSender } from "../lib/telegramLeadDetection";

// Phase1 리팩터: removePathWithRetries 구현은 activation.ts로 이관(teardownRuntime이 사용). 기존
// import 경로(settings.test.ts의 `import { removePathWithRetries } from "./settings"`)는 재export로 보존.
export { removePathWithRetries } from "../lib/activation";

export interface SettingsDeps {
  db: Database;
  registryPath: string; // agents.json
  teamOsPath: string; // rules/TEAM-OS.md
  appendAudit: (db: Database, actor: string, event: string, target: string, meta?: unknown) => void;
  onRegistryChanged?: () => void;
  // 퇴사 시 workspace 보관 함수(주입 가능). 기본=실제 archiveWorkspace(라이브 ~/Development/<id> mv).
  // 테스트는 noop을 주입해 실제 워크스페이스를 건드리지 않게 한다(test 격리 — 라이브 멤버 mv 사고 방지).
  archiveWorkspace?: (id: string, runtime: string) => string | null;
  // ★런타임 파일정리(removeClaudeBridgeFiles 등 실 HOME 경로 rm) 건너뜀 — 테스트가 실제 ~/.claude·~/.hermes·~/.openclaw를 지우지 않게(test 격리).
  //   이게 없어서 `bun test`의 DELETE /members/steve 테스트가 실제 telegram-steve 폴더를 삭제하던 치명 버그(OWNER 2026-07-01 fs_usage로 확정). 테스트는 true 주입.
  skipRuntimeCleanup?: boolean;
  checkRuntimeAuth?: typeof checkRuntimeAuth;
  activateMember?: typeof activateMember;
  // 활성화 직후 실제 첫 모델 호출 검증. 테스트는 mock 주입으로 라이브 계정/외부 상태 의존을 끊는다.
  firstModelCall?: (input: { id: string; runtime: string; workspacePath?: string }) => Promise<FirstModelCallResult>;
  // 텔레그램 API 호출 주입점. 테스트는 fake fetch를 넣어 실제 봇 토큰/getUpdates 의존을 끊는다.
  telegramFetch?: typeof fetch;
  // provision 봇 토큰 getMe 검증 주입점. 테스트는 stub 로 실 텔레그램 getMe 의존을 끊는다.
  validateBotToken?: typeof validateBotToken;
}

// RUNTIMES/STATUS_BY_RUNTIME는 activation.ts 정본을 import(swapRuntime과 단일 소스 공유, Phase1 리팩터).
// 영입 시 자동 SVG 아이콘(icons.ts ICONS 키) — 기존 팀원과 안 겹치게 팔레트에서 배정(결정적).
const ICON_PALETTE = ["wrench", "code", "flask-conical", "cpu", "landmark", "newspaper", "user-circle", "route", "layers", "shield", "workflow", "database", "monitor", "search", "inbox", "megaphone", "file-text", "users"];
const ICON_RE = /^[a-z][a-z0-9-]{0,31}$/; // ICONS 키 형식
const ICON_COLOR_KEYS = ["green", "orange", "yellow", "blue", "red", "violet"]; // web/agentColors.ts와 동기화
// 창립멤버 6명은 기본아이콘(web/icons AGENT_ICON)을 agents.json에 저장하지 않아 used 가 못 봄 → reserved 로 고정.
const FOUNDER_ICONS = ["wrench", "code", "flask-conical", "cpu", "landmark", "newspaper"];
function pickIcon(list: any[], requested: string): string {
  if (requested && ICON_RE.test(requested)) return requested; // 직접 지정 우선
  const used = new Set<string>([...FOUNDER_ICONS, ...list.map((a) => a.icon).filter(Boolean)]);
  return ICON_PALETTE.find((e) => !used.has(e)) ?? ICON_PALETTE[list.length % ICON_PALETTE.length] ?? "bot";
}
const ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const LEAD_ID_RE = /^[a-z0-9_-]{1,40}$/;
const SLACK_USER_ID_RE = /^U[A-Z0-9]{8,}$/;
const SLACK_APP_ID_RE = /^A[A-Z0-9]{8,}$/;
const SLACK_BOT_TOKEN_RE = /^xoxb-[A-Za-z0-9-]+$/;
const SLACK_APP_TOKEN_RE = /^xapp-[A-Za-z0-9-]+$/;
const SLACK_SECRET_RE = /^[A-Za-z0-9]{24,}$/;
// §1 Mission 블록: 헤더 다음부터 "## 2." 직전까지(lookahead 로 다음 절은 소비 안 함).
// 제목 텍스트는 무관하게 "## 1." 만 매칭 — 운영판("Mission & Identity")·공개 템플릿("정체성 (팀마다 채움)") 양쪽 동작.
const MISSION_RE = /(## 1\.[^\n]*\n)([\s\S]*?)(?=\n## 2\.)/;

function getSetting(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM setting WHERE key = ?").get(key) as { value: string } | null;
  return row ? row.value : null;
}
function setSetting(db: Database, key: string, value: string) {
  db.query(
    "INSERT INTO setting (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
  ).run(key, value);
}

// 전체 핵심룰 재적용 롤백 가능 시간(6시간). 지나면 롤백 버튼/엔드포인트가 거부.
const ROLLBACK_WINDOW_MS = 6 * 60 * 60 * 1000;

// 공개 빌드 여부. 전체 핵심룰 재적용/롤백은 라이브 전용 운영 기능이라 공개판에선 비활성(OWNER 2026-06-30).
// make-public-release.sh 가 아래 false→true 로 뒤집어 공개판 엔드포인트가 404를 반환한다. (live·테스트는 false라 정상 동작)
export const PUBLIC_BUILD = true; // PUBLIC-BUILD-FLIP:PUBLIC_BUILD (public build: live-only endpoints disabled)
// codex·b3os_native = 라이브 검증 후 공개(OWNER 2026-07-05). 공개빌드(PUBLIC_BUILD=true)에선 영입·스왑에서 서버측 거부(UI 숨김의 방어 이중화).
const LIVE_ONLY_RUNTIMES = new Set(["b3os_native", "codex"]);
export const allowedRuntimes = (publicBuild = PUBLIC_BUILD) =>
  [...RUNTIMES].filter((runtime) => !publicBuild || !LIVE_ONLY_RUNTIMES.has(runtime));

// 파일 쓰기 전 .bak 백업 (직전 1세대) — 사고 시 복구 경로 확보.
// seen: 한 요청 내 같은 파일을 두 번 백업하지 않게(예: core-rule loop → comms loop이 같은 CLAUDE.md를
//   다시 .bak로 덮어 진짜 원본을 잃던 버그 방지). 첫 백업만 원본으로 보존.
function backup(path: string, seen?: Set<string>) {
  if (seen?.has(path)) return;
  if (existsSync(path)) copyFileSync(path, path + ".bak");
  seen?.add(path);
}

// 능력 카탈로그 — "팀/에이전트가 뭘 할 수 있나"(OT의 핵심 + 3과제①). 점차 실제 스킬/툴 연동.
const CAPABILITIES = [
  { key: "tasks", label: "과제 칸반(Tasks)", desc: "계획·실행중·완료 추적, owner별 과제", category: "surface" },
  { key: "reports", label: "보고서 포털(Reports)", desc: "MD→아이폰 HTML 보고서 게시·검색", category: "surface" },
  { key: "search", label: "팀 검색(Search)", desc: "메시지·문서·작업 통합 검색", category: "surface" },
  { key: "settings", label: "팀 설정(Settings)", desc: "팀명·미션·팀원 영입/퇴사·아이콘", category: "surface" },
  { key: "agents", label: "팀원 상태(Agents)", desc: "팀원·런타임·상태·persona 보기", category: "surface" },
  { key: "audit", label: "감사 로그(Audit)", desc: "누가 무엇을 했는지 기록", category: "surface" },
  { key: "owner_routing", label: "담당자 자동 배정", desc: "@멘션>답장>sticky로 메시지 owner 1명 판정", category: "ops" },
  { key: "feedback_mode", label: "피드백 기본모드", desc: "요청 받으면 받음/못함/ETA/1차의견 중 하나 즉시", category: "ops" },
  { key: "continuation_guard", label: "진행 지속 가드", desc: "실행 과제가 조용히 사라지지 않게 감시", category: "ops" },
  { key: "b3os-report", label: "보고서 작성 스킬", desc: "MD→아이폰 HTML+SVG 보고서", category: "skill" },
  { key: "b3rys-make-ppt", label: "발표 슬라이드 스킬", desc: "16:9 HTML 덱", category: "skill" },
  { key: "b3os-harness-playbook", label: "병렬 실행 플레이북", desc: "sub agent 병렬 결정·품질 플레이북(트리거 우선)", category: "skill" },
  { key: "b3os-task-mgmt", label: "과제 관리 스킬", desc: "칸반·handoff·continuation", category: "skill" },
  { key: "b3os-team-member-lifecycle", label: "팀원 영입/온보딩 스킬", desc: "영입·OT·퇴사 lifecycle", category: "skill" },
  { key: "rt_claude_channel", label: "Claude 런타임", desc: "claude_channel(tmux)", category: "runtime" },
  { key: "rt_openclaw", label: "OpenClaw 런타임", desc: "openclaw(gateway)", category: "runtime" },
  { key: "rt_hermes_agent", label: "Hermes 런타임", desc: "hermes_agent", category: "runtime" },
  { key: "rt_codex", label: "Codex 런타임", desc: "codex(OpenAI Codex CLI)", category: "runtime" },
];

// 공개빌드(PUBLIC_BUILD=true)에선 라이브전용 런타임(codex·b3os_native)의 능력카탈로그 항목(rt_*)을
// 표시 표면에서도 숨긴다 — 영입/스왑은 이미 서버측 거부(runtime_not_public)로 막지만, /capabilities·OT번들
// 같은 ★표시★ 경로가 무필터면 "보이는데 못 고르는" 모순 + 비공개 런타임 노출이 된다.
const VISIBLE_CAPABILITIES = CAPABILITIES.filter(
  (cap) =>
    !(PUBLIC_BUILD && cap.category === "runtime" && cap.key.startsWith("rt_") && LIVE_ONLY_RUNTIMES.has(cap.key.slice(3))),
);

// OT 단계: 등록→프로비저닝→인증점검→OT번들→합류. recruit 시 register=done, 나머지 pending.
//   preflight = provision(토큰저장)과 bundle(활성화) 사이 런타임 oauth 로그인 사전점검(미로그인이면 활성화 차단).
function initOtSteps() {
  return [
    { key: "register", label: "등록", state: "done", detail: "레지스트리에 등록됨" },
    { key: "provision", label: "프로비저닝", state: "pending", detail: "런타임·봇 연결 대기" },
    { key: "preflight", label: "런타임 인증 점검", state: "pending", detail: "선택한 런타임 CLI·로그인 상태 확인 대기" },
    { key: "bundle", label: "OT 자료 전달", state: "pending", detail: "TEAM-OS·역할·팀현황·능력 카탈로그·팀 스킬 목록" },
    { key: "join", label: "합류 확인", state: "pending", detail: "첫 응답(ack) 대기" },
  ];
}
// 단계 배열 → 현재 stage 파생.
function deriveStage(steps: Array<{ key: string; state: string }>): string {
  if (steps.some((s) => s.state === "failed")) return "failed";
  if (steps.every((s) => s.state === "done")) return "joined";
  const next = steps.find((s) => s.state !== "done");
  return next ? next.key : "joined";
}
function otId(): string {
  return "ot_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}
// 셀프서비스 프로비저닝 입력 마커 — provision 단계에서 고객(또는 빌)이 봇 토큰을 넣어야 함.
// 전송 성공 시 서버가 null 로 내려 패널 자동 닫힘. fields 제네릭(런타임이 2번째 입력 필요하면 추가).
const AWAITING_BOT_TOKEN = {
  kind: "bot_token",
  hint: "이 팀원을 깨우려면 텔레그램 봇 토큰이 필요해요 (BotFather /newbot)",
  fields: [{ key: "bot_token", label: "텔레그램 봇 토큰", secret: true, hint: "BotFather에서 /newbot 으로 받은 토큰" }],
};

function slackMemberStatus(agent: any) {
  const creds = loadAgentCreds(agent.id);
  const hasIdentity = typeof agent.slack_bot_user_id === "string" && agent.slack_bot_user_id.trim().length > 0;
  const hasToken = !!creds?.bot_token;
  const hasSigningSecret = !!creds?.signing_secret;
  const hasAppId = !!creds?.app_id;
  const hasAppToken = !!creds?.app_token;
  const mode = agent.slack_connection_mode === "socket" ? "socket" : "webhook";
  const state = hasIdentity && hasToken
    ? "ready"
    : hasIdentity || hasToken || hasSlackTokenFile(agent.id)
      ? "partial"
      : "not_connected";
  return {
    id: agent.id,
    display_name: agent.display_name,
    slack_bot_user_id: agent.slack_bot_user_id ?? null,
    slack_app_name: agent.slack_app_name ?? null,
    slack_connection_mode: mode,
    state,
    has_identity: hasIdentity,
    has_token: hasToken,
    has_signing_secret: hasSigningSecret,
    has_app_id: hasAppId,
    has_app_token: hasAppToken,
    mode,
    socket_ready: mode === "socket" && hasToken && hasAppToken,
    supports_bot_mentions: hasIdentity && hasToken,
  };
}

export function createSettingsApp(deps: SettingsDeps): Hono {
  const { db, registryPath, teamOsPath, appendAudit } = deps;
  configureLeadActorDb(db);
  const doArchiveWorkspace = deps.archiveWorkspace ?? archiveWorkspace; // 주입 없으면 실제 함수(라이브). 테스트는 noop 주입.
  const skipRuntimeCleanup = deps.skipRuntimeCleanup ?? false; // 테스트=true → 실 HOME(~/.claude 등) 파일 rm 건너뜀(라이브 봇 데이터 삭제 방지).
  const doCheckRuntimeAuth = deps.checkRuntimeAuth ?? checkRuntimeAuth;
  const doActivateMember = deps.activateMember ?? activateMember;
  const firstModelCall = deps.firstModelCall ?? verifyFirstModelCall;
  const telegramFetch = deps.telegramFetch ?? fetch;
  const doValidateBotToken = deps.validateBotToken ?? validateBotToken;
  const app = new Hono();
  // Option B: 라이브 rules 에서만 템플릿 편집 + {{OWNER}} 렌더를 쓴다. 테스트(임시 경로)는
  // teamOsPath(=TEAM-OS.md) 그대로 읽고 렌더는 skip(실파일 부작용 방지).
  const isLiveRules = teamOsPath === LIVE_TEAM_OS_PATH; // 포터블: repo명 무관, 렌더본 경로와 정확 일치(공개 repo명 b3rys-team-os 대응)
  // 편집 대상: 라이브 rules면 템플릿({{OWNER}} 보존). 단 공개 릴리스는 TEAM-OS.template.md 를
  // 제외하고 내용을 TEAM-OS.md 로만 복사하므로(make-public-release.sh), 템플릿 파일이 없으면
  // teamOsPath(=TEAM-OS.md)로 폴백한다. 폴백 없으면 신규 공개설치서 GET/PUT /mission 이 없는
  // 템플릿을 readFileSync → 500 read_failed (OWNER 2026-07-02).
  const teamOsEditPath = isLiveRules && existsSync(TEAM_OS_TEMPLATE_PATH) ? TEAM_OS_TEMPLATE_PATH : teamOsPath;
  const renderOwner = () => {
    if (!isLiveRules) return;
    try {
      const claudeIds = readAgents().filter((a: any) => a.runtime === "claude_channel").map((a: any) => a.id);
      const v = getSetting(db, "owner_name");
      const r = renderAndRepoint(v, claudeIds);
      appendAudit(db, "user", "teamos_owner_rendered", "team", { owner: r.owner, repointed: r.repointed, ok: r.ok });
    } catch { /* best-effort */ }
  };
  // 셋업 완료 = 필수 3개 모두 채워짐(팀 이름·팀장 ID·팀장 이름) — OWNER 2026-07-10. 스킬/API 경로도 이 게이트로 필수 강제.
  const setupComplete = () => Boolean(getSetting(db, "team_name")?.trim() && getSetting(db, "lead_id")?.trim() && getSetting(db, "owner_name")?.trim());

  // ── 팀 정체성: 팀명·태그라인 ──────────────────────────────────────
  app.get("/settings", (c) => {
    return c.json({
      team_name: getSetting(db, "team_name") ?? "",
      lead_id: getSetting(db, "lead_id") ?? "",
      setup_complete: setupComplete(),
      lead_actor_id: leadActorId(db),
      lead_actor_source: leadActorSource(db),
      tagline: getSetting(db, "tagline") ?? "",
      // owner_name: Mission/페르소나의 {{OWNER}} 자리표시자를 채우는 팀장 이름. 비면 {{OWNER}} 유지.
      owner_name: getSetting(db, "owner_name") ?? "",
      // owner_chat_id: 팀장 텔레그램 chat_id(옵션). codex/외부런타임 봇 발신자 게이트 시드에 사용 — 봇이 팀장에게만 응답,
      //   낯선 사람이 팀장 AI 예산 소진 방지. 비면 claude 페어링에서 자동 도출(claude 첫영입) or 타런타임 첫영입 시 입력 유도.
      owner_chat_id: getSetting(db, "owner_chat_id") ?? "",
      // locale: UI/메시지 언어. 기본 ko, 'en' 토글. (OWNER 2026-06-30 — 라이브·공개 다 ko기본, 토글로 en)
      locale: getSetting(db, "locale") === "en" ? "en" : "ko",
      // dm_capture: 팀원↔팀장 1:1 DM 을 dm_message 로 적재할지. 팀원 세션 기록을 읽는 기능이라 끌 수 있어야 한다(OWNER 2026-07-14).
      //   끄면 대시보드 DM 통계와 bus-recall 의 1:1 조회만 비고, 버스·위임·발신은 전부 그대로 돈다(크리티컬 아님).
      dm_capture: getSetting(db, "dm_capture") !== "off",
    });
  });

  app.put("/settings", async (c) => {
    let body: { team_name?: unknown; lead_id?: unknown; tagline?: unknown; owner_name?: unknown; owner_chat_id?: unknown; locale?: unknown; dm_capture?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const out: Record<string, string> = {};
    if (body.team_name !== undefined) {
      if (typeof body.team_name !== "string" || body.team_name.length > 20)
        return c.json({ error: "team_name_invalid" }, 400);
      setSetting(db, "team_name", body.team_name.trim());
      out.team_name = body.team_name.trim();
    }
    if (body.lead_id !== undefined) {
      if (typeof body.lead_id !== "string" || !LEAD_ID_RE.test(body.lead_id.trim()))
        return c.json({ error: "lead_id_invalid", hint: "소문자/숫자/-/_, 1~40자" }, 400);
      const v = body.lead_id.trim();
      setSetting(db, "lead_id", v);
      out.lead_id = v;
    }
    if (body.tagline !== undefined) {
      if (typeof body.tagline !== "string" || body.tagline.length > 200)
        return c.json({ error: "tagline_invalid" }, 400);
      setSetting(db, "tagline", body.tagline.trim());
      out.tagline = body.tagline.trim();
    }
    if (body.owner_name !== undefined) {
      if (typeof body.owner_name !== "string" || body.owner_name.length > 40)
        return c.json({ error: "owner_name_invalid" }, 400);
      const v = body.owner_name.trim();
      setSetting(db, "owner_name", v);
      out.owner_name = v;
      renderOwner(); // {{OWNER}} 렌더본 갱신 + 심링크 (라이브에서만)
    }
    if (body.owner_chat_id !== undefined) {
      // 옵션 필드: 빈값 허용(비우면 자동도출/입력유도). 값 있으면 텔레그램 chat_id(정수, 그룹은 음수 가능)만.
      if (typeof body.owner_chat_id !== "string") return c.json({ error: "owner_chat_id_invalid" }, 400);
      const v = body.owner_chat_id.trim();
      if (v !== "" && !/^-?\d{1,20}$/.test(v)) return c.json({ error: "owner_chat_id_invalid", hint: "텔레그램 chat_id(숫자)만, 비우면 자동도출" }, 400);
      setSetting(db, "owner_chat_id", v);
      out.owner_chat_id = v;
    }
    if (body.locale !== undefined) {
      // UI/메시지 언어 토글. 'ko'|'en'만, 그 외는 기본 ko. 라이브 읽기라 즉시 반영(재시작 불요).
      const loc = body.locale === "en" ? "en" : "ko";
      setSetting(db, "locale", loc);
      out.locale = loc;
    }
    if (body.dm_capture !== undefined) {
      // 1:1 DM 적재 on/off. 워커가 매 tick 읽으므로 재시작 없이 즉시 반영.
      const on = body.dm_capture !== false && body.dm_capture !== "off";
      setSetting(db, "dm_capture", on ? "on" : "off");
      out.dm_capture = on ? "on" : "off";
    }
    appendAudit(db, "user", "settings_updated", "team", out);
    return c.json({ ok: true, ...out, setup_complete: setupComplete(), lead_actor_id: leadActorId(db), lead_actor_source: leadActorSource(db) });
  });

  // ── Mission: TEAM-OS §1 읽기/쓰기 ────────────────────────────────
  app.get("/mission", (c) => {
    try {
      const text = readFileSync(teamOsEditPath, "utf-8"); // 편집 대상=템플릿({{OWNER}} 보존)
      const m = text.match(MISSION_RE);
      if (!m) return c.json({ error: "mission_section_not_found" }, 500);
      return c.json({ mission: (m[2] ?? "").trim() });
    } catch (e) {
      return c.json({ error: "read_failed", detail: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.put("/mission", async (c) => {
    let body: { mission?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (typeof body.mission !== "string" || !body.mission.trim())
      return c.json({ error: "mission_must_be_nonempty_string" }, 400);
    if (Buffer.byteLength(body.mission, "utf-8") > 8192)
      return c.json({ error: "too_large", max_bytes: 8192 }, 413);
    let text: string;
    try {
      text = readFileSync(teamOsEditPath, "utf-8"); // 편집 대상=템플릿
    } catch (e) {
      return c.json({ error: "read_failed", detail: e instanceof Error ? e.message : String(e) }, 500);
    }
    const m = text.match(MISSION_RE);
    if (!m || m.index === undefined) return c.json({ error: "mission_section_not_found" }, 500);
    const replacement = (m[1] ?? "") + "\n" + body.mission.trim() + "\n";
    const next = text.slice(0, m.index) + replacement + text.slice(m.index + m[0].length);
    try {
      backup(teamOsEditPath);
      writeFileSync(teamOsEditPath, next, "utf-8"); // 템플릿에 저장 → 아래 renderTeamOs가 rules/TEAM-OS.md 갱신
    } catch (e) {
      return c.json({ error: "write_failed", detail: e instanceof Error ? e.message : String(e) }, 500);
    }
    renderOwner(); // 템플릿(mission) 변경 → rules/TEAM-OS.md 렌더본 갱신 (라이브에서만)
    appendAudit(db, "user", "mission_updated", "team", { bytes: Buffer.byteLength(body.mission) });
    return c.json({ ok: true });
  });

  // ── 팀원: 목록·추가·퇴사 (agents.json) ───────────────────────────
  function readAgents(): any[] {
    // agents.json 은 런타임 상태(untracked) — 없으면 빈 로스터(공개 clone 첫 부팅/셋업 전). writeAgents 가 곧 생성.
    let raw: string;
    try {
      raw = readFileSync(registryPath, "utf-8");
    } catch (e: any) {
      if (e?.code === "ENOENT") return [];
      throw e;
    }
    return JSON.parse(raw);
  }
  function writeAgents(list: any[]) {
    backup(registryPath);
    writeFileSync(registryPath, JSON.stringify(list, null, 2) + "\n", "utf-8");
    try {
      chmodSync(registryPath, 0o600); // 0600 권한 유지(원본이 private)
    } catch {
      /* best-effort */
    }
    deps.onRegistryChanged?.();
  }

  app.get("/members", (c) => {
    try {
      const list = readAgents();
      return c.json(
        list.map((a) => ({ id: a.id, display_name: a.display_name, role: a.role, runtime: a.runtime, avatar_emoji: a.avatar_emoji, icon: a.icon ?? null, icon_color: a.icon_color ?? null, off: isAgentOff(a.id) })),
      );
    } catch (e) {
      return c.json({ error: "read_failed", detail: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // ★영입 게이트(팀명·팀장ID·팀장이름)는 ★UI 전용★ 이다 — 이 엔드포인트는 그 셋을 보지 않는다.★
  //   (2026-07-17 실측: setup_complete=false 여도 이 POST 는 200 으로 통과한다)
  //   화면의 setupComplete() 배너는 ★UX 안내지 보안 경계가 아니다.★ 로컬 대시보드라 그대로 두지만,
  //   ★"게이트가 있으니 안전" 으로 읽지 말 것.★ 서버 강제가 필요해지면 여기에 조건을 넣어야 한다.
  app.post("/members", async (c) => {
    let body: { id?: unknown; display_name?: unknown; role?: unknown; runtime?: unknown; avatar_emoji?: unknown; icon?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const id = typeof body.id === "string" ? body.id.trim().toLowerCase() : "";
    const display_name = typeof body.display_name === "string" ? body.display_name.trim() : "";
    const role = typeof body.role === "string" ? body.role.trim() : "";
    const runtime = typeof body.runtime === "string" ? body.runtime.trim() : "claude_channel";
    if (!ID_RE.test(id)) return c.json({ error: "id_invalid", hint: "소문자/숫자/-/_, 2~32자, 영문자 시작" }, 400);
    if (!display_name) return c.json({ error: "display_name_required" }, 400);
    if (!role) return c.json({ error: "role_required" }, 400);
    if (!RUNTIMES.has(runtime)) return c.json({ error: "runtime_invalid", allowed: allowedRuntimes() }, 400);
    if (PUBLIC_BUILD && LIVE_ONLY_RUNTIMES.has(runtime)) return c.json({ error: "runtime_not_public", hint: "선택한 런타임은 공개 빌드에서 지원하지 않습니다." }, 400);

    let list: any[];
    try {
      list = readAgents();
    } catch (e) {
      return c.json({ error: "read_failed", detail: e instanceof Error ? e.message : String(e) }, 500);
    }
    if (list.some((a) => a.id === id)) {
      // OT 중단으로 ot_id 를 잃었을 때 재개할 수 있도록, 진행 중인 OT id 를 409 에 실어준다(#6 재개경로).
      const existingOt = db.query("SELECT id FROM ot WHERE member_id = ? ORDER BY updated_at DESC LIMIT 1").get(id) as any;
      return c.json({ error: "id_exists", id, ot_id: existingOt?.id ?? null, hint: existingOt?.id ? "이미 등록된 팀원 — 재영입 대신 이 ot_id 로 진행 중인 OT 를 이어가세요." : undefined }, 409);
    }
    // 최소 유효 엔트리. 봇/tmux/slack 실제 연결은 별도(b3os-team-member-lifecycle 스킬).
    const _paths = memberPaths(id, runtime);
    const entry = withInitialLeadCapabilities(list, {
      id,
      display_name,
      nicknames: [id, display_name],
      role,
      response_mode: "mention-only",
      runtime,
      status_provider: STATUS_BY_RUNTIME[runtime] ?? "claude_tmux",
      workspace_path: _paths.workspace_path,
      persona_file: _paths.persona_file,
      avatar_emoji: "🤖",
      icon: pickIcon(list, typeof body.icon === "string" ? body.icon.trim() : ""),
      moderator_eligible: false,
    });
    try {
      writeAgents([...list, entry]);
    } catch (e) {
      return c.json({ error: "write_failed", detail: e instanceof Error ? e.message : String(e) }, 500);
    }
    appendAudit(db, "user", "member_added", id, { display_name, role, runtime });
    return c.json({ ok: true, member: { id, display_name, role, runtime, icon: entry.icon }, note: "봇·tmux·slack 연결은 lifecycle 스킬로 별도 설정" });
  });

  // 아이콘 교체: SVG icon(ICONS 키) 그리고/또는 icon_color(팔레트 키) 갱신(본인 Settings 페이지에서 클릭→선택).
  app.patch("/members/:id", async (c) => {
    const id = c.req.param("id");
    let body: { icon?: unknown; icon_color?: unknown; nicknames?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const hasIcon = body.icon !== undefined;
    const hasColor = body.icon_color !== undefined;
    const hasNicks = body.nicknames !== undefined;
    if (!hasIcon && !hasColor && !hasNicks) return c.json({ error: "no_change" }, 400);

    const icon = typeof body.icon === "string" ? body.icon.trim() : "";
    if (hasIcon && !ICON_RE.test(icon)) return c.json({ error: "icon_invalid" }, 400);

    const iconColor = typeof body.icon_color === "string" ? body.icon_color.trim() : "";
    if (hasColor && !ICON_COLOR_KEYS.includes(iconColor)) return c.json({ error: "icon_color_invalid" }, 400);

    // nicknames = 추가 멘션 별칭(id·display_name 외에 @로 부를 이름). 라우터가 별칭으로 owner 매칭에 사용.
    //   각 토큰 공백 없이 ≤32자, 최대 8개, @접두 제거. 빈 배열이면 별칭 제거(undefined). (OWNER 맥북테스트 2026-07-03)
    let nicknames: string[] = [];
    if (hasNicks) {
      if (!Array.isArray(body.nicknames)) return c.json({ error: "nicknames_invalid", hint: "문자열 배열이어야 합니다" }, 400);
      nicknames = (body.nicknames as unknown[])
        .map((n) => (typeof n === "string" ? n.trim().replace(/^@+/, "") : ""))
        .filter(Boolean);
      if (nicknames.some((n) => n.length > 32 || /\s/.test(n))) return c.json({ error: "nicknames_invalid", hint: "각 별칭은 공백 없이 32자 이하" }, 400);
      if (nicknames.length > 8) return c.json({ error: "nicknames_invalid", hint: "최대 8개" }, 400);
    }

    let list: any[];
    try {
      list = readAgents();
    } catch (e) {
      return c.json({ error: "read_failed", detail: e instanceof Error ? e.message : String(e) }, 500);
    }
    const target = list.find((a) => a.id === id);
    if (!target) return c.json({ error: "unknown_member", id }, 404);
    if (hasIcon) target.icon = icon;
    if (hasColor) target.icon_color = iconColor;
    if (hasNicks) target.nicknames = nicknames.length ? nicknames : undefined;
    try {
      writeAgents(list);
    } catch (e) {
      return c.json({ error: "write_failed", detail: e instanceof Error ? e.message : String(e) }, 500);
    }
    appendAudit(db, "user", "member_icon_updated", id, { ...(hasIcon ? { icon } : {}), ...(hasColor ? { icon_color: iconColor } : {}), ...(hasNicks ? { nicknames } : {}) });
    return c.json({ ok: true, id, ...(hasIcon ? { icon } : {}), ...(hasColor ? { icon_color: iconColor } : {}), ...(hasNicks ? { nicknames } : {}) });
  });

  // 퇴사: confirm_name 이 display_name 과 정확히 일치해야 진행(오발 방지).
  app.delete("/members/:id", async (c) => {
    const id = c.req.param("id");
    let body: { confirm_name?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "confirm_name_required", hint: "퇴사하려면 팀원 이름을 정확히 입력하세요" }, 400);
    }
    let list: any[];
    try {
      list = readAgents();
    } catch (e) {
      return c.json({ error: "read_failed", detail: e instanceof Error ? e.message : String(e) }, 500);
    }
    const target = list.find((a) => a.id === id);
    if (!target) return c.json({ error: "unknown_member", id }, 404);
    if (typeof body.confirm_name !== "string" || body.confirm_name.trim() !== target.display_name)
      return c.json({ error: "confirm_name_mismatch", hint: `정확히 "${target.display_name}" 입력 필요` }, 400);
    if (list.length <= 1) return c.json({ error: "cannot_remove_last_member" }, 400);
    // ★base hermes 프로필(b3ryshermes) 멤버 퇴사 차단 — 모든 hermes 멤버의 공유 auth.json 소스+clone 원본이라 정상 퇴사 대상이 아님(하네스 재검증 LOW-MED: 삭제 시 런타임 전멸, gateway만 정지해도 auth refresh 위험). 아래 프로필-dir 가드는 defense-in-depth. OWNER 2026-07-02.
    if (target.runtime === "hermes_agent" && ((target as any).hermes_profile ?? id) === "b3ryshermes")
      return c.json({ error: "cannot_offboard_base_hermes_profile", hint: "b3ryshermes는 모든 hermes 멤버가 공유하는 base 프로필(auth 소스)입니다. 이 멤버는 퇴사 대상이 아닙니다 — 필요 시 인프라 재구성으로 별도 처리하세요." }, 400);
    // ⚠ 레지스트리 제거(writeAgents)는 런타임 cleanup 이후로 미룬다 — setAgentEnabled→setHermes가 ambientAgents()로 프로필을 조회하는데, 먼저 지우면 profile≠id(기존 hermes=b3ryshermes)일 때 오프로필을 stop함(Codex 크로스리뷰 #4). OWNER 2026-07-01.
    // 4-branch 런타임 teardown(codex/claude_channel/hermes_agent/openclaw) = teardownRuntime()로 추출(activation.ts,
    // Phase1 리팩터) — swap-runtime(신규 엔드포인트)과 이 함수를 공유한다. 동작은 원본과 동일(각 분기·가드·retry 그대로).
    await teardownRuntime(id, target.runtime, target, { skip: skipRuntimeCleanup });
    // 이제 레지스트리에서 제거 커밋 — 위 런타임 cleanup(setHermes의 프로필 조회 포함)이 끝난 뒤라야 안전(Codex #4). OWNER 2026-07-01.
    try {
      const remaining = list.filter((a) => a.id !== id);
      // ★sole coordinator 삭제 시 재할당 — coordinator 를 가진 멤버를 지우면 팀에 0명이 되어 라우팅 fallback 이
      //   죽는다(coordinatorId 경고 + 미배정 메시지 유실). 잔여 멤버 중 coordinator 가 없으면 첫 멤버에게 부여
      //   (withInitialLeadCapabilities 는 첫 영입에만 주고 삭제엔 재할당 없던 갭 — OWNER 맥북 클린테스트 2026-07-03).
      //   ★승계도 첫 영입과 같은 '팀 리드' 능력 묶음을 쓴다(withLeadCapabilities 단일 출처).★
      //   coordinator 만 넘기면 새 리드가 팀 맥락(full_context)을 못 봐서 첫 영입 리드와 권한이 달라진다.
      if (remaining.length > 0 && !remaining.some((a) => hasCapability(a, "coordinator"))) {
        const heir = remaining[0];
        heir.capabilities = withLeadCapabilities(heir.capabilities);
        appendAudit(db, "system", "coordinator_reassigned", heir.id, { from: id });
      }
      writeAgents(remaining);
    } catch (e) {
      return c.json({ error: "write_failed", detail: e instanceof Error ? e.message : String(e) }, 500);
    }
    // ★off-list + bus-wake allowlist 정리(deleted≠off) — 안 지우면 재영입 agent가 게이트웨이는 떠도 버스 suppress+ghost wake(하네스 #1·#2 systemic breaker, openclaw/hermes 재영입 실패 근본). OWNER 2026-07-01.
    try { clearAgentOff(id); } catch { /* best-effort */ }
    try { removeBusWake(id); } catch { /* best-effort */ }
    // 프로비저닝 토큰(var/secrets/<id>.bot-token) 정리 — 퇴사 후 살아있는 봇 credential 잔존 방지(전 런타임 공통, 하네스 LOW). OWNER 2026-07-01.
    if (/^[a-z0-9_-]+$/i.test(id)) {
      try { const tp = join(dirname(registryPath), "var", "secrets", `${id}.bot-token`); if (existsSync(tp)) rmSync(tp); } catch { /* best-effort */ }
    }
    // 슬랙 토큰(slack-tokens/<id>.env) 정리 — 퇴사한 멤버의 슬랙 연결도 revoke(퇴사=봇·tmux·게이트웨이·슬랙 완전 disconnect 일관성, OWNER 2026-07-02). SLACK_TOKENS_DIR env라 테스트 격리됨.
    let slackRevoked = false;
    try { slackRevoked = removeAgentCreds(id).removed; } catch { /* best-effort */ }
    // workspace 보관(archive) — 삭제 아니라 .archived/<id>-<ts> 로 mv. 재영입 잔재 충돌 방지 + 데이터 보존(best-effort).
    let archivedTo: string | null = null;
    try { archivedTo = doArchiveWorkspace(id, target.runtime); } catch { /* best-effort */ }
    // OT 레코드 정리 — 퇴사 시 진행/완료 OT를 지워 orphan(재영입 충돌 · Settings 잔상) 방지. (OWNER 2026-07-01)
    try { db.query("DELETE FROM ot WHERE member_id = ?").run(id); } catch { /* best-effort */ }
    appendAudit(db, "user", "member_removed", id, { display_name: target.display_name, archived: archivedTo, slack_revoked: slackRevoked });
    return c.json({ ok: true, removed: { id, display_name: target.display_name, archived: archivedTo, slack_revoked: slackRevoked } });
  });

  // 런타임 스왑(claude_channel ↔ codex ↔ openclaw ↔ hermes_agent) — offboard(delete+recruit)와 달리
  // MEMORY.md·memory/*.md·TODO.md·워크스페이스를 그대로 둔 채 런타임만 교체한다(swapRuntime, activation.ts).
  // exec 게이트(APPROVAL_EXECUTION_ENABLED)는 swapRuntime 내부 STEP0에서 레지스트리 변경 전에 거부한다
  // (teardown-then-stuck-halfway 방지 — TEAM-OS §4 self-mod 게이트와 동일 원칙).
  app.post("/members/:id/swap-runtime", async (c) => {
    const id = c.req.param("id");
    let body: { target_runtime?: unknown; confirm_name?: unknown; bot_token?: unknown } = {};
    try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid_json" }, 400); }
    const targetRuntime = typeof body.target_runtime === "string" ? body.target_runtime.trim() : "";
    const bot_token = typeof body.bot_token === "string" && body.bot_token.trim() ? body.bot_token.trim() : undefined;
    if (!targetRuntime) return c.json({ ok: false, error: "target_runtime_required" }, 400);
    if (PUBLIC_BUILD && LIVE_ONLY_RUNTIMES.has(targetRuntime)) return c.json({ ok: false, error: "runtime_not_public", hint: "선택한 런타임은 공개 빌드에서 지원하지 않습니다." }, 400);

    // ★파괴적 작업(런타임 죽였다 다시 살림) — offboard처럼 팀원 이름 정확 입력을 요구해 오발 방지(OWNER 2026-07-04 승인).
    const swapTarget = readAgents().find((a: any) => a.id === id);
    if (!swapTarget) return c.json({ ok: false, error: "unknown_member", code: "unknown_member" }, 404);
    if (typeof body.confirm_name !== "string" || body.confirm_name.trim() !== swapTarget.display_name)
      return c.json({ ok: false, error: "confirm_name_mismatch", hint: `정확히 "${swapTarget.display_name}" 입력 필요` }, 400);

    // teardownRuntime 은 skipRuntimeCleanup(테스트 격리 플래그)을 그대로 물려받는다 — offboard와 동일 규약.
    const boundTeardownRuntime: typeof teardownRuntime = (tid, runtime, agent) => teardownRuntime(tid, runtime, agent, { skip: skipRuntimeCleanup });

    const result = await swapRuntime(
      db,
      { id, targetRuntime, registryPath, bot_token },
      { checkRuntimeAuth: doCheckRuntimeAuth, activateMember: doActivateMember, teardownRuntime: boundTeardownRuntime },
    );
    // 성공/실패/롤백 무관 항상 재동기화 — swapRuntime이 agents.json을 직접 쓰므로 in-memory/DB 캐시를 맞춘다.
    deps.onRegistryChanged?.();
    appendAudit(db, "user", result.ok ? "member_swap_done" : "member_swap_failed", id, {
      target_runtime: targetRuntime, ok: result.ok, error: result.error ?? null, code: result.code ?? null,
    });
    const status = result.ok
      ? 200
      : result.code === "unknown_member" ? 404
      : result.code === "execution_off" ? 403
      : 400; // no_op·invalid_runtime·base_hermes_guard·preflight_blocked·read_failed·registry_write_failed·activate_failed
    return c.json(result, status);
  });

  // ── 능력 카탈로그 (?role=&runtime= 는 향후 per-member 맞춤용 예약) ──
  app.get("/capabilities", (c) => c.json(VISIBLE_CAPABILITIES));

  // ── Slack: Telegram과 같은 지원 채널로 쓰기 위한 상태/설정 API ────────
  app.get("/slack/status", (c) => {
    let list: any[];
    try { list = readAgents(); } catch (e) { return c.json({ error: "read_failed", detail: e instanceof Error ? e.message : String(e) }, 500); }
    const members = list.map(slackMemberStatus);
    return c.json({
      enabled: (process.env.TEAM_SLACK_POLL_ENABLED ?? "1") !== "0",
      channels: (process.env.TEAM_SLACK_POLL_CHANNELS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      poll_interval_ms: Number(process.env.TEAM_SLACK_POLL_INTERVAL_MS ?? 20_000),
      token_agent: process.env.TEAM_SLACK_POLL_TOKEN_AGENT ?? null,
      tokens_dir: slackTokensDir(),
      members,
      summary: {
        ready: members.filter((m) => m.state === "ready").length,
        partial: members.filter((m) => m.state === "partial").length,
        not_connected: members.filter((m) => m.state === "not_connected").length,
      },
      notes: [
        "Slack bot-to-bot mention support is handled by slackPoll/routes/slack; author self-trigger is excluded and a bot loop guard limits repeated bot-authored triggers.",
        "Human Slack workspace install/permission approval still has to happen in Slack, but token and identity wiring can be completed here.",
      ],
    });
  });

  // 라이브 헬스 — /slack/status는 '파일 존재' 기반이라 죽은 앱(account_inactive)도 ready로 뜬다.
  // 여기서 토큰별 auth.test를 병렬 실행해 '진짜' 상태를 준다. 마법사가 '재설치 필요' 배지에 사용.
  // effective: ready(토큰 유효) / token_invalid(토큰은 있는데 죽음=재설치 필요) / not_connected / partial.
  app.get("/slack/health", async (c) => {
    let list: any[];
    try { list = readAgents(); } catch (e) { return c.json({ error: "read_failed", detail: e instanceof Error ? e.message : String(e) }, 500); }
    const members = await Promise.all(list.map(async (a) => {
      const base = slackMemberStatus(a);
      const creds = loadAgentCreds(a.id);
      if (!creds?.bot_token) {
        return { ...base, live_ok: false, live_error: null, live_user_id: null, effective: base.state };
      }
      try {
        const res = await fetch("https://slack.com/api/auth.test", { headers: { Authorization: `Bearer ${creds.bot_token}` } });
        const data = (await res.json()) as { ok?: boolean; error?: string; user_id?: string };
        return {
          ...base,
          live_ok: !!data.ok,
          live_error: data.error ?? null,
          live_user_id: data.user_id ?? null,
          effective: data.ok ? "ready" : "token_invalid",
        };
      } catch (e) {
        return { ...base, live_ok: false, live_error: e instanceof Error ? e.message : String(e), live_user_id: null, effective: "check_failed" };
      }
    }));
    const eff = (s: string) => members.filter((m) => m.effective === s).length;
    return c.json({
      members,
      summary: {
        ready: eff("ready"),
        token_invalid: eff("token_invalid"),
        check_failed: eff("check_failed"),
        partial: eff("partial"),
        not_connected: eff("not_connected"),
      },
    });
  });

  const updateMemberSlack = async (c: any) => {
    const id = c.req.param("id");
    let body: {
      slack_bot_user_id?: unknown;
      slack_app_name?: unknown;
      slack_app_id?: unknown;
      slack_bot_token?: unknown;
      slack_signing_secret?: unknown;
      slack_app_token?: unknown;
      slack_connection_mode?: unknown;
    };
    try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid_json" }, 400); }

    const slack_bot_user_id = typeof body.slack_bot_user_id === "string" ? body.slack_bot_user_id.trim().toUpperCase() : undefined;
    const slack_app_name = typeof body.slack_app_name === "string" ? body.slack_app_name.trim() : undefined;
    const slack_app_id = typeof body.slack_app_id === "string" ? body.slack_app_id.trim().toUpperCase() : undefined;
    const slack_bot_token = typeof body.slack_bot_token === "string" ? body.slack_bot_token.trim() : undefined;
    const slack_signing_secret = typeof body.slack_signing_secret === "string" ? body.slack_signing_secret.trim() : undefined;
    const slack_app_token = typeof body.slack_app_token === "string" ? body.slack_app_token.trim() : undefined;
    const slack_connection_mode = typeof body.slack_connection_mode === "string" ? body.slack_connection_mode.trim().toLowerCase() : undefined;

    if (slack_bot_user_id !== undefined && slack_bot_user_id !== "" && !SLACK_USER_ID_RE.test(slack_bot_user_id)) {
      return c.json({ ok: false, error: "slack_bot_user_id_invalid", hint: "Slack Bot User ID는 U로 시작합니다. 예: U0B4XTFG3E1" }, 400);
    }
    if (slack_app_id !== undefined && slack_app_id !== "" && !SLACK_APP_ID_RE.test(slack_app_id)) {
      return c.json({ ok: false, error: "slack_app_id_invalid", hint: "Slack App ID는 A로 시작합니다." }, 400);
    }
    if (slack_bot_token !== undefined && slack_bot_token !== "" && !SLACK_BOT_TOKEN_RE.test(slack_bot_token)) {
      return c.json({ ok: false, error: "slack_bot_token_invalid", hint: "Bot token은 xoxb- 로 시작해야 합니다." }, 400);
    }
    if (slack_signing_secret !== undefined && slack_signing_secret !== "" && !SLACK_SECRET_RE.test(slack_signing_secret)) {
      return c.json({ ok: false, error: "slack_signing_secret_invalid", hint: "Signing secret 값을 전체 복사해 주세요." }, 400);
    }
    if (slack_app_token !== undefined && slack_app_token !== "" && !SLACK_APP_TOKEN_RE.test(slack_app_token)) {
      return c.json({ ok: false, error: "slack_app_token_invalid", hint: "App-level token은 xapp- 로 시작해야 합니다." }, 400);
    }
    if (slack_connection_mode !== undefined && slack_connection_mode !== "" && slack_connection_mode !== "webhook" && slack_connection_mode !== "socket") {
      return c.json({ ok: false, error: "slack_connection_mode_invalid", hint: "Slack connection mode는 webhook 또는 socket이어야 합니다." }, 400);
    }

    let list: any[];
    try { list = readAgents(); } catch (e) { return c.json({ ok: false, error: "read_failed", detail: e instanceof Error ? e.message : String(e) }, 500); }
    const target = list.find((a) => a.id === id);
    if (!target) return c.json({ ok: false, error: "unknown_member", id }, 404);

    if (slack_bot_user_id !== undefined) {
      target.slack_bot_user_id = slack_bot_user_id || null;
      target.channel_identities = { ...(target.channel_identities ?? {}), ...(slack_bot_user_id ? { slack: slack_bot_user_id } : {}) };
      if (!slack_bot_user_id && target.channel_identities) delete target.channel_identities.slack;
    }
    if (slack_app_name !== undefined) target.slack_app_name = slack_app_name || null;
    if (slack_connection_mode === "webhook" || slack_connection_mode === "socket") {
      target.slack_connection_mode = slack_connection_mode;
    }
    const existingCreds = loadAgentCreds(id);
    if (target.slack_connection_mode === "socket" && !slack_app_token && !existingCreds?.app_token) {
      return c.json({ ok: false, error: "slack_app_token_required_for_socket", hint: "Socket Mode에는 xapp- App-Level Token이 필요합니다." }, 400);
    }

    const tokenInput: { bot_token?: string; signing_secret?: string; app_id?: string; app_token?: string } = {};
    if (slack_bot_token) tokenInput.bot_token = slack_bot_token;
    if (slack_signing_secret) tokenInput.signing_secret = slack_signing_secret;
    if (slack_app_id) tokenInput.app_id = slack_app_id;
    if (slack_app_token) tokenInput.app_token = slack_app_token;
    let tokenUpdated: string[] = [];
    try {
      if (Object.keys(tokenInput).length > 0) {
        tokenUpdated = saveAgentCreds(id, tokenInput).updated;
      }
      // Bot User ID 자동채움 — 봇 토큰이 있고 식별자가 비어 있으면 auth.test로 자동 설정(OWNER가 수동으로 못 찾던 값. 멘션 라우팅에 필수).
      if (!target.slack_bot_user_id) {
        const botToken = slack_bot_token || existingCreds?.bot_token;
        if (botToken) {
          try {
            const res = await fetch("https://slack.com/api/auth.test", { headers: { Authorization: `Bearer ${botToken}` } });
            const data = (await res.json()) as { ok?: boolean; user_id?: string };
            if (data.ok && data.user_id) {
              target.slack_bot_user_id = data.user_id;
              target.channel_identities = { ...(target.channel_identities ?? {}), slack: data.user_id };
            }
          } catch { /* 자동채움 실패해도 토큰 저장은 진행 */ }
        }
      }
      writeAgents(list);
    } catch (e) {
      return c.json({ ok: false, error: "write_failed", detail: e instanceof Error ? e.message : String(e) }, 500);
    }

    appendAudit(db, "user", "member_slack_configured", id, {
      slack_bot_user_id: target.slack_bot_user_id ?? null,
      slack_app_name: target.slack_app_name ?? null,
      token_updated: tokenUpdated.length > 0,
      fields_updated: tokenUpdated,
    });
    return c.json({ ok: true, member: slackMemberStatus(target), token_updated: tokenUpdated.length > 0, fields_updated: tokenUpdated });
  };
  app.post("/members/:id/slack", updateMemberSlack);

  app.post("/members/:id/slack/check", async (c) => {
    const id = c.req.param("id");
    let agent: any = null;
    try { agent = readAgents().find((a) => a.id === id) ?? null; } catch { /* ignore */ }
    if (!agent) return c.json({ ok: false, error: "unknown_member", id }, 404);
    const creds = loadAgentCreds(id);
    if (!creds?.bot_token) return c.json({ ok: false, error: "no_slack_token", status: slackMemberStatus(agent) }, 400);
    try {
      const res = await fetch("https://slack.com/api/auth.test", {
        headers: { Authorization: `Bearer ${creds.bot_token}` },
      });
      const data = (await res.json()) as { ok?: boolean; user_id?: string; bot_id?: string; team?: string; error?: string };
      appendAudit(db, "user", data.ok ? "member_slack_check_ok" : "member_slack_check_failed", id, { error: data.error ?? null });
      return c.json({
        ok: !!data.ok,
        error: data.error ?? null,
        user_id: data.user_id ?? null,
        bot_id: data.bot_id ?? null,
        team: data.team ?? null,
        matches_registry: data.user_id ? data.user_id === (agent.slack_bot_user_id ?? null) : null,
        status: slackMemberStatus(agent),
      });
    } catch (e) {
      appendAudit(db, "user", "member_slack_check_failed", id, { error: e instanceof Error ? e.message : String(e) });
      return c.json({ ok: false, error: "slack_auth_test_failed", detail: e instanceof Error ? e.message : String(e), status: slackMemberStatus(agent) }, 502);
    }
  });

  // ── Slack 연동 마법사 백엔드 (test-post / reinstall-info / revoke) ──────
  // 채널에 실제 게시해 봇 멤버십+권한을 검증. 마법사 "연결 확인" 단계.
  app.post("/members/:id/slack/test-post", async (c) => {
    const id = c.req.param("id");
    let agent: any = null;
    try { agent = readAgents().find((a) => a.id === id) ?? null; } catch { /* ignore */ }
    if (!agent) return c.json({ ok: false, error: "unknown_member", id }, 404);
    const creds = loadAgentCreds(id);
    if (!creds?.bot_token) return c.json({ ok: false, error: "no_slack_token", status: slackMemberStatus(agent) }, 400);
    let body: { channel?: unknown; text?: unknown } = {};
    try { body = await c.req.json(); } catch { /* optional body */ }
    const channel = typeof body.channel === "string" && body.channel.trim()
      ? body.channel.trim()
      : (process.env.TEAM_SLACK_POLL_CHANNELS ?? "").split(",")[0]!.trim();
    const text = typeof body.text === "string" && body.text.trim()
      ? body.text.trim()
      : `✅ Slack 연동 테스트 — ${agent.display_name}(${id}) 봇이 이 채널에 정상 게시합니다.`;
    const result = await postMessage({ bot_token: creds.bot_token, channel, text });
    const hint = result.ok
      ? null
      : result.error === "not_in_channel" || result.error === "channel_not_found"
        ? "봇이 채널 멤버가 아닙니다. Slack 채널에서 봇을 초대하세요 (/invite @봇)."
        : result.error === "missing_scope"
          ? "앱에 chat:write 권한이 없습니다. 앱 scope 추가 후 재설치하세요."
          : result.error === "account_inactive"
            ? "슬랙 앱이 비활성/삭제 상태입니다. 앱 재설치가 필요합니다."
            : null;
    appendAudit(db, "user", result.ok ? "member_slack_test_post_ok" : "member_slack_test_post_failed", id, { channel, error: result.error ?? null });
    return c.json({ ok: !!result.ok, channel, ts: result.ts ?? null, error: result.error ?? null, hint });
  });

  // 재설치/신규 연동 프리필 — 마법사가 폼·매니페스트·Event URL 자동 채움.
  app.get("/members/:id/slack/reinstall-info", (c) => {
    const id = c.req.param("id");
    let agent: any = null;
    try { agent = readAgents().find((a) => a.id === id) ?? null; } catch { /* ignore */ }
    if (!agent) return c.json({ ok: false, error: "unknown_member", id }, 404);
    const creds = loadAgentCreds(id);
    const publicBase = (process.env.TEAM_PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
    if (!publicBase) {
      return c.json({
        ok: false,
        error: "missing_public_base_url",
        hint: "Slack 매니페스트 생성 전 TEAM_PUBLIC_BASE_URL을 공개 HTTPS 도메인/터널로 설정하세요",
      }, 400);
    }
    const eventUrl = `${publicBase}/team/api/slack/events`;
    const channel = (process.env.TEAM_SLACK_POLL_CHANNELS ?? "").split(",")[0]!.trim();
    const scopes = ["app_mentions:read", "chat:write", "groups:history", "channels:history"];
    const appName = agent.slack_app_name || `owner ${id}`;
    return c.json({
      ok: true,
      id,
      display_name: agent.display_name,
      slack_app_name: agent.slack_app_name ?? null,
      slack_app_id: creds?.app_id ?? null,
      slack_bot_user_id: agent.slack_bot_user_id ?? null,
      state: slackMemberStatus(agent).state,
      event_request_url: eventUrl,
      channel,
      needed_scopes: scopes,
      manifest: {
        display_information: { name: appName },
        features: { bot_user: { display_name: agent.slack_app_name || `gd_${id}`, always_online: true } },
        oauth_config: { scopes: { bot: scopes } },
        settings: { event_subscriptions: { request_url: eventUrl, bot_events: ["app_mention"] }, org_deploy_enabled: false, socket_mode_enabled: false },
      },
    });
  });

  // 연동 해제 — 토큰 파일 삭제 + (기본) agents.json 슬랙 신원 정리.
  app.post("/members/:id/slack/revoke", async (c) => {
    const id = c.req.param("id");
    let list: any[];
    try { list = readAgents(); } catch (e) { return c.json({ ok: false, error: "read_failed", detail: e instanceof Error ? e.message : String(e) }, 500); }
    const target = list.find((a) => a.id === id);
    if (!target) return c.json({ ok: false, error: "unknown_member", id }, 404);
    let body: { keep_identity?: unknown } = {};
    try { body = await c.req.json(); } catch { /* optional */ }
    const keepIdentity = body.keep_identity === true;
    const removed = removeAgentCreds(id).removed;
    if (!keepIdentity) {
      target.slack_bot_user_id = null;
      target.slack_app_name = null;
      if (target.channel_identities) delete target.channel_identities.slack;
    }
    try { writeAgents(list); } catch (e) { return c.json({ ok: false, error: "write_failed", detail: e instanceof Error ? e.message : String(e) }, 500); }
    appendAudit(db, "user", "member_slack_revoked", id, { removed_token: removed, kept_identity: keepIdentity });
    return c.json({ ok: true, removed_token: removed, member: slackMemberStatus(target) });
  });

  // ── 영입(recruit) = 등록 + OT(오리엔테이션) 시작 ─────────────────
  app.post("/members/recruit", async (c) => {
    let body: { id?: unknown; display_name?: unknown; role?: unknown; runtime?: unknown; nicknames?: unknown; persona?: unknown; icon?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
    if (!setupComplete()) {
      return c.json({
        error: "setup_incomplete",
        message: "먼저 팀명·팀장ID·팀장이름 세팅",
        setup_complete: false,
        missing: {
          team_name: !getSetting(db, "team_name")?.trim(),
          lead_id: !getSetting(db, "lead_id")?.trim(),
          owner_name: !getSetting(db, "owner_name")?.trim(),
        },
      }, 400);
    }
    const id = typeof body.id === "string" ? body.id.trim().toLowerCase() : "";
    const display_name = typeof body.display_name === "string" ? body.display_name.trim() : "";
    const role = typeof body.role === "string" ? body.role.trim() : "";
    const runtime = typeof body.runtime === "string" ? body.runtime.trim() : "claude_channel";
    if (!ID_RE.test(id)) return c.json({ error: "id_invalid", hint: "소문자/숫자/-/_, 2~32자, 영문자 시작" }, 400);
    if (!display_name) return c.json({ error: "display_name_required" }, 400);
    if (!role) return c.json({ error: "role_required" }, 400);
    if (!RUNTIMES.has(runtime)) return c.json({ error: "runtime_invalid", allowed: allowedRuntimes() }, 400);
    if (PUBLIC_BUILD && LIVE_ONLY_RUNTIMES.has(runtime)) return c.json({ error: "runtime_not_public", hint: "선택한 런타임은 공개 빌드에서 지원하지 않습니다." }, 400);
    let list: any[];
    try { list = readAgents(); } catch (e) { return c.json({ error: "read_failed", detail: e instanceof Error ? e.message : String(e) }, 500); }
    if (list.some((a) => a.id === id)) {
      // OT 중단으로 ot_id 를 잃었을 때 재개할 수 있도록, 진행 중인 OT id 를 409 에 실어준다(#6 재개경로).
      const existingOt = db.query("SELECT id FROM ot WHERE member_id = ? ORDER BY updated_at DESC LIMIT 1").get(id) as any;
      return c.json({ error: "id_exists", id, ot_id: existingOt?.id ?? null, hint: existingOt?.id ? "이미 등록된 팀원 — 재영입 대신 이 ot_id 로 진행 중인 OT 를 이어가세요." : undefined }, 409);
    }
    const icon = pickIcon(list, typeof body.icon === "string" ? body.icon.trim() : "");
    // 멘션 별칭(쉼표 구분) — @멘션 라우팅용. 사용자 입력 + id/이름(라우팅 보장) 합집합, 중복 제거. 비우면 [id, display_name].
    const rawNick = typeof body.nicknames === "string" ? body.nicknames : "";
    const nicknames = [...new Set([...rawNick.split(",").map((s) => s.trim()).filter(Boolean), id, display_name])];
    const _paths = memberPaths(id, runtime);
    const entry = withInitialLeadCapabilities(list, {
      id, display_name, nicknames, role,
      response_mode: "mention-only", runtime,
      status_provider: STATUS_BY_RUNTIME[runtime] ?? "claude_tmux",
      workspace_path: _paths.workspace_path, persona_file: _paths.persona_file,
      avatar_emoji: "🤖", icon, moderator_eligible: false,
    });
    try { writeAgents([...list, entry]); } catch (e) { return c.json({ error: "write_failed", detail: e instanceof Error ? e.message : String(e) }, 500); }
    const persona = typeof body.persona === "string" ? body.persona : "";
    // 페르소나 파일 = 통일 템플릿(정체성 + 팀 공통규칙은 TEAM-OS include/참조, 복붙 안 함).
    // 이미 존재하면 덮어쓰지 않음(수동 작성 보호). 실패해도 영입은 진행(best-effort).
    let persona_written = false;
    try {
      // ★룰 렌더와 persona 저장은 분리★ (OWNER 2026-07-17): writeMemberPersona=룰(CLAUDE/AGENTS.md), SOUL 은 안 건드림.
      writeMemberPersona({ id, display_name, role, runtime, workspace_path: _paths.workspace_path, persona_file: _paths.persona_file, owner_name: getSetting(db, "owner_name") ?? undefined, team_name: getSetting(db, "team_name") ?? undefined, team_collect_enabled: false /* 수집 오케스트레이션 제거 (2026-07-13) — collector 가 직접 모아 직접 보고한다 */ });
      if (persona && persona.trim()) savePersonaFile(_paths.persona_file, persona);   // persona 값 = SOUL.md 에만
      // ★합류 플래그: 첫 발화 자기소개+OT를 '합류 직후 1회'만 하게 하는 마커(sectionFirstContact 가 이 파일 있을 때만 소개→후 rm). 영입 때만 심음 → 재시작·재활성화는 반복 안 함. OWNER 2026-07-19.
      try { writeFileSync(join(_paths.workspace_path, ".b3os-just-joined"), "joined\n"); } catch { /* best-effort */ }
      persona_written = true;
      // claude_channel: CLAUDE.md 의 `@TEAM-OS.md`(상대) 가 풀리도록 workspace 에 심링크 생성(Steve 패턴).
      if (runtime === "claude_channel") {
        const link = join(_paths.workspace_path, "TEAM-OS.md");
        if (!existsSync(link)) {
          symlinkSync(LIVE_TEAM_OS_PATH, link); // 포터블: 렌더본 절대경로(REPO_ROOT 기준)
        }
      }
    } catch (e) {
      appendAudit(db, "user", "persona_write_failed", id, { error: e instanceof Error ? e.message : String(e) });
    }
    const id_ot = otId();
    const steps = initOtSteps();
    db.query("INSERT INTO ot (id, member_id, stage, steps_json, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))")
      .run(id_ot, id, deriveStage(steps), JSON.stringify({ steps, persona, awaiting_input: AWAITING_BOT_TOKEN }));
    appendAudit(db, "user", "member_recruited", id, { display_name, role, runtime, ot_id: id_ot, persona_written });
    return c.json({ ok: true, ot_id: id_ot, member: { id, display_name, role, runtime, icon }, persona_file: _paths.persona_file, persona_written });
  });

  // 페르소나 핵심룰 재적용 — 기존 팀원 페르소나의 "## ⭐ 핵심 룰"만 현재 템플릿(멈춤장치·통신·conti)으로 교체.
  // 정체·능력 등 커스텀은 보존. 직접 파일 덮어쓰기는 self-mod(차단)이므로 서버가 OWNER 인증 탭에 실행(터미널 0).
  // forin 폭주 후 전 팀원에 'member처럼' norms 주입하는 경로(OWNER 2026-06-11).
  app.post("/members/:id/regenerate-persona", (c) => {
    if (PUBLIC_BUILD) return c.json({ error: "live_only", hint: "핵심룰 재적용은 라이브 전용입니다." }, 404);
    const id = c.req.param("id");
    let agent: any = null;
    try { agent = readAgents().find((a) => a.id === id) ?? null; } catch { /* ignore */ }
    if (!agent) return c.json({ error: "unknown_member", id }, 404);
    const runtime = agent.runtime ?? "claude_channel";
    // agents.json 의 실제 경로 우선(id≠워크스페이스 폴더명인 팀원 대응). 없으면 id기반 폴백.
    const fb = memberPaths(id, runtime);
    const personaFile = (agent.persona_file as string) || fb.persona_file;
    const wsPath = (agent.workspace_path as string) || fb.workspace_path;
    const updated: string[] = [], skipped: string[] = [];
    const owner = getSetting(db, "owner_name") ?? undefined; // 라이브 → 핵심룰 {{OWNER}}를 팀장 이름으로 치환
    const team = getSetting(db, "team_name") ?? undefined; // 라이브 → 핵심룰 {{TEAM}}를 팀 이름으로 치환
    const backedUp = new Set<string>(); // 요청 내 파일별 1회만 백업(원본 .bak 보존)
    for (const { file: f, op } of coreRuleTargets(personaFile, wsPath, runtime)) {
      try {
        if (!existsSync(f)) { skipped.push(`${f}(없음)`); continue; }
        const cur = readFileSync(f, "utf-8");
        const next = op === "inject" ? injectCoreRule(cur, coreRuleFor(id, owner, team, false /* 수집 오케스트레이션 제거 (2026-07-13) — collector 가 직접 모아 직접 보고한다 */, runtime)) : stripCoreRule(cur);
        if (next === cur) { skipped.push(`${f}(변경없음)`); continue; }
        backup(f, backedUp);
        writeFileSync(f, next, "utf-8");
        updated.push(`${f}[${op}]`);
      } catch (e) { skipped.push(`${f}: ${(e as Error).message}`); }
    }
    // Claude 전용 소통 섹션 동기화 (claude_channel만 inject, 비-Claude는 strip).
    for (const { file: f, op } of claudeCommsTargets(personaFile, wsPath, runtime)) {
      try {
        if (!existsSync(f)) continue;
        const cur = readFileSync(f, "utf-8");
        const next = op === "inject" ? injectClaudeComms(cur) : stripClaudeComms(cur);
        if (next === cur) continue;
        backup(f, backedUp);
        writeFileSync(f, next, "utf-8");
        updated.push(`${f}[comms-${op}]`);
      } catch (e) { skipped.push(`${f}: ${(e as Error).message}`); }
    }
    appendAudit(db, "user", "persona_core_rule_injected", id, { updated: updated.length, runtime });
    return c.json({ ok: updated.length > 0, updated, skipped, runtime });
  });

  // 페르소나 프로필 편집 (role + persona) — 대시보드가 "파일 통짜 편집" 대신 구조화 필드만 저장.
  // 소스=agents.json(role·purpose) → 런타임별 로딩파일 자동 재생성(백업먼저):
  //   claude=CLAUDE.md(+SOUL.md) · codex/openclaw/hermes=AGENTS.md+SOUL.md.
  //   룰=템플릿(영문) / 능력(purpose)=사용자 입력 verbatim. divergence·codex gap·유실 근본해결(OWNER 2026-07-04).
  app.post("/members/:id/profile", async (c) => {
    // 프로필(역할·persona) 편집은 ★공개 빌드에서도 허용★ — 사용자가 자기 팀원 페르소나를 대시보드에서
    // 편집하는 건 정상 기능이다(agents.json role + SOUL.md persona + 로딩파일 재생성뿐, 위험 op 아님).
    // (구 live_only 게이트 제거 — 공개 사용자가 persona 저장 시 "실패: live_only" 나던 버그. OWNER 2026-07-19 맥북테스트.)
    const id = c.req.param("id");
    if (!/^[a-z0-9_-]+$/i.test(id)) return c.json({ error: "invalid_id" }, 400); // path traversal 방지
    const body = (await c.req.json().catch(() => ({}))) as { role?: unknown; persona?: unknown };
    const role = typeof body.role === "string" ? body.role.trim() : undefined;
    const persona = typeof body.persona === "string" ? body.persona : undefined;
    if (role === undefined && persona === undefined) return c.json({ error: "nothing_to_update" }, 400);
    const list = readAgents();
    const agent = list.find((a) => a.id === id);
    if (!agent) return c.json({ error: "unknown_member", id }, 404);
    // ① agents.json 갱신 — ★role 등 나머지 필드만.★ persona 는 여기 저장하지 않는다.
    //   ★"persona 값은 그냥 soul.md 에만 저장해. 대시보드 나머지 필드는 agents.json이 원본이면 되고"★ (OWNER 2026-07-17)
    //   purpose 필드는 제거됐다 — 두 곳에 두니 반드시 어긋났고(12명 중 7명), 어긋나면 렌더가 옛값으로 덮었다.
    if (role !== undefined) agent.role = role;
    try { writeAgents(list); } catch (e) { return c.json({ error: "registry_write_failed", detail: e instanceof Error ? e.message : String(e) }, 500); }
    // ② 런타임별 로딩파일 재생성 (백업먼저). 룰=템플릿(영문).
    const runtime = agent.runtime ?? "claude_channel";
    const owner = getSetting(db, "owner_name") ?? undefined;
    const team = getSetting(db, "team_name") ?? undefined;
    const fb = memberPaths(id, runtime);
    const ws = (agent.workspace_path as string) || fb.workspace_path;
    // ★persona 저장 = SOUL.md 에만.★ 렌더러는 SOUL 을 안 건드리므로 여기가 유일한 저장 지점이다.
    const soulPath = (agent.persona_file as string) || fb.persona_file;
    if (persona !== undefined) {
      try { savePersonaFile(soulPath, persona); }
      catch (e) { return c.json({ error: "persona_write_failed", detail: e instanceof Error ? e.message : String(e) }, 500); }
    }
    // ★persona 쓰기는 단일 canonical writeMemberPersona 하나만 통과(OWNER 2026-07-05 아키텍처 지시).
    //   custom(purpose) verbatim 보존 + backup-first + 룰만 최신 + 런타임별 파일. 기존 put/buildPersona/buildPersonaFromCustom 분기 divergence 제거.
    let written: string[] = [];
    const failed: string[] = [];
    try {
      const wr = writeMemberPersona({ id, display_name: agent.display_name, role: agent.role, runtime, signature: agent.signature as string | undefined, bot_username: agent.telegram_bot_username, workspace_path: ws, persona_file: (agent.persona_file as string) || fb.persona_file, owner_name: owner, team_name: team, team_collect_enabled: false /* 수집 오케스트레이션 제거 (2026-07-13) — collector 가 직접 모아 직접 보고한다 */ });
      written = wr.written;
    } catch (e) { failed.push((e as Error).message); }
    appendAudit(db, "user", "persona_profile_edited", id, { role_changed: role !== undefined, persona_changed: persona !== undefined, written: written.length, runtime });
    return c.json({ ok: failed.length === 0, updated: written, failed, runtime });
  });

  // 팀원 재시작 (대시보드 onoff — 터미널/팀방 /onoff 없이 Settings에서 바로). self-mod 실행=APPROVAL_EXECUTION_ENABLED + OWNER 인증탭.
  app.post("/members/:id/restart", async (c) => {
    const id = c.req.param("id");
    let agent: any = null;
    try { agent = readAgents().find((a) => a.id === id) ?? null; } catch { /* ignore */ }
    if (!agent) return c.json({ ok: false, error: "unknown_member", id }, 404);
    const body = await c.req.json().catch(() => ({}));
    const fresh = (body as any)?.fresh === true;
    const res = await restartAgent(id, agent.runtime ?? "claude_channel", fresh);
    const action = res.ok ? (fresh ? "member_restart_fresh" : "member_restart") : "member_restart_failed";
    appendAudit(db, "user", action, id, { detail: res.detail, fresh });
    return c.json({ ok: res.ok, detail: res.detail, fresh });
  });

  // 봇 토큰 변경 (대시보드 self-service — 죽은/withdrawn 봇 교체. OWNER 2026-07-01, 터미널·에이전트에 토큰 전달 없이).
  //   흐름: id검증 → codex 런타임 확인 → execOn 게이트 → 형식검증 → getMe(살아있는 봇) → placeCodexToken(0600) → 브릿지 파일 보장 → 재시작.
  //   보안(하네스 검증): ①credential+재시작이라 activation과 동일하게 execOn 게이트(승인 OFF면 토큰 안 씀) ②런타임별 파일저장(codex=var/secrets, claude/hermes=.env, openclaw=파일기반 계정만 credentials/telegram-<id>-token.txt) ③토큰 값은 파일로만(응답/로그=username만).
  app.post("/members/:id/rotate-token", async (c) => {
    const id = c.req.param("id");
    if (!/^[a-z0-9_-]+$/i.test(id)) return c.json({ ok: false, error: "invalid_id" }, 400); // path traversal 방지(방어적)
    let agent: any = null;
    try { agent = readAgents().find((a) => a.id === id) ?? null; } catch { /* ignore */ }
    if (!agent) return c.json({ ok: false, error: "unknown_member", id }, 404);
    // execOn 게이트 — credential 쓰기+서비스 재시작=민감 self-mod. activation과 동일 게이트(하네스 HIGH 반영). 승인 OFF면 차단.
    if (process.env.APPROVAL_EXECUTION_ENABLED !== "1") {
      return c.json({ ok: false, error: "execution_off", hint: "실행이 꺼져 있어요(APPROVAL_EXECUTION_ENABLED≠1). 봇 토큰 변경은 credential+재시작이라 실행 ON(인증 탭)에서만 가능합니다." }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const token = typeof (body as any)?.bot_token === "string" ? (body as any).bot_token : "";
    // 런타임별 격리 핸들러 + fail-safe(검증→백업→쓰기→재시작→실패 시 기존 복원). codex/claude/hermes + openclaw ★파일기반(tokenFile 정의) 계정★ 지원(인라인 botToken·미정의는 거부, 공유 게이트웨이 재시작 warning). 토큰값 노출 없음. (OWNER 2026-07-05: openclaw 파일기반 파일실종도 생성 허용)
    const res = await rotateBotToken(restartAgent, agent.runtime ?? "", id, agent, token);
    appendAudit(db, "user", res.ok ? "member_token_rotated" : "member_token_rotate_failed", id, { runtime: agent.runtime, bot_username: res.bot_username, error: res.error }); // 토큰값 절대 X
    const status = res.ok ? 200
      : res.error === "getme_failed" ? 502
      : res.error === "store_failed" || res.error === "restart_failed_reverted" ? 500
      : 400; // unsupported_member·bot_token_invalid·bot_token_dead
    return c.json({ ok: res.ok, bot_username: res.bot_username, error: res.error, detail: res.detail, warning: res.warning }, status);
  });

  // 전체 재시작 (대시보드 — Settings에서 한 번에). member·정지팀원 제외, member 맨 마지막.
  app.post("/members/restart-all", async (c) => {
    let list: any[] = [];
    try { list = readAgents(); } catch (e) { return c.json({ ok: false, error: "read_failed", detail: e instanceof Error ? e.message : String(e) }, 500); }
    const members = list.filter((a) => ["openclaw", "claude_channel", "hermes_agent", "codex"].includes(a.runtime)).map((a) => ({ id: a.id, runtime: a.runtime, capabilities: a.capabilities ?? [] }));
    const results = await restartAll(members);
    appendAudit(db, "user", "restart_all", "team", { applied: results.filter((r) => r.ok).length });
    return c.json({ ok: true, results });
  });

  // 비상 전체 정지 (대시보드 빨강 버튼·더블컨펌). member 제외 전원 정지.
  app.post("/members/stop-all", async (c) => {
    let list: any[] = [];
    try { list = readAgents(); } catch (e) { return c.json({ ok: false, error: "read_failed", detail: e instanceof Error ? e.message : String(e) }, 500); }
    const members = list.filter((a) => ["openclaw", "claude_channel", "hermes_agent", "codex"].includes(a.runtime)).map((a) => ({ id: a.id, runtime: a.runtime, capabilities: a.capabilities ?? [] }));
    const results = await stopAll(members);
    const recoveryIds = new Set(list.filter((a) => hasCapability(a, "recovery")).map((a) => a.id));
    appendAudit(db, "user", "stop_all_emergency", "team", { stopped: results.filter((r) => r.ok && !recoveryIds.has(r.id)).length });
    return c.json({ ok: true, results });
  });

  // 팀원 정지/기동 (대시보드 서킷브레이커). body {enabled:boolean}.
  app.post("/members/:id/enabled", async (c) => {
    const id = c.req.param("id");
    let agent: any = null;
    try { agent = readAgents().find((a) => a.id === id) ?? null; } catch { /* ignore */ }
    if (!agent) return c.json({ ok: false, error: "unknown_member", id }, 404);
    let body: { enabled?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid_json" }, 400); }
    const enabled = body.enabled === true;
    const res = await setAgentEnabled(id, agent.runtime ?? "claude_channel", enabled);
    appendAudit(db, "user", res.ok ? "member_onoff" : "member_onoff_failed", id, { enabled, detail: res.detail });
    return c.json({ ok: res.ok, off: isAgentOff(id), detail: res.detail });
  });

  // 전체 핵심룰 재적용 — 모든 팀원(기준멤버 포함, non_interactive cron만 제외)에 멈춤장치+통신+conti 주입(한 번에). 각자 백업.
  // 롤백: 백업한 .bak 파일목록+시각을 setting(last_regen_all)에 기록 → 6시간 내 /members/regenerate-all-personas/rollback 로 복원.
  app.post("/members/regenerate-all-personas", (c) => {
    if (PUBLIC_BUILD) return c.json({ error: "live_only", hint: "전체 핵심룰 재적용은 라이브 전용입니다." }, 404);
    let list: any[] = [];
    try { list = readAgents(); } catch (e) { return c.json({ error: "read_failed", detail: e instanceof Error ? e.message : String(e) }, 500); }
    const results: Array<{ id: string; runtime?: string; updated?: number; skipped?: string; errors?: string[]; missing?: string[] }> = [];
    const owner = getSetting(db, "owner_name") ?? undefined; // 라이브 → 핵심룰 {{OWNER}}를 팀장 이름으로 치환
    const team = getSetting(db, "team_name") ?? undefined; // 라이브 → 핵심룰 {{TEAM}}를 팀 이름으로 치환
    const allTouched = new Set<string>(); // 롤백용 — 이번 재적용에서 백업(.bak)·덮어쓴 파일 전체 수집
    for (const agent of list) {
      // recovery(기준/Bill)도 자동주입에 포함 — OWNER 2026-06-28. core-rule은 이미 canonical과 일치(idempotent)라 comms만 추가됨.
      // non_interactive = 비대화형 cron 다이제스트 봇(persona=cron 프롬프트). 멈춤/통신/conti norms 비해당 → 제외.
      if (hasCapability(agent, "non_interactive")) { results.push({ id: agent.id, skipped: "cron(비대화)" }); continue; }
      const runtime = agent.runtime ?? "claude_channel";
      // agents.json 실제 경로 우선(id≠워크스페이스 폴더명 대응). 없으면 id기반 폴백.
      const fb = memberPaths(agent.id, runtime);
      const personaFile = (agent.persona_file as string) || fb.persona_file;
      const wsPath = (agent.workspace_path as string) || fb.workspace_path;
      let updated = 0;
      const errors: string[] = []; // 무음실패 금지 — 쓰기 실패 원인을 results로 노출
      const missing: string[] = []; // 누락된 inject 대상(예: openclaw 로딩파일 AGENTS.md 없음) — 복구버튼이 못 봤다고 단정 못 하게 노출(Devon)
      const backedUp = new Set<string>(); // 파일별 1회만 백업(원본 .bak 보존)
      for (const { file: f, op } of coreRuleTargets(personaFile, wsPath, runtime)) {
        try {
          if (!existsSync(f)) { if (op === "inject") missing.push(f); continue; }
          const cur = readFileSync(f, "utf-8");
          const next = op === "inject" ? injectCoreRule(cur, coreRuleFor(agent.id, owner, team)) : stripCoreRule(cur);
          if (next === cur) continue;
          backup(f, backedUp);
          writeFileSync(f, next, "utf-8");
          allTouched.add(f);
          updated++;
        } catch (e) { errors.push(`${f}: ${(e as Error).message}`); }
      }
      // Claude 전용 소통 섹션 동기화 (claude_channel만 inject).
      for (const { file: f, op } of claudeCommsTargets(personaFile, wsPath, runtime)) {
        try {
          if (!existsSync(f)) { if (op === "inject") missing.push(f); continue; }
          const cur = readFileSync(f, "utf-8");
          const next = op === "inject" ? injectClaudeComms(cur) : stripClaudeComms(cur);
          if (next === cur) continue;
          backup(f, backedUp);
          writeFileSync(f, next, "utf-8");
          allTouched.add(f);
          updated++;
        } catch (e) { errors.push(`${f}: ${(e as Error).message}`); }
      }
      const row: { id: string; runtime?: string; updated?: number; skipped?: string; errors?: string[]; missing?: string[] } = { id: agent.id, runtime, updated };
      if (errors.length) row.errors = errors;
      if (missing.length) row.missing = missing;
      results.push(row);
    }
    // 롤백 메타 기록 — 6시간 내 .bak 복원 가능. 변경된 파일이 있을 때만 기록(무변화 재적용은 기존 롤백창 유지).
    if (allTouched.size > 0) {
      setSetting(db, "last_regen_all", JSON.stringify({ at: new Date().toISOString(), files: [...allTouched] }));
    }
    appendAudit(db, "user", "persona_core_rule_injected_all", "team", { applied: results.filter((r) => (r.updated ?? 0) > 0).length, rollback_files: allTouched.size });
    return c.json({ ok: true, results, rollback_available: allTouched.size > 0 });
  });

  // 전체 재적용 롤백 상태 — 6시간 내면 available:true (프론트 임시 버튼 노출·카운트다운용).
  app.get("/members/regenerate-all-personas/rollback", (c) => {
    if (PUBLIC_BUILD) return c.json({ available: false });
    const raw = getSetting(db, "last_regen_all");
    if (!raw) return c.json({ available: false });
    let meta: { at?: string; files?: string[] };
    try { meta = JSON.parse(raw); } catch { return c.json({ available: false }); }
    const atMs = meta.at ? Date.parse(meta.at) : NaN;
    if (!Number.isFinite(atMs)) return c.json({ available: false });
    const remaining = atMs + ROLLBACK_WINDOW_MS - Date.now();
    if (remaining <= 0) return c.json({ available: false, expired: true });
    return c.json({ available: true, at: meta.at, files: (meta.files ?? []).length, remaining_ms: remaining });
  });

  // 전체 재적용 롤백 실행 — 6시간 내면 .bak → 원본 복원 후 기록 삭제(버튼 사라짐). 창 만료/기록없음이면 거부.
  app.post("/members/regenerate-all-personas/rollback", (c) => {
    if (PUBLIC_BUILD) return c.json({ ok: false, error: "live_only" }, 404);
    const raw = getSetting(db, "last_regen_all");
    if (!raw) return c.json({ ok: false, error: "nothing_to_rollback" }, 404);
    let meta: { at?: string; files?: string[] };
    try { meta = JSON.parse(raw); } catch { return c.json({ ok: false, error: "corrupt_record" }, 500); }
    const atMs = meta.at ? Date.parse(meta.at) : NaN;
    if (!Number.isFinite(atMs) || atMs + ROLLBACK_WINDOW_MS - Date.now() <= 0) {
      db.query("DELETE FROM setting WHERE key = ?").run("last_regen_all");
      return c.json({ ok: false, error: "rollback_window_expired" }, 410);
    }
    const restored: string[] = [], missing: string[] = [], errors: string[] = [];
    for (const f of meta.files ?? []) {
      const bak = f + ".bak";
      try {
        if (!existsSync(bak)) { missing.push(f); continue; }
        copyFileSync(bak, f);
        restored.push(f);
      } catch (e) { errors.push(`${f}: ${(e as Error).message}`); }
    }
    db.query("DELETE FROM setting WHERE key = ?").run("last_regen_all");
    appendAudit(db, "user", "persona_core_rule_rollback", "team", { restored: restored.length, missing: missing.length, errors: errors.length });
    return c.json({ ok: errors.length === 0, restored, missing, errors });
  });

  // 진행 중(미완료) OT 1건 — 대시보드 로드 시 끊긴 영입을 resume(OWNER가 새로고침해도 단계 복원).
  // 주의: /ot/:ot_id 보다 먼저 등록해야 "active" 가 ot_id 로 매칭되지 않음.
  app.get("/ot/active", (c) => {
    // 최근(2시간 내) 진행 중 OT만 resume — 활성 영입 세션은 복원하되 오래된 stale/테스트 OT 는 제외.
    const rows = db.query("SELECT id, member_id, steps_json FROM ot WHERE updated_at > datetime('now','-2 hours') ORDER BY updated_at DESC").all() as any[];
    for (const row of rows) {
      let parsed: any = {};
      try { parsed = JSON.parse(row.steps_json); } catch { /* corrupt → skip */ }
      const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
      const stage = deriveStage(steps);
      if (stage === "joined" || stage === "failed") continue;
      let agent: any = null;
      try { agent = readAgents().find((a) => a.id === row.member_id) ?? null; } catch { /* ignore */ }
      if (!agent) continue;
      return c.json({ ot_id: row.id, member: { id: agent.id, display_name: agent.display_name, role: agent.role, runtime: agent.runtime, icon: agent.icon ?? null } });
    }
    return c.json({ ot_id: null });
  });

  // ── OT 상태 조회 (Steve 스테퍼가 ~1.5s 폴링) ─────────────────────
  app.get("/ot/:ot_id", (c) => {
    const ot_id = c.req.param("ot_id");
    const row = db.query("SELECT id, member_id, steps_json, error FROM ot WHERE id = ?").get(ot_id) as any;
    if (!row) return c.json({ error: "unknown_ot", ot_id }, 404);
    let parsed: any = {};
    try { parsed = JSON.parse(row.steps_json); } catch { /* corrupt → 빈 */ }
    const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
    const stage = deriveStage(steps);
    return c.json({ ot_id: row.id, member_id: row.member_id, stage, steps, awaiting_input: parsed.awaiting_input ?? null, done: stage === "joined" || stage === "failed", joined: stage === "joined", error: row.error ?? undefined });
  });

  // ── OT 단계 진행 (프로비저닝/합류 완료 시 갱신) ──────────────────
  app.post("/ot/:ot_id/advance", async (c) => {
    const ot_id = c.req.param("ot_id");
    let body: { key?: unknown; state?: unknown; detail?: unknown; error?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
    const key = typeof body.key === "string" ? body.key : "";
    const state = typeof body.state === "string" ? body.state : "";
    if (!["register", "provision", "preflight", "bundle", "join"].includes(key)) return c.json({ error: "key_invalid" }, 400);
    if (!["pending", "running", "done", "failed", "blocked"].includes(state)) return c.json({ error: "state_invalid" }, 400);
    const row = db.query("SELECT steps_json FROM ot WHERE id = ?").get(ot_id) as any;
    if (!row) return c.json({ error: "unknown_ot", ot_id }, 404);
    let parsed: any = {};
    try { parsed = JSON.parse(row.steps_json); } catch { parsed = {}; }
    const steps = Array.isArray(parsed.steps) ? parsed.steps : initOtSteps();
    const step = steps.find((s: any) => s.key === key);
    if (step) { step.state = state; if (typeof body.detail === "string") step.detail = body.detail; }
    parsed.steps = steps;
    const stage = deriveStage(steps);
    const error = typeof body.error === "string" ? body.error : null;
    db.query("UPDATE ot SET steps_json = ?, stage = ?, error = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(parsed), stage, error, ot_id);
    appendAudit(db, "system", "ot_advanced", ot_id, { key, state });
    return c.json({ ok: true, ot_id, stage, steps });
  });

  // ── 영입 취소(cancel) = recruit 역연산: 진행 중(미합류) OT를 롤백 ──────
  //   레지스트리 entry + OT 레코드 + agent 상태행 + 자동생성 workspace/persona 를 정리한다.
  //   합류 완료(joined)는 취소 불가 → 정식 퇴사(DELETE /members)로. 사용자 작성 파일은 보호('빈' workspace만 삭제).
  app.post("/ot/:ot_id/cancel", async (c) => {
    const ot_id = c.req.param("ot_id");
    const row = db.query("SELECT id, member_id, steps_json FROM ot WHERE id = ?").get(ot_id) as any;
    if (!row) return c.json({ error: "unknown_ot", ot_id }, 404);
    let parsed: any = {};
    try { parsed = JSON.parse(row.steps_json); } catch { parsed = {}; }
    const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
    if (deriveStage(steps) === "joined")
      return c.json({ error: "already_joined", hint: "합류 완료된 멤버는 퇴사(멤버 삭제)로 처리하세요" }, 400);
    const member_id = row.member_id;
    // runtime/display_name 확보(workspace 경로 계산용) — 레지스트리에서 제거하기 전에.
    let runtime = "claude_channel", display_name = member_id, hermes_profile = member_id, removed_from_registry = false;
    try {
      const list = readAgents();
      const target = list.find((a: any) => a.id === member_id);
      if (target) {
        runtime = target.runtime ?? runtime;
        display_name = target.display_name ?? member_id;
        hermes_profile = (target as any).hermes_profile ?? member_id; // hermes cleanup 프로필 경로용
        writeAgents(list.filter((a: any) => a.id !== member_id));
        removed_from_registry = true;
      }
    } catch (e) {
      return c.json({ error: "registry_write_failed", detail: e instanceof Error ? e.message : String(e) }, 500);
    }
    // OT 레코드 + agent 상태행 삭제.
    db.query("DELETE FROM ot WHERE id = ?").run(ot_id);
    try { db.query("DELETE FROM agent WHERE id = ?").run(member_id); } catch { /* 없으면 무시 */ }
    // ★자동생성 workspace/persona 정리 — DELETE(퇴사)와 동일하게 주입가능한 doArchiveWorkspace 경유(삭제 아닌 archive→.archived, 복구가능).
    //   ★Steve-safety(OWNER 최우선): 기존 직접 rmSync(persona)는 skipRuntimeCleanup 게이트 밖+주입 미경유라, cancel 테스트가 fixture id(steve/bill)로 라이브 ~/Development/<id>/CLAUDE.md 삭제하던 인시던트 재현형태(하네스 적대검증 FAIL). 주입 archiveWorkspace는 테스트서 noop → 라이브 데이터 절대 안 건드림. OWNER 2026-07-02.
    let workspace_archived: string | null = null;
    try { workspace_archived = doArchiveWorkspace(member_id, runtime); } catch { /* best-effort: 정리 실패해도 레지스트리/OT 롤백은 완료 */ }
    // ★recruit 역연산 완결(하네스 MEDIUM) — cancel이 프로비저닝 토큰·부분 활성화된 브릿지·off/bus-wake를 orphan으로 남기던 갭.
    //   provision만 된 경우=var/secrets 토큰 orphan / activate 실패한 경우=브릿지(토큰·plist·home)+off-list orphan. OWNER 2026-07-02.
    if (/^[a-z0-9_-]+$/i.test(member_id)) {
      try { const tp = join(dirname(registryPath), "var", "secrets", `${member_id}.bot-token`); if (existsSync(tp)) rmSync(tp); } catch { /* best-effort */ }
    }
    if (!skipRuntimeCleanup) {
      const HHc = process.env.HOME ?? "";
      try { if (runtime === "codex") { await setAgentEnabled(member_id, "codex", false).catch(() => {}); removeCodexBridgeFiles(member_id, { removeToken: true, removeHome: true }); } } catch { /* best-effort */ }
      try { if (runtime === "claude_channel") { await setAgentEnabled(member_id, "claude_channel", false).catch(() => {}); removeClaudeBridgeFiles(member_id, { removeToken: true }); } } catch { /* best-effort */ }
      // ★openclaw/hermes cleanup — 퇴사(DELETE)와 동일 미러(하네스: cancel이 openclaw agent dir·hermes 프로필 orphan→재영입 실패·페어링 상속). base-hermes 가드+슬러그로 공유자원/Steve-class 차단. OWNER 2026-07-02.
      if (runtime === "openclaw" && /^[a-z0-9_-]+$/i.test(member_id)) {
        try { await setAgentEnabled(member_id, "openclaw", false).catch(() => {}); } catch { /* best-effort */ }
        try { const ot = `${HHc}/.openclaw/credentials/telegram-${member_id}-token.txt`; if (existsSync(ot)) rmSync(ot); } catch { /* best-effort */ }
        try { const af = `${HHc}/.openclaw/credentials/telegram-${member_id}-allowFrom.json`; if (existsSync(af)) rmSync(af); } catch { /* best-effort */ }
        try { const ad = `${HHc}/.openclaw/agents/${member_id}`; if (existsSync(ad)) rmSync(ad, { recursive: true }); } catch { /* best-effort */ }
      }
      if (runtime === "hermes_agent" && hermes_profile !== "b3ryshermes") { // ★base 프로필 보존(공유 auth 소스)
        const prof = hermes_profile;
        try { await setAgentEnabled(member_id, "hermes_agent", false).catch(() => {}); } catch { /* best-effort */ }
        if (/^[a-z0-9_-]+$/i.test(prof)) { try { const hp = `${HHc}/Library/LaunchAgents/ai.hermes.gateway-${prof}.plist`; if (existsSync(hp)) rmSync(hp); } catch { /* best-effort */ } }
        if (/^[a-z0-9_-]+$/i.test(member_id)) { try { const ct = `${HHc}/.hermes/credentials/${member_id}-token.txt`; if (existsSync(ct)) rmSync(ct); } catch { /* best-effort */ } }
        if (/^[a-z0-9_-]+$/i.test(prof)) { try { const pd = `${HHc}/.hermes/profiles/${prof}`; if (existsSync(pd)) rmSync(pd, { recursive: true }); } catch { /* best-effort */ } }
      }
    }
    try { clearAgentOff(member_id); } catch { /* best-effort */ }
    try { removeBusWake(member_id); } catch { /* best-effort */ }
    appendAudit(db, "user", "member_recruit_cancelled", member_id, { ot_id, removed_from_registry, workspace_archived });
    return c.json({ ok: true, cancelled: { ot_id, member_id, display_name }, removed_from_registry, workspace_archived });
  });

  // ── 셀프서비스 프로비저닝: 봇 토큰 받아 안전저장 + 단계 진행 (no-Bill 경로 핵심) ──
  app.post("/ot/:ot_id/provision", async (c) => {
    const ot_id = c.req.param("ot_id");
    let body: Record<string, unknown>;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
    const token = typeof body.bot_token === "string" ? body.bot_token.trim() : "";
    // 텔레그램 봇 토큰 형식 느슨 검증(<digits>:<35+>). 값은 절대 로그/echo 안 함.
    if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token)) {
      return c.json({ error: "bot_token_invalid", hint: "BotFather가 준 토큰 형식이 아니에요. 예: 1234567:ABC… 전체를 붙여넣어 주세요." }, 400);
    }
    const row = db.query("SELECT id, member_id, steps_json FROM ot WHERE id = ?").get(ot_id) as any;
    if (!row) return c.json({ error: "unknown_ot", ot_id }, 404);
    // 형식만으로는 '살아있는 봇'인지 알 수 없다 — getMe로 즉시 검증한다(없는 OT는 위에서 이미 404, 네트워크 호출 아낌).
    //   (오타/폐기 토큰이 '봇 토큰 연결됨 ✓'으로 통과한 뒤, 실패가 activate 의 28s poller 타임아웃에서 '재활성화 필요'로만
    //    드러나 토큰을 의심할 단서가 0이던 갭 — OWNER rotate 원칙 '검증 실패면 멈춤'과 동일하게 저장 전 차단.)
    const live = await doValidateBotToken(token);
    if (!live.ok) {
      return c.json(
        live.error === "getme_failed"
          ? { error: "getme_failed", hint: "텔레그램에 연결해 토큰을 검증하지 못했어요(일시적 네트워크 문제일 수 있어요). 잠시 후 다시 시도해 주세요." }
          : { error: "bot_token_dead", hint: "이 봇 토큰이 살아있지 않아요(getMe 실패). BotFather가 준 토큰을 다시 확인해 주세요 — 오타이거나 폐기·재발급된 봇일 수 있어요." },
        live.error === "getme_failed" ? 503 : 400,
      );
    }
    let parsed: any = {};
    try { parsed = JSON.parse(row.steps_json); } catch { parsed = {}; }
    // 시크릿 안전저장: var/secrets/<id>.bot-token (gitignored), 0600. 값은 파일로만, stdout/로그/응답 노출 안 함.
    let tokenPath = "";
    try {
      const secretsDir = join(dirname(registryPath), "var", "secrets");
      mkdirSync(secretsDir, { recursive: true });
      tokenPath = join(secretsDir, `${row.member_id}.bot-token`);
      writeFileSync(tokenPath, token, { mode: 0o600 });
      try { chmodSync(tokenPath, 0o600); } catch { /* best-effort */ }
    } catch {
      return c.json({ error: "store_failed", hint: "토큰 저장에 실패했어요. 잠시 후 다시 시도해 주세요." }, 500);
    }
    // 단계 진행: provision done, bundle done(자료 준비). join 은 런타임 기동 후 첫 ack 시.
    const steps = Array.isArray(parsed.steps) ? parsed.steps : initOtSteps();
    const pv = steps.find((s: any) => s.key === "provision"); if (pv) { pv.state = "done"; pv.detail = `봇 토큰 연결됨 (@${live.username})`; } // getMe로 검증된 실제 봇 username — 긍정 증거(공개값이라 노출 안전)
    // preflight: provision done 직후 런타임 oauth 로그인 사전점검. 미로그인이면 'blocked'+fixHint 로 활성화 차단 안내.
    //   (구버전 OT엔 preflight 단계가 없을 수 있어 find 실패 시 조용히 skip — 기존 동작 안 깨짐.)
    const pf = steps.find((s: any) => s.key === "preflight");
    if (pf) {
      try {
        let runtime = "claude_channel";
        try { runtime = readAgents().find((a: any) => a.id === row.member_id)?.runtime ?? runtime; } catch { /* 기본값 사용 */ }
        const auth = await doCheckRuntimeAuth(runtime); // credential 값 노출 없음 — 존재·status만
        pf.state = auth.loggedIn ? "done" : "blocked";
        pf.detail = auth.loggedIn ? auth.detail : auth.fixHint; // fixHint 만, 토큰/계정값 절대 X
      } catch (e) {
        pf.state = "blocked"; pf.detail = "인증 점검 실패: " + (e instanceof Error ? e.message : String(e));
      }
    }
    // bundle(활성화+OT주입)은 /activate 가 done 처리. 여기선 pending 유지 → 대시보드가 '활성화' 버튼 표시.
    const bd = steps.find((s: any) => s.key === "bundle"); if (bd) { bd.state = "pending"; bd.detail = "런타임 활성화 대기 — '활성화' 클릭"; }
    const jn = steps.find((s: any) => s.key === "join"); if (jn) { jn.detail = "활성화 후 첫 응답 대기"; }
    parsed.steps = steps;
    parsed.awaiting_input = null; // 마커 clear → 패널 자동 닫힘
    const stage = deriveStage(steps);
    db.query("UPDATE ot SET steps_json = ?, stage = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(parsed), stage, ot_id);
    appendAudit(db, "user", "ot_provisioned", row.member_id, { ot_id, token_path: tokenPath }); // 경로만 — 토큰 값 절대 X
    return c.json({ ok: true, ot: { ot_id, member_id: row.member_id, stage, steps, awaiting_input: null, done: stage === "joined" || stage === "failed", joined: stage === "joined" } });
  });

  // ── 대시보드-실행-활성화 (OWNER 2026-06-11): 서버가 런타임을 활성화(터미널 0) ──
  //   provision(토큰 저장) 후 호출. 런타임 생성 + AGENTS.md(팀지식) + bus-wake. 단계별 결과 반환(스무스·에러처리).
  app.post("/ot/:ot_id/activate", async (c) => {
    const ot_id = c.req.param("ot_id");
    const row = db.query("SELECT id, member_id, steps_json FROM ot WHERE id = ?").get(ot_id) as any;
    if (!row) return c.json({ error: "unknown_ot", ot_id }, 404);
    let parsed: any = {};
    try { parsed = JSON.parse(row.steps_json); } catch { parsed = {}; }
    let agent: any = null;
    try { agent = readAgents().find((a) => a.id === row.member_id) ?? null; } catch { /* ignore */ }
    if (!agent) return c.json({ error: "unknown_member", id: row.member_id }, 404);
    // 저장된 봇 토큰 읽기(값은 응답/로그 노출 X)
    let token = "";
    try {
      const tp = join(dirname(registryPath), "var", "secrets", `${row.member_id}.bot-token`);
      if (existsSync(tp)) token = readFileSync(tp, "utf-8").trim();
    } catch { /* ignore */ }
    if (!token) return c.json({ error: "no_token", hint: "먼저 봇 토큰을 입력(provision)해 주세요." }, 400);

    // 런타임 인증 preflight 게이트(안전망) — claude/codex 미로그인이면 활성화 거부+fixHint(spawn 전에 차단).
    //   credential 값은 보지 않고 존재·status만 본다. activateMember 안에도 동일 가드가 있어 이중 안전망.
    const pre = await doCheckRuntimeAuth(agent.runtime);
    if (!pre.loggedIn) {
      const steps = Array.isArray(parsed.steps) ? parsed.steps : initOtSteps();
      const pf = steps.find((s: any) => s.key === "preflight"); if (pf) { pf.state = "blocked"; pf.detail = pre.fixHint; }
      parsed.steps = steps;
      const stage = deriveStage(steps);
      db.query("UPDATE ot SET steps_json = ?, stage = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(parsed), stage, ot_id);
      appendAudit(db, "user", "ot_activate_preflight_blocked", row.member_id, { ot_id, runtime: agent.runtime });
      return c.json({ error: "runtime_auth_required", hint: pre.fixHint, runtime: agent.runtime, ot: { ot_id, member_id: row.member_id, stage, steps } }, 400);
    }

    const result = await doActivateMember(db, {
      id: agent.id, display_name: agent.display_name, role: agent.role, runtime: agent.runtime,
      bot_username: agent.telegram_bot_username, persona: typeof parsed.persona === "string" ? parsed.persona : "", bot_token: token,
    });
    // hermes 활성화 성공 → bridge가 쓰는 hermes_profile 필드 등록(없으면 못 깨움). best-effort.
    if (result.ok && agent.runtime === "hermes_agent") {
      try {
        const list = readAgents();
        const t = list.find((a) => a.id === agent.id);
        if (t && !t.hermes_profile) { t.hermes_profile = agent.id; writeAgents(list); }
      } catch { /* best-effort */ }
    }
    // claude_channel 활성화 성공 → tmux_session(claude-<id>) 레지스트리 기록. 봇 세션은 claude-<id> 관례로
    //   뜨지만 recruit는 이 필드를 null로 남긴다. statusProbe(null이면 즉시 offline 판정)·wakeDispatcher(null이면
    //   no_tmux_session_for 로 버스 주입 실패) 둘 다 이 필드를 보므로, activate가 안 채우면 봇이 살아있어도
    //   빨강+라우팅 불통이 된다(OWNER 맥북 클린설치서 발견 2026-07-03). hermes_profile 패턴과 동형.
    if (result.ok && agent.runtime === "claude_channel") {
      try {
        const list = readAgents();
        const t = list.find((a) => a.id === agent.id);
        const sess = `claude-${agent.id}`;
        if (t && t.tmux_session !== sess) { t.tmux_session = sess; writeAgents(list); }
      } catch { /* best-effort */ }
    }
    // OT 단계 갱신: 성공 시 bundle done(팀지식 주입됨)·join 은 첫 ack 대기. 실패 시 provision 으로 되돌림.
    const steps = Array.isArray(parsed.steps) ? parsed.steps : initOtSteps();
    // preflight 게이트를 통과해 여기까지 왔으므로 done 으로 확정(스테퍼가 멈춰 보이지 않게).
    const pf = steps.find((s: any) => s.key === "preflight"); if (pf) { pf.state = "done"; pf.detail = "런타임 인증 확인됨"; }
    const bd = steps.find((s: any) => s.key === "bundle");
    if (bd) { bd.state = result.ok ? "done" : "pending"; bd.detail = result.ok ? "런타임 활성화 + 팀지식 주입 완료" : "활성화 실패 — 재시도 필요"; }
    const jn = steps.find((s: any) => s.key === "join");
    if (jn) {
      // codex/claude/hermes 는 openclaw 같은 pairing 게이트가 없다 → preflight 인증 통과 + 봇/브릿지 기동 성공 =
      //   양방향 가능 = 합류 완료로 확정(무한 '첫 응답 대기' 방지). openclaw 는 pairing-approve 로 join 완료. OWNER 2026-07-01.
      const firstCallRuntime = agent.runtime === "codex" || agent.runtime === "claude_channel";
      const noPairingRuntime = firstCallRuntime || agent.runtime === "hermes_agent";
      let firstCall: FirstModelCallResult | null = null;
      if (result.ok && firstCallRuntime) {
        firstCall = await firstModelCall({ id: agent.id, runtime: agent.runtime, workspacePath: agent.workspace_path });
        result.steps.push({
          step: "first-model-call",
          ok: firstCall.ok,
          detail: firstCall.subscriptionNeeded ? "subscription_needed: 구독/한도 확인 필요" : firstCall.detail,
        });
      }
      if (result.ok && noPairingRuntime && (!firstCallRuntime || firstCall?.ok)) {
        const rtLabel = agent.runtime === "codex" ? "codex 브릿지" : agent.runtime === "claude_channel" ? "claude 봇" : "hermes 게이트웨이";
        jn.state = "done"; jn.detail = `활성화됨 (${rtLabel} 가동 + 첫 모델 호출 확인) — 합류. 이제 Telegram에서 @<bot_username>에게 DM으로 인사해 보세요. 답이 오면 연동 성공입니다.`;
      } else if (firstCall?.subscriptionNeeded) {
        jn.state = "blocked";
        jn.detail = "subscription_needed: 구독 또는 사용 한도 때문에 첫 모델 호출이 실패했습니다. 결제/구독 상태를 확인한 뒤 다시 활성화하세요.";
      } else {
        jn.detail = result.ok ? "활성화됨 — 첫 모델 호출 확인/첫 응답(ack) 대기" : "활성화 대기";
      }
    }
    parsed.steps = steps;
    const stage = deriveStage(steps);
    db.query("UPDATE ot SET steps_json = ?, stage = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(parsed), stage, ot_id);
    const subscriptionNeeded = steps.some((s: any) => s.key === "join" && s.state === "blocked" && /subscription_needed/i.test(String(s.detail ?? "")));
    appendAudit(db, "user", result.ok ? "ot_activated" : "ot_activate_failed", row.member_id, { ot_id, steps: result.steps.map((s) => ({ step: s.step, ok: s.ok })) });
    return c.json({ ok: result.ok && !subscriptionNeeded, subscription_needed: subscriptionNeeded, error: subscriptionNeeded ? "subscription_needed" : result.error, steps: result.steps, ot: { ot_id, member_id: row.member_id, stage, steps } }, result.ok || subscriptionNeeded ? 200 : 502);
  });

  // ── preflight 재확인: OWNER가 터미널에서 codex login / claude 로그인한 직후 즉시 재점검 ──
  //   GET /ot/:ot_id 폴링은 저장된 steps만 반환(재점검 안 함)하므로, blocked 상태 회복은 이 엔드포인트로만 가능.
  //   credential 값은 보지 않고 존재·status만 본다(checkRuntimeAuth). 통과 시 preflight=done → 활성화 버튼 노출.
  app.post("/ot/:ot_id/preflight-recheck", async (c) => {
    const ot_id = c.req.param("ot_id");
    const row = db.query("SELECT id, member_id, steps_json FROM ot WHERE id = ?").get(ot_id) as any;
    if (!row) return c.json({ error: "unknown_ot", ot_id }, 404);
    let parsed: any = {};
    try { parsed = JSON.parse(row.steps_json); } catch { parsed = {}; }
    let runtime = "claude_channel";
    try { runtime = readAgents().find((a: any) => a.id === row.member_id)?.runtime ?? runtime; } catch { /* 기본값 사용 */ }
    const steps = Array.isArray(parsed.steps) ? parsed.steps : initOtSteps();
    const pf = steps.find((s: any) => s.key === "preflight");
    if (pf) {
      try {
        const auth = await doCheckRuntimeAuth(runtime); // credential 값 노출 없음 — 존재·status만
        pf.state = auth.loggedIn ? "done" : "blocked";
        pf.detail = auth.loggedIn ? auth.detail : auth.fixHint; // fixHint 만, 토큰/계정값 절대 X
      } catch (e) {
        pf.state = "blocked"; pf.detail = "인증 점검 실패: " + (e instanceof Error ? e.message : String(e));
      }
    }
    parsed.steps = steps;
    const stage = deriveStage(steps);
    db.query("UPDATE ot SET steps_json = ?, stage = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(parsed), stage, ot_id);
    appendAudit(db, "user", pf?.state === "done" ? "ot_preflight_ok" : "ot_preflight_blocked", row.member_id, { ot_id, runtime });
    return c.json({ ok: pf?.state === "done", ot: { ot_id, member_id: row.member_id, stage, steps } });
  });

  // 영입 마지막 단계: OWNER 접근(pairing) 승인 — 서버가 pairing.json pending 요청을 읽어 executor로 승인(터미널 0).
  // OWNER가 봇에 DM 한번 → 대시보드 [접근 승인] 탭. 인증된 대시보드 트리거 = OWNER 인가(/, approve 모델과 동일).
  app.post("/ot/:ot_id/pair-approve", async (c) => {
    const ot_id = c.req.param("ot_id");
    const row = db.query("SELECT id, member_id FROM ot WHERE id = ?").get(ot_id) as any;
    if (!row) return c.json({ error: "unknown_ot", ot_id }, 404);
    let agent: any = null;
    try { agent = readAgents().find((a) => a.id === row.member_id) ?? null; } catch { /* ignore */ }
    if (!agent) return c.json({ error: "unknown_member", id: row.member_id }, 404);
    if (agent.runtime !== "openclaw") return c.json({ ok: true, detail: `${agent.runtime}: pairing 승인 불필요`, skipped: true, fixHint: agent.runtime === "claude_channel" ? "claude 페어링 승인은 pair-approve 가 아니라 ~/.claude/channels/telegram-<id>/access.json 의 allowFrom 에 본인 DM chat_id 추가(dmPolicy=allowlist). setup-claude-telegram-bot 스킬이 있으면 promote-pending.sh <id> <code>." : undefined });
    const r = await approveOpenclawPairing(agent.id);
    appendAudit(db, "user", r.ok ? "ot_pair_approved" : "ot_pair_approve_failed", row.member_id, { ot_id, reason: r.reason });
    if (r.ok) {
      // 접근 승인 성공 = openclaw 멤버가 OWNER와 양방향 가능 → 합류 완료 처리. 패널이 "합류 완료"로 전환되고
      // 접근 승인 버튼이 사라진다(중복 클릭·"요청 없음" 혼란 제거). OWNER 피드백 2026-06-11.
      try {
        const orow = db.query("SELECT steps_json FROM ot WHERE id = ?").get(ot_id) as any;
        let parsed: any = {}; try { parsed = JSON.parse(orow?.steps_json ?? "{}"); } catch { /* */ }
        const steps = Array.isArray(parsed.steps) ? parsed.steps : initOtSteps();
        const jn = steps.find((s: any) => s.key === "join");
        if (jn) { jn.state = "done"; jn.detail = "접근 승인 완료 — 합류"; }
        parsed.steps = steps; parsed.awaiting_input = null;
        const stage = deriveStage(steps);
        db.query("UPDATE ot SET steps_json = ?, stage = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(parsed), stage, ot_id);
        return c.json({ ok: true, detail: r.detail, ot: { ot_id, member_id: row.member_id, stage, steps, joined: stage === "joined" } });
      } catch { /* 갱신 실패해도 승인 자체는 성공 */ }
    }
    return c.json({ ok: r.ok, detail: r.detail, reason: r.reason }, r.ok ? 200 : (r.reason === "no_request" ? 409 : 502));
  });

  // ── OT 번들: 신규 영입이 합류 시 받는 패키지(무엇이 다운로드되나) ──
  // 팀 스킬 목록 — skills/*/SKILL.md frontmatter(name·description) 스캔. OT 번들에 포함(신규 팀원이 어떤 스킬이 있는지 발견).
  // 실제 설치/복사는 안 함(OWNER 2026-06-30 옵션 A) — 스킬은 team-collab/skills 공유 경로라 런타임 무관하게 그대로 실행.
  function listTeamSkills(): Array<{ name: string; description: string }> {
    try {
      const skillsDir = join(dirname(registryPath), "skills");
      const out: Array<{ name: string; description: string }> = [];
      for (const d of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const f = join(skillsDir, d.name, "SKILL.md");
        if (!existsSync(f)) continue;
        const fm = readFileSync(f, "utf-8").match(/^---\n([\s\S]*?)\n---/);
        const body = fm?.[1] ?? "";
        const name = (body.match(/^name:\s*(.+)$/m)?.[1] ?? d.name).trim();
        const desc = (body.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? "").trim().slice(0, 300);
        out.push({ name, description: desc });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    } catch { return []; }
  }

  app.get("/ot/:ot_id/bundle", (c) => {
    const ot_id = c.req.param("ot_id");
    const row = db.query("SELECT id, member_id, steps_json FROM ot WHERE id = ?").get(ot_id) as any;
    if (!row) return c.json({ error: "unknown_ot", ot_id }, 404);
    let parsed: any = {};
    try { parsed = JSON.parse(row.steps_json); } catch { parsed = {}; }
    let agent: any = null;
    try { agent = readAgents().find((a) => a.id === row.member_id) ?? null; } catch { /* ignore */ }
    let mission = "", currentState = "";
    try {
      const t = readFileSync(teamOsPath, "utf-8");
      const m1 = t.match(MISSION_RE); mission = m1 ? (m1[2] ?? "").trim() : "";
      const m8 = t.match(/## 8\. Current State[\s\S]*?\n([\s\S]*?)(?=\n## 9\.)/);
      currentState = m8 ? (m8[1] ?? "").trim().slice(0, 1200) : "";
    } catch { /* best-effort */ }
    return c.json({
      ot_id, member: agent ? { id: agent.id, display_name: agent.display_name, role: agent.role, runtime: agent.runtime, icon: agent.icon } : { id: row.member_id },
      team_os: { rules_path: "rules/TEAM-OS.md", mission },
      persona: typeof parsed.persona === "string" ? parsed.persona : "",
      current_state: currentState,
      capabilities: VISIBLE_CAPABILITIES,
      skills: listTeamSkills(), // 팀 스킬 목록(이름·설명) — 신규 팀원 발견용. 실제 설치 아님(공유 경로 team-collab/skills에서 실행).
      connection: agent ? { runtime: agent.runtime, status_provider: agent.status_provider, workspace_path: agent.workspace_path, persona_file: agent.persona_file, note: "시크릿(토큰 등)은 .env·런타임에서 주입 — 값 노출 금지" } : null,
      first_action: "①TEAM-OS 로드 → ②자기 thread 구독·대기 → ③요청 오면 feedback-mode(받음/못함/ETA/1차의견) → ④작업표면(Inbox/Tasks/Agents/Audit) 확인",
    });
  });

  // ── 시스템 OP (P0 기본 협업 floor) — capture 봇 토큰·라우터·그룹을 UI로 설정 ──
  // 토큰=0600 파일(write-only, UI엔 has_capture_token 만 노출) / router=라이브 토글(즉시) / 토큰·그룹=재시작 시 적용.
  // graceful PIN: PIN 설정돼 있으면 검증 필수(앱레벨 잠금, 자가호스터 보안), 없으면 dashboard-trusted(기본 floor UX 안 막음).
  const CAPTURE_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,120}$/; // 하네스 LOW-1: 길이 상한(DoS 방지)
  const CAPTURE_GROUP_RE = /^-?\d{1,20}$/; // telegram chat_id(음수 supergroup 포함). 하네스 LOW-1: group 검증
  app.get("/system-op", (c) => c.json(captureConfigStatus(db)));

  // ── merge-gate (강제 머지 승인) ON/OFF ─────────────────────────────
  // 라이브 전용. OFF(기본)=퍼블릭과 동일(게이트 없음). 토글은 install-merge-gate.sh 를 통해
  // 훅 wiring(core.hooksPath)+flag(merge_gate_enabled)을 함께 켜고 끈다.
  const mergeGateStatus = () => {
    // flag = repo-local git config (b3os.mergeGate) · wired = core.hooksPath=githooks. 둘 다여야 실효.
    // available = install-merge-gate.sh 존재(=내부 관리 repo). 공개판은 scripts/ 제외라 미존재 → UI 숨김.
    const repo = process.env.TEAM_COLLAB_DIR ?? `${process.env.HOME}/Development/b3rys-team-os`;
    const available = existsSync(`${repo}/scripts/install-merge-gate.sh`);
    const cfg = (k: string) => { try { return Bun.spawnSync(["git", "-C", repo, "config", "--get", k]).stdout.toString().trim(); } catch { return ""; } };
    const flag = cfg("b3os.mergeGate") === "true";
    const wired = cfg("core.hooksPath") === "githooks";
    // ★승인자는 설정에서 읽어 내려준다★ — UI 가 이름을 하드코딩하면(예: "Bill·Steve·Codex")
    //   설정을 바꿔도 화면은 옛 이름을 말하고, 공개 사용자에겐 ★존재하지 않는 팀원 이름★을 보여주게 된다(거짓말).
    return { available, enabled: flag && wired, flag, wired, approvers: getNormalApprovers(db) };
  };
  app.get("/merge-gate", (c) => c.json(mergeGateStatus()));
  app.patch("/merge-gate", async (c) => {
    // 공개판/비관리 repo(install 스크립트 없음) → 이 엔드포인트 비활성(404). live-only.
    if (!mergeGateStatus().available) return c.json({ ok: false, error: "merge_gate_unavailable" }, 404);
    let body: { enabled?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid_json" }, 400); }
    if (typeof body.enabled !== "boolean") return c.json({ ok: false, error: "enabled_bool_required" }, 400);
    const repo = process.env.TEAM_COLLAB_DIR ?? `${process.env.HOME}/Development/b3rys-team-os`;
    const sub = body.enabled ? "enable" : "disable";
    const p = Bun.spawnSync(["bash", `${repo}/scripts/install-merge-gate.sh`, sub], { env: { ...process.env, TEAM_COLLAB_DIR: repo } });
    const out = (p.stdout.toString() + p.stderr.toString()).trim().slice(-500);
    const ok = p.exitCode === 0;
    appendAudit(db, "user", "merge_gate_toggled", "system", { enabled: body.enabled, ok });
    return c.json({ ok, ...mergeGateStatus(), output: out });
  });

  app.patch("/system-op", async (c) => {
    let body: { capture_bot_token?: unknown; capture_group_id?: unknown; router_enabled?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid_json" }, 400); }
    // (접근제어/PIN은 System OP에서 제거 — OWNER 2026-06-28. 추후 소셜로긴/이메일로 독립 레벨 설계.)
    const token = typeof body.capture_bot_token === "string" ? body.capture_bot_token.trim() : undefined;
    const group = typeof body.capture_group_id === "string" ? body.capture_group_id.trim() : undefined;
    const router = typeof body.router_enabled === "boolean" ? body.router_enabled : undefined;
    if (token !== undefined && token !== "" && !CAPTURE_TOKEN_RE.test(token)) {
      return c.json({ ok: false, error: "capture_bot_token_invalid", hint: "봇 토큰 형식: 숫자:영숫자30~120 (BotFather)" }, 400);
    }
    if (group !== undefined && group !== "" && !CAPTURE_GROUP_RE.test(group)) {
      return c.json({ ok: false, error: "capture_group_id_invalid", hint: "그룹 chat_id는 숫자(슈퍼그룹은 -100…). 예: -1001234567890" }, 400);
    }
    let needsRestart = false;
    if (token) { setCaptureToken(token); needsRestart = true; }
    if (group !== undefined) { setCaptureGroupId(group); needsRestart = true; } // 파일기반(captureConfig) — 재시작 시 적용
    if (router !== undefined) setRouterEnabled(db, router); // 라이브 — 재시작 불요
    appendAudit(db, "user", "system_op_updated", "system", { token_set: !!token, group_set: group !== undefined, router_enabled: router }); // ★토큰 값은 audit에 안 넣음
    return c.json({ ok: true, ...captureConfigStatus(db), needs_restart: needsRestart, note: needsRestart ? "토큰/그룹 변경은 서버 재시작 시 적용(라우터는 즉시)" : "적용됨" });
  });

  // 저장된 토큰이 텔레그램에서 유효한지 확인(getMe). ★응답엔 bot_username 만, 토큰 값 노출 안 함.
  app.post("/system-op/check", async (c) => {
    const tok = getCaptureToken();
    if (!tok) return c.json({ ok: false, error: "no_token" }, 400);
    try {
      const r = await fetch(`https://api.telegram.org/bot${tok}/getMe`);
      const j = (await r.json()) as { ok?: boolean; result?: { username?: string } };
      if (!j.ok) return c.json({ ok: false, error: "telegram_rejected" }, 400);
      return c.json({ ok: true, bot_username: j.result?.username ?? null });
    } catch {
      return c.json({ ok: false, error: "check_failed" }, 502);
    }
  });

  // 캡처 worker가 이미 받은 최근 non-bot 발신자 id를 팀장 텔레그램 id로 저장한다.
  // 안전: 여기서 getUpdates를 직접 호출하지 않는다. CAPTURE_BOT_TOKEN은 worker long-poll과 토큰당 단일 poller라 경합한다.
  // 토큰은 captureConfig 경로(getCaptureToken)로만 읽고, 응답/audit에는 숫자 id와 bot_username만 둔다.
  app.post("/system-op/detect-lead-id", async (c) => {
    const tok = getCaptureToken();
    if (!tok) return c.json({ ok: false, error: "no_token" }, 400);
    try {
      const sender = latestCaptureNonBotSender(db);
      if (!sender) {
        return c.json({ ok: false, error: "no_recent_sender", hint: "캡처 worker가 켜진 상태에서 캡처봇이 들어간 텔레그램 대화에 팀장이 메시지 1개를 보낸 뒤 다시 시도하세요." }, 404);
      }
      setSetting(db, "lead_telegram_id", sender.id);
      appendAudit(db, "user", "lead_telegram_id_detected", "system", { lead_telegram_id: sender.id, username: sender.username });
      return c.json({ ok: true, lead_telegram_id: sender.id, username: sender.username, note: "숫자 id는 non-secret입니다. 캡처 승인 allowlist는 lead_telegram_id setting을 함께 봅니다." });
    } catch (e) {
      return c.json({ ok: false, error: "detect_failed", detail: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  return app;
}
