// Settings — 팀 셀프 커스터마이즈 탭 (심플 코어: 팀 정체성 + 팀원).
// API(전부 /team/api 하위): GET/PUT /settings · GET/PUT /mission · GET/POST /members · DELETE /members/:id.
// 봇·tmux·slack 실제 연결은 b3os-team-member-lifecycle 스킬로 별도 — 여기선 레지스트리 엔트리만.
import { apiBase } from "../ws";
import { store } from "../store";
import { pick } from "../i18n";
import { renderIcon, agentIconName } from "../icons";
import { renderAgentIcon } from "../agentColors";
import { FALLBACK_RUNTIME_OPTIONS, fetchRuntimeOptions, runtimeLabel as optionRuntimeLabel, runtimeSetupHref, type RuntimeOption } from "./runtimeOptions";

// 시간 걸리는 버튼: 클릭 즉시 "⏳ …중" + 흐려짐 + 다시 못 눌림(중복 클릭 방지). restore() 로 복구.
export function setBtnBusy(btn: HTMLButtonElement, busyText: string): () => void {
  const orig = btn.textContent ?? "";
  btn.textContent = busyText; btn.disabled = true;
  btn.style.opacity = "0.55"; btn.style.cursor = "wait";
  return () => { btn.textContent = orig; btn.disabled = false; btn.style.opacity = ""; btn.style.cursor = ""; };
}

interface TeamSettings { team_name: string; lead_id: string; tagline: string; owner_name: string; owner_chat_id: string; locale: "ko" | "en"; dm_capture: boolean }
interface Member { id: string; display_name: string; role: string; runtime: string; avatar_emoji?: string; icon?: string | null; icon_color?: string | null; team_official_member?: boolean; off?: boolean }
interface Capability { key: string; label: string; desc: string; category?: string }
interface SlackMemberStatus {
  id: string;
  display_name: string;
  slack_bot_user_id: string | null;
  slack_app_name: string | null;
  state: "ready" | "partial" | "not_connected";
  has_identity: boolean;
  has_token: boolean;
  has_signing_secret: boolean;
  has_app_id: boolean;
  supports_bot_mentions: boolean;
}
interface SlackStatus {
  enabled: boolean;
  channels: string[];
  poll_interval_ms: number;
  token_agent: string | null;
  tokens_dir: string;
  members: SlackMemberStatus[];
  summary: { ready: number; partial: number; not_connected: number };
  notes?: string[];
}
// /slack/health — auth.test 기반 실측. effective=token_invalid는 토큰 있는데 앱 죽음(재설치 필요).
type SlackEffective = "ready" | "token_invalid" | "partial" | "not_connected" | "check_failed";
interface SlackHealth {
  members: Array<{ id: string; effective: SlackEffective; live_error?: string | null }>;
  summary: { ready: number; token_invalid: number; check_failed: number; partial: number; not_connected: number };
}
// state: 'blocked' = 회복 가능한 대기(예: preflight 미로그인 — GD 터미널 로그인 후 자동 통과). 'failed'와 달리 OT 전체를 실패로 보지 않는다.
interface OtStep { key: string; label: string; state: "pending" | "running" | "done" | "blocked" | "failed"; detail?: string }
interface OtField { key: string; label: string; secret?: boolean; hint?: string }
interface AwaitingInput { kind: string; hint?: string; fields: OtField[] }
interface OtData { ot_id: string; member_id: string; stage: string; steps: OtStep[]; done?: boolean; joined?: boolean; error?: string; awaiting_input?: AwaitingInput | null }
interface OtState { otId: string; member: Member; data: OtData | null }

// 영입 검증(acceptance-check) — Devon 엔드포인트 GET /api/members/:id/acceptance-check 응답 계약.
interface AcceptanceCheck { label: string; status: "pass" | "fail" | "info"; detail?: string; fix?: string }
interface AcceptanceSection { key: string; label: string; checks: AcceptanceCheck[] }
interface AcceptanceResult { ok: boolean; summary: { pass: number; fail: number; info: number }; sections: AcceptanceSection[] }
// 검증 진행 상태(staged reveal): result 받은 뒤 체크를 한 줄씩 드러내 진행감을 준다.
interface OtVerifyState { member: string; loading: boolean; result: AcceptanceResult | null; revealed: number; error: string | null }

const MAX_OFFICIAL_TEAM_MEMBERS = 15;

function activeOfficialMemberCount(): number {
  return _members.filter((m) => m.team_official_member !== false && !m.off).length;
}
// OT 4단계 라벨 — 서버 steps 도착 전 스켈레톤용(서버가 steps 주면 그걸 우선).
const OT_STEP_DEFS: { key: string; label: string }[] = [
  { key: "register", label: pick("등록", "Register") },
  { key: "provision", label: pick("프로비저닝", "Provisioning") },
  { key: "preflight", label: pick("인증 확인", "Auth check") },   // 선택 런타임 로그인 사전점검 — 미로그인이면 활성화 차단(blocked)
  { key: "bundle", label: pick("OT 번들 전달", "OT bundle handoff") },
  { key: "join", label: pick("합류 확인", "Join confirmation") },
];

let _root: HTMLElement | null = null;
let _settings: TeamSettings = { team_name: "", lead_id: "", tagline: "", owner_name: "", owner_chat_id: "", locale: "ko", dm_capture: true };
// 첫 세팅 락(GD): 팀명+팀장ID 통과해야 팀원 영입. GET /settings가 setup_complete/lead_actor_id 반환.
let _setupComplete = false;
let _leadActorId: string | null = null;
let _leadTelegramId: string | null = null; // detect-lead-id 로 감지되면 표시
const LEAD_ID_RE = /^[a-z0-9_-]{1,40}$/;
// 팀장 텔레그램ID 자동감지 버튼: detect-lead-id의 getUpdates가 capture worker 폴링과 경합 위험(Steve concern·Bill 확인)
// → Codex 오프셋 안전화 후 true 로 켠다. 그 전까진 숨김(필드+배지+PUT은 배포 OK). Bill 2026-07-02.
const DETECT_LEAD_ENABLED = false;
let _members: Member[] = [];
let _runtimeOptions: RuntimeOption[] = FALLBACK_RUNTIME_OPTIONS;
let _capabilities: Capability[] = [];
let _slack: SlackStatus | null = null;
let _slackHealth: SlackHealth | null = null; // auth.test 실측(2단계 갱신) — 배지 정확성용
// 시스템 OP (P0 기본 협업 floor) — capture 토큰·router·그룹·PIN. 토큰값은 안 받음(has_*만).
let _systemOp: { has_capture_token: boolean; capture_group_id: string | null; router_enabled: boolean } | null = null;
let _mergeGate: { available: boolean; enabled: boolean; flag: boolean; wired: boolean; approvers?: string[] } | null = null;
let _systemOpOpen = false; // 기본 접힘 — 클릭하면 펼침(설정 필요 느낌만 주고 평소엔 간결).
let _addOpen = false;
let _ot: OtState | null = null;          // 진행 중인 신규 OT(영입). null이면 폼/버튼 표시.

// 온보딩 CTA('첫 팀원 만들기')가 Settings 진입 시 영입 폼을 바로 펼치도록.
// setMainView("settings") 직전에 호출하면, 처음 렌더되는 Settings가 '+영입' 버튼 대신 폼을 보여준다.
export function openRecruitForm(): void { _addOpen = true; }
let _otTimer: ReturnType<typeof setInterval> | null = null;
let _rollbackTimer: ReturnType<typeof setInterval> | null = null; // 전체 재적용 롤백 버튼 6h 카운트다운
let _rollbackGen = 0; // refreshRollback overlap 가드 — 늦게 끝난 이전 async 호출이 새 interval 만드는 누수 방지(Devon P1)

// 라이브 전용 운영 버튼(전체 핵심룰 재적용 + 롤백) 노출 여부 = ★런타임 플래그★. 서버가 대시보드 HTML에
// 주입하는 window.__B3OS_LIVE__(B3OS_LIVE=1 일 때 true)를 읽는다. 기본(공개)=false → 라이브 전용 UI 숨김.
// 백엔드 엔드포인트는 PUBLIC_BUILD 가 이중으로 가드. (public=source: 빌드 플립 제거 · 토글 목록=docs/BUILD_MODES.md)
export const LIVE_ONLY_OPS =
  typeof window !== "undefined" && (window as { __B3OS_LIVE__?: boolean }).__B3OS_LIVE__ === true;
let _otVerify: OtVerifyState | null = null;          // 영입 검증(합류 후 acceptance-check)
let _otVerifyTimer: ReturnType<typeof setInterval> | null = null; // staged reveal 타이머
let _activating = false;        // 활성화 fetch in-flight — 폴링 re-render가 버튼 다시 켜는 것 방지(중복 클릭 차단)
let _activateMsg = "";          // 활성화 진행/결과 HTML(재렌더 간 보존)
let _pairing = false;           // pairing 승인 fetch in-flight(동일 폴링 가드)
let _pairMsg = "";              // pairing 승인 진행/결과 HTML(재렌더 간 보존)
let _prechecking = false;       // preflight 재확인 fetch in-flight(중복 클릭 차단)
let _precheckMsg = "";          // preflight 재확인 진행/결과 HTML(재렌더 간 보존)
// preflight blocked 동안 폴링 사이클에서 자동 recheck를 돌리되, 매 1.5s 폴링마다가 아니라 throttle(아래 간격)로만.
// 런타임 preflight가 느릴 수 있으므로 throttle 필수. _autoRecheckAt=0이면 아직 안 돌림.
const AUTO_RECHECK_MS = 5000;   // 자동 재확인 최소 간격(폴링은 1.5s지만 recheck는 5s마다)
let _autoRecheckAt = 0;         // 마지막 자동 recheck 시각(ms). throttle 게이트.
let _autoRechecking = false;    // 자동 recheck fetch in-flight(중복 호출/수동 버튼과 겹침 방지)

