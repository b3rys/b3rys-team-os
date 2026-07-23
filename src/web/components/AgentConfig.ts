// AgentConfig — per-agent settings panel.
// Shows the agents.json registry entry (read-only) + the persona_file content (editable).
// Persona edits PUT to /api/agents/:id/persona which writes ONLY the registered persona path;
// the change takes effect on the agent's next Claude Code session.

import { store, type Agent } from "../store";
import { apiBase } from "../ws";
import { setBtnBusy, LIVE_ONLY_OPS } from "./Settings";
import { FALLBACK_RUNTIME_OPTIONS, fetchRuntimeOptions, runtimeLabel, type RuntimeOption } from "./runtimeOptions";
import { renderAgentSlack } from "./AgentSlack";
import { renderIcon, agentIconName, downloadAgentIconJpg } from "../icons";
import { AGENT_ICON_COLORS, renderAgentIcon, iconColorHex } from "../agentColors";
import { pick } from "../i18n";

// 아이콘 선택지(icons.ts ICONS 키 중 페르소나/역할에 어울리는 것).
const ICON_CHOICES = [
  "wrench", "code", "flask-conical", "cpu", "landmark", "newspaper", "user-circle", "user", "users",
  "route", "layers", "shield", "workflow", "database", "monitor", "hard-drive", "search", "inbox",
  "megaphone", "file-text", "message-square", "bot",
];

interface ConfigResponse {
  agent: Agent & {
    slack_bot_user_id?: string | null;
    slack_app_name?: string | null;
    openclaw_agent_id?: string | null;
  };
  persona: { path: string; content: string | null; exists: boolean; bytes: number };
  custom_persona?: string | null; // 편집기 pre-fill용 커스텀 블록(룰 섹션 제거·추출) — 파일 통짜 대신 이걸 편집
  off?: boolean;
}

// 런타임 교체 대상 화이트리스트. codex 는 내부 빌드에서만 /runtime-options 에 실려(공개판은 서버가 미노출),
// 이 목록에 있어도 공개판 swap select 엔 나타나지 않는다(옵션 = 이 목록 ∩ runtime-options). readiness·disabled 사유는 /runtime-options 정본.
const SWAP_TARGETS = ["claude_channel", "openclaw", "hermes_agent", "codex"];

// 게이트웨이 런타임 재시작 시 다른 팀원도 잠깐 깜빡인다는 경고. 목록에 없는 런타임(claude_channel 등)은 경고 없음(기본).
const GATEWAY_RESTART_NOTE: Record<string, { ko: string; en: string }> = {
  openclaw: { ko: " 게이트웨이라 다른 openclaw 팀원도 ~1분 깜빡", en: " gateway — other openclaw members also blink ~1 min" },
  hermes_agent: { ko: " 게이트웨이라 다른 hermes 팀원도 ~1분 깜빡", en: " gateway — other hermes members also blink ~1 min" },
};

interface SwapStepRes { step: string; ok: boolean; detail: string }
// POST /members/:id/swap-runtime 응답 — activation.ts SwapResult + settings.ts 라우트 레벨 사전체크(hint) 합.
interface SwapRuntimeResponse {
  ok: boolean;
  steps?: SwapStepRes[];
  error?: string;
  code?: string;
  hint?: string;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function revealExpandedSection(section: HTMLElement): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!section.hasAttribute("open")) return;
      const scroller = section.closest<HTMLElement>(".overflow-y-auto");
      if (!scroller) {
        section.scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
      }
      const sectionRect = section.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const bottomOverflow = sectionRect.bottom - scrollerRect.bottom + 20;
      if (bottomOverflow > 0) {
        scroller.scrollBy({ top: bottomOverflow, behavior: "smooth" });
      }
    });
  });
}

// 인앱 확인 모달 — native confirm() 대신(WKWebView 앱 호환 + 팀원명 크게·굵게 스타일 가능).
// bodyHtml 은 신뢰된 문자열(호출부에서 escape 처리). 확인=resolve(true), 취소/backdrop/Esc=false.
function confirmModal(bodyHtml: string, opts: { danger?: boolean; okLabel?: string } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[100] flex items-center justify-center bg-black/55 backdrop-blur-sm p-4";
    const okCls = opts.danger ? "bg-status-blocked/90 hover:bg-status-blocked text-white" : "bg-accent-green/90 hover:bg-accent-green text-white";
    const okLabel = opts.okLabel ?? pick("확인", "Confirm");
    overlay.innerHTML = `
      <div class="max-w-sm w-full rounded-xl bg-surface-2 border border-surface-3 shadow-2xl p-5" role="dialog" aria-modal="true">
        <div class="text-sm text-slate-300 leading-relaxed mb-5">${bodyHtml}</div>
        <div class="flex justify-end gap-2">
          <button data-mc="cancel" class="px-4 py-2 rounded-md text-sm font-medium text-slate-300 border border-surface-3 hover:bg-surface-3">${pick("취소", "Cancel")}</button>
          <button data-mc="ok" class="px-4 py-2 rounded-md text-sm font-semibold ${okCls}">${escape(okLabel)}</button>
        </div>
      </div>`;
    const done = (v: boolean) => { overlay.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") done(false); };
    overlay.addEventListener("click", (e) => { if (e.target === overlay) done(false); });
    overlay.querySelector('[data-mc="ok"]')?.addEventListener("click", () => done(true));
    overlay.querySelector('[data-mc="cancel"]')?.addEventListener("click", () => done(false));
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    overlay.querySelector<HTMLButtonElement>('[data-mc="ok"]')?.focus();
  });
}

const REGISTRY_FIELDS: Array<[string, (a: ConfigResponse["agent"]) => string]> = [
  ["id", (a) => a.id],
  ["display_name", (a) => a.display_name],
  ["role", (a) => a.role],
  ["response_mode", (a) => a.response_mode ?? "mention-only"],
  ["default_intake_scope", (a) => a.default_intake_scope ?? "none"],
  ["default_intake_description", (a) => a.default_intake_description ?? "—"],
  ["runtime", (a) => a.runtime],
  ["status_provider", (a) => a.status_provider],
  ["tmux_session", (a) => a.tmux_session ?? "—"],
  ["telegram_bot", (a) => a.telegram_bot_username ?? "—"],
  ["workspace_path", (a) => a.workspace_path],
  ["persona_file", (a) => a.persona_file],
  ["slack_bot_user_id", (a) => a.slack_bot_user_id ?? "—"],
  ["openclaw_agent_id", (a) => a.openclaw_agent_id ?? "—"],
  ["moderator_eligible", (a) => (a.moderator_eligible ? "yes" : "no")],
];

export function renderAgentConfig(root: HTMLElement): void {
  let lastAgentId: string | null = null;
  let loading = false;

  const load = async (agentId: string) => {
    loading = true;
    try {
      const [res, runtimeOptions] = await Promise.all([
        fetch(`${apiBase()}/api/agents/${agentId}/config`),
        fetchRuntimeOptions(),
      ]);
      if (!res.ok) {
        root.innerHTML = `<div class="flex-1 flex items-center justify-center text-status-blocked">${pick("config 로드 실패", "Failed to load config")} (${res.status})</div>`;
        return;
      }
      const data = (await res.json()) as ConfigResponse;
      renderInto(root, data, () => load(agentId), runtimeOptions); // runtime-options와 영입 UI의 선택 정책을 공유
    } catch (e) {
      root.innerHTML = `<div class="flex-1 flex items-center justify-center text-status-blocked">${pick("config 로드 오류", "Error loading config")}: ${escape(String(e))}</div>`;
    } finally {
      loading = false;
    }
  };

  const sync = () => {
    const { selectedAgentId, mainView } = store.getState();
    if (mainView !== "config") return;
    if (!selectedAgentId) {
      root.innerHTML = `<div class="flex-1 flex items-center justify-center text-slate-500">${pick("좌측에서 agent 선택", "Select an agent on the left")}</div>`;
      lastAgentId = null;
      return;
    }
    if (selectedAgentId !== lastAgentId && !loading) {
      lastAgentId = selectedAgentId;
      void load(selectedAgentId);
    }
  };

  sync();
  store.subscribe(sync);
}