function escape(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function shouldShowClaudePairingPanel(runtime: string, awaiting: Pick<AwaitingInput, "kind"> | null | undefined): boolean {
  if (runtime !== "claude_channel") return false;
  const kind = String(awaiting?.kind ?? "").toLowerCase();
  return kind === "claude_pairing_code" || kind === "telegram_plugin_pairing";
}

function claudePairingPanelHtml(aw: AwaitingInput): string {
  return `
    <div class="rounded-lg border border-accent-green/30 bg-surface-0/60 p-3.5 mt-3">
      <div class="text-[12px] font-semibold text-slate-200 mb-1">${pick("Claude 접근 승인", "Claude access approval")}</div>
      <div class="text-[11px] text-slate-400 leading-relaxed mb-2">${escape(aw.hint || pick("봇 DM에서 받은 6자리 코드를 입력해 승인하세요. 이 박스는 서버가 승인 필요 상태를 내려줄 때만 보입니다.", "Enter the 6-digit code from the bot DM to approve access. This box appears only when the server reports that pairing is required."))}</div>
      <div class="flex flex-col sm:flex-row gap-2">
        <input id="ot-claude-pair-code" class="${inputCls} sm:flex-1" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="123456" />
        <button id="ot-claude-pair-approve" class="${btnPrimary}"${_pairing ? " disabled" : ""}>${_pairing ? `⏳ ${pick("승인 중…", "Approving…")}` : `🔓 ${pick("승인", "Approve")}`}</button>
      </div>
      <div class="text-[11px] text-slate-600 mt-2">${pick("두 번째 이후 Claude 팀원은 보통 기존 Telegram plugin access.json 승인을 자동 승계하므로 이 박스가 뜨지 않는 것이 정상입니다.", "Later Claude teammates usually inherit the existing Telegram plugin access.json approval automatically, so it is normal for this box not to appear.")}</div>
      <div id="ot-pair-result" class="mt-2 text-[12px] space-y-0.5">${_pairMsg}</div>
    </div>`;
}
export function runtimeLabel(rt: string): string {
  return optionRuntimeLabel(rt, _runtimeOptions);
}
function api(path: string): string {
  return `${apiBase()}/api${path}`;
}
// 팀명을 대시보드 탭 타이틀 + 좌상단 브랜드에 반영. team_name 비면 기본("b3rys") 유지.
let _cachedTeamName = "";
export function getTeamName(): string { return _cachedTeamName; } // MetricsBar 브랜드가 렌더마다 읽음
export function applyTeamTitle(name: string): void {
  const n = (name || "").trim();
  _cachedTeamName = n;
  if (n) document.title = `${n} - team os`;
  const brand = document.querySelector("[data-team-brand]"); // 비동기 로드 완료 시점 직접 패치(update 미발생 대비)
  if (brand) brand.textContent = n || "b3rys";
}
// 부팅 시 1회: Settings 탭 방문 전에도 팀명이 타이틀에 보이게.
export async function initTeamTitle(): Promise<void> {
  try {
    const s = await fetch(api("/settings"), { headers: { accept: "application/json" } }).then((r) => r.json());
    if (s && s.team_name) applyTeamTitle(s.team_name);
    // locale 은 localStorage 가 권위(i18n.ts 모듈 초기화) — 백엔드에서 덮지 않는다(토글이 localStorage+백엔드 동시 설정). 백엔드 locale 은 팀원 메시지 주입용.
  } catch {
    /* best-effort — 실패 시 기본 타이틀 유지 */
  }
}

async function loadAll(): Promise<void> {
  const [s, mem, cap, slack, sysop, mgate, runtimeOptions] = await Promise.allSettled([
    fetch(api("/settings"), { headers: { accept: "application/json" } }).then((r) => r.json()),
    fetch(api("/members"), { headers: { accept: "application/json" } }).then((r) => r.json()),
    fetch(api("/capabilities"), { headers: { accept: "application/json" } }).then((r) => r.json()),
    fetch(api("/slack/status"), { headers: { accept: "application/json" } }).then((r) => r.json()),
    fetch(api("/system-op"), { headers: { accept: "application/json" } }).then((r) => r.json()),
    fetch(api("/merge-gate"), { headers: { accept: "application/json" } }).then((r) => r.json()),
    fetchRuntimeOptions(),
  ]);
  if (s.status === "fulfilled" && s.value) {
    _settings = { team_name: s.value.team_name ?? "", lead_id: s.value.lead_id ?? "", tagline: s.value.tagline ?? "", owner_name: s.value.owner_name ?? "", owner_chat_id: s.value.owner_chat_id ?? "", locale: s.value.locale === "en" ? "en" : "ko", dm_capture: s.value.dm_capture !== false };
    _setupComplete = Boolean(s.value.setup_complete);
    _leadActorId = s.value.lead_actor_id ?? null;
  }
  if (mem.status === "fulfilled" && Array.isArray(mem.value)) _members = mem.value;
  if (cap.status === "fulfilled" && Array.isArray(cap.value)) _capabilities = cap.value;
  if (slack.status === "fulfilled" && slack.value && Array.isArray(slack.value.members)) _slack = slack.value as SlackStatus;
  if (sysop.status === "fulfilled" && sysop.value && typeof sysop.value.router_enabled === "boolean") _systemOp = sysop.value;
  if (mgate.status === "fulfilled" && mgate.value && typeof mgate.value.enabled === "boolean") _mergeGate = mgate.value;
  if (runtimeOptions.status === "fulfilled") _runtimeOptions = runtimeOptions.value;
  applyTeamTitle(_settings.team_name);
}

async function refreshMembers(): Promise<void> {
  try {
    const mem = await fetch(api("/members"), { headers: { accept: "application/json" } }).then((r) => r.json());
    if (Array.isArray(mem)) _members = mem;
  } catch { /* keep current */ }
}

function card(title: string, eyebrow: string, body: string): string {
  return `
    <div class="rounded-xl border border-surface-3 bg-surface-2/60 p-5">
      <div class="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-txt-green">${escape(eyebrow)}</div>
      <div class="mb-4 text-base font-semibold text-slate-100">${escape(title)}</div>
      ${body}
    </div>`;
}

// auth.test 실측 effective가 있으면 그걸, 없으면 파일기반 status state로 폴백.
function effectiveFor(id: string): string {
  return _slackHealth?.members.find((m) => m.id === id)?.effective ?? slackForMember(id)?.state ?? "not_connected";
}

async function loadSlackHealth(): Promise<void> {
  try {
    const h = await fetch(api("/slack/health"), { headers: { accept: "application/json" } }).then((r) => r.json());
    if (h && Array.isArray(h.members)) { _slackHealth = h as SlackHealth; if (_root) render(); }
  } catch { /* status 폴백 유지 */ }
}

// 설정 뷰 재진입 시 Slack 상태/헬스 재조회 — 토큰 갱신·재연동 후에도 '재설치 필요' 배지가 stale로 남던 것 방지(GD).
// renderSettings는 main.ts에서 1회만 호출되므로(settingsRendered 가드), 재방문 갱신은 이 가벼운 재조회로 처리한다.
export async function refreshSettingsSlack(): Promise<void> {
  if (!_root) return; // 아직 한 번도 렌더 안 됐으면 renderSettings가 처리
  try {
    const s = await fetch(api("/slack/status"), { headers: { accept: "application/json" } }).then((r) => r.json());
    if (s && Array.isArray(s.members)) _slack = s as SlackStatus;
  } catch { /* 이전 값 유지 */ }
  render();
  void loadSlackHealth(); // auth.test 실측 재조회 → 배지 갱신
}

// 설정 뷰 재진입 시 팀원 로스터 재조회 — 퇴사(다른 화면 AgentConfig danger zone)·영입 후에도 로스터가 stale 로
// 남던 것 방지(Bill flag 2026-07-01: Cody 퇴사 후 왼쪽 메뉴는 갱신됐으나 Settings 로스터는 새로고침 전까지 stale).
// renderSettings는 1회만 호출되므로(settingsRendered 가드), 재방문 갱신은 이 가벼운 재조회로 처리한다.
export async function refreshSettingsMembers(): Promise<void> {
  if (!_root) return; // 아직 렌더 안 됐으면 renderSettings가 처리
  try {
    const mem = await fetch(api("/members"), { headers: { accept: "application/json" } }).then((r) => r.json());
    if (Array.isArray(mem)) _members = mem;
  } catch { /* 이전 값 유지 */ }
  render();
}

function slackStateLabel(state: string): { label: string; cls: string } {
  if (state === "ready") return { label: "Ready", cls: "border-accent-green/30 text-accent-greenSoft bg-accent-green/10" };
  if (state === "token_invalid") return { label: pick("재설치 필요", "Reinstall needed"), cls: "border-txt-red/40 text-txt-red bg-txt-red/10" };
  if (state === "partial") return { label: "Needs repair", cls: "border-txt-amber/40 text-txt-amber bg-txt-amber/10" };
  if (state === "check_failed") return { label: pick("확인 실패", "Check failed"), cls: "border-txt-amber/40 text-txt-amber bg-txt-amber/10" };
  return { label: "Optional", cls: "border-surface-3 text-slate-500 bg-surface-0" };
}

function slackForMember(id: string): SlackMemberStatus | null {
  return _slack?.members.find((m) => m.id === id) ?? null;
}

function slackChannelsHtml(): string {
  if (!_slack) return "";
  const top = card(pick("지원 채널", "Supported channels"), "channels", `
    <div class="space-y-3">
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div class="rounded-lg border border-surface-3 bg-surface-0/60 p-3">
          <div class="text-[10px] uppercase tracking-wide text-slate-500">Telegram</div>
          <div class="text-sm font-semibold text-accent-greenSoft mt-1">Primary</div>
          <div class="text-[11px] text-slate-500 mt-1 leading-snug">${pick("팀방 멘션·visible reply 기본 채널", "Default channel for team-room mentions and visible replies")}</div>
        </div>
        <div class="rounded-lg border border-surface-3 bg-surface-0/60 p-3">
          <div class="text-[10px] uppercase tracking-wide text-slate-500">Slack</div>
          <div class="text-sm font-semibold text-slate-300 mt-1">Supported option</div>
          <div class="text-[11px] text-slate-500 mt-1 leading-snug">${pick("봇→봇 멘션과 thread reply 지원", "Supports bot-to-bot mentions and thread replies")}</div>
        </div>
        <div class="rounded-lg border border-surface-3 bg-surface-0/60 p-3">
          <div class="text-[10px] uppercase tracking-wide text-slate-500">${pick("폴링 · 보조", "Polling · fallback")}</div>
          <div class="text-sm font-semibold ${_slack.enabled ? "text-accent-greenSoft" : "text-slate-400"} mt-1">${_slack.enabled ? "On" : "Off"}</div>
          <div class="text-[11px] text-slate-500 mt-1 leading-snug">${escape(_slack.channels.join(", ") || pick("channel 미설정", "channel not set"))} · ${Math.round(_slack.poll_interval_ms / 1000)}s · ${pick("누락 보조용", "fallback for misses")}</div>
        </div>
      </div>
      <div class="flex flex-wrap gap-2 text-[11px]">
        <span class="px-2 py-1 rounded border border-accent-green/30 text-accent-greenSoft bg-accent-green/10">ready ${_slackHealth?.summary.ready ?? _slack.summary.ready}</span>
        ${_slackHealth && _slackHealth.summary.token_invalid > 0 ? `<span class="px-2 py-1 rounded border border-txt-red/40 text-txt-red bg-txt-red/10">${pick("재설치 필요", "Reinstall needed")} ${_slackHealth.summary.token_invalid}</span>` : ""}
        ${(_slackHealth?.summary.partial ?? _slack.summary.partial) > 0 ? `<span class="px-2 py-1 rounded border border-txt-amber/40 text-txt-amber bg-txt-amber/10">repair ${_slackHealth?.summary.partial ?? _slack.summary.partial}</span>` : ""}
        <span class="px-2 py-1 rounded border border-surface-3 text-slate-500 bg-surface-0">optional ${_slackHealth?.summary.not_connected ?? _slack.summary.not_connected}</span>
        ${_slackHealth ? "" : `<span class="px-2 py-1 rounded border border-surface-3 text-slate-600 bg-surface-0">${pick("실측 확인 중…", "Live-checking…")}</span>`}
      </div>
      <div class="text-[11px] text-slate-500 leading-relaxed">
        ${pick("Slack은 아직 기본 채널이 아니라 지원 옵션으로 둡니다. 각 팀원 Settings에서 Bot User ID와 token을 넣으면 Telegram과 같은 내부 bus 흐름으로 들어옵니다.", "Slack is not the default channel yet — it's a supported option. Enter each member's Bot User ID and token in their Settings and it joins the same internal bus flow as Telegram.")}
        <br /><span class="text-slate-400">${pick("봇 멘션·연동은 webhook으로 상시 동작", "Bot mentions and integration run continuously via webhook")}</span>${pick("하므로, 위 폴링이 ", ", so even if the polling above is ")}<b>${pick("Off여도 Slack 연동·응답은 정상", "Off, Slack integration and replies work fine")}</b>${pick("입니다(폴링은 webhook 누락 시 보조).", " (polling is a fallback for missed webhooks).")}
      </div>
    </div>
  `);
  return top;
}
const inputCls = "w-full bg-surface-0 border border-surface-3 rounded-lg text-sm text-slate-200 px-3 py-2.5 outline-none focus:border-accent-green/40 placeholder:text-slate-600";
const labelCls = "block text-[12px] font-medium text-slate-400 mb-1.5";
const btnPrimary = "text-[13px] font-semibold px-4 py-2 rounded-lg bg-accent-btn text-accent-on hover:bg-accent-btnHover transition-colors disabled:opacity-50";
const btnGhost = "text-[13px] font-medium px-3.5 py-2 rounded-lg border border-surface-3 bg-surface-2 text-slate-300 hover:text-slate-100 hover:border-accent-green/40 transition-colors";

// ── 능력 카탈로그: '이 팀원이 뭘 할 수 있나'(영입 화면 컨텍스트) ──
function capabilityPanelHtml(): string {
  if (!_capabilities.length) return "";
  const byCat = new Map<string, Capability[]>();
  for (const c of _capabilities) { const k = c.category || pick("기타", "Other"); (byCat.get(k) ?? byCat.set(k, []).get(k)!).push(c); }
  const groups = [...byCat.entries()].map(([cat, items]) => `
    <div>
      <div class="text-[10px] font-semibold uppercase tracking-wide text-txt-green mb-1">${escape(cat)}</div>
      <div class="flex flex-wrap gap-1.5">
        ${items.map((c) => `<span class="text-[11px] px-2 py-0.5 rounded border border-surface-3 bg-surface-0 text-slate-300" title="${escape(c.desc)}">${escape(c.label)}</span>`).join("")}
      </div>
    </div>`).join("");
  return `
    <div class="rounded-lg border border-surface-3 bg-surface-0/60 p-3 mt-3">
      <div class="text-[12px] font-semibold text-slate-200 mb-2">${pick("이 팀이 할 수 있는 일", "What this team can do")} <span class="text-slate-500 font-normal">· ${pick("능력 카탈로그", "capability catalog")} ${_capabilities.length}</span></div>
      <div class="space-y-2.5">${groups}</div>
    </div>`;
}

// ── 영입 마법사 폼 ────────────────────────────────────────────────
function recruitFormHtml(): string {
  const current = activeOfficialMemberCount();
  const atLimit = current >= MAX_OFFICIAL_TEAM_MEMBERS;
  return `
    <div class="rounded-lg border border-accent-green/35 bg-surface-2/60 p-3.5 mt-2">
      <div class="text-[13px] font-semibold text-slate-100 mb-1">${pick("신규 영입 — 새 팀원 OT", "Onboard — new member OT")}</div>
      <div class="text-[11px] ${atLimit ? "text-txt-red" : "text-slate-500"} mb-3">${pick(`공식 팀원 ${current}/${MAX_OFFICIAL_TEAM_MEMBERS}명`, `Official members ${current}/${MAX_OFFICIAL_TEAM_MEMBERS}`)}${atLimit ? pick(" · 상한에 도달했습니다. 기존 팀원을 정지하거나 퇴사 처리해 주세요.", " · Limit reached. Disable or offboard an existing member first.") : ""}</div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div><label class="${labelCls}">id <span class="text-slate-600">${pick("(소문자/숫자/-/_, 2~32, 영문시작)", "(lowercase/digits/-/_, 2–32, starts with a letter)")}</span></label><input id="rec-id" class="${inputCls}" placeholder="${pick("예: nova", "e.g. nova")}" autocomplete="off" /></div>
        <div><label class="${labelCls}">${pick("이름", "Name")}</label><input id="rec-name" class="${inputCls}" placeholder="${pick("예: Nova", "e.g. Nova")}" autocomplete="off" /></div>
        <div><label class="${labelCls}">${pick("역할", "Role")}</label><input id="rec-role" class="${inputCls}" placeholder="${pick("예: 디자인 리드", "e.g. Design lead")}" autocomplete="off" /></div>
        <div><label class="${labelCls}">${pick("런타임", "Runtime")}</label><select id="rec-runtime" class="${inputCls} dash-select">${_runtimeOptions.map((r) => `<option value="${r.runtime}" ${r.disabled ? "disabled" : ""}>${escape(r.label)}${r.recommended ? pick(" · 기본 권장", " · Recommended") : ""}</option>`).join("")}</select><div class="mt-1 space-y-1">${_runtimeOptions.filter((r) => r.tier === "advanced_byo").map((r) => `<div class="text-[11px] ${r.disabled ? "text-txt-amber" : "text-slate-500"}"><b>${escape(r.label)}</b>: ${escape(r.reason)} · <a class="underline" href="${runtimeSetupHref(r.setup_ref)}" target="_blank" rel="noreferrer" data-setup-ref="${escape(r.setup_ref ?? "")}">${pick("연동 안내", "Setup guide")}</a></div>`).join("")}</div></div>
        <div class="md:col-span-2"><label class="${labelCls}">${pick("멘션 별칭", "Mention aliases")} <span class="text-slate-600">${pick("(선택 · 쉼표 구분 · @멘션 라우팅용. 비우면 id+이름 자동)", "(optional · comma-separated · for @mention routing. Empty = auto from id+name)")}</span></label><input id="rec-nicknames" class="${inputCls}" placeholder="${pick("예: Nova, nova, 노바", "e.g. Nova, nova")}" autocomplete="off" /></div>
        <div class="md:col-span-2"><label class="${labelCls}">${pick("페르소나", "Persona")} <span class="text-slate-600">${pick("(선택 · 성격·말투·전문성 한두 줄)", "(optional · a line or two on character, tone, expertise)")}</span></label><textarea id="rec-persona" class="${inputCls} min-h-[64px] resize-y leading-relaxed" placeholder="${pick("예: 차분하고 디테일에 강한 프로덕트 디자이너. 근거 먼저, 시안은 항상 2안.", "e.g. A calm, detail-oriented product designer. Evidence first, always two design options.")}"></textarea></div>
      </div>
      ${capabilityPanelHtml()}
      <div class="flex items-center gap-3 mt-3">
        <button id="rec-submit" class="${btnPrimary}" ${atLimit ? "disabled" : ""}>${pick("영입 시작", "Start onboarding")}</button>
        <button id="rec-cancel" class="${btnGhost}">${pick("취소", "Cancel")}</button>
        <span id="rec-msg" class="text-[12px] text-slate-500 flex-1 leading-snug"></span>
      </div>
    </div>`;
}

// ── OT 진행 스테퍼 ────────────────────────────────────────────────
function stepDot(state: string): string {
  if (state === "done") return `<span class="inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent-green/15 text-accent-green text-xs">✓</span>`;
  if (state === "running") return `<span class="inline-flex h-5 w-5 items-center justify-center rounded-full border-2 border-accent-green/40 border-t-accent-green animate-spin"></span>`;
  if (state === "failed") return `<span class="inline-flex h-5 w-5 items-center justify-center rounded-full bg-status-blocked/20 text-status-blocked text-xs">✕</span>`;
  if (state === "blocked") return `<span class="inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-500/20 text-txt-amber text-xs">⏸</span>`;
  return `<span class="inline-flex h-5 w-5 items-center justify-center rounded-full border border-surface-3 text-slate-600 text-[10px]">○</span>`;
}
// 셀프서비스 프로비저닝 패널 — awaiting_input.fields 를 제네릭 렌더(secret=password).
// 토큰 등 시크릿: 화면 표시 X, 전송 후 즉시 clear, 컴포넌트 상태에 보관 X.
function provisionPanelHtml(aw: AwaitingInput): string {
  const fields = (aw.fields ?? []).map((f) => `
    <div class="mb-2.5">
      <label class="${labelCls}">${escape(f.label)}${f.hint ? ` <span class="text-slate-600">(${escape(f.hint)})</span>` : ""}</label>
      <input class="ot-pf ${inputCls}" data-key="${escape(f.key)}" type="${f.secret ? "password" : "text"}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${escape(f.label)}" />
    </div>`).join("");
  return `
    <div class="rounded-lg border border-accent-green/30 bg-surface-0/60 p-3.5 mt-3">
      <div class="text-[12px] text-slate-300 mb-3 leading-relaxed">${escape(aw.hint || pick("이 팀원을 깨우려면 연결 정보가 필요합니다.", "Waking this member needs connection details."))}</div>
      ${fields}
      <div class="flex items-center gap-3 mt-1">
        <button id="ot-provision-submit" class="${btnPrimary}">${pick("연결", "Connect")}</button>
        <span id="ot-provision-msg" class="text-[12px] text-slate-500 flex-1 leading-snug"></span>
      </div>
      <div class="text-[11px] text-slate-600 mt-2">🔒 ${pick("입력값은 화면·로그에 남지 않으며 전송 후 즉시 지워집니다. 서버가 안전하게 저장합니다.", "Input never stays on screen or in logs and is cleared right after sending. The server stores it securely.")}</div>
    </div>`;
}

function otStepperHtml(): string {
  if (!_ot) return "";
  const m = _ot.member, d = _ot.data;
  const steps: OtStep[] = d?.steps?.length
    ? d.steps
    : OT_STEP_DEFS.map((s, i) => ({ key: s.key, label: s.label, state: i === 0 ? "running" : "pending" }));
  const joined = !!(d?.joined || d?.stage === "joined");
  // preflight 미로그인은 회복 가능(blocked/failed)이라 OT '실패'로 보지 않는다 — recheck 패널로 안내.
  // 진짜 실패 = preflight 외 단계의 failed 또는 명시적 error. stage==='failed'는 그 자체로 보지 않고(preflight만 막혀도 stage가 failed가 될 수 있어 dead-end), 비-preflight failed로만 판정.
  const realFailure = steps.some((s) => s.state === "failed" && s.key !== "preflight");
  const failed = !!(d?.error || realFailure);
  const header = joined
    ? `<span class="text-accent-greenSoft">✅ ${escape(m.display_name)} ${pick("합류 완료", "joined")}</span>`
    : failed
      ? `<span class="text-status-blocked">⚠ ${escape(m.display_name)} ${pick("OT 실패", "OT failed")}</span>`
      : `<span class="text-slate-100">🆕 ${escape(m.display_name)} ${pick("합류 중…", "joining…")}</span>`;
  const rows = steps.map((s) => `
    <div class="flex items-start gap-3 py-1.5">
      ${stepDot(s.state)}
      <div class="min-w-0 flex-1">
        <div class="text-[13px] ${s.state === "pending" ? "text-slate-500" : "text-slate-200"} font-medium">${escape(s.label)}</div>
        ${s.detail ? `<div class="text-[11px] text-slate-500 leading-snug">${escape(s.detail)}</div>` : ""}
      </div>
    </div>`).join("");
  const awaiting = d?.awaiting_input;
  const needsClaudePairing = shouldShowClaudePairingPanel(m.runtime, awaiting);
  const provisionDone = (d?.steps || []).find((s) => s.key === "provision")?.state === "done";
  const bundlePending = (d?.steps || []).find((s) => s.key === "bundle")?.state === "pending";
  // preflight(인증 사전점검): done이면 활성화 게이트 통과, blocked/failed면 활성화 차단 + fixHint 안내.
  // 단계가 아직 없는(구 서버 호환) 경우엔 undefined → 게이트를 막지 않는다(preflightOk=true).
  const preflightStep = (d?.steps || []).find((s) => s.key === "preflight");
  const preflightOk = !preflightStep || preflightStep.state === "done";
  const preflightBlocked = !!preflightStep && (preflightStep.state === "blocked" || preflightStep.state === "failed");
  const needsActivate = provisionDone && bundlePending && preflightOk && !(awaiting && awaiting.fields?.length);
  // 활성화 직전 인증이 막힘 — 활성화 버튼 대신 fixHint 안내 + 다시 확인.
  const needsPreflight = provisionDone && bundlePending && preflightBlocked && !(awaiting && awaiting.fields?.length);
  const preflightHint = preflightStep?.detail || pick("팀장(관리자) 터미널에서 선택한 런타임 CLI 로그인 후 자동으로 활성화 가능합니다.", "After logging in to the selected runtime CLI in the team lead (admin) terminal, activation happens automatically.");
  const subscriptionStep = steps.find((s) => s.key === "join" && s.state === "blocked" && /subscription_needed/i.test(s.detail || ""));
  const needsSubscription = !!subscriptionStep;
  const joinedGreeting = joined ? `
       <div class="rounded-lg border border-accent-green/30 bg-accent-green/10 p-3 mt-3 text-[12px] text-accent-greenSoft leading-relaxed">
         ${pick("이제 Telegram에서 새 팀원 봇에게 DM으로 인사해 보세요 — 답이 오면 연동 성공입니다.", "Now DM the new member bot on Telegram and say hello — if it replies, the connection works.")}
         ${m.runtime === "claude_channel" ? `<div class="mt-1 text-[11px] text-slate-400">${pick("첫 Claude 팀원은 Claude Code Telegram plugin의 access.json에 팀장 DM chat_id를 허용해야 합니다. 서버가 6자리 승인 필요 상태를 내려주면 입력 박스가 뜨고, 2번째 이후 Claude 팀원은 보통 기존 승인(access.json)을 자동 승계해 박스가 뜨지 않습니다.", "The first Claude teammate must allow the team lead's DM chat_id in the Claude Code Telegram plugin access.json. If the server reports that a 6-digit approval is required, an input box appears; later Claude teammates usually inherit the existing access.json approval automatically, so no box appears.")}</div>` : ""}
       </div>` : "";
  const footer = joined
    ? `${joinedGreeting}
       ${acceptanceVerifyHtml()}
       <div class="flex items-center gap-2 mt-3">
         <button id="ot-bundle" class="${btnGhost}">${pick("합류 패키지 보기", "View join package")}</button>
         <button id="ot-close" class="${btnPrimary}">${pick("완료", "Done")}</button>
       </div>
       <div id="ot-bundle-view" class="mt-3"></div>`
      : failed
      ? `<div class="text-[12px] text-status-blocked mt-2">${escape(d?.error || pick("OT 진행 중 오류", "Error during OT"))}</div>
         <button id="ot-close" class="${btnGhost} mt-3">${pick("닫기", "Close")}</button>`
      : needsClaudePairing && awaiting
        ? claudePairingPanelHtml(awaiting)
      : (awaiting && awaiting.fields?.length)
        ? provisionPanelHtml(awaiting)
        : needsSubscription
          ? `<div class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 mt-2">
               <div class="text-[12px] font-semibold text-txt-amber">⏸ ${pick("구독 또는 한도 확인이 필요합니다", "Subscription or quota check required")}</div>
               <div class="text-[11px] text-txt-amber leading-relaxed mt-1">${escape(subscriptionStep?.detail || "subscription_needed")}</div>
             </div>
             <button id="ot-activate" class="${btnGhost} mt-2"${_activating ? " disabled" : ""}>${_activating ? `⏳ ${pick("다시 확인 중…", "Rechecking…")}` : `🔄 ${pick("해결 후 다시 활성화", "Reactivate after fixing")}`}</button>
             <div id="ot-activate-result" class="mt-2 text-[12px] space-y-0.5">${_activateMsg}</div>`
        : needsPreflight
          ? `<div class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 mt-2">
               <div class="text-[12px] font-semibold text-txt-amber">⏸ ${pick("런타임 인증이 필요합니다 — 활성화 보류", "Runtime authentication required — activation on hold")}</div>
               <div class="text-[11px] text-txt-amber leading-relaxed mt-1">${escape(preflightHint)}</div>
               <div class="text-[10px] text-slate-500 mt-1">${pick("터미널에서 로그인하면 자동으로 확인되어 활성화됩니다(또는 아래 '다시 확인').", "Log in via the terminal and it's checked automatically and activated (or use 'Recheck' below).")}</div>
             </div>
             <button id="ot-preflight-recheck" class="${btnGhost} mt-2"${_prechecking ? " disabled" : ""}>${_prechecking ? `⏳ ${pick("확인 중…", "Checking…")}` : `🔄 ${pick("다시 확인", "Recheck")}`}</button>
             <div id="ot-preflight-result" class="mt-2 text-[12px] space-y-0.5">${_precheckMsg}</div>`
          : needsActivate
          ? `<div class="text-[12px] text-slate-300 mt-2">${pick("봇 토큰 연결됨 ✓ · 인증 확인됨 ✓ — 이제 런타임을 활성화하세요(서버가 실행, 터미널 0).", "Bot token connected ✓ · auth confirmed ✓ — now activate the runtime (server runs it, zero terminal).")}</div>
             <button id="ot-activate" class="${btnPrimary} mt-2"${_activating ? " disabled" : ""}>${_activating ? `⏳ ${pick("활성화 중… (수십 초)", "Activating… (tens of seconds)")}` : `🚀 ${pick("활성화", "Activate")}`}</button>
             <div id="ot-activate-result" class="mt-2 text-[12px] space-y-0.5">${_activateMsg}</div>`
          : (m.runtime === "openclaw" && !joined)
            ? `<div class="text-[12px] text-slate-300 mt-2">${pick("활성화 완료 ✓ — 마지막으로", "Activation done ✓ — finally, for")} ${escape(m.display_name)}${pick("이(가) 팀장에게 응답하려면 접근 승인(pairing)이 필요해요.", " to reply to the team lead, access approval (pairing) is needed.")}</div>
               <ol class="text-[11px] text-slate-400 mt-1 ml-4 list-decimal space-y-0.5">
                 <li>${escape(m.display_name)} ${pick("봇에게 텔레그램으로 메시지를 하나 보내세요(아무 말이나).", "bot — send it any message on Telegram (anything).")}</li>
                 <li>${pick("아래 [접근 승인]을 누르세요 — 서버가 코드를 자동으로 읽어 승인합니다(복붙·터미널 불필요).", "Press [Grant access] below — the server reads the code and approves automatically (no copy-paste or terminal).")}</li>
               </ol>
               <button id="ot-pair-approve" class="${btnPrimary} mt-2"${_pairing ? " disabled" : ""}>${_pairing ? `⏳ ${pick("승인 중…", "Approving…")}` : `🔓 ${pick("접근 승인", "Grant access")}`}</button>
               <div id="ot-pair-result" class="mt-2 text-[12px] space-y-0.5">${_pairMsg}</div>`
            : `<div class="text-[11px] text-slate-500 mt-2">${pick("활성화 후 첫 응답(ack)을 기다리는 중입니다. 이 화면은 자동 갱신됩니다.", "Waiting for the first ack after activation. This screen refreshes automatically.")}</div>`;
  return `
    <div class="rounded-lg border ${joined ? "border-accent-green/40" : failed ? "border-status-blocked/40" : "border-accent-green/30"} bg-surface-2/60 p-4 mt-2">
      <div class="flex items-center gap-2 mb-3">
        <span class="inline-flex w-6 justify-center">${renderAgentIcon(m.icon || agentIconName(m.id), m.icon_color, 18)}</span>
        <div class="text-[13px] font-semibold">${header}</div>
        <span class="ml-auto text-[10px] text-slate-500 uppercase tracking-wide">${escape(m.id)} · ${escape(runtimeLabel(m.runtime))}</span>
      </div>
      <div class="border-t border-surface-3 pt-2">${rows}</div>
      ${footer}
      ${!joined && !failed ? `<button id="ot-cancel" class="mt-3 w-full text-[12px] font-medium px-3 py-2 rounded-lg border border-status-blocked/30 bg-surface-2 text-status-blocked/80 hover:text-status-blocked hover:border-status-blocked/50 transition-colors">✕ ${pick("영입 취소 — 지금까지 등록한 것 지움", "Cancel onboarding — clear what was set up")}</button>` : ""}
    </div>`;
}

// 영입 검증 시작 — acceptance-check 호출 후 체크를 한 줄씩 staged reveal. 같은 member로 진행/완료 중이면 무시(중복방지).
async function startOtVerify(member: string): Promise<void> {
  if (_otVerify && _otVerify.member === member && (_otVerify.loading || _otVerify.result)) return;
  stopOtVerifyTimer();
  _otVerify = { member, loading: true, result: null, revealed: 0, error: null };
  render();
  try {
    const r = await fetch(api(`/members/${encodeURIComponent(member)}/acceptance-check`), { headers: { accept: "application/json" } });
    const d = (await r.json()) as AcceptanceResult;
    if (!_otVerify || _otVerify.member !== member) return; // 그 사이 OT 닫힘/전환
    _otVerify = { member, loading: false, result: d, revealed: 0, error: null };
    render();
    const total = (d.sections || []).reduce((n, s) => n + s.checks.length, 0);
    _otVerifyTimer = setInterval(() => {
      if (!_otVerify || !_otVerify.result) { stopOtVerifyTimer(); return; }
      _otVerify.revealed = Math.min(_otVerify.revealed + 1, total);
      if (_otVerify.revealed >= total) stopOtVerifyTimer();
      render();
    }, 140);
  } catch (e) {
    if (_otVerify && _otVerify.member === member) { _otVerify = { member, loading: false, result: null, revealed: 0, error: (e as Error).message }; render(); }
  }
}
function stopOtVerifyTimer(): void { if (_otVerifyTimer) { clearInterval(_otVerifyTimer); _otVerifyTimer = null; } }
function resetOtVerify(): void { stopOtVerifyTimer(); _otVerify = null; }

// 검증 패널 HTML — 섹션별 체크를 revealed 개수까지만 ✅/❌/ℹ️ 한 줄씩. 전부 드러나면 게이트(영입 완료 / 실패).
function acceptanceVerifyHtml(): string {
  const v = _otVerify;
  if (!v) return "";
  if (v.error) return `
    <div class="rounded-lg border border-status-blocked/40 bg-surface-0/40 p-3 mt-3 text-[12px]">
      <div class="text-status-blocked mb-1">⚠ ${pick("검증 호출 오류:", "Verification call error:")} ${escape(v.error)}</div>
      <button id="ot-verify-retry" class="${btnGhost}">${pick("재검증", "Re-verify")}</button>
    </div>`;
  if (v.loading || !v.result) return `<div class="rounded-lg border border-surface-3 bg-surface-0/40 p-3 mt-3 text-[12px] text-slate-400">⏳ ${pick("영입 검증 실행 중…", "Running onboarding verification…")}</div>`;
  const r = v.result;
  const total = r.sections.reduce((n, s) => n + s.checks.length, 0);
  const allRevealed = v.revealed >= total;
  let idx = 0;
  const sectionsHtml = r.sections.map((sec) => {
    const lines = sec.checks.map((c) => {
      const shown = idx < v.revealed; idx++;
      if (!shown) return "";
      const icon = c.status === "pass" ? "✅" : c.status === "fail" ? "❌" : "ℹ️";
      const cls = c.status === "fail" ? "text-status-blocked" : c.status === "info" ? "text-slate-400" : "text-slate-300";
      return `<div class="flex items-start gap-2 py-0.5 text-[12px] ${cls}"><span class="shrink-0">${icon}</span><span class="flex-1 min-w-0">${escape(c.label)}${c.detail ? ` <span class="text-slate-500">— ${escape(c.detail)}</span>` : ""}</span></div>`;
    }).join("");
    if (!lines) return ""; // 이 섹션에 아직 드러난 줄 없으면 헤더도 숨김(진행감)
    return `<div class="mt-2"><div class="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-0.5">${escape(sec.label)}</div>${lines}</div>`;
  }).join("");
  const gate = !allRevealed
    ? `<div class="text-[12px] text-slate-400 mt-2.5">⏳ ${pick("검증 중…", "Verifying…")} (${v.revealed}/${total})</div>`
    : r.ok
      ? `<div class="mt-3 rounded-md border border-accent-green/40 bg-accent-green/10 px-3 py-2 text-[13px] font-semibold text-accent-greenSoft">✅ ${pick("영입 완료 — 모든 검증 통과", "Onboarding complete — all checks passed")} (pass ${r.summary.pass}${r.summary.info ? ` · info ${r.summary.info}` : ""})</div>`
      : `<div class="mt-3 rounded-md border border-status-blocked/40 bg-status-blocked/10 px-3 py-2 text-[13px] text-status-blocked flex items-center gap-2">
           <span class="font-semibold">❌ ${pick("검증 실패 — ", "Verification failed — ")}${r.summary.fail}${pick("개 항목 확인 필요", " item(s) need attention")}</span>
           <button id="ot-verify-retry" class="ml-auto ${btnGhost} !py-1 !px-2 !text-[11px]">${pick("재검증", "Re-verify")}</button>
         </div>`;
  return `
    <div class="rounded-lg border border-surface-3 bg-surface-0/40 p-3 mt-3">
      <div class="text-[12px] font-semibold text-slate-200 mb-1">${pick("영입 검증", "Onboarding verification")} <span class="text-slate-500 font-normal">${pick("· 설정·룰·OT·포터빌리티", "· settings·rules·OT·portability")}</span></div>
      ${sectionsHtml}
      ${gate}
    </div>`;
}

// otZone = 팀원 카드 하단 동적 영역: OT 진행 / 영입 폼 / +영입 버튼.
function otZoneHtml(): string {
  if (_ot) return otStepperHtml();
  if (_addOpen) return recruitFormHtml();
  const current = activeOfficialMemberCount();
  const atLimit = current >= MAX_OFFICIAL_TEAM_MEMBERS;
  return `<button id="rec-open" class="mt-2 w-full ${btnGhost} py-2.5 border-dashed" ${atLimit ? "disabled" : ""}>${atLimit ? pick(`공식 팀원 ${current}/${MAX_OFFICIAL_TEAM_MEMBERS} · 영입 상한 도달`, `Official members ${current}/${MAX_OFFICIAL_TEAM_MEMBERS} · limit reached`) : `+ ${pick("영입", "Onboard")}`}</button>`;
}

// ── 시스템 OP 패널 (P0 기본 협업 floor) ──────────────────────────────
function systemOpHtml(): string {
  const s = _systemOp;
  const tokenSet = !!s?.has_capture_token;
  const routerOn = !!s?.router_enabled;
  const group = s?.capture_group_id ?? "";
  const configured = tokenSet && routerOn;
  const badge = configured
    ? `<span class="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded border border-accent-green/30 text-accent-greenSoft bg-accent-green/10">${pick("설정됨", "Configured")}</span>`
    : `<span class="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded border border-txt-amber/40 text-txt-amber bg-txt-amber/10">${pick("설정 필요", "Setup needed")}</span>`;
  // 기본 접힘 — 헤더(요약)만 보이고 클릭하면 폼 펼침.
  const header = `
    <button id="sysop-toggle" class="w-full flex items-center gap-3 text-left">
      <div class="flex-1 min-w-0">
        <div class="text-base font-semibold text-slate-100">${pick("시스템 OP", "System OP")} <span class="text-[10px] uppercase tracking-[0.18em] text-txt-green ml-1.5">${pick("기본 협업 floor", "base collab floor")}</span></div>
        <div class="text-[12px] text-slate-500 mt-0.5 truncate">${configured ? pick("팀방에서 agent 가 응답합니다 (capture·라우터 연결됨).", "Agents respond in the team room (capture·router connected).") : pick("팀방 협업을 켜려면 설정하세요 · 1:1·handoff 는 설정 없이도 동작.", "Configure to enable team-room collab · 1:1·handoff works without setup.")}</div>
      </div>
      ${badge}
      <span class="shrink-0 text-slate-500 text-lg leading-none ${_systemOpOpen ? "rotate-90" : ""} transition-transform">›</span>
    </button>`;
  if (!_systemOpOpen) return `<div class="rounded-xl border border-surface-3 bg-surface-2/60 p-5">${header}</div>`;
  // 컴팩트 입력/라벨(GD: 필드 너무 큼).
  const cInput = "w-full bg-surface-0 border border-surface-3 rounded-md text-[13px] text-slate-200 px-2.5 py-1.5 outline-none focus:border-accent-green/40 placeholder:text-slate-600";
  const cLabel = "block text-[11px] font-medium text-slate-400 mb-1";
  // (관리자 PIN/접근제어는 System OP에서 제거 — GD 2026-06-28. 추후 소셜로긴/이메일로 독립 레벨 설계.)
  const form = `
    <div class="mt-4 space-y-3 border-t border-surface-3 pt-4">
      <div class="text-[12px] text-slate-400 leading-relaxed bg-surface-0/40 rounded-md p-3 border border-surface-3/60">
        ${pick("팀방(그룹방)에서 팀원이 <b>자동 협업</b>하고 <b>/status·/approve·/digest</b> 운영 명령을 쓰려면 전용 'op 봇'을 붙입니다. ★안 붙여도 1:1 DM·팀원끼리 협업은 됩니다★ — 그룹방 자동협업을 원할 때만.", "Attach a dedicated 'op bot' for <b>auto-collab in the team room</b> + ops commands (<b>/status·/approve·/digest</b>). ★1:1 DM & teammate collab work without it★ — only for group-room auto-collab.")}
        <div class="mt-2 text-txt-amber/90">${pick("필수: BotFather에서 op 봇 privacy mode를 OFF(Disable)로 바꾸거나, op 봇을 그룹 admin으로 승격하세요. 그렇지 않으면 일반 그룹 메시지를 라우터가 못 봅니다.", "Required: turn the op bot's privacy mode OFF (Disable) in BotFather, or promote the op bot to group admin. Otherwise the router cannot see ordinary group messages.")}</div>
      </div>
      <div>
        <label class="${cLabel}">${pick("capture 봇 토큰", "capture bot token")} ${tokenSet ? `<span class="text-accent-greenSoft">${pick("설정됨", "Configured")} ✓</span>` : `<span class="text-txt-amber">${pick("미설정", "Not set")}</span>`}</label>
        <input id="sysop-token" type="password" class="${cInput}" placeholder="${tokenSet ? pick("새 토큰으로 변경", "Change to a new token") : "123456:ABC..."}" autocomplete="off" />
        <div class="text-[11px] text-slate-500 mt-1">${pick("BotFather 에서 <b>op 전용 봇</b>을 새로 만들어(팀원 봇과 별개) 받은 토큰을 붙여넣기 · <b>저장하면 즉시 적용</b>(재시작 불필요).", "Create a <b>dedicated op bot</b> in BotFather (separate from member bots), paste its token · <b>applied immediately on save</b> (no restart).")}</div>
      </div>
      <div>
        <label class="${cLabel}">${pick("팀 그룹 chat_id", "team group chat_id")} <span class="text-slate-600">${pick("(비우면 모든 그룹)", "(empty = all groups)")}</span></label>
        <input id="sysop-group" class="${cInput}" value="${escape(group)}" placeholder="-1001234567890" autocomplete="off" />
        <div class="text-[11px] text-slate-500 mt-1">${pick("팀원 넣을 텔레그램 <b>그룹에 op 봇을 초대</b> → 그 그룹에 <b>@userinfobot</b> 을 잠깐 초대하면 그룹 id(<code>-100…</code>)를 알려줍니다.", "Invite the op bot to your Telegram <b>group</b> → briefly add <b>@userinfobot</b> there to get the group id (<code>-100…</code>).")}</div>
      </div>
      <div class="flex items-center justify-between rounded-md border border-surface-3 bg-surface-0/60 px-3 py-2">
        <span class="text-[13px] font-medium text-slate-200">${pick("라우터 (agent 응답)", "Router (agent replies)")} <span class="${routerOn ? "text-accent-greenSoft" : "text-slate-500"} text-[11px]">${routerOn ? "ON" : "OFF · shadow"}</span></span>
        <button id="sysop-router" class="${routerOn ? "bg-accent-green/80" : "bg-slate-400/50"} shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors" role="switch" aria-checked="${routerOn}"><span class="${routerOn ? "translate-x-6" : "translate-x-1"} inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform"></span></button>
      </div>
      <div class="text-[11px] text-slate-500 -mt-1 leading-relaxed">${pick("ON = 팀방(그룹방)에서 팀원이 자동으로 응답 · OFF = 팀방에선 조용(결정만 기록). ★OFF여도 1:1 DM·팀원끼리 버스 협업은 그대로 동작★ — 라우터는 '그룹방 자동응답'만 켜고 끕니다.", "ON = teammates auto-reply in the team room · OFF = quiet in the room (decisions only logged). ★1:1 DM & teammate bus collab still work when OFF★ — the router only toggles group-room auto-reply.")}</div>
      <div class="flex items-center gap-3 pt-1">
        <button id="sysop-save" class="${btnPrimary}">${pick("저장", "Save")}</button>
        <button id="sysop-check" class="${btnGhost}">${pick("봇 연결 확인", "Check bot connection")}</button>
        <span id="sysop-msg" class="text-[12px] text-slate-500 flex-1 leading-snug"></span>
      </div>
      <details class="mt-1 text-[12px]">
        <summary class="cursor-pointer text-slate-400 hover:text-slate-200 select-none">${pick("🔧 자동 복구 — b3os가 알아서 해줍니다", "🔧 Auto-recovery — b3os handles it")}</summary>
        <div class="mt-2 text-slate-500 leading-relaxed space-y-1">
          <div>${pick("봇 상태를 10분마다 점검하고 대부분 스스로 복구합니다:", "Health-checks your bot every 10 min and fixes most problems on its own:")}</div>
          <div>${pick("• 봇이 멈추거나 세션이 사라지면 → 자동 재시작(기억 유지) · 입력을 막는 프롬프트(설문 등) → 자동으로 닫아 응답 재개 · 재부팅/정전 후 → 다음 부팅 때 자동 복귀 · 주 1회 예방 재시작", "• Bot stops or session disappears → auto-restart (memory kept) · A prompt blocking input → auto-dismissed · After a reboot/power loss → comes back next boot · Weekly preventive restart")}</div>
          <div class="text-txt-amber/80">${pick("⚠ 안전상 자동으로 안 하고 알림만: 권한·신뢰 확인 프롬프트 · 로그인 만료·사용량 한도(인증정보 안 건드림) · 자동복구 실패 시 해결 명령과 함께 알림. 토큰이 비면 무한 재시작 대신 알림.", "⚠ Alert-only for safety: permission/trust prompts · login expiry·usage limits (credentials untouched) · heal failure alerts with the fix command. Empty token → alert, not endless restart.")}</div>
        </div>
      </details>
    </div>`;
  return `<div class="rounded-xl border border-surface-3 bg-surface-2/60 p-5">${header}${form}</div>`;
}

/** 승인자 문구 — ★설정(merge_approvers_normal)에서 읽어 렌더한다.★
 *  화면 문구에 이름을 박아두면 설정을 바꿔도 화면은 옛 이름을 말하고,
 *  공개 사용자에겐 ★자기 팀에 없는 사람 이름★을 보여주게 된다 = 화면이 거짓말을 한다.
 *  설정이 비어 있으면 이름을 지어내지 말고 '아직 지정되지 않음'이라고 사실대로 말한다. */
function approverText(): string {
  const list = (_mergeGate?.approvers ?? []).filter(Boolean);
  if (list.length === 0) {
    return pick(
      "main 머지는 승인제입니다. 아직 승인자가 지정되지 않아 승인할 수 있는 사람이 없습니다 — 먼저 승인자를 설정하세요.",
      "Merging to main needs approval. No approver is configured yet, so nobody can approve — set the approver list first.",
    );
  }
  const names = list.join(" · ");
  return pick(
    `main 머지는 승인제 — 승인자(${names})가 ✅ 해야 머지되고, 미승인 머지는 git 훅이 차단합니다.`,
    `Merging to main needs approval — merges only after an approver (${names}) taps ✅; un-approved merges are blocked by a git hook.`,
  );
}

// ── merge-gate (강제 머지 승인) 섹션 — 심플 ON/OFF + 핵심 설명 ──────────
function mergeGateHtml(): string {
  if (!_mergeGate?.available) return ""; // 공개판(scripts 제외)·비관리 repo 에선 섹션 숨김 → live-only.
  const on = !!_mergeGate?.enabled;
  const badge = on
    ? `<span class="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded border border-accent-green/30 text-accent-greenSoft bg-accent-green/10">ON</span>`
    : `<span class="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded border border-surface-3 text-slate-500 bg-surface-0/40">OFF · ${pick("퍼블릭 동일", "public default")}</span>`;
  const toggle = `<button id="mgate-toggle" class="${on ? "bg-accent-green/80" : "bg-slate-400/50"} shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors" role="switch" aria-checked="${on}"><span class="${on ? "translate-x-6" : "translate-x-1"} inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform"></span></button>`;
  return `
    <div class="rounded-xl border border-surface-3 bg-surface-2/60 p-5">
      <div class="flex items-center gap-3">
        <div class="flex-1 min-w-0">
          <div class="text-base font-semibold text-slate-100">${pick("강제 머지 승인", "Enforced merge approval")} ${badge}</div>
          <div class="text-[12px] text-slate-500 mt-0.5">${pick("에이전트가 승인 없이 main 에 머지하지 못하게 막습니다.", "Stops agents from merging to main without approval.")}</div>
        </div>
        ${toggle}
      </div>
      <div class="mt-3 border-t border-surface-3 pt-3 text-[12px] text-slate-400 leading-relaxed space-y-1.5">
        <div><span class="text-slate-200 font-medium">${pick("무엇을 하나", "What it does")}:</span> ${approverText()}</div>
        <div id="mgate-msg" class="text-[12px] text-slate-500 pt-1"></div>
      </div>
    </div>`;
}

function wireMergeGate(): void {
  if (!_root) return;
  const setMsg = (t: string) => { const m = _root!.querySelector<HTMLDivElement>("#mgate-msg"); if (m) m.textContent = t; };
  _root.querySelector<HTMLButtonElement>("#mgate-toggle")?.addEventListener("click", async () => {
    const next = !_mergeGate?.enabled;
    setMsg(pick("적용 중…", "Applying…"));
    try {
      const r = await fetch(api("/merge-gate"), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: next }) });
      const j = await r.json();
      if (!j.ok) { setMsg(pick("실패: ", "Failed: ") + (j.output || j.error || "")); return; }
      _mergeGate = { available: true, enabled: j.enabled, flag: j.flag, wired: j.wired };
      setMsg(j.enabled ? pick("✅ 게이트 ON — 승인 없인 main 머지 불가", "✅ Gate ON — no un-approved main merges") : pick("게이트 OFF — 퍼블릭 동일(자유 머지)", "Gate OFF — public default (free merges)"));
      render();
    } catch (e) { setMsg(pick("오류: ", "Error: ") + (e as Error).message); }
  });
}

function wireSystemOp(): void {
  if (!_root) return;
  _root.querySelector<HTMLButtonElement>("#sysop-toggle")?.addEventListener("click", () => { _systemOpOpen = !_systemOpOpen; render(); });
  const val = (id: string) => (_root!.querySelector<HTMLInputElement>(id)?.value ?? "").trim();
  const setMsg = (t: string) => { const m = _root!.querySelector<HTMLSpanElement>("#sysop-msg"); if (m) m.textContent = t; };
  const setState = (j: { has_capture_token: boolean; capture_group_id: string | null; router_enabled: boolean }) => {
    _systemOp = { has_capture_token: j.has_capture_token, capture_group_id: j.capture_group_id, router_enabled: j.router_enabled };
  };
  // (접근제어/PIN은 System OP에서 제거 — GD 2026-06-28. 라우터/저장/봇확인은 바로 동작.)

  _root.querySelector<HTMLButtonElement>("#sysop-router")?.addEventListener("click", async () => {
    const r = await fetch(api("/system-op"), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ router_enabled: !_systemOp?.router_enabled }) });
    const j = await r.json();
    if (!r.ok) { setMsg(`${pick("실패:", "Failed:")} ${j.error ?? ""}`); return; }
    setState(j); render();
  });

  _root.querySelector<HTMLButtonElement>("#sysop-save")?.addEventListener("click", async () => {
    const token = val("#sysop-token"); const group = val("#sysop-group");
    const body: Record<string, unknown> = { capture_group_id: group };
    if (token) body.capture_bot_token = token;
    setMsg(pick("저장 중…", "Saving…"));
    const r = await fetch(api("/system-op"), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) { setMsg(`${pick("실패:", "Failed:")} ${j.error ?? ""} ${j.hint ?? ""}`.trim()); return; }
    setState(j);
    setMsg(j.needs_restart ? pick("저장됨 — 토큰/그룹은 서버 재시작 시 적용(라우터는 즉시)", "Saved — token/group apply on server restart (router immediately)") : `${pick("저장됨 — 즉시 적용", "Saved — applied immediately")} ✓`);
    render();
  });

  _root.querySelector<HTMLButtonElement>("#sysop-check")?.addEventListener("click", async () => {
    setMsg(pick("봇 연결 확인 중…", "Checking bot connection…"));
    const r = await fetch(api("/system-op/check"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    const j = await r.json();
    setMsg(r.ok && j.ok ? `${pick("봇", "Bot")} @${j.bot_username ?? "?"} ${pick("연결 OK", "connected OK")} ✓` : `${pick("확인 실패:", "Check failed:")} ${j.error ?? ""}`);
  });
}

function render(): void {
  if (!_root) return;

  // ── 팀 정체성 ──────────────────────────────────────────────────
  const detectLeadBlock = DETECT_LEAD_ENABLED ? `
      <div>
        <label class="${labelCls}">${pick("팀장 텔레그램 ID", "Team-lead Telegram ID")} <span class="text-slate-600">${pick("(자동 감지 · 선택)", "(auto-detect · optional)")}</span></label>
        <div class="flex items-center gap-2 flex-wrap">
          <button id="set-detect-lead" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-400/40 bg-surface-3 text-txt-blue text-sm font-medium hover:bg-surface-0 hover:border-txt-blue/50">${pick("🔎 자동 감지", "🔎 Auto-detect")}</button>
          <span id="set-detect-msg" class="text-[12px] text-slate-500">${_leadTelegramId ? `${pick("감지됨:", "Detected:")} <b class="text-accent-greenSoft">${escape(_leadTelegramId)}</b> ✓` : ""}</span>
        </div>
        <div class="mt-1.5 text-[11px] text-slate-500">${pick("봇에 아무 메시지나 보낸 뒤 클릭하세요. 모르면 @userinfobot 으로 확인.", "Send any message to the bot, then click. If unsure, check via @userinfobot.")}</div>
      </div>` : "";

  const identity = card(pick("팀 정체성", "Team identity"), "team identity", `
    <div class="space-y-4">
      ${/* ★안내가 요구하는 항목 = 서버 게이트 조건과 같아야 한다 (2026-07-17 실측).★
            서버는 setupComplete() = team_name && lead_id && ★owner_name★ 세 개를 본다(routes/settings.ts:243).
            그런데 이 문구는 앞의 둘만 말해서, 팀 이름·팀장 ID 를 채우고도 배너가 안 사라지는데
            ★뭘 더 넣어야 하는지는 화면 어디에도 없었다★ = 사용자가 첫 화면에서 막힌다.
            (문구를 줄이려면 게이트 조건부터 줄여야 한다 — 안내만 줄이면 그게 거짓말이 된다) */""}
      ${_setupComplete ? "" : `<div class="rounded-lg border border-txt-amber/40 bg-txt-amber/10 px-3.5 py-2.5 text-[12px] text-txt-amber leading-relaxed">${pick("⚠ 먼저 팀 이름 · 팀장 ID · 팀장 이름을 저장하세요. 이 셋을 마쳐야 팀원을 영입할 수 있습니다.", "⚠ Set your team name, team-lead ID, and team-lead name first — you can recruit members only after all three are saved.")}</div>`}
      <div>
        <label class="${labelCls}">${pick("팀 이름", "Team name")} <span class="text-txt-red font-bold">${pick("* 필수", "* required")}</span> <span class="text-slate-600">${pick("(≤20자)", "(≤20 chars)")}</span></label>
        <input id="set-team-name" data-req="1" class="${inputCls}" maxlength="20" value="${escape(_settings.team_name)}" placeholder="${pick("예: b3rys", "e.g. b3rys")}" />
      </div>
      <div>
        <label class="${labelCls}">${pick("팀장 ID", "Team-lead ID")} <span class="text-txt-red font-bold">${pick("* 필수", "* required")}</span> <span class="text-slate-600">${pick("(영문 slug)", "(lowercase slug)")}</span></label>
        <input id="set-lead-id" data-req="1" class="${inputCls}" maxlength="40" value="${escape(_settings.lead_id)}" placeholder="${pick("예: gd", "e.g. gd")}" />
        <div class="mt-1.5 text-[11px] text-slate-500">${pick("소문자·숫자·-·_ 1~40자. 팀장을 식별하는 고유 ID입니다.", "Lowercase, digits, -, _ (1–40). A unique ID identifying the team lead.")}</div>
      </div>
      ${detectLeadBlock}
      <div>
        <label class="${labelCls}">${pick("팀장 이름", "The team lead's name")} <span class="text-txt-red font-bold">${pick("* 필수", "* required")}</span> <span class="text-slate-600">${pick("(≤40자)", "(≤40 chars)")}</span></label>
        <input id="set-owner-name" data-req="1" class="${inputCls}" maxlength="40" value="${escape(_settings.owner_name)}" placeholder="${pick("예: 팀장 이름", "e.g. the team lead's name")}" />
        <div class="mt-1.5 text-[11px] ${_settings.owner_name ? "text-accent-greenSoft" : "text-slate-500"}">${_settings.owner_name
          ? `${pick("팀원들이 읽는 이름:", "Name members read:")} <b>${escape(_settings.owner_name)}</b> ${pick("적용 중 ✓", "in effect ✓")}`
          : `${pick("미설정 — 팀원들이", "Not set — members read")} <code class="text-slate-400">{{OWNER}}</code> ${pick("그대로 읽습니다", "as-is")}`}</div>
      </div>
      <div>
        <label class="${labelCls}">${pick("팀장 텔레그램 chat_id", "The team lead's Telegram chat_id")} <span class="text-slate-600">${pick("(선택·숫자)", "(optional, numeric)")}</span></label>
        <input id="set-owner-chat-id" class="${inputCls}" inputmode="numeric" value="${escape(_settings.owner_chat_id)}" placeholder="${pick("예: 123456789 (비워도 됨)", "e.g. 123456789 (can be empty)")}" />
        <div class="mt-1.5 text-[11px] ${_settings.owner_chat_id ? "text-accent-greenSoft" : "text-slate-500"}">${_settings.owner_chat_id
          ? `${pick("발신자 게이트 시드:", "Sender gate seed:")} <b>${escape(_settings.owner_chat_id)}</b> ${pick("적용 중 ✓ — 팀원들이 팀장에게만 응답", "in effect ✓ — team members respond only to you")}`
          : pick("텔레그램 봇이 당신에게만 응답하려면 설정하세요. 다른 사람이 봇 ID를 통해 봇에 접근할 수 있습니다. (claude를 첫 팀원으로 영입하면 자동으로 채워집니다 · 모르면 @userinfobot 에게 DM)", "Set this so the Telegram bot responds only to you. Others can reach the bot through its bot ID. (Auto-filled if you recruit a Claude member first · if unknown, DM @userinfobot)")}</div>
      </div>
      <div class="pt-3 border-t border-surface-3">
        <label class="flex items-start gap-2.5 cursor-pointer">
          <input id="set-dm-capture" type="checkbox" class="mt-0.5 accent-txt-blue" ${_settings.dm_capture ? "checked" : ""} />
          <span>
            <span class="${labelCls} !mb-0">${pick("팀장 1:1 대화 기록", "Record the team lead's 1:1 chats")}</span>
            <span class="block mt-1 text-[11px] text-slate-500">${pick(
              "팀원과 팀장이 1:1 로 주고받은 말을 팀 DB 에 적재합니다. 팀원이 \"팀장님이 그때 뭐라고 하셨지?\" 를 찾아볼 때(recall)와 대시보드 통계에 쓰입니다. <b>꺼도 팀 버스·위임·발신은 그대로 동작합니다.</b>",
              "Stores 1:1 messages between a member and the team lead in the team DB. Used for member recall (\"what did the lead say?\") and dashboard stats. <b>Turning it off does not affect the team bus, delegation, or sending.</b>")}</span>
          </span>
        </label>
      </div>
      <div class="flex items-center gap-3 pt-3 mt-1 border-t border-surface-3">
        <button id="set-save" class="${btnPrimary}">${pick("저장", "Save")}</button>
        <span id="set-msg" class="text-[13px] text-slate-500 flex-1 leading-snug"></span>
      </div>
    </div>
  `);

  // ── 팀원 ──────────────────────────────────────────────────────
  // 팀원 클릭 → 본인 Settings 페이지(AgentConfig)로 이동. 퇴사는 거기 맨 아래에서(설정 일원화).
  const rows = _members.map((m) => {
    const slack = slackForMember(m.id);
    const slackBadge = slack ? slackStateLabel(effectiveFor(m.id)) : null;
    return `
      <button class="mem-row w-full flex items-center gap-3 px-3.5 py-3 text-left rounded-lg border border-surface-3 bg-surface-2/60 hover:border-accent-green/35 transition-colors" data-id="${escape(m.id)}">
        <span class="inline-flex w-6 justify-center">${renderAgentIcon(m.icon || agentIconName(m.id), m.icon_color, 18)}</span>
        <div class="min-w-0 flex-1">
          <div class="text-sm font-semibold text-slate-100">${escape(m.display_name)} <span class="text-slate-500 font-normal">· ${escape(m.id)}</span></div>
          <div class="text-[12px] text-slate-400 truncate">${escape(m.role)}</div>
        </div>
        ${slackBadge ? `<span class="shrink-0 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded border ${slackBadge.cls}">Slack ${escape(slackBadge.label)}</span>` : ""}
        <span class="shrink-0 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded border border-surface-3 text-slate-400">${escape(runtimeLabel(m.runtime))}</span>
        <span class="shrink-0 text-slate-600 text-lg leading-none">›</span>
      </button>`;
  }).join("");

  const members = card(pick("팀원", "Members"), "members", `
    <div class="space-y-2">${rows || `<div class="text-sm text-slate-500 py-4 text-center">${pick("팀원이 없습니다", "No members")}</div>`}</div>
    <div id="ot-zone">${otZoneHtml()}</div>
    <div class="text-[11px] text-slate-600 mt-3">${pick("영입하면 신규 OT(등록→프로비저닝→번들 전달→합류 확인)가 시작됩니다. 봇·tmux·slack 실제 연결은 프로비저닝 단계에서 처리됩니다.", "Onboarding starts a new OT (register → provision → bundle handoff → join confirmation). Actual bot/tmux/slack wiring is handled in the provisioning step.")}</div>
    <div class="mt-3 pt-3 border-t border-surface-3 flex items-center gap-2 flex-wrap">
      ${LIVE_ONLY_OPS ? `<button id="regen-all" title="${pick("전 팀원의 ⭐핵심룰을 현재 템플릿(멈춤장치·통신·conti)으로 재적용 — 정체·능력 보존, 각자 백업. 6시간 안에 되돌릴 수 있음.", "Reapply every member's ⭐core rules with the current template (stop guards·comms·conti) — identity·capabilities preserved, each backed up. Undo within 6 hours.")}" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-400/40 bg-surface-3 text-txt-amber text-sm font-medium hover:bg-surface-0 hover:border-txt-amber/50">${renderIcon("refresh-cw", { size: 13, className: "shrink-0" })}${pick("전체 핵심룰 재적용", "Reapply all core rules")}</button>
      <button id="regen-rollback" title="${pick("가장 최근에 전체 적용한 1회분을 백업본으로 되돌립니다. 적용 후 6시간 동안만 보입니다(직전 1회만).", "Reverts the most recent reapply-all batch from its .bak backups. Shown only for 6 hours after reapply (the last one only).")}" class="hidden inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-txt-amber/40 bg-surface-3 text-txt-amber text-sm font-medium hover:bg-surface-0 hover:border-txt-amber/60">${renderIcon("rotate-ccw", { size: 13, className: "shrink-0" })}<span id="regen-rollback-label">↩ ${pick("되돌리기", "Undo")}</span></button>` : ""}
      <button id="restart-all" title="${pick("정지 팀원 제외 전원 재시작 — 복구 코디네이터는 맨 마지막(이 대화 ~15s 깜빡). openclaw 게이트웨이 1회.", "Restart everyone except stopped members — recovery coordinator last (this chat blinks ~15s). openclaw gateway once.")}" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-400/40 bg-surface-3 text-txt-blue text-sm font-medium hover:bg-surface-0 hover:border-txt-blue/50">${renderIcon("refresh-cw", { size: 13, className: "shrink-0" })}${pick("전체 재시작", "Restart all")}</button>
      <span id="regen-all-msg" class="text-[11px] text-slate-500 flex-1 leading-snug"></span>
      <button id="stop-all" title="${pick("비상 서킷브레이커 — 복구 코디네이터 제외 전원 즉시 정지. 두 번 확인.", "Emergency circuit breaker — stop everyone except recovery coordinator immediately. Double confirm.")}" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-status-blocked/90 text-white text-sm font-semibold hover:bg-status-blocked">${renderIcon("power", { size: 13, className: "shrink-0" })}${pick("전체 정지 (비상)", "Stop all (emergency)")}</button>
    </div>
  `);

  // 재렌더 전 스크롤 위치 보존 — 팀원 클릭 등으로 innerHTML 교체 시 위로 튀는 것 방지.
  const prevScroll = _root.querySelector<HTMLElement>("[data-scroll]")?.scrollTop ?? 0;
  _root.innerHTML = `
    <div data-scroll class="h-full overflow-y-auto">
      <div class="max-w-3xl mx-auto px-4 md:px-6 py-5 pb-20 space-y-5">
        <div class="text-sm text-slate-500">${pick("팀 이름·팀장·팀원을 직접 관리합니다. 처음엔 핵심만 — 자세한 운영 설정은 점차 추가됩니다.", "Manage your team name·lead·members directly. Just the essentials at first — detailed operational settings are added over time.")}</div>
        ${identity}
        ${slackChannelsHtml()}
        ${systemOpHtml()}
        ${mergeGateHtml()}
        ${members}
      </div>
    </div>`;

  if (prevScroll) { const sc = _root.querySelector<HTMLElement>("[data-scroll]"); if (sc) sc.scrollTop = prevScroll; }
  wire();
}

function wire(): void {
  if (!_root) return;
  wireSystemOp(); // 시스템 OP 패널 핸들러(P0)
  wireMergeGate(); // 강제 머지 승인 토글
  // 언어 토글은 우상단 헤더 깃발(MetricsBar #locale-flag)로 이전 — 여기선 제거(GD 2026-07-01).
  // 저장 + 필수 필드 검증(팀 이름·팀장 ID·팀장 이름) — GD 2026-07-10
  const save = _root.querySelector<HTMLButtonElement>("#set-save");
  const syncRequired = (): void => {
    let anyEmpty = false;
    _root!.querySelectorAll<HTMLInputElement>("[data-req]").forEach((inp) => {
      const empty = inp.value.trim() === "";
      if (empty) anyEmpty = true;
      inp.classList.toggle("border-txt-red", empty); // 빈 필수 → 빨간 테두리
      inp.classList.toggle("border-surface-3", !empty);
    });
    if (save) save.disabled = anyEmpty; // 셋 중 하나라도 비면 저장 비활성
  };
  _root.querySelectorAll<HTMLInputElement>("[data-req]").forEach((inp) => inp.addEventListener("input", syncRequired));
  syncRequired(); // 초기 상태 반영(빈 필수 빨간테두리 + 저장 비활성)
  save?.addEventListener("click", async () => {
    const name = (_root!.querySelector<HTMLInputElement>("#set-team-name")?.value ?? "").trim();
    const leadId = (_root!.querySelector<HTMLInputElement>("#set-lead-id")?.value ?? "").trim();
    const owner = (_root!.querySelector<HTMLInputElement>("#set-owner-name")?.value ?? "").trim();
    const ownerChatId = (_root!.querySelector<HTMLInputElement>("#set-owner-chat-id")?.value ?? "").trim();
    const dmCapture = _root!.querySelector<HTMLInputElement>("#set-dm-capture")?.checked ?? true;
    const msg = _root!.querySelector<HTMLSpanElement>("#set-msg")!;
    if (!name || !leadId || !owner) { // 필수 3개 가드(버튼 비활성 우회 대비)
      msg.className = "text-[13px] text-txt-red flex-1 leading-snug";
      msg.textContent = pick("팀 이름·팀장 ID·팀장 이름은 필수입니다", "Team name, team-lead ID, and lead name are required");
      syncRequired();
      return;
    }
    if (leadId && !LEAD_ID_RE.test(leadId)) {
      msg.className = "text-[13px] text-txt-red flex-1 leading-snug";
      msg.textContent = pick("팀장 ID 형식 오류 — 소문자·숫자·-·_ 1~40자", "Invalid team-lead ID — lowercase, digits, -, _ (1–40)");
      return;
    }
    if (ownerChatId && !/^-?\d{1,20}$/.test(ownerChatId)) {
      msg.className = "text-[13px] text-txt-red flex-1 leading-snug";
      msg.textContent = pick("팀장 chat_id는 숫자만 (비워도 됩니다)", "Team-lead chat_id must be numeric (or empty)");
      return;
    }
    save.disabled = true; msg.className = "text-[13px] text-slate-500 flex-1 leading-snug"; msg.textContent = pick("저장 중…", "Saving…");
    try {
      const r1 = await fetch(api("/settings"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ team_name: name, lead_id: leadId, owner_name: owner, owner_chat_id: ownerChatId, dm_capture: dmCapture }) });
      const j1 = await r1.json().catch(() => ({}));
      if (!r1.ok || !j1.ok) throw new Error(j1.error || "settings HTTP " + r1.status);
      // ★미션은 대시보드에서 편집하지 않는다(GD 2026-07-19) — TEAM-OS.md §1 의 기본값을 쓴다.★ 필드·PUT /mission 호출 제거.
      _settings = { team_name: name, lead_id: leadId, tagline: _settings.tagline, owner_name: owner, owner_chat_id: ownerChatId, locale: _settings.locale, dm_capture: dmCapture };
      _setupComplete = Boolean(j1.setup_complete); _leadActorId = j1.lead_actor_id ?? _leadActorId;
      applyTeamTitle(name);
      msg.className = "text-[13px] text-accent-greenSoft flex-1 leading-snug";
      msg.textContent = `✅ ${pick("저장됨 (팀 정보)", "Saved (team info)")}`;
    } catch (e) {
      msg.className = "text-[13px] text-txt-red flex-1 leading-snug";
      msg.textContent = pick("저장 실패: ", "Save failed: ") + (e as Error).message;
    } finally {
      save.disabled = false;
    }
  });

  // 팀장 텔레그램 ID 자동 감지 — capture worker가 이미 받은 최근 non-bot 발신자를 lead_telegram_id로 저장(숫자 id=non-secret).
  const detect = _root.querySelector<HTMLButtonElement>("#set-detect-lead");
  detect?.addEventListener("click", async () => {
    const dmsg = _root!.querySelector<HTMLSpanElement>("#set-detect-msg")!;
    const restore = setBtnBusy(detect, pick("감지 중…", "Detecting…"));
    dmsg.className = "text-[12px] text-slate-500";
    try {
      const r = await fetch(api("/system-op/detect-lead-id"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || j.hint || "HTTP " + r.status);
      _leadTelegramId = j.lead_telegram_id ? String(j.lead_telegram_id) : null;
      dmsg.className = "text-[12px] text-slate-500";
      dmsg.innerHTML = _leadTelegramId
        ? `${pick("감지됨:", "Detected:")} <b class="text-accent-greenSoft">${escape(_leadTelegramId)}</b>${j.username ? ` (@${escape(String(j.username))})` : ""} ✓`
        : pick("감지 실패 — 팀방에 메시지를 보낸 뒤 다시 시도", "Not found — send a team-room message, then retry");
    } catch (e) {
      dmsg.className = "text-[12px] text-txt-red";
      dmsg.textContent = pick("감지 실패: ", "Detect failed: ") + (e as Error).message;
    } finally {
      restore();
    }
  });

  // 팀원 행 클릭 → 본인 Settings 페이지(AgentConfig)로 이동. 퇴사는 거기 맨 아래(설정 일원화).
  _root.querySelectorAll<HTMLButtonElement>(".mem-row").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.dataset.id;
      if (!id) return;
      store.getState().selectAgent(id);
      store.getState().setMainView("config");
    });
  });

  // 전체 핵심룰 재적용 — 한 번 탭으로 전 팀원(기준멤버 포함)에 멈춤장치·통신·conti 주입(각자 백업).
  const regenAll = _root.querySelector<HTMLButtonElement>("#regen-all");
  const regenAllMsg = _root.querySelector<HTMLElement>("#regen-all-msg");
  regenAll?.addEventListener("click", async () => {
    if (!confirm(pick("모든 팀원의 ⭐핵심룰을 현재 템플릿(멈춤장치·통신·conti)으로 재적용할까요?\n각자 정체·능력은 보존되고 백업이 남습니다. 적용된 규칙은 각 팀원 다음 세션부터 적용됩니다.\n적용 후 6시간 동안 되돌리기 버튼으로 되돌릴 수 있습니다.", "Reapply every member's ⭐core rules with the current template (stop guards·comms·conti)?\nEach member's identity·capabilities are preserved and a backup is kept. The applied rules take effect from each member's next session.\nYou can undo it with the Undo button for 6 hours after applying."))) return;
    const _busy = setBtnBusy(regenAll, `⏳ ${pick("적용 중…", "Applying…")}`);
    if (regenAllMsg) { regenAllMsg.textContent = pick("전체 재적용 중…", "Reapplying to all…"); regenAllMsg.className = "text-[11px] text-slate-400 flex-1 leading-snug"; }
    try {
      const r = await fetch(api("/members/regenerate-all-personas"), { method: "POST", headers: { "content-type": "application/json" } });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; results?: Array<{ id: string; updated?: number; skipped?: string }>; error?: string };
      if (j.ok && j.results) {
        const applied = j.results.filter((x) => (x.updated ?? 0) > 0).map((x) => x.id);
        const skipped = j.results.filter((x) => x.skipped).map((x) => x.id);
        if (regenAllMsg) { regenAllMsg.textContent = `✓ ${pick("적용", "Applied")} ${applied.length}${pick("명", " member(s)")} (${applied.join(", ")})${skipped.length ? ` · ${pick("제외", "excluded")} ${skipped.join(",")}` : ""}${pick(" — 새로고침하면 각 팀원 페르소나에 반영", " — refresh to see each member's persona updated")}`; regenAllMsg.className = "text-[11px] text-accent-greenSoft flex-1 leading-snug"; }
      } else {
        if (regenAllMsg) { regenAllMsg.textContent = `${pick("실패:", "Failed:")} ${j.error || pick("오류", "error")}`; regenAllMsg.className = "text-[11px] text-txt-red flex-1 leading-snug"; }
      }
    } catch (e) {
      if (regenAllMsg) { regenAllMsg.textContent = pick("실패: ", "Failed: ") + (e as Error).message; regenAllMsg.className = "text-[11px] text-txt-red flex-1 leading-snug"; }
    }
    refreshRollback();
    _busy();
  });

  // ↩ 롤백 — 직전 전체 재적용을 .bak로 되돌림. 재적용 후 6시간 동안만 노출(서버가 시각 기준).
  const rollbackBtn = _root.querySelector<HTMLButtonElement>("#regen-rollback");
  const rollbackLabel = _root.querySelector<HTMLElement>("#regen-rollback-label");
  function fmtRemain(ms: number): string {
    const totalMin = Math.max(0, Math.floor(ms / 60000));
    const h = Math.floor(totalMin / 60), m = totalMin % 60;
    return h > 0 ? `${h}${pick("시간", "h")} ${m}${pick("분", "m")}` : `${m}${pick("분", "m")}`;
  }
  async function refreshRollback(): Promise<void> {
    const gen = ++_rollbackGen; // 이 호출의 세대 — await 후 최신인지 확인해 overlap 누수 차단
    if (_rollbackTimer) { clearInterval(_rollbackTimer); _rollbackTimer = null; }
    if (!rollbackBtn) return;
    let st: { available?: boolean; remaining_ms?: number } = {};
    try { st = await (await fetch(api("/members/regenerate-all-personas/rollback"))).json(); } catch { st = {}; }
    if (gen !== _rollbackGen) return; // 그 사이 더 최신 refresh가 시작됨 → 이 호출 폐기(중복 interval 방지)
    if (!st.available || !st.remaining_ms || st.remaining_ms <= 0) { rollbackBtn.classList.add("hidden"); return; }
    rollbackBtn.classList.remove("hidden");
    const endAt = Date.now() + st.remaining_ms; // 클라이언트 기준 만료시각 — 1분마다 갱신, 만료 시 자동 숨김
    const tick = () => {
      const rem = endAt - Date.now();
      if (rem <= 0) { rollbackBtn.classList.add("hidden"); if (_rollbackTimer) { clearInterval(_rollbackTimer); _rollbackTimer = null; } return; }
      if (rollbackLabel) rollbackLabel.textContent = `↩ ${pick("되돌리기", "Undo")} (${fmtRemain(rem)} ${pick("남음", "left")})`;
    };
    tick();
    _rollbackTimer = setInterval(tick, 30000);
  }
  rollbackBtn?.addEventListener("click", async () => {
    if (!confirm(pick("직전 전체 핵심룰 재적용(가장 최근 1회분)을 되돌릴까요?\n각 팀원 페르소나가 재적용 직전 .bak 백업으로 복원됩니다.", "Undo the last reapply-all of core rules (the most recent batch)?\nEach member's persona is restored from the .bak backup taken just before reapplying."))) return;
    // setBtnBusy는 버튼 child(#regen-rollback-label span)를 textContent로 날려 카운트다운이 깨짐(Devon P2).
    // disabled + label 텍스트만 바꿔 span을 보존 → 실패/재시도 경로에서도 tick()이 계속 라벨 갱신.
    rollbackBtn.disabled = true;
    const prevLabel = rollbackLabel?.textContent ?? `↩ ${pick("되돌리기", "Undo")}`;
    if (rollbackLabel) rollbackLabel.textContent = `⏳ ${pick("되돌리는 중…", "Undoing…")}`;
    if (regenAllMsg) { regenAllMsg.textContent = pick("되돌리는 중…", "Undoing…"); regenAllMsg.className = "text-[11px] text-slate-400 flex-1 leading-snug"; }
    try {
      const r = await fetch(api("/members/regenerate-all-personas/rollback"), { method: "POST", headers: { "content-type": "application/json" } });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; restored?: string[]; missing?: string[]; error?: string };
      if (r.ok && j.ok) {
        if (regenAllMsg) { regenAllMsg.textContent = `↩ ${pick("되돌림", "Undone")} (${(j.restored ?? []).length}${pick("개 파일 복원", " files restored")})${(j.missing ?? []).length ? ` · ${pick("백업없음", "no backup")} ${(j.missing ?? []).length}` : ""}${pick(" — 새로고침하면 반영", " — refresh to see changes")}`; regenAllMsg.className = "text-[11px] text-accent-greenSoft flex-1 leading-snug"; }
      } else if (regenAllMsg) {
        regenAllMsg.textContent = `${pick("되돌리기 실패:", "Undo failed:")} ${j.error || ("HTTP " + r.status)}`; regenAllMsg.className = "text-[11px] text-txt-red flex-1 leading-snug";
      }
    } catch (e) {
      if (regenAllMsg) { regenAllMsg.textContent = pick("되돌리기 실패: ", "Undo failed: ") + (e as Error).message; regenAllMsg.className = "text-[11px] text-txt-red flex-1 leading-snug"; }
    }
    rollbackBtn.disabled = false;
    if (rollbackLabel) rollbackLabel.textContent = prevLabel; // span 보존 복원 — refreshRollback의 tick()이 곧 다시 갱신
    refreshRollback(); // 서버상태로 버튼 갱신 — 성공 시 기록삭제되어 자동으로 사라짐
  });
  refreshRollback(); // 페이지 로드 시: 6시간 내면 버튼 노출 + 카운트다운 시작

  // 🔄 전체 재시작 — 빌·정지팀원 제외 전원 재시작(빌 맨 마지막).
  const restartAll = _root.querySelector<HTMLButtonElement>("#restart-all");
  restartAll?.addEventListener("click", async () => {
    if (!confirm(pick("정지 팀원 제외 전원을 재시작할까요?\n새 페르소나/상태를 로드합니다. openclaw 게이트웨이는 ~1분 깜빡, 복구 코디네이터는 맨 마지막(이 대화 ~15s 깜빡 후 복귀).", "Restart everyone except stopped members?\nThey reload fresh persona/state. The openclaw gateway blinks ~1 min; the recovery coordinator is last (this chat blinks ~15s, then returns)."))) return;
    const _busy = setBtnBusy(restartAll, `⏳ ${pick("재시작 중…", "Restarting…")}`);
    if (regenAllMsg) { regenAllMsg.textContent = pick("전체 재시작 중…", "Restarting all…"); regenAllMsg.className = "text-[11px] text-slate-400 flex-1 leading-snug"; }
    try {
      const r = await fetch(api("/members/restart-all"), { method: "POST", headers: { "content-type": "application/json" } });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; results?: Array<{ id: string; ok?: boolean }>; error?: string };
      if (j.ok && j.results) {
        const done = j.results.filter((x) => x.ok).map((x) => x.id);
        if (regenAllMsg) { regenAllMsg.textContent = `🔄 ${pick("재시작", "Restarted")} ${done.length}${pick("명", " member(s)")} (${done.join(", ")})`; regenAllMsg.className = "text-[11px] text-txt-blue flex-1 leading-snug"; }
      } else if (regenAllMsg) { regenAllMsg.textContent = `${pick("실패:", "Failed:")} ${j.error || pick("오류", "error")}`; regenAllMsg.className = "text-[11px] text-txt-red flex-1 leading-snug"; }
    } catch (e) {
      if (regenAllMsg) { regenAllMsg.textContent = pick("실패: ", "Failed: ") + (e as Error).message; regenAllMsg.className = "text-[11px] text-txt-red flex-1 leading-snug"; }
    }
    _busy();
  });

  // 🔴 전체 정지 (비상) — 빌 제외 전원 정지. 더블컨펌(강한 경고).
  const stopAll = _root.querySelector<HTMLButtonElement>("#stop-all");
  stopAll?.addEventListener("click", async () => {
    if (!confirm(pick("🔴 비상 정지\n\n복구 코디네이터를 제외한 모든 팀원을 즉시 정지합니다.\n폭주·이상 상황의 서킷브레이커입니다. 정말 전원 정지할까요?\n\n(다시 켜려면 각 팀원 🟢 기동 또는 /onoff)", "🔴 Emergency stop\n\nImmediately stops every member except the recovery coordinator.\nThis is the circuit breaker for runaway/abnormal situations. Really stop everyone?\n\n(To turn them back on, use each member's 🟢 Start or /onoff)"))) return;
    const _busy = setBtnBusy(stopAll, `⏳ ${pick("정지 중…", "Stopping…")}`);
    if (regenAllMsg) { regenAllMsg.textContent = `🔴 ${pick("비상 정지 중…", "Emergency stopping…")}`; regenAllMsg.className = "text-[11px] text-txt-red flex-1 leading-snug"; }
    try {
      const r = await fetch(api("/members/stop-all"), { method: "POST", headers: { "content-type": "application/json" } });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; results?: Array<{ id: string; ok?: boolean }>; error?: string };
      if (j.ok && j.results) {
        const stopped = j.results.filter((x) => x.ok && x.id !== "bill").map((x) => x.id);
        if (regenAllMsg) { regenAllMsg.textContent = `🔴 ${pick("정지됨", "Stopped")} ${stopped.length}${pick("명", " member(s)")} (${stopped.join(", ")}) · ${pick("코디네이터 유지", "coordinator kept")}`; regenAllMsg.className = "text-[11px] text-txt-red flex-1 leading-snug"; }
      } else if (regenAllMsg) { regenAllMsg.textContent = `${pick("실패:", "Failed:")} ${j.error || pick("오류", "error")}`; regenAllMsg.className = "text-[11px] text-txt-red flex-1 leading-snug"; }
    } catch (e) {
      if (regenAllMsg) { regenAllMsg.textContent = pick("실패: ", "Failed: ") + (e as Error).message; regenAllMsg.className = "text-[11px] text-txt-red flex-1 leading-snug"; }
    }
    _busy();
  });

  // 영입(신규 OT) — 폼·스테퍼·폴링
  wireOtZone();
}