function renderInto(root: HTMLElement, data: ConfigResponse, reload: () => void, runtimeOptions: RuntimeOption[] = FALLBACK_RUNTIME_OPTIONS) {
  const { agent, persona } = data;
  const customPersona = (data.custom_persona ?? "").trim(); // pre-fill = SOUL.md 정본(서버가 SOUL 에서 읽어 내려줌). agents.json fallback 제거 — purpose 필드 자체가 없어졌다(GD 2026-07-17)
  const currentIcon = agent.icon || agentIconName(agent.id); // 저장된 icon, 없으면 id 기본 매핑
  const currentColor = agent.icon_color || "green"; // 저장된 색, 없으면 green 기본
  const rows = REGISTRY_FIELDS.map(
    ([label, get]) => `
      <tr class="border-b border-surface-3/50">
        <td class="py-1.5 pr-4 text-slate-500 align-top whitespace-nowrap">${label}</td>
        <td class="py-1.5 text-slate-200 break-all font-mono text-[11px]">${escape(get(agent))}</td>
      </tr>`,
  ).join("");
  // 레지스트리 표에 자연스럽게 이어지는 icon 행 — 아이콘 클릭 시 피커 펼쳐 아이콘+색 변경(색은 펼침 메뉴 안에 녹임, GD 2026-06-27).
  const iconRow = `
      <tr class="border-b border-surface-3/50">
        <td class="py-1.5 pr-4 text-slate-500 align-top whitespace-nowrap">icon</td>
        <td class="py-1.5">
          <button id="cfg-icon-btn" title="${pick("클릭해서 아이콘·색 변경", "Click to change icon & color")}" class="inline-flex items-center justify-center w-8 h-8 rounded-md border border-surface-3 hover:border-accent-green align-middle">${renderAgentIcon(currentIcon, currentColor, 18)}</button>
          <button id="cfg-icon-dl" title="${pick("JPG로 다운로드 (텔레그램·슬랙 아바타용)", "Download as JPG (for Telegram / Slack avatar)")}" class="ml-1.5 px-2 h-8 rounded-md border border-surface-3 hover:border-accent-green text-[11px] text-slate-300 align-middle">⬇ JPG</button>
          <span id="cfg-icon-msg" class="text-[11px] text-slate-500 ml-2 align-middle"></span>
          <div id="cfg-icon-picker" class="hidden mt-2 max-w-md">
            <div id="cfg-icon-choices" class="flex flex-wrap gap-1.5"></div>
            <div class="mt-2 pt-2 border-t border-surface-3/60">
              <div class="text-[10px] text-slate-500 mb-1">${pick("색 (팀원 구분용 · 선택)", "Color (to distinguish members · optional)")}</div>
              <div id="cfg-color-picker" class="flex flex-wrap gap-1.5 items-center"></div>
            </div>
          </div>
        </td>
      </tr>`;

  const personaContent = persona.content ?? "";
  // 런타임 교체 select 옵션 — 서버 화이트리스트(SWAP_TARGETS)와 교집합 + 현재 런타임 제외 + 공개빌드 b3os_native 숨김.
  // 공개빌드에선 아래 '런타임 교체' 섹션 전체를 렌더하지 않는다(LIVE_ONLY_OPS=false) — 공개판은 UI에서만 swap 숨김(GD 0721). 서버 엔드포인트는 유지되며 codex target·미준비는 publicRuntimeGate/runtime_not_ready 가 막는다.
  const swapTargetOptions = runtimeOptions
    .filter((r) => SWAP_TARGETS.includes(r.runtime) && r.runtime !== agent.runtime)
    .map((r) => `<option value="${escape(r.runtime)}" ${r.disabled ? "disabled" : ""}>${escape(r.label)}${r.disabled ? pick(" · 연동 필요", " · Setup required") : ""}</option>`)
    .join("");
  const swapSetupHelp = runtimeOptions.filter((r) => r.tier === "advanced_byo" && r.disabled)
    .map((r) => `<div class="text-[11px] text-txt-amber"><b>${escape(r.label)}</b>: ${escape(r.reason)} · <a class="underline" href="/team/runtime-setup?runtime=${encodeURIComponent(r.runtime)}" data-setup-ref="${escape(r.setup_ref ?? "")}">${pick("연동 안내", "Setup guide")}</a></div>`).join("");
  root.innerHTML = `
    <div class="flex-1 flex flex-col min-h-0 overflow-y-auto">
      <div class="h-10 flex items-center justify-between px-4 border-b border-surface-3 shrink-0 bg-surface-1 sticky top-0 z-10">
        <div class="text-sm font-semibold flex items-center gap-2">${renderAgentIcon(currentIcon, currentColor, 16)} ${escape(agent.display_name)} · Settings</div>
        <div class="text-xs text-slate-500">${persona.exists ? `${persona.bytes}B` : pick("persona 없음", "no persona")}</div>
      </div>

      <div class="p-4">
        <div class="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-2">${pick("레지스트리 (agents.json · icon만 변경 가능)", "Registry (agents.json · icon only)")}</div>
        <table class="w-full text-xs mb-6"><tbody>${rows}${iconRow}</tbody></table>

        <div class="flex items-center justify-between mb-2">
          <div class="text-xs font-semibold uppercase tracking-widest text-slate-500">${pick("역할 · 페르소나 (agents.json)", "Role · Persona (agents.json)")}</div>
        </div>
        <div class="text-[11px] text-slate-500 mb-1">${pick("역할 (role)", "Role")}</div>
        <input id="cfg-role" value="${escape(agent.role ?? "")}" spellcheck="false"
          class="w-full bg-surface-0 border border-surface-3 rounded-md px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-accent-green mb-3"
          placeholder="${pick("예: Step Engineer", "e.g. Step Engineer")}" />
        <div class="text-[11px] text-slate-500 mb-1">${pick("멘션명 (별칭 — @로 부를 이름, 쉼표로 구분 · 공백 없이 · 최대 8개 · 아래 저장 버튼으로 함께 저장)", "Mention names (aliases — @-callable, comma-separated · no spaces · max 8 · saved with the Save button below)")}</div>
        <input id="cfg-nicknames" value="${escape((agent.nicknames ?? []).join(", "))}" spellcheck="false"
          class="w-full bg-surface-0 border border-surface-3 rounded-md px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-accent-green mb-1"
          placeholder="${pick(`예: ${escape(agent.display_name)}, 리사`, `e.g. ${escape(agent.display_name)}, li`)}" autocomplete="off" />
        <div class="text-[11px] text-slate-500 mb-3">${pick("비워두면 id·표시이름으로만 부를 수 있습니다.", "If empty, callable only by id / display name.")}</div>
        <div class="text-[11px] text-slate-500 mb-1">${pick("페르소나 · 능력 (자유 입력 — 적은 그대로 반영)", "Persona · capability (free text — saved verbatim)")}</div>
        <textarea id="cfg-persona"
          class="w-full h-48 bg-surface-0 border border-surface-3 rounded-md p-3 text-[12px] text-slate-100 focus:outline-none focus:border-accent-green resize-y"
          spellcheck="false" placeholder="${pick("이 팀원의 성격·강점·역할을 자유롭게… (## 소제목 마크다운 OK)", "Describe this member's personality, strengths, role… (## sub-headers OK)")}">${escape(customPersona)}</textarea>
        <div class="text-[11px] text-slate-500 mt-1">${pick("저장 → agents.json 저장 → 런타임 파일 자동생성(룰=템플릿·영문 / 입력=그대로 verbatim). 모든 런타임에 반영됨.", "Save → stored in agents.json → runtime file auto-generated (rules=template / input=verbatim). Applies to every runtime.")}</div>
        <div class="flex flex-wrap items-center gap-2 mt-2">
          <button id="cfg-save"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent-btn text-accent-on text-sm font-semibold hover:bg-accent-btnHover disabled:opacity-50">${renderIcon("save", { size: 13, className: "shrink-0" })}${pick("저장", "Save")}</button>
          <button id="cfg-reset"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-400/40 bg-surface-3 text-slate-200 text-sm font-medium hover:bg-surface-0 hover:border-slate-400/60">${renderIcon("rotate-ccw", { size: 13, className: "shrink-0" })}${pick("되돌리기", "Revert")}</button>
          ${LIVE_ONLY_OPS ? `<button id="cfg-regen" title="${pick("핵심룰(멈춤장치·통신·conti)을 현재 템플릿으로 재적용 — 정체·능력은 보존", "Re-apply core rules (stop-guard · comms · conti) from the current template — identity & capabilities preserved")}"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-400/40 bg-surface-3 text-txt-amber text-sm font-medium hover:bg-surface-0 hover:border-txt-amber/50">${renderIcon("refresh-cw", { size: 13, className: "shrink-0" })}${pick("핵심룰 재적용", "Re-apply core rules")}</button>` : ""}
          <button id="cfg-restart" title="${pick("런타임 재시작 — 컨텍스트 유지(--resume) + 새 CLAUDE.md 로드 (openclaw는 게이트웨이, ~1분 깜빡)", "Restart runtime — keeps context (--resume) + loads new CLAUDE.md (openclaw is a gateway, ~1 min blink)")}"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-400/40 bg-surface-3 text-txt-blue text-sm font-medium hover:bg-surface-0 hover:border-txt-blue/50">${renderIcon("refresh-cw", { size: 13, className: "shrink-0" })}${pick("재시작", "Restart")}</button>
          <button id="cfg-restart-fresh" title="${pick("완전 재시작 — 세션 컨텍스트(기억) 완전 비움 + 콜드 스타트(--fresh). claude 런타임만 의미 있음.", "Full restart — wipes session context (memory) + cold start (--fresh). Only meaningful for the claude runtime.")}"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-400/40 bg-surface-3 text-txt-red text-sm font-medium hover:bg-surface-0 hover:border-txt-red/50">${renderIcon("refresh-cw", { size: 13, className: "shrink-0" })}${pick("완전 재시작", "Full restart")}</button>
          <button id="cfg-onoff" title="${pick("서킷브레이커 — 정지/기동", "Circuit breaker — stop/start")}"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-400/40 bg-surface-3 text-sm font-medium hover:bg-surface-0 ${data.off ? "text-accent-greenSoft hover:border-accent-green/50" : "text-txt-red hover:border-txt-red/50"}">${renderIcon("power", { size: 13, className: "shrink-0" })}${data.off ? pick("기동", "Start") : pick("정지", "Stop")}</button>
          <span id="cfg-regen-msg" class="text-[11px] text-slate-500"></span>
        </div>
        <div id="cfg-save-status" class="text-[11px] text-slate-500 mt-1.5 empty:hidden"></div>
        <div class="text-[11px] text-slate-500 mt-1">${pick("재적용→재시작까지 여기서 바로.", "Re-apply through restart, right here.")} ${data.off ? pick("⚠ 현재 <b class=\"text-status-blocked\">정지</b> 상태.", "⚠ Currently <b class=\"text-status-blocked\">stopped</b>.") : ""}</div>

        ${LIVE_ONLY_OPS ? `
        <details class="mt-8 pt-5 border-t border-txt-amber/30 group">
          <summary class="flex items-center gap-1.5 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden text-xs font-semibold uppercase tracking-widest text-txt-amber/80 hover:text-txt-amber">
            <span class="text-txt-amber/70 inline-block text-[10px] leading-none transition-transform acc-chevron">▶</span>${pick("런타임 교체", "Swap runtime")}
          </summary>
          <div class="mt-3">
            <div class="text-[12px] text-slate-400 mb-2">
              ${pick("현재 런타임", "Current runtime")}: <span class="font-mono text-slate-200">${escape(runtimeLabel(agent.runtime))}</span><br/>
              ⚠ ${pick("런타임을 정지했다 재기동합니다. 진행 중 작업이 있으면 중단될 수 있습니다. MEMORY.md 등 메모리는 보존됩니다.", "This stops the runtime and restarts it. In-progress work may be interrupted. Memory (MEMORY.md etc.) is preserved.")}
            </div>
            ${swapTargetOptions ? `
            <div class="flex items-center gap-2 flex-wrap">
              <select id="cfg-swap-target" class="bg-surface-0 border border-surface-3 rounded-md px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-txt-amber/50 dash-select">
                <option value="">${pick("교체할 런타임 선택…", "Select target runtime…")}</option>
                ${swapTargetOptions}
              </select>
              <input id="cfg-swap-confirm" class="bg-surface-0 border border-surface-3 rounded-md px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-txt-amber/50 min-w-[160px]" placeholder="${escape(agent.display_name)}" autocomplete="off" spellcheck="false" />
              <button id="cfg-swap-submit" class="text-sm font-semibold px-4 py-2 rounded-md border border-slate-400/40 bg-surface-3 text-txt-amber hover:bg-surface-0 hover:border-txt-amber/50 disabled:opacity-40 disabled:cursor-not-allowed" disabled>${pick("런타임 교체", "Swap runtime")}</button>
            </div>
            <div class="text-[11px] text-slate-600 mt-1">${pick(`진행하려면 이름 <b class="text-slate-200">${escape(agent.display_name)}</b> 을(를) 정확히 입력하세요.`, `To proceed, type the exact name <b class="text-slate-200">${escape(agent.display_name)}</b>.`)}</div>
            ` : `<div class="text-[12px] text-txt-amber/80">${pick("교체 가능한 다른 런타임이 없습니다.", "No other runtime available to swap to.")}</div>`}
            <div class="mt-2 space-y-1">${swapSetupHelp}</div>
            <div id="cfg-swap-msg" class="text-[12px] mt-2 leading-snug text-slate-500"></div>
            <div id="cfg-swap-steps" class="mt-2 space-y-0.5"></div>
          </div>
        </details>
        ` : ""}

        <div id="cfg-slack"></div>

        <details class="mt-8 pt-5 border-t border-surface-3 group">
          <summary class="flex items-center gap-1.5 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden text-xs font-semibold uppercase tracking-widest text-slate-500 hover:text-slate-300">
            <span class="text-slate-500 inline-block text-[10px] leading-none transition-transform acc-chevron">▶</span>${pick("봇 토큰 변경", "Change bot token")}
          </summary>
          <div class="mt-3">
            <div class="text-[12px] text-slate-400 mb-2">${pick("봇이 죽었거나 탈퇴한 계정이면 새 토큰으로 바꿉니다(다시 영입할 필요 없이). 서버가 확인하고 새 토큰으로 다시 연결합니다.", "If the bot is dead or a withdrawn account, swap in a new token (no need to re-recruit). The server checks it and reconnects with the new token.")}</div>
            <div class="flex items-center gap-2 flex-wrap">
              <input id="cfg-token" type="password" class="bg-surface-0 border border-surface-3 rounded-md px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-accent-green/40 min-w-[220px] font-mono" placeholder="${pick("봇 토큰 붙여넣기", "Paste bot token")}" autocomplete="off" spellcheck="false" />
              <button id="cfg-token-submit" class="text-sm font-semibold px-4 py-2 rounded-md border border-slate-400/40 bg-surface-3 text-txt-blue hover:bg-surface-0 hover:border-txt-blue/50 disabled:opacity-40 disabled:cursor-not-allowed">${pick("검증·적용", "Verify & apply")}</button>
            </div>
            <div id="cfg-token-msg" class="text-[12px] mt-2 leading-snug text-slate-500"></div>
            <div class="text-[11px] text-slate-600 mt-1">🔒 ${pick("입력한 토큰은 화면·기록에 남지 않고 보낸 뒤 바로 지워집니다. 서버가 안전하게 확인하고 새 토큰으로 다시 연결합니다.", "The token you enter is never left on the screen or in logs; it is cleared right after sending. The server checks it safely and reconnects with the new token.")}</div>
          </div>
        </details>

        <details class="mt-8 pt-5 border-t border-status-blocked/30 group">
          <summary class="flex items-center gap-1.5 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden text-xs font-semibold uppercase tracking-widest text-status-blocked/80 hover:text-status-blocked">
            <span class="text-status-blocked/70 inline-block text-[10px] leading-none transition-transform acc-chevron">▶</span>${pick("위험 구역 · 퇴사", "Danger zone · Offboard")}
          </summary>
          <div class="mt-3">
            <div class="text-[12px] text-slate-400 mb-2">${pick(`팀원 목록에서 제거합니다. 진행하려면 이름 <b class="text-slate-200">${escape(agent.display_name)}</b> 을(를) 정확히 입력하세요.`, `Removes them from the team. To proceed, type the exact name <b class="text-slate-200">${escape(agent.display_name)}</b>.`)}</div>
            <div class="flex items-center gap-2 flex-wrap">
              <input id="cfg-offboard-confirm" class="bg-surface-0 border border-surface-3 rounded-md px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-status-blocked min-w-[160px]" placeholder="${escape(agent.display_name)}" autocomplete="off" />
              <button id="cfg-offboard" class="text-sm font-semibold px-4 py-2 rounded-md bg-status-blocked/90 text-white hover:bg-status-blocked disabled:opacity-40 disabled:cursor-not-allowed" disabled>${pick("퇴사", "Offboard")}</button>
            </div>
            <div id="cfg-offboard-msg" class="text-[12px] mt-2 leading-snug text-slate-500"></div>
            <div class="text-[11px] text-slate-600 mt-2">${pick("※ 퇴사 시 봇·tmux·게이트웨이·슬랙 등 연결이 자동으로 정리되고, 워크스페이스는 삭제 대신 아카이브됩니다.", "※ On offboard, the bot / tmux / gateway / Slack wiring is cleaned up automatically, and the workspace is archived (not deleted).")}</div>
          </div>
        </details>
      </div>
    </div>`;

  // 팀원별 Slack 연동 섹션 mount (상태배지 + 연결확인 + 연동 마법사)
  const slackHost = root.querySelector<HTMLElement>("#cfg-slack");
  if (slackHost) renderAgentSlack(slackHost, agent.id, agent.display_name);

  root.querySelectorAll<HTMLDetailsElement>("details").forEach((details) => {
    details.addEventListener("toggle", () => {
      if (details.open) revealExpandedSection(details);
    });
  });

  const textarea = root.querySelector<HTMLTextAreaElement>("#cfg-persona");
  const roleInput = root.querySelector<HTMLInputElement>("#cfg-role");
  const saveBtn = root.querySelector<HTMLButtonElement>("#cfg-save");
  const resetBtn = root.querySelector<HTMLButtonElement>("#cfg-reset");
  const statusEl = root.querySelector<HTMLElement>("#cfg-save-status");
  const originalProfile = { role: agent.role ?? "", persona: customPersona };

  resetBtn?.addEventListener("click", () => {
    if (roleInput) roleInput.value = originalProfile.role;
    if (textarea) textarea.value = originalProfile.persona;
    if (nicksInput) nicksInput.value = (agent.nicknames ?? []).join(", ");
    if (statusEl) statusEl.textContent = "";
  });

  // 멘션명(별칭) — 별도 버튼 없이 아래 '저장' 버튼이 role·persona 와 함께 저장(GD 2026-07-19). PATCH /members/:id {nicknames}.
  //   쉼표/공백으로 분리 → @접두 제거. 빈 값이면 별칭 제거(id·display_name 만으로 호출).
  const nicksInput = root.querySelector<HTMLInputElement>("#cfg-nicknames");
  const parseNicknames = (): { nicknames: string[] } | { error: string } => {
    const nicknames = (nicksInput?.value ?? "")
      .split(/[,\s]+/)
      .map((s) => s.trim().replace(/^@+/, ""))
      .filter(Boolean);
    if (nicknames.length > 8) return { error: pick("멘션명은 최대 8개입니다.", "Up to 8 mention names.") };
    if (nicknames.some((n) => n.length > 32)) return { error: pick("각 멘션명은 32자 이하여야 합니다.", "Each mention name must be ≤ 32 chars.") };
    return { nicknames };
  };

  // 핵심룰 재적용 — 서버가 페르소나의 ⭐핵심룰만 현재 템플릿(멈춤장치·통신·conti)으로 교체(정체·능력 보존).
  const regenBtn = root.querySelector<HTMLButtonElement>("#cfg-regen");
  const regenMsg = root.querySelector<HTMLElement>("#cfg-regen-msg");
  regenBtn?.addEventListener("click", async () => {
    if (!confirm(pick(`${agent.display_name}의 ⭐핵심룰(멈춤장치·통신·conti)을 현재 템플릿으로 재적용할까요?\n정체·능력 등 커스텀은 보존됩니다. (백업 자동)`, `Re-apply ${agent.display_name}'s ⭐core rules (stop-guard · comms · conti) from the current template?\nCustomizations like identity & capabilities are preserved. (auto backup)`))) return;
    const _busy = setBtnBusy(regenBtn, pick("⏳ 적용 중…", "⏳ Applying…"));
    if (regenMsg) { regenMsg.textContent = pick("재적용 중…", "Re-applying…"); regenMsg.className = "text-[11px] text-slate-400"; }
    try {
      const res = await fetch(`${apiBase()}/api/members/${encodeURIComponent(agent.id)}/regenerate-persona`, {
        method: "POST", headers: { "Content-Type": "application/json" },
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; updated?: string[]; skipped?: string[]; error?: string };
      if (j.ok) {
        if (regenMsg) { regenMsg.textContent = pick(`✓ 재적용됨 (${(j.updated ?? []).length}개 파일) — 자동 새로고침…`, `✓ Re-applied (${(j.updated ?? []).length} files) — auto refreshing…`); regenMsg.className = "text-[11px] text-accent-greenSoft"; }
        setTimeout(reload, 700); // 자동 리로드(in-place) — 갱신된 페르소나 바로 보이게, 첫화면 튕김 없음
      } else {
        if (regenMsg) { regenMsg.textContent = `${pick("재적용 안 됨: ", "Not re-applied: ")}${(j.skipped ?? []).join(", ") || j.error || pick("변경 없음", "no changes")}`; regenMsg.className = "text-[11px] text-txt-amber"; }
        _busy();
      }
    } catch (e) {
      if (regenMsg) { regenMsg.textContent = pick("실패: ", "Failed: ") + (e as Error).message; regenMsg.className = "text-[11px] text-txt-red"; }
      _busy();
    }
  });

  // 🔁 재시작 — 런타임 재시작(새 페르소나 로드). 성공 시 자동 리로드.
  const restartBtn = root.querySelector<HTMLButtonElement>("#cfg-restart");
  restartBtn?.addEventListener("click", async () => {
    const gwNote = GATEWAY_RESTART_NOTE[agent.runtime];
    if (!confirm(pick(`${agent.display_name} 런타임을 재시작할까요? (새 페르소나/상태 로드${gwNote ? `.${gwNote.ko}` : ""})`, `Restart the ${agent.display_name} runtime? (loads new persona/state${gwNote ? `.${gwNote.en}` : ""})`))) return;
    const _busy = setBtnBusy(restartBtn, pick("⏳ 재시작 중…", "⏳ Restarting…"));
    if (regenMsg) { regenMsg.textContent = pick(`${agent.display_name} 재시작 중…`, `Restarting ${agent.display_name}…`); regenMsg.className = "text-[11px] text-slate-400"; }
    try {
      const res = await fetch(`${apiBase()}/api/members/${encodeURIComponent(agent.id)}/restart`, { method: "POST", headers: { "Content-Type": "application/json" } });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: string };
      if (regenMsg) { regenMsg.textContent = (j.ok ? pick("🔁 재시작됨 — ", "🔁 Restarted — ") : pick("⚠ 실패 — ", "⚠ Failed — ")) + (j.detail ?? ""); regenMsg.className = j.ok ? "text-[11px] text-txt-blue" : "text-[11px] text-txt-red"; }
    } catch (e) {
      if (regenMsg) { regenMsg.textContent = pick("실패: ", "Failed: ") + (e as Error).message; regenMsg.className = "text-[11px] text-txt-red"; }
    }
    _busy();
  });

  // 🧹 완전 재시작 — 세션 컨텍스트(기억) 완전 비움 + 콜드 스타트(--fresh). 되돌릴 수 없는 작업이라 명시 경고.
  const restartFreshBtn = root.querySelector<HTMLButtonElement>("#cfg-restart-fresh");
  restartFreshBtn?.addEventListener("click", async () => {
    if (!confirm(pick(`${agent.display_name}을(를) 완전 재시작할까요?\n\n⚠ 이 팀원의 대화 컨텍스트(그동안의 기억)가 완전히 비워지고, 새 CLAUDE.md로 콜드 스타트합니다.\n진행 중이던 작업 맥락이 사라집니다. 되돌릴 수 없습니다.`, `Fully restart ${agent.display_name}?\n\n⚠ This member's conversation context (all memory so far) will be completely wiped, and it will cold-start with the new CLAUDE.md.\nThe context of any in-progress work is lost. This cannot be undone.`))) return;
    const _busy = setBtnBusy(restartFreshBtn, pick("⏳ 완전 재시작 중…", "⏳ Full restarting…"));
    if (regenMsg) { regenMsg.textContent = pick(`${agent.display_name} 완전 재시작 중… (컨텍스트 비움)`, `Fully restarting ${agent.display_name}… (wiping context)`); regenMsg.className = "text-[11px] text-slate-400"; }
    try {
      const res = await fetch(`${apiBase()}/api/members/${encodeURIComponent(agent.id)}/restart`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fresh: true }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: string };
      if (regenMsg) { regenMsg.textContent = (j.ok ? pick("🧹 완전 재시작됨 — ", "🧹 Fully restarted — ") : pick("⚠ 실패 — ", "⚠ Failed — ")) + (j.detail ?? ""); regenMsg.className = j.ok ? "text-[11px] text-txt-blue" : "text-[11px] text-txt-red"; }
    } catch (e) {
      if (regenMsg) { regenMsg.textContent = pick("실패: ", "Failed: ") + (e as Error).message; regenMsg.className = "text-[11px] text-txt-red"; }
    }
    _busy();
  });

  // 🔴 정지 / 🟢 기동 — 서킷브레이커. 성공 시 자동 리로드(버튼 상태 갱신).
  const onoffBtn = root.querySelector<HTMLButtonElement>("#cfg-onoff");
  onoffBtn?.addEventListener("click", async () => {
    const want = data.off === true; // off면 기동(true), on이면 정지(false)
    if (!confirm(pick(`${agent.display_name}을(를) ${want ? "기동" : "정지"}할까요?`, `${want ? "Start" : "Stop"} ${agent.display_name}?`))) return;
    onoffBtn.disabled = true;
    if (regenMsg) { regenMsg.textContent = pick(`${agent.display_name} ${want ? "기동" : "정지"} 중…`, `${want ? "Starting" : "Stopping"} ${agent.display_name}…`); regenMsg.className = "text-[11px] text-slate-400"; }
    try {
      const res = await fetch(`${apiBase()}/api/members/${encodeURIComponent(agent.id)}/enabled`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: want }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: string };
      if (regenMsg) { regenMsg.textContent = (j.ok ? "✓ " : pick("⚠ 실패 — ", "⚠ Failed — ")) + (j.detail ?? ""); regenMsg.className = j.ok ? "text-[11px] text-accent-greenSoft" : "text-[11px] text-txt-red"; }
      if (j.ok) setTimeout(reload, 700); // 상태 바뀐 버튼 갱신
      else onoffBtn.disabled = false;
    } catch (e) {
      if (regenMsg) { regenMsg.textContent = pick("실패: ", "Failed: ") + (e as Error).message; regenMsg.className = "text-[11px] text-txt-red"; }
      onoffBtn.disabled = false;
    }
  });

  saveBtn?.addEventListener("click", async () => {
    if (!textarea) return;
    saveBtn.disabled = true;
    if (statusEl) {
      statusEl.textContent = pick("저장 중… (agents.json + 런타임 파일 재생성)", "Saving… (agents.json + regenerating runtime file)");
      statusEl.className = "text-[11px] mt-1.5 text-slate-400";
    }
    try {
      // 멘션명 검증 먼저 — 형식 오류면 저장 중단(role·persona 도 안 씀).
      const nk = parseNicknames();
      if ("error" in nk) {
        if (statusEl) { statusEl.textContent = `✗ ${nk.error}`; statusEl.className = "text-[11px] mt-1.5 text-status-blocked"; }
        return;
      }
      // ① 멘션명 저장(PATCH /members/:id) — profile POST 보다 먼저. 둘 다 agents.json read-modify-write 라
      //    순차 필수(병렬이면 lost update). PATCH 가 먼저 쓰면 profile POST 가 그 결과를 읽어 role 갱신 → 멘션명 보존.
      const nickRes = await fetch(`${apiBase()}/api/members/${encodeURIComponent(agent.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nicknames: nk.nicknames }),
      });
      if (!nickRes.ok) {
        const err = (await nickRes.json().catch(() => ({}))) as { error?: string; hint?: string };
        if (statusEl) { statusEl.textContent = `${pick("✗ 멘션명 실패: ", "✗ Mention names failed: ")}${err.hint ?? err.error ?? nickRes.status}`; statusEl.className = "text-[11px] mt-1.5 text-status-blocked"; }
        return;
      }
      // ② 역할·페르소나 저장(POST /profile) — agents.json(멘션명 반영본) 읽어 role 갱신 + 런타임 로딩파일 자동 재생성.
      const res = await fetch(`${apiBase()}/api/members/${encodeURIComponent(agent.id)}/profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: roleInput?.value ?? agent.role, persona: textarea.value }),
      });
      if (res.ok) {
        await res.json().catch(() => ({})); // 응답 소비. '0개 파일 재생성' 문구 제거 — SOUL 저장돼도 로딩파일 렌더가 동일하면 0으로 떠 실패처럼 읽혔음(PR#1 04f7713).
        if (statusEl) {
          statusEl.textContent = pick(`✓ 저장됨 (역할·페르소나·멘션명) — 재시작하면 반영`, `✓ Saved (role · persona · mention names) — restart to apply`);
          statusEl.className = "text-[11px] mt-1.5 text-accent-greenSoft";
        }
      } else {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        if (statusEl) {
          statusEl.textContent = `${pick("✗ 실패: ", "✗ Failed: ")}${err.error ?? res.status}`;
          statusEl.className = "text-[11px] mt-1.5 text-status-blocked";
        }
      }
    } catch (e) {
      if (statusEl) {
        statusEl.textContent = `${pick("✗ 오류: ", "✗ Error: ")}${String(e)}`;
        statusEl.className = "text-[11px] mt-1.5 text-status-blocked";
      }
    } finally {
      saveBtn.disabled = false;
    }
  });

  // 봇 토큰 변경 — 서버가 getMe 검증→저장→브릿지 재시작. 시크릿 input은 전송 후 즉시 클리어(화면·로그 잔존 방지).
  const tokenInput = root.querySelector<HTMLInputElement>("#cfg-token");
  const tokenBtn = root.querySelector<HTMLButtonElement>("#cfg-token-submit");
  const tokenMsg = root.querySelector<HTMLElement>("#cfg-token-msg");
  const setTokenMsg = (cls: string, text: string) => { if (tokenMsg) { tokenMsg.className = `text-[12px] mt-2 leading-snug ${cls}`; tokenMsg.textContent = text; } };
  tokenBtn?.addEventListener("click", async () => {
    const token = tokenInput?.value.trim() ?? "";
    if (!token) { setTokenMsg("text-txt-red", pick("토큰을 입력하세요.", "Enter a token.")); return; }
    // 엉뚱한 팀원에게 적용 방지 — 팀원명 크게 노출한 확인창(GD 2026-07-01).
    if (!(await confirmModal(pick(
      `<b class="text-base text-slate-100">${escape(agent.display_name)}</b> 의 봇 토큰을 바꾸시겠습니까?<div class="text-[12px] text-slate-500 mt-1">이 팀원의 봇을 새 토큰으로 다시 연결합니다.</div>`,
      `Change <b class="text-base text-slate-100">${escape(agent.display_name)}</b>'s bot token?<div class="text-[12px] text-slate-500 mt-1">Reconnects this member's bot with the new token.</div>`)))) { if (tokenInput) tokenInput.value = ""; return; }
    if (tokenBtn) tokenBtn.disabled = true;
    setTokenMsg("text-slate-400", pick("검증 중…", "Verifying…"));
    try {
      const res = await fetch(`${apiBase()}/api/members/${encodeURIComponent(agent.id)}/rotate-token`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bot_token: token }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; bot_username?: string; detail?: string; error?: string; hint?: string; warning?: string };
      if (tokenInput) tokenInput.value = ""; // 시크릿 즉시 클리어
      if (res.ok && j.ok) {
        const warn = j.warning ? ` · ⚠ ${escape(String(j.warning))}` : ""; // 예: openclaw 전체재시작 안내(Bill 백엔드 계약)
        setTokenMsg("text-accent-greenSoft", `✅ @${escape(String(j.bot_username ?? ""))} ${pick("확인 — 적용됨", "verified — applied")}${j.detail ? ` · ${escape(String(j.detail))}` : ""}${warn}`);
      } else {
        setTokenMsg("text-txt-red", `❌ ${escape(String(j.detail ?? j.hint ?? j.error ?? "HTTP " + res.status))}`); // detail=fail-safe 메시지('기존 유지' 등) 우선(Bill 계약)
      }
    } catch (e) {
      if (tokenInput) tokenInput.value = "";
      setTokenMsg("text-txt-red", `❌ ${pick("오류: ", "Error: ")}${(e as Error).message}`);
    } finally {
      if (tokenBtn) tokenBtn.disabled = false;
    }
  });

  // 런타임 교체(swap-runtime): target 선택 + 이름 정확 입력 시에만 버튼 활성 → POST /api/members/:id/swap-runtime
  // {target_runtime, confirm_name}. 백엔드(swapRuntime, activation.ts)가 메모리(MEMORY.md 등)는 건드리지 않고
  // 런타임만 교체 — offboard(퇴사)와 달리 워크스페이스를 archive하지 않는다.
  const swapTargetSel = root.querySelector<HTMLSelectElement>("#cfg-swap-target");
  const swapConfirm = root.querySelector<HTMLInputElement>("#cfg-swap-confirm");
  const swapBtn = root.querySelector<HTMLButtonElement>("#cfg-swap-submit");
  const swapMsg = root.querySelector<HTMLElement>("#cfg-swap-msg");
  const swapStepsEl = root.querySelector<HTMLElement>("#cfg-swap-steps");
  const updateSwapBtnState = () => {
    if (!swapBtn) return;
    const hasTarget = !!swapTargetSel?.value;
    const nameOk = (swapConfirm?.value.trim() ?? "") === agent.display_name;
    swapBtn.disabled = !(hasTarget && nameOk);
  };
  swapTargetSel?.addEventListener("change", updateSwapBtnState);
  swapConfirm?.addEventListener("input", updateSwapBtnState);
  const renderSwapSteps = (steps: SwapStepRes[] | undefined) => {
    if (!swapStepsEl) return;
    if (!steps || steps.length === 0) { swapStepsEl.innerHTML = ""; return; }
    swapStepsEl.innerHTML = steps
      .map((s) => `<div class="text-[11px] ${s.ok ? "text-slate-400" : "text-txt-red"}">${s.ok ? "✓" : "✗"} <span class="font-mono">${escape(s.step)}</span> — ${escape(s.detail)}</div>`)
      .join("");
  };
  swapBtn?.addEventListener("click", async () => {
    const target = swapTargetSel?.value ?? "";
    const confirmName = swapConfirm?.value.trim() ?? "";
    if (!target || confirmName !== agent.display_name) return;
    // 파괴적 작업(런타임 정지→재기동) — 팀원명 크게 노출한 확인창(offboard/토큰변경과 동일 패턴, GD 2026-07-01 관례).
    if (!(await confirmModal(pick(
      `<b class="text-base text-slate-100">${escape(agent.display_name)}</b> 의 런타임을 <b class="text-txt-amber">${escape(runtimeLabel(agent.runtime))} → ${escape(runtimeLabel(target))}</b> 로 교체할까요?<div class="text-[12px] text-slate-500 mt-1">런타임을 정지했다 재기동합니다. 진행 중 작업이 있으면 중단될 수 있습니다. 메모리는 보존됩니다.</div>`,
      `Swap <b class="text-base text-slate-100">${escape(agent.display_name)}</b>'s runtime from <b class="text-txt-amber">${escape(runtimeLabel(agent.runtime))} → ${escape(runtimeLabel(target))}</b>?<div class="text-[12px] text-slate-500 mt-1">This stops and restarts the runtime. In-progress work may be interrupted. Memory is preserved.</div>`),
      { danger: true, okLabel: pick("교체", "Swap") }))) return;
    const _busy = setBtnBusy(swapBtn, pick("⏳ 교체 중…", "⏳ Swapping…"));
    if (swapMsg) { swapMsg.textContent = pick("런타임 교체 중… (정지→레지스트리 갱신→재기동)", "Swapping runtime… (stop → registry update → restart)"); swapMsg.className = "text-[12px] mt-2 leading-snug text-slate-400"; }
    renderSwapSteps(undefined);
    try {
      const res = await fetch(`${apiBase()}/api/members/${encodeURIComponent(agent.id)}/swap-runtime`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_runtime: target, confirm_name: confirmName }),
      });
      const j = (await res.json().catch(() => ({ ok: false }))) as SwapRuntimeResponse;
      renderSwapSteps(j.steps);
      if (j.ok) {
        if (swapMsg) { swapMsg.textContent = pick("✅ 교체 완료 (메모리 보존됨) — 자동 새로고침…", "✅ Swap complete (memory preserved) — auto refreshing…"); swapMsg.className = "text-[12px] mt-2 leading-snug text-accent-greenSoft"; }
        // 사이드바 등 다른 뷰의 런타임 배지도 즉시 갱신 — WS member 이벤트가 없어 store를 직접 갱신(offboard의 setAgents 패턴과 동일).
        const st = store.getState();
        st.setAgents(st.agents.map((a) => (a.id === agent.id ? { ...a, runtime: target as Agent["runtime"] } : a)));
        setTimeout(reload, 700); // in-place 재로드 — 배지·registry 표가 서버 진실(status_provider 등 포함)로 갱신됨
      } else if (j.code === "preflight_blocked") {
        // ★대상 런타임 미설치/미인증 — 대시보드가 대신 설치 시도 안 함(self-mod·할루시 위험). fixHint를 그대로 노출.
        if (swapMsg) {
          swapMsg.innerHTML = `<div class="px-2 py-1.5 rounded border border-status-blocked/50 bg-status-blocked/10 text-status-blocked">⚠ ${escape(j.error ?? "preflight blocked")}</div><div class="text-slate-500 mt-1">${pick("이 서버 터미널에서 위 조치 후 다시 시도하세요.", "Take the action above on this server's terminal, then try again.")}</div>`;
          swapMsg.className = "text-[12px] mt-2 leading-snug";
        }
        _busy();
      } else {
        const label: Record<string, string> = {
          confirm_name_mismatch: pick("이름이 정확히 일치하지 않습니다.", "The name doesn't match exactly."),
          invalid_runtime: pick("허용되지 않는 런타임입니다.", "That runtime isn't allowed."),
          execution_off: pick("실행이 꺼져 있습니다(팀장 인가 필요).", "Execution is off (team lead authorization required)."),
          unknown_member: pick("팀원을 찾을 수 없습니다.", "Member not found."),
          no_op: pick("이미 해당 런타임입니다.", "Already on that runtime."),
          base_hermes_guard: pick("공유 base hermes 프로필은 교체 대상이 아닙니다.", "The shared base hermes profile can't be swapped."),
          registry_write_failed: pick("레지스트리 갱신 실패 — 수동 확인이 필요할 수 있습니다.", "Registry update failed — may need manual verification."),
          activate_failed: pick("신규 런타임 활성화 실패 — 자동 복구를 시도했습니다(steps 확인).", "New runtime activation failed — auto-recovery was attempted (see steps)."),
        };
        const code = j.code ?? j.error ?? "";
        const text = j.hint ?? label[code] ?? j.error ?? `HTTP ${res.status}`;
        if (swapMsg) { swapMsg.textContent = `❌ ${text}`; swapMsg.className = "text-[12px] mt-2 leading-snug text-txt-red"; }
        _busy();
      }
    } catch (e) {
      if (swapMsg) { swapMsg.textContent = `❌ ${pick("오류: ", "Error: ")}${(e as Error).message}`; swapMsg.className = "text-[12px] mt-2 leading-snug text-txt-red"; }
      _busy();
    }
  });

  // 퇴사(offboard): 이름 정확 입력 시에만 버튼 활성 → DELETE /api/members/:id {confirm_name}
  const offConfirm = root.querySelector<HTMLInputElement>("#cfg-offboard-confirm");
  const offBtn = root.querySelector<HTMLButtonElement>("#cfg-offboard");
  const offMsg = root.querySelector<HTMLElement>("#cfg-offboard-msg");
  offConfirm?.addEventListener("input", () => {
    if (offBtn) offBtn.disabled = offConfirm.value.trim() !== agent.display_name;
  });
  offBtn?.addEventListener("click", async () => {
    // 이름-타이핑 가드에 더해 명시적 확인창 — 엉뚱한 팀원 퇴사 방지, 팀원명 크게(GD 2026-07-01).
    if (!(await confirmModal(pick(
      `정말 <b class="text-base text-slate-100">${escape(agent.display_name)}</b> 을(를) 퇴사시키겠습니까?<div class="text-[12px] text-slate-500 mt-1">팀원 목록에서 지우고, 지금까지 등록·진행한 내용을 정리합니다.</div>`,
      `Really offboard <b class="text-base text-slate-100">${escape(agent.display_name)}</b>?<div class="text-[12px] text-slate-500 mt-1">Removes them from the team and clears what was set up so far.</div>`), { danger: true, okLabel: pick("퇴사", "Offboard") }))) return;
    offBtn.disabled = true;
    if (offMsg) {
      // openclaw는 게이트웨이 정리(bootout+프로필 제거)로 퇴사가 더 오래 걸림 → 눈에 띄게 안내(GD 2026-07-02).
      offMsg.textContent = agent.runtime === "openclaw"
        ? pick("⏳ 퇴사 처리 중… 오픈클로 팀원은 게이트웨이 정리로 조금 더 걸립니다…", "⏳ Offboarding… OpenClaw members take a bit longer (gateway cleanup)…")
        : pick("퇴사 처리 중…", "Offboarding…");
      offMsg.className = agent.runtime === "openclaw" ? "text-[12px] mt-2 text-txt-amber" : "text-[12px] mt-2 text-slate-400";
    }
    try {
      const res = await fetch(`${apiBase()}/api/members/${agent.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm_name: offConfirm?.value.trim() ?? "" }),
      });
      if (res.ok) {
        if (offMsg) { offMsg.textContent = pick(`✓ ${escape(agent.display_name)} 퇴사 처리됨`, `✓ ${escape(agent.display_name)} offboarded`); offMsg.className = "text-[12px] mt-2 text-accent-greenSoft"; }
        const st = store.getState();
        st.setAgents(st.agents.filter((a) => a.id !== agent.id)); // roster에서 즉시 제거 — DELETE가 ws broadcast를 안 해서 새로고침 전까지 stale했던 버그 fix
        st.selectAgent(null);     // 레지스트리에서 제거됨 → 팀 설정(roster)로 이동
        st.setMainView("settings");
      } else {
        const err = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
        if (offMsg) { offMsg.textContent = `✗ ${err.hint ?? err.error ?? res.status}`; offMsg.className = "text-[12px] mt-2 text-status-blocked"; }
        offBtn.disabled = false;
      }
    } catch (e) {
      if (offMsg) { offMsg.textContent = `${pick("✗ 오류: ", "✗ Error: ")}${String(e)}`; offMsg.className = "text-[12px] mt-2 text-status-blocked"; }
      offBtn.disabled = false;
    }
  });

  // 아이콘 교체 → 아이콘 클릭 시 피커 펼침 → 선택 시 PATCH /api/members/:id {icon} (대시보드 곳곳 반영)
  const iconBtn = root.querySelector<HTMLButtonElement>("#cfg-icon-btn");
  const iconPicker = root.querySelector<HTMLElement>("#cfg-icon-picker");
  const iconMsg = root.querySelector<HTMLElement>("#cfg-icon-msg");
  // 아이콘 JPG 다운로드 (텔레그램 BotFather·슬랙 아바타 업로드용 — 512px, 배경+글리프)
  const iconDl = root.querySelector<HTMLButtonElement>("#cfg-icon-dl");
  iconDl?.addEventListener("click", async () => {
    try {
      if (iconMsg) { iconMsg.textContent = pick("JPG 생성 중…", "Generating JPG…"); iconMsg.className = "text-[11px] text-slate-400 ml-2 align-middle"; }
      const result = await downloadAgentIconJpg(agent.id, agent.icon || agentIconName(agent.id));
      if (iconMsg && result === "cancelled") {
        iconMsg.textContent = pick("JPG 저장 취소됨", "JPG save cancelled");
        iconMsg.className = "text-[11px] text-slate-400 ml-2 align-middle";
      } else if (iconMsg) {
        iconMsg.textContent = pick(`${agent.id}-icon.jpg 다운로드됨`, `${agent.id}-icon.jpg downloaded`);
        iconMsg.className = "text-[11px] text-accent-greenSoft ml-2 align-middle";
      }
    } catch (e) {
      if (iconMsg) { iconMsg.textContent = pick("JPG 생성 실패: ", "JPG generation failed: ") + (e as Error).message; iconMsg.className = "text-[11px] text-txt-red ml-2 align-middle"; }
    }
  });
  // 현재 선택 상태(아이콘 버튼을 색+아이콘 함께 다시 그릴 때 사용)
  let selIcon = currentIcon;
  let selColor = currentColor;
  const choiceCls = (sel: boolean) =>
    `w-8 h-8 inline-flex items-center justify-center rounded-md border ${sel ? "border-accent-green text-accent-green" : "border-surface-3 text-slate-400 hover:border-accent-green hover:text-accent-greenSoft"}`;
  const iconChoices = root.querySelector<HTMLElement>("#cfg-icon-choices");
  if (iconBtn && iconPicker && iconChoices) {
    iconChoices.innerHTML = ICON_CHOICES.map(
      (name) => `<button type="button" data-icon="${name}" title="${name}" class="${choiceCls(name === currentIcon)}">${renderIcon(name, { size: 18 })}</button>`,
    ).join("");
    iconBtn.addEventListener("click", () => iconPicker.classList.toggle("hidden"));
    iconPicker.querySelectorAll<HTMLButtonElement>("[data-icon]").forEach((b) => {
      b.addEventListener("click", async () => {
        const name = b.dataset.icon;
        if (!name) return;
        if (iconMsg) { iconMsg.textContent = pick("저장 중…", "Saving…"); iconMsg.className = "text-[11px] text-slate-400 ml-2 align-middle"; }
        try {
          const res = await fetch(`${apiBase()}/api/members/${agent.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ icon: name }),
          });
          if (res.ok) {
            selIcon = name;
            iconBtn.innerHTML = renderAgentIcon(selIcon, selColor, 18);
            iconPicker.querySelectorAll<HTMLButtonElement>("[data-icon]").forEach((x) => { x.className = choiceCls(x.dataset.icon === name); });
            if (iconMsg) { iconMsg.textContent = pick("✓ 변경됨", "✓ Changed"); iconMsg.className = "text-[11px] text-accent-greenSoft ml-2 align-middle"; }
            iconPicker.classList.add("hidden");
          } else {
            const err = (await res.json().catch(() => ({}))) as { error?: string };
            if (iconMsg) { iconMsg.textContent = `✗ ${err.error ?? res.status}`; iconMsg.className = "text-[11px] text-status-blocked ml-2 align-middle"; }
          }
        } catch (e) {
          if (iconMsg) { iconMsg.textContent = `✗ ${String(e)}`; iconMsg.className = "text-[11px] text-status-blocked ml-2 align-middle"; }
        }
      });
    });
  }

  // 아이콘 색 스와치 — 클릭 시 PATCH /api/members/:id {icon_color} (대시보드 곳곳 반영)
  const colorPicker = root.querySelector<HTMLElement>("#cfg-color-picker");
  const swatchCls = (sel: boolean) =>
    `w-7 h-7 inline-flex items-center justify-center rounded-full border-2 transition-colors ${sel ? "border-slate-100" : "border-transparent hover:border-slate-500"}`;
  if (colorPicker) {
    colorPicker.innerHTML = AGENT_ICON_COLORS.map(
      (c) => `<button type="button" data-color="${c.key}" title="${c.label}" class="${swatchCls(c.key === selColor)}"><span class="w-4 h-4 rounded-full" style="background:${iconColorHex(c.key) ?? "#34d399"}"></span></button>`,
    ).join("");
    colorPicker.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((b) => {
      b.addEventListener("click", async () => {
        const key = b.dataset.color;
        if (!key) return;
        if (iconMsg) { iconMsg.textContent = pick("색 저장 중…", "Saving color…"); iconMsg.className = "text-[11px] text-slate-400 ml-2 align-middle"; }
        try {
          const res = await fetch(`${apiBase()}/api/members/${agent.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ icon_color: key }),
          });
          if (res.ok) {
            selColor = key;
            if (iconBtn) iconBtn.innerHTML = renderAgentIcon(selIcon, selColor, 18);
            colorPicker.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((x) => { x.className = swatchCls(x.dataset.color === key); });
            if (iconMsg) { iconMsg.textContent = pick("✓ 색 변경됨", "✓ Color changed"); iconMsg.className = "text-[11px] text-accent-greenSoft ml-2 align-middle"; }
          } else {
            const err = (await res.json().catch(() => ({}))) as { error?: string };
            if (iconMsg) { iconMsg.textContent = `✗ ${err.error ?? res.status}`; iconMsg.className = "text-[11px] text-status-blocked ml-2 align-middle"; }
          }
        } catch (e) {
          if (iconMsg) { iconMsg.textContent = `✗ ${String(e)}`; iconMsg.className = "text-[11px] text-status-blocked ml-2 align-middle"; }
        }
      });
    });
  }
}