// otZone 동적 영역만 갱신(폴링 시 전체 render 대신 이 구역만 교체 → 상단 입력 포커스 보존).
function refreshOtZone(): void {
  const zone = _root?.querySelector<HTMLElement>("#ot-zone");
  if (!zone) return;
  zone.innerHTML = otZoneHtml();
  wireOtZone();
}

function wireOtZone(): void {
  if (!_root) return;
  // +영입 / 취소
  _root.querySelector<HTMLButtonElement>("#rec-open")?.addEventListener("click", () => { _addOpen = true; refreshOtZone(); });
  _root.querySelector<HTMLButtonElement>("#rec-cancel")?.addEventListener("click", () => { _addOpen = false; refreshOtZone(); });
  // id 검증 — blur 시 형식(백엔드 ID_RE 미러)·중복 위반이면 빨간 테두리 + 영입 버튼 비활성(자동변환 안 함, GD 2026-07-01).
  {
    const recId = _root.querySelector<HTMLInputElement>("#rec-id");
    const recSubmitBtn = _root.querySelector<HTMLButtonElement>("#rec-submit");
    const recMsg = _root.querySelector<HTMLSpanElement>("#rec-msg");
    const REC_ID_RE = /^[a-z][a-z0-9_-]{1,31}$/; // 백엔드 settings.ts ID_RE 와 동일
    const validateRecId = (showRed: boolean) => {
      if (!recId || !recSubmitBtn) return;
      const v = recId.value.trim();
      const dup = !!v && _members.some((m) => m.id === v);
      const bad = !!v && (!REC_ID_RE.test(v) || dup);
      recSubmitBtn.disabled = bad;                                   // 위반 시 영입 버튼 비활성(live)
      recId.style.borderColor = bad && showRed ? "rgb(var(--status-blocked))" : ""; // 빨간 테두리는 blur 시(GD)
      if (recMsg && (bad && showRed)) {
        recMsg.className = "text-[12px] text-txt-red flex-1 leading-snug";
        recMsg.textContent = dup ? pick("이미 있는 id예요.", "That id already exists.") : pick("id 형식: 소문자·숫자·- ·_, 2~32자, 영문자로 시작", "id format: lowercase/digits/-/_, 2–32 chars, must start with a letter");
      } else if (recMsg && !bad && (recMsg.textContent.includes("id ") || recMsg.textContent.includes("id예요") || recMsg.textContent.includes("id already"))) {
        recMsg.textContent = ""; // 유효해지면 id 에러문만 지움
      }
    };
    recId?.addEventListener("blur", () => validateRecId(true));
    recId?.addEventListener("input", () => validateRecId(false)); // 다시 타이핑하면 빨강 해제 + 버튼 상태 갱신
  }
  // 영입 시작 → POST /members/recruit → OT 폴링
  _root.querySelector<HTMLButtonElement>("#rec-submit")?.addEventListener("click", async () => {
    const get = (id: string) => (_root!.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(id)?.value ?? "").trim();
    const payload = { id: get("#rec-id"), display_name: get("#rec-name"), role: get("#rec-role"), runtime: get("#rec-runtime"), nicknames: get("#rec-nicknames"), persona: get("#rec-persona") };
    const msg = _root!.querySelector<HTMLSpanElement>("#rec-msg")!;
    const submit = _root!.querySelector<HTMLButtonElement>("#rec-submit")!;
    if (!payload.id || !payload.display_name || !payload.role) { msg.className = "text-[12px] text-txt-red flex-1 leading-snug"; msg.textContent = pick("id·이름·역할은 필수입니다.", "id, name, and role are required."); return; }
    submit.disabled = true; msg.className = "text-[12px] text-slate-500 flex-1 leading-snug"; msg.textContent = pick("영입 시작 중…", "Starting onboarding…");
    try {
      const r = await fetch(api("/members/recruit"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.hint || j.error || "HTTP " + r.status);
      _addOpen = false;
      _activating = false; _activateMsg = ""; _pairing = false; _pairMsg = ""; _prechecking = false; _precheckMsg = "";  // 새 OT 시작 — 이전 활성화/승인/인증확인 상태 잔재 제거
      _ot = { otId: j.ot_id, member: { id: j.member.id, display_name: j.member.display_name, role: j.member.role, runtime: j.member.runtime, icon: j.member.icon }, data: null };
      refreshOtZone();
      startOtPolling();
    } catch (e) {
      msg.className = "text-[12px] text-txt-red flex-1 leading-snug"; msg.textContent = pick("영입 실패: ", "Onboarding failed: ") + (e as Error).message; submit.disabled = false;
    }
  });
  // 셀프서비스 프로비저닝 — 봇토큰 등 입력 → POST /ot/:id/provision
  _root.querySelector<HTMLButtonElement>("#ot-provision-submit")?.addEventListener("click", async () => {
    if (!_ot) return;
    const inputs = [..._root!.querySelectorAll<HTMLInputElement>(".ot-pf")];
    const msg = _root!.querySelector<HTMLSpanElement>("#ot-provision-msg")!;
    const btn = _root!.querySelector<HTMLButtonElement>("#ot-provision-submit")!;
    if (inputs.some((el) => !el.value.trim())) { msg.className = "text-[12px] text-txt-red flex-1 leading-snug"; msg.textContent = pick("필요한 값을 모두 입력하세요.", "Enter all required values."); return; }
    const body: Record<string, string> = {};
    for (const el of inputs) { const k = el.dataset.key; if (k) body[k] = el.value; }
    for (const el of inputs) el.value = "";          // 시크릿 위생: 캡처 직후 입력칸 즉시 clear
    btn.disabled = true; msg.className = "text-[12px] text-slate-500 flex-1 leading-snug"; msg.textContent = pick("연결 중…", "Connecting…");
    try {
      const r = await fetch(api("/ot/" + encodeURIComponent(_ot.otId) + "/provision"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.hint || j.error || "HTTP " + r.status);
      if (!_ot) return;
      if (j.ot) _ot.data = j.ot;                     // 갱신 OT 즉시 반영(awaiting_input → null이면 패널 자동 닫힘)
      refreshOtZone();
      startOtPolling();                              // bundle→join 진행 폴링 재개
    } catch (e) {
      msg.className = "text-[12px] text-txt-red flex-1 leading-snug"; msg.textContent = pick("연결 실패: ", "Connection failed: ") + (e as Error).message; btn.disabled = false;
    }
    // body 는 지역 변수 — 전송 후 스코프 종료. 전역/컴포넌트 상태에 토큰 보관 안 함.
  });

  // 대시보드-실행-활성화 — 서버가 런타임 활성화(터미널 0). 단계별 결과 표시.
  _root.querySelector<HTMLButtonElement>("#ot-activate")?.addEventListener("click", async () => {
    if (!_ot || _activating) return;                 // 이미 진행 중이면 무시(중복 클릭/재실행 차단)
    _activating = true;
    _activateMsg = `<div class="text-slate-400">${pick("서버가 런타임을 활성화하는 중… (수십 초 걸릴 수 있어요)", "Server is activating the runtime… (may take tens of seconds)")}</div>`;
    stopOtPolling();                                  // 활성화 동안 폴링 정지(re-render churn → 버튼 재활성 방지)
    refreshOtZone();                                  // 즉시 비활성+"활성화 중…" 반영(폴링 꺼져 유지됨)
    try {
      const r = await fetch(api("/ot/" + encodeURIComponent(_ot.otId) + "/activate"), { method: "POST", headers: { "content-type": "application/json" } });
      const j = await r.json().catch(() => ({}));
      const steps = Array.isArray(j.steps) ? j.steps : [];
      let html = steps.map((s: { step: string; ok: boolean; detail: string }) =>
        `<div class="${s.ok ? "text-accent-greenSoft" : "text-txt-red"}">${s.ok ? "✓" : "✕"} ${escape(s.step)} — ${escape(s.detail)}</div>`).join("")
        || `<div class="text-slate-400">${pick("결과 없음", "No results")}</div>`;
      if (j.ok) {
        html += `<div class="text-accent-greenSoft mt-1">✅ ${pick("활성화 완료 — 첫 응답(ack) 대기 중", "Activation done — waiting for first ack")}</div>`;
        if (_ot && j.ot) _ot.data = j.ot;
        _activating = false; _activateMsg = html;
        refreshOtZone();
        startOtPolling();                              // join 진행 폴링 재개
      } else if (j.subscription_needed) {
        html += `<div class="text-txt-amber mt-1">⏸ ${pick("구독/한도 때문에 첫 모델 호출이 실패했습니다. 결제 또는 구독 상태를 확인한 뒤 다시 시도하세요.", "The first model call failed because subscription/quota is required. Check billing or subscription and retry.")}</div>`;
        if (_ot && j.ot) _ot.data = j.ot;
        _activating = false; _activateMsg = html;
        refreshOtZone();
      } else {
        const err = String(j.error || pick("오류", "error"));
        const retryHint = /gateway|게이트웨이/i.test(err)
          ? pick(" — 게이트웨이 기동 상태를 확인한 뒤 다시 활성화하세요.", " — check gateway startup and activate again.")
          : pick(" — 위 실패 단계를 확인한 뒤 다시 활성화하세요.", " — check the failed step above and activate again.");
        html += `<div class="text-txt-red mt-1">⚠ ${pick("실패:", "Failed:")} ${escape(err)}${retryHint}</div>`;
        _activating = false; _activateMsg = html;
        refreshOtZone();                               // enabled "🚀 활성화" 버튼 복귀(재시도 가능)
      }
    } catch (e) {
      _activating = false;
      _activateMsg = `<div class="text-txt-red">${pick("활성화 요청 실패:", "Activation request failed:")} ${escape((e as Error).message)}${pick(" — 다시 시도하세요.", " — please try again.")}</div>`;
      refreshOtZone();
    }
  });

  // 인증 다시 확인(preflight recheck) — GD가 터미널에서 로그인한 뒤 즉시 재점검. 서버가 checkRuntimeAuth 재실행 후 OT 갱신.
  // (자동 폴링도 같은 일을 하지만, GD가 방금 로그인했을 때 1.5s 안 기다리고 바로 확인하는 단축 버튼.)
  _root.querySelector<HTMLButtonElement>("#ot-preflight-recheck")?.addEventListener("click", async () => {
    if (!_ot || _prechecking) return;                 // 이미 진행 중이면 무시(중복 클릭 차단)
    _prechecking = true;
    _precheckMsg = `<div class="text-slate-400">${pick("런타임 로그인 상태를 다시 확인하는 중…", "Rechecking runtime login status…")}</div>`;
    stopOtPolling();                                  // 확인 동안 폴링 정지(re-render churn 방지)
    refreshOtZone();
    try {
      const r = await fetch(api("/ot/" + encodeURIComponent(_ot.otId) + "/preflight-recheck"), { method: "POST", headers: { "content-type": "application/json" } });
      const j = await r.json().catch(() => ({}));
      if (!_ot) return;
      if (j.ot) _ot.data = j.ot;                       // 갱신 OT 즉시 반영(통과면 활성화 버튼으로 전환)
      const pf = (j.ot?.steps || []).find((s: OtStep) => s.key === "preflight");
      _precheckMsg = pf?.state === "done"
        ? `<div class="text-accent-greenSoft">✓ ${pick("인증 확인됨 — 이제 활성화할 수 있어요.", "Auth confirmed — you can activate now.")}</div>`
        : `<div class="text-txt-amber">${pick("아직 미로그인 상태예요.", "Still not logged in.")} ${escape(pf?.detail || pick("터미널 로그인 후 다시 확인하세요.", "Log in via terminal and recheck."))}</div>`;
      _prechecking = false;
      refreshOtZone();
      startOtPolling();                                // 통과 안 됐으면 자동 폴링으로 계속 감시
    } catch (e) {
      _prechecking = false;
      _precheckMsg = `<div class="text-txt-red">${pick("확인 요청 실패:", "Check request failed:")} ${escape((e as Error).message)}${pick(" — 다시 시도하세요.", " — please try again.")}</div>`;
      refreshOtZone();
      startOtPolling();
    }
  });

  // Claude Telegram plugin pairing — 서버가 승인 필요 상태(awaiting_input.kind)를 내려줄 때만 6자리 입력 박스를 렌더한다.
  _root.querySelector<HTMLButtonElement>("#ot-claude-pair-approve")?.addEventListener("click", async () => {
    if (!_ot || _pairing) return;
    const input = _root!.querySelector<HTMLInputElement>("#ot-claude-pair-code");
    const code = (input?.value ?? "").trim();
    if (!/^\d{6}$/.test(code)) {
      _pairMsg = `<div class="text-txt-red">${pick("6자리 숫자 코드를 입력하세요.", "Enter the 6-digit numeric code.")}</div>`;
      refreshOtZone();
      return;
    }
    _pairing = true;
    _pairMsg = `<div class="text-slate-400">${pick("Claude 접근 승인을 처리하는 중…", "Processing Claude access approval…")}</div>`;
    if (input) input.value = ""; // one-time code hygiene
    stopOtPolling();
    refreshOtZone();
    try {
      const r = await fetch(api("/ot/" + encodeURIComponent(_ot.otId) + "/claude-pair-approve"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
      const j = await r.json().catch(() => ({}));
      _pairing = false;
      if (j.ok) {
        if (_ot && j.ot) _ot.data = j.ot;
        _pairMsg = `<div class="text-accent-greenSoft">✅ ${escape(j.detail || pick("Claude 접근 승인 완료", "Claude access approved"))}</div>`;
        refreshOtZone();
        startOtPolling();
      } else {
        _pairMsg = `<div class="text-txt-red">⚠ ${escape(j.detail || j.error || pick("승인 실패", "Approval failed"))}</div>`;
        refreshOtZone();
        startOtPolling();
      }
    } catch (e) {
      _pairing = false;
      _pairMsg = `<div class="text-txt-red">${pick("승인 요청 실패:", "Approval request failed:")} ${escape((e as Error).message)}</div>`;
      refreshOtZone();
      startOtPolling();
    }
  });

  // 접근 승인(pairing) — 서버가 pairing.json pending 읽어 executor로 승인(터미널 0). 활성화 버튼과 동일 가드.
  _root.querySelector<HTMLButtonElement>("#ot-pair-approve")?.addEventListener("click", async () => {
    if (!_ot || _pairing) return;
    _pairing = true;
    _pairMsg = `<div class="text-slate-400">${pick("서버가 접근 승인을 처리하는 중…", "Server is processing access approval…")}</div>`;
    stopOtPolling();
    refreshOtZone();
    try {
      const r = await fetch(api("/ot/" + encodeURIComponent(_ot.otId) + "/pair-approve"), { method: "POST", headers: { "content-type": "application/json" } });
      const j = await r.json().catch(() => ({}));
      _pairing = false;
      if (j.ok) {
        if (_ot && j.ot) _ot.data = j.ot;             // joined 반영 → 패널이 "합류 완료"로 전환, 접근 승인 버튼 사라짐
        _pairMsg = `<div class="text-accent-greenSoft">✅ ${escape(j.detail || pick("접근 승인 완료", "Access approved"))}${pick(" — 합류 완료", " — joined")}</div>`;
        refreshOtZone();
        // openclaw는 pairing으로 join(폴링 종료 경로 밖) → 검수 테스트(acceptance-check) 트리거 + 로스터 재조회를 여기서 직접 호출. codex/claude/hermes는 폴링 종료 시 아래 pollOt가 refreshMembers()를 하지만 openclaw는 pair-approve가 폴링을 멈춰서 둘 다 누락됐음(로스터 stale → F5 필요). GD 2026-07-01.
        if (_ot && (_ot.data?.joined || _ot.data?.stage === "joined")) {
          await refreshMembers(); // 새 팀원(openclaw) 목록 반영 — #ot-close render() 전에 _members 갱신
          render();               // 뒤 목록 행 즉시 갱신(닫기 전에도 이미 로스터에 보이게)
          void startOtVerify(_ot.member.id);
        }
      } else if (j.reason === "no_request") {
        _pairMsg = `<div class="text-txt-amber">${escape(j.detail || pick("대기 중인 접근 요청이 없습니다", "No pending access request"))}${pick(" → 봇에게 텔레그램 메시지를 한번 보낸 뒤 다시 누르세요.", " → send the bot a Telegram message once, then press again.")}</div>`;
        refreshOtZone();
      } else {
        _pairMsg = `<div class="text-txt-red">⚠ ${escape(j.detail || j.error || pick("승인 실패", "Approval failed"))}${pick(" — 다시 시도하세요.", " — please try again.")}</div>`;
        refreshOtZone();
      }
    } catch (e) {
      _pairing = false;
      _pairMsg = `<div class="text-txt-red">${pick("승인 요청 실패:", "Approval request failed:")} ${escape((e as Error).message)}</div>`;
      refreshOtZone();
    }
  });

  // OT 완료/닫기
  _root.querySelector<HTMLButtonElement>("#ot-close")?.addEventListener("click", () => {
    stopOtPolling(); resetOtVerify(); _ot = null; _activating = false; _activateMsg = ""; _pairing = false; _pairMsg = ""; _prechecking = false; _precheckMsg = ""; render();  // 새 팀원이 목록에 반영된 상태로 전체 갱신
  });
  // 재검증 — acceptance-check 다시 호출(staged reveal 재시작).
  _root.querySelector<HTMLButtonElement>("#ot-verify-retry")?.addEventListener("click", () => {
    if (_otVerify) { const m = _otVerify.member; _otVerify = null; void startOtVerify(m); }
  });
  // 영입 취소 — POST /ot/:id/cancel (등록·OT·자동생성 폴더 롤백). 진행 중(미합류) OT만 노출됨.
  _root.querySelector<HTMLButtonElement>("#ot-cancel")?.addEventListener("click", async () => {
    if (!_ot) return;
    const name = _ot.member.display_name;
    if (!confirm(`${name} ${pick("영입을 취소할까요?\n\n지금까지 등록·진행한 것을 지우고, 자동으로 만들어진 빈 작업 폴더를 정리합니다.\n(직접 손댄 파일은 그대로 둡니다)", "onboarding — cancel it?\n\nClears what was registered and set up so far, and removes the empty auto-created work folder.\n(files you touched are kept)")}`)) return;
    const btn = _root!.querySelector<HTMLButtonElement>("#ot-cancel")!;
    btn.disabled = true; btn.textContent = pick("취소 중…", "Cancelling…");
    try {
      const r = await fetch(api("/ot/" + encodeURIComponent(_ot.otId) + "/cancel"), { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.hint || j.error || "HTTP " + r.status);
      stopOtPolling(); resetOtVerify(); _ot = null; _activating = false; _activateMsg = ""; _pairing = false; _pairMsg = ""; _prechecking = false; _precheckMsg = ""; render();
    } catch (e) {
      btn.disabled = false; btn.textContent = `✕ ${pick("영입 취소 — 지금까지 등록한 것 지움", "Cancel onboarding — clear what was set up")}`;
      alert(pick("취소 실패: ", "Cancel failed: ") + (e as Error).message);
    }
  });
  // 합류 패키지(OT 번들) 보기
  _root.querySelector<HTMLButtonElement>("#ot-bundle")?.addEventListener("click", async () => {
    const view = _root!.querySelector<HTMLDivElement>("#ot-bundle-view");
    if (!view || !_ot) return;
    view.innerHTML = `<div class="text-[12px] text-slate-500">${pick("불러오는 중…", "Loading…")}</div>`;
    try {
      const b = await fetch(api("/ot/" + encodeURIComponent(_ot.otId) + "/bundle"), { headers: { accept: "application/json" } }).then((r) => r.json());
      const fa = b.first_action ?? b.firstAction;
      const conn = b.connection;
      view.innerHTML = `
        <div class="rounded-lg border border-surface-3 bg-surface-0/60 p-3 text-[12px] leading-6 text-slate-300 space-y-1.5">
          <div class="text-slate-200 font-semibold">${pick("합류 패키지 — 새 팀원에게 전달됨", "Join package — handed to the new member")}</div>
          ${b.mission ? `<div><span class="text-slate-500">${pick("미션:", "Mission:")}</span> ${escape(String(b.mission).slice(0, 160))}…</div>` : ""}
          ${Array.isArray(b.capabilities) ? `<div><span class="text-slate-500">${pick("능력:", "Capabilities:")}</span> ${escape(b.capabilities.map((c: Capability | string) => (typeof c === "string" ? c : c.label)).slice(0, 8).join(" · "))}</div>` : ""}
          ${conn ? `<div><span class="text-slate-500">${pick("연결:", "Connection:")}</span> ${escape(typeof conn === "string" ? conn : [(conn as any).runtime && `runtime: ${(conn as any).runtime}`, (conn as any).status_provider && `status: ${(conn as any).status_provider}`].filter(Boolean).join(" · ") || pick("런타임 연결됨", "runtime connected"))}</div>` : ""}
          ${fa ? `<div><span class="text-slate-500">${pick("첫 액션:", "First action:")}</span> ${escape(typeof fa === "string" ? fa : JSON.stringify(fa))}</div>` : ""}
        </div>`;
    } catch (e) {
      view.innerHTML = `<div class="text-[12px] text-txt-red">${pick("번들 불러오기 실패:", "Bundle load failed:")} ${escape((e as Error).message)}</div>`;
    }
  });
}

// ── OT 폴링 (~1.5s, busflow 패턴) ─────────────────────────────────
function stopOtPolling(): void { if (_otTimer) { clearInterval(_otTimer); _otTimer = null; } }
function startOtPolling(): void { stopOtPolling(); _otTimer = setInterval(() => void pollOt(), 1500); void pollOt(); }
async function pollOt(): Promise<void> {
  if (!_ot) { stopOtPolling(); return; }
  let d: OtData;
  try {
    const r = await fetch(api("/ot/" + encodeURIComponent(_ot.otId)), { headers: { accept: "application/json" } });
    if (!r.ok) return;            // 일시 오류 → 다음 틱 재시도
    d = await r.json();
  } catch { return; }
  if (!_ot) return;
  _ot.data = d;
  const terminal = !!(d.error || d.stage === "failed" || d.joined || d.stage === "joined" || d.done);
  if (terminal) {
    stopOtPolling();
    if (d.joined || d.stage === "joined" || d.done) await refreshMembers();  // 새 팀원 목록 반영
    if (_ot && (d.joined || d.stage === "joined")) void startOtVerify(_ot.member.id); // 합류 → 영입 검증 자동 시작(staged reveal)
    render();                      // 전체 갱신(행+성공/실패 패널)
    return;
  }
  if (d.awaiting_input && d.awaiting_input.fields?.length) {
    // 입력 대기 — 서버는 제출 전엔 진행 안 함. 폴링 정지(타이핑 중 입력칸 클로버 방지).
    stopOtPolling();
    // 패널이 아직 안 떠 있을 때만 렌더(이미 입력 중이면 건드리지 않음).
    if (!_root?.querySelector("#ot-provision-submit")) refreshOtZone();
    return;
  }
  void maybeAutoRecheckPreflight(d); // preflight blocked면 throttle로 자동 재점검(로그인되면 done→다음 렌더에서 활성화 버튼 노출)
  refreshOtZone();                 // 진행 중엔 OT 구역만 갱신
}

// preflight가 blocked인 동안 폴링 사이클에서 자동으로 POST /preflight-recheck를 호출한다.
// GET 폴링은 저장된 steps만 주고 재점검을 안 하므로(서버가 checkRuntimeAuth 재실행 X), 이게 없으면
// GD가 터미널 로그인해도 '다시 확인'을 수동으로 눌러야만 활성화 버튼이 뜬다. throttle(AUTO_RECHECK_MS)로
// 런타임 preflight 부하를 막고, 통과되면 recheck가 preflight=done으로 바꿔 다음 렌더에서 활성화 버튼이 자동 노출.
async function maybeAutoRecheckPreflight(d: OtData): Promise<void> {
  if (!_ot) return;
  const pf = (d.steps || []).find((s) => s.key === "preflight");
  if (!pf || pf.state !== "blocked") return;        // blocked 동안만 자동 재점검
  if (_prechecking || _autoRechecking) return;       // 수동 확인 중이거나 이미 자동 호출 중이면 스킵
  const now = Date.now();
  if (now - _autoRecheckAt < AUTO_RECHECK_MS) return; // throttle: 매 1.5s 폴링마다가 아니라 5s 간격
  _autoRecheckAt = now;
  _autoRechecking = true;
  const otId = _ot.otId;
  try {
    const r = await fetch(api("/ot/" + encodeURIComponent(otId) + "/preflight-recheck"), { method: "POST", headers: { "content-type": "application/json" } });
    const j = await r.json().catch(() => ({}));
    if (_ot && _ot.otId === otId && j.ot) { _ot.data = j.ot; refreshOtZone(); } // done이면 다음 렌더에서 활성화 버튼 노출
  } catch { /* 일시 오류 → 다음 throttle 주기에 재시도 */ }
  finally { _autoRechecking = false; }
}

export function renderSettings(root: HTMLElement): void {
  _root = root;
  root.innerHTML = `<div class="h-full overflow-y-auto"><div class="max-w-3xl mx-auto px-4 md:px-6 py-5"><div class="text-slate-500 py-16 text-center">${pick("설정 불러오는 중…", "Loading settings…")}</div></div></div>`;
  void loadAll().then(async () => {
    // 끊긴 영입 resume: 진행 중 OT 가 있으면 패널 복원(새로고침해도 활성화/승인 단계로 돌아옴).
    if (!_ot) {
      try {
        const a = await fetch(api("/ot/active"), { headers: { accept: "application/json" } }).then((r) => r.json());
        if (a && a.ot_id && a.member) { _ot = { otId: a.ot_id, member: a.member, data: null }; }
      } catch { /* resume 실패해도 일반 화면 */ }
    }
    if (_root) render();
    if (_ot) startOtPolling();
    void loadSlackHealth(); // 2단계: auth.test 실측으로 배지 갱신(죽은앱=token_invalid 빨강)
  });
}
