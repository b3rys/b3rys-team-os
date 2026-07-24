// AgentSlack — 팀원별 Slack 연동 섹션 + 연동 마법사 (AgentConfig에서 mount).
// 자동(서버): 상태조회·토큰저장·연결검증(test-post)·재설치 프리필(reinstall-info)·해제(revoke).
// 수동(사람이 Slack에서): 앱 생성(manifest 복붙)·설치/승인·토큰복사·채널초대·Event URL 등록 — 마법사가 복붙만 하게 안내.
// '죽은 앱'=account_inactive → 앱 재설치 필요(토큰 갱신만으론 복구 불가, Bill 진단).
// 시크릿 위생: 토큰/secret은 화면 표시 X, 전송 후 즉시 input clear.
// 엔드포인트(Bill 3e63cca): GET /slack/status · POST /members/:id/slack · POST /slack/test-post{channel?,text?}→{ok,hint}
//   · GET /slack/reinstall-info → {manifest,event_request_url,needed_scopes,...} · POST /slack/revoke{keep_identity?}
import { apiBase } from "../ws";
import { setBtnBusy } from "./Settings";
import { renderIcon } from "../icons";
import { pick } from "../i18n";
import { showAlert, showConfirm } from "./dialogs";

const inputCls = "w-full bg-surface-0 border border-surface-3 rounded-lg text-sm text-slate-200 px-3 py-2.5 outline-none focus:border-accent-green/40 placeholder:text-slate-600";
const labelCls = "block text-[13px] font-medium text-slate-300 mb-1.5";
const btnPrimary = "text-[13px] font-semibold px-4 py-2 rounded-lg bg-accent-btn text-accent-on hover:bg-accent-btnHover transition-colors disabled:opacity-50";
const btnGhost = "text-[13px] font-medium px-3.5 py-2 rounded-lg border border-surface-3 bg-surface-2 text-slate-300 hover:text-slate-100 hover:border-accent-green/40 transition-colors";
const copyCls = "shrink-0 text-[11px] font-medium px-2 py-1 rounded border border-surface-3 bg-surface-2 text-slate-400 hover:text-slate-100 hover:border-accent-green/40 transition-colors";

interface SlackMember {
  id: string; display_name: string;
  slack_bot_user_id: string | null; slack_app_name: string | null;
  state: "ready" | "partial" | "not_connected";
  has_identity: boolean; has_token: boolean; supports_bot_mentions: boolean;
  slack_connection_mode?: "webhook" | "socket"; has_app_token?: boolean; socket_ready?: boolean;
}
interface ReinstallInfo {
  ok: boolean; id: string; display_name: string;
  slack_app_name: string | null; slack_app_id: string | null; slack_bot_user_id: string | null;
  state: string; event_request_url: string; channel: string;
  needed_scopes: string[]; manifest: unknown;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function stateBadge(state: string): string {
  if (state === "ready") return `<span class="inline-flex items-center gap-1 text-[12px] font-semibold text-accent-greenSoft"><span class="h-1.5 w-1.5 rounded-full bg-accent-green"></span>${pick("연동됨", "Connected")}</span>`;
  if (state === "partial") return `<span class="inline-flex items-center gap-1 text-[12px] font-semibold text-txt-amber"><span class="h-1.5 w-1.5 rounded-full bg-txt-amber"></span>${pick("부분 설정", "Partial setup")}</span>`;
  return `<span class="inline-flex items-center gap-1 text-[12px] font-semibold text-slate-500"><span class="h-1.5 w-1.5 rounded-full bg-slate-600"></span>${pick("미연동", "Not connected")}</span>`;
}

// 복사 가능한 한 줄(값은 truncate, 복사 버튼). data-copy에 실제 복사값.
function copyRow(label: string, value: string, mono = true): string {
  return `
    <div class="flex items-center gap-2 mb-1.5">
      <span class="text-[12px] text-slate-500 w-24 shrink-0">${esc(label)}</span>
      <code class="flex-1 min-w-0 truncate text-[12px] ${mono ? "font-mono" : ""} text-slate-300 bg-surface-0 border border-surface-3 rounded px-2 py-1.5">${esc(value)}</code>
      <button class="sl-copy ${copyCls}" data-copy="${esc(value)}">${pick("복사", "Copy")}</button>
    </div>`;
}

async function clip(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

// Socket Mode용 매니페스트 변환 — socket_mode_enabled=true + event_subscriptions.request_url 제거(공개 URL 불필요).
function socketManifest(manifest: unknown): unknown {
  try {
    const m = JSON.parse(JSON.stringify(manifest ?? {})) as Record<string, any>;
    m.settings = m.settings || {};
    m.settings.socket_mode_enabled = true;
    if (m.settings.event_subscriptions) delete m.settings.event_subscriptions.request_url;
    return m;
  } catch {
    return manifest;
  }
}

export function renderAgentSlack(host: HTMLElement, agentId: string, _displayName: string): void {
  let open = false;
  let me: SlackMember | null = null;
  let info: ReinstallInfo | null = null;
  let infoLoading = false;
  // 마법사 안에서 고르는 연결 방식(로컬). 저장 시 slack_connection_mode로 persist.
  // 마법사 열 때 현재 persist된 방식으로 초기화. (메인 화면엔 토글 없음 — 방식 선택은 마법사 안에서만)
  let wizardMode: "webhook" | "socket" = "webhook";

  const fetchStatus = async (): Promise<SlackMember | null> => {
    try {
      const r = await fetch(`${apiBase()}/api/slack/status`, { headers: { accept: "application/json" } });
      const d = await r.json();
      return (d.members ?? []).find((m: SlackMember) => m.id === agentId) ?? null;
    } catch { return null; }
  };

  const loadInfo = async () => {
    infoLoading = true;
    try {
      const r = await fetch(`${apiBase()}/api/members/${encodeURIComponent(agentId)}/slack/reinstall-info`, { headers: { accept: "application/json" } });
      info = await r.json();
    } catch { info = null; }
    infoLoading = false;
    render();
  };

  const wizardHtml = (): string => {
    if (infoLoading || !info) return `<div class="rounded-lg border border-surface-3 bg-surface-0/40 p-3.5 text-[12px] text-slate-500">${pick("설정 정보 불러오는 중…", "Loading settings…")}</div>`;
    const isSocket = wizardMode === "socket";
    const manifestStr = JSON.stringify(isSocket ? socketManifest(info.manifest) : (info.manifest ?? {}), null, 2);
    const scopes = (info.needed_scopes ?? []).join(", ");
    const channel = info.channel || "#300-gd-ai-team";
    const appLink = `<a class="text-accent-greenSoft underline" href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noopener">api.slack.com/apps</a>`;

    const steps = isSocket
      ? [
          pick(
            `Slack 앱 생성: ${appLink} → <b>From a manifest</b> → 워크스페이스 선택 → 아래 <b>매니페스트</b> 붙여넣기. <span class="text-slate-500">(Socket Mode 켜진 매니페스트 — 공개 URL 불필요)</span>`,
            `Create the Slack app: ${appLink} → <b>From a manifest</b> → select a workspace → paste the <b>manifest</b> below. <span class="text-slate-500">(manifest with Socket Mode on — no public URL needed)</span>`),
          pick(
            `<b>Install to Workspace</b> → Allow (권한 승인). 필요 scope: <code>${esc(scopes || "—")}</code>.`,
            `<b>Install to Workspace</b> → Allow (approve permissions). Scopes needed: <code>${esc(scopes || "—")}</code>.`),
          pick(
            `<b>Basic Information</b> → <b>App-Level Tokens</b> → Generate Token → scope <code>connections:write</code> 추가 → <b>App-Level Token</b>(<code>xapp-…</code>) 복사.`,
            `<b>Basic Information</b> → <b>App-Level Tokens</b> → Generate Token → add scope <code>connections:write</code> → copy the <b>App-Level Token</b>(<code>xapp-…</code>).`),
          pick(
            `<b>OAuth & Permissions</b> → <b>Bot User OAuth Token</b>(<code>xoxb-…</code>) 복사 → 아래 폼에 <b>xoxb</b>·<b>xapp</b> 붙여넣기.`,
            `<b>OAuth & Permissions</b> → copy the <b>Bot User OAuth Token</b>(<code>xoxb-…</code>) → paste <b>xoxb</b> and <b>xapp</b> into the form below.`),
          pick(
            `봇을 <b>${esc(channel)}</b>에 초대: <code>/invite @봇이름</code>.`,
            `Invite the bot to <b>${esc(channel)}</b>: <code>/invite @botname</code>.`),
        ]
      : [
          pick(
            `Slack 앱 생성: ${appLink} → <b>From a manifest</b> → 워크스페이스 선택 → 아래 <b>매니페스트</b> 붙여넣기.`,
            `Create the Slack app: ${appLink} → <b>From a manifest</b> → select a workspace → paste the <b>manifest</b> below.`),
          pick(
            `<b>Install to Workspace</b> → Allow (권한 승인). 필요 scope: <code>${esc(scopes || "—")}</code>.`,
            `<b>Install to Workspace</b> → Allow (approve permissions). Scopes needed: <code>${esc(scopes || "—")}</code>.`),
          pick(
            `<b>Bot User OAuth Token</b>(<code>xoxb-…</code>)과 <b>Signing Secret</b> 복사 → 아래 폼에 붙여넣기.`,
            `Copy the <b>Bot User OAuth Token</b>(<code>xoxb-…</code>) and <b>Signing Secret</b> → paste into the form below.`),
          pick(
            `봇을 <b>${esc(channel)}</b>에 초대: <code>/invite @봇이름</code>.`,
            `Invite the bot to <b>${esc(channel)}</b>: <code>/invite @botname</code>.`),
          pick(
            `Event Subscriptions Request URL = 아래 값 등록 + <code>app_mention</code> 구독 (URL은 우리 서버 고정 주소 — 매니페스트에 이미 포함, 붙여넣으면 바로 Verified).`,
            `Event Subscriptions Request URL = register the value below + subscribe to <code>app_mention</code> (the URL is our server's fixed address — already in the manifest, so it turns Verified as soon as you paste it).`),
        ];

    const copyRows = isSocket
      ? copyRow(pick("채널", "Channel"), channel, false)
      : copyRow("Event URL", info.event_request_url || "—") + copyRow(pick("채널", "Channel"), channel, false);

    const tokenInputs = isSocket
      ? `<div class="mb-2.5"><label class="${labelCls}">Bot Token <span class="text-slate-600">(xoxb-…)</span></label>
           <input class="sl-pf ${inputCls}" data-key="slack_bot_token" type="password" autocomplete="off" spellcheck="false" placeholder="xoxb-…" /></div>
         <div class="mb-2.5"><label class="${labelCls}">App-Level Token <span class="text-slate-600">(xapp-… · ${pick("Socket Mode 필수", "required for Socket Mode")})</span></label>
           <input class="sl-pf ${inputCls}" data-key="slack_app_token" type="password" autocomplete="off" spellcheck="false" placeholder="xapp-…" />
           <div class="text-[11px] text-slate-500 mt-1">${me?.has_app_token ? pick("저장된 App Token 있음 ✓ (바꾸려면 새 값 입력)", "App Token saved ✓ (enter a new value to change)") : pick("Socket Mode에 필요 — connections:write scope", "needed for Socket Mode — connections:write scope")}</div></div>`
      : `<div class="mb-2.5"><label class="${labelCls}">Bot Token <span class="text-slate-600">(xoxb-…)</span></label>
           <input class="sl-pf ${inputCls}" data-key="slack_bot_token" type="password" autocomplete="off" spellcheck="false" placeholder="xoxb-…" /></div>
         <div class="mb-2.5"><label class="${labelCls}">Signing Secret <span class="text-slate-600">(${pick("선택", "optional")})</span></label>
           <input class="sl-pf ${inputCls}" data-key="slack_signing_secret" type="password" autocomplete="off" spellcheck="false" placeholder="signing secret" /></div>`;

    const seg = (m: string, label: string) =>
      `<button data-wmode="${m}" class="px-3 py-1 text-[12px] font-medium transition-colors ${wizardMode === m ? "bg-accent-btn text-accent-on" : "text-slate-400 hover:text-slate-200"}">${label}</button>`;

    return `
      <div class="rounded-lg border border-accent-green/30 bg-surface-0/60 p-3.5">
        <div class="flex flex-wrap items-center gap-2 mb-3">
          <span class="text-[12px] text-slate-500">${pick("연결 방식", "Connection method")}</span>
          <div class="inline-flex rounded-md border border-surface-3 overflow-hidden">${seg("socket", "Socket Mode")}${seg("webhook", "Event URL")}</div>
          <span class="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold" style="color:rgb(var(--accent)/.95);background:rgb(var(--accent)/.12)">${pick("Socket 권장", "Socket recommended")}</span>
          <span class="text-[11px] text-slate-500">${isSocket ? pick("공개 URL 불필요 · 외부 사용자에 권장", "No public URL needed · recommended for external users") : pick("공개 URL(자동·고정) · 이미 호스팅 있으면", "Public URL (automatic·fixed) · if you already have hosting")}</span>
        </div>
        <div class="text-[13px] font-semibold text-slate-200 mb-2 flex items-center gap-1.5"><span class="text-slate-400 inline-flex">${renderIcon("user-circle", { size: 15 })}</span>${pick("Slack에서 (사람 단계 — 복붙만 하면 됩니다)", "In Slack (human step — just copy & paste)")}</div>
        <ol class="text-[13px] text-slate-300 leading-relaxed ml-4 list-decimal space-y-2 mb-3">
          ${steps.map((s) => `<li>${s}</li>`).join("")}
        </ol>
        <div class="rounded-md border border-surface-3 bg-surface-0 p-2.5 mb-3">
          <div class="flex items-center justify-between mb-1.5">
            <span class="text-[12px] font-semibold text-slate-300">${pick("앱 매니페스트 (그대로 붙여넣기)", "App manifest (paste as-is)")}</span>
            <button class="sl-copy ${copyCls}" data-copy="${esc(manifestStr)}">${pick("매니페스트 복사", "Copy manifest")}</button>
          </div>
          <pre class="text-[12px] font-mono text-slate-300 max-h-56 overflow-auto leading-normal">${esc(manifestStr)}</pre>
        </div>
        ${copyRows}

        <div class="border-t border-surface-3 my-3"></div>
        <div class="text-[13px] font-semibold text-slate-200 mb-2 flex items-center gap-1.5"><span class="text-slate-400 inline-flex">${renderIcon("key", { size: 14 })}</span>${pick("복사한 값 입력", "Enter the copied values")}</div>
        <div class="mb-2.5"><label class="${labelCls}">Bot User ID <span class="text-slate-600">(U… · ${pick("봇 토큰 저장 시 자동 — 비워둬도 됨", "auto-filled when the bot token is saved — can leave blank")})</span></label>
          <input class="sl-pf ${inputCls}" data-key="slack_bot_user_id" type="text" autocomplete="off" spellcheck="false" placeholder="${pick("자동으로 채워집니다 (비워두세요)", "Auto-filled (leave blank)")}" value="${esc(info.slack_bot_user_id ?? "")}" /></div>
        <div class="mb-2.5"><label class="${labelCls}">${pick("앱 이름", "App name")}</label>
          <input class="sl-pf ${inputCls}" data-key="slack_app_name" type="text" autocomplete="off" spellcheck="false" placeholder="${pick("앱 이름", "App name")}" value="${esc(info.slack_app_name ?? "")}" /></div>
        ${tokenInputs}
        <div class="mb-2.5"><label class="${labelCls}">App ID <span class="text-slate-600">(${pick("선택", "optional")} · A…)</span></label>
          <input class="sl-pf ${inputCls}" data-key="slack_app_id" type="text" autocomplete="off" spellcheck="false" placeholder="A…" value="${esc(info.slack_app_id ?? "")}" /></div>
        <div class="flex items-center gap-3 mt-1">
          <button id="sl-save" class="${btnPrimary}">${pick("저장 &amp; 검증", "Save &amp; verify")}</button>
          <button id="sl-cancel" class="${btnGhost}">${pick("닫기", "Close")}</button>
          <span id="sl-msg" class="text-[12px] text-slate-500 flex-1 leading-snug"></span>
        </div>
        <div class="text-[12px] text-slate-500 mt-2 flex items-start gap-1.5"><span class="inline-flex mt-0.5 shrink-0">${renderIcon("lock", { size: 12 })}</span><span>${pick("토큰·secret은 화면·로그에 남지 않고 전송 후 즉시 지워집니다. 서버가 0600으로 저장합니다.", "Tokens and secrets are never kept on screen or in logs — cleared right after sending. The server saves them with 0600 permissions.")}</span></div>
      </div>`;
  };

  const render = () => {
    const state = me?.state ?? "not_connected";
    const identity = me?.slack_bot_user_id ? esc(me.slack_bot_user_id) : "—";
    const appName = me?.slack_app_name ? esc(me.slack_app_name) : "—";
    const connectLabel = state === "not_connected" ? pick("Slack 연결", "Connect Slack") : pick("다시 설정 · 재설치", "Reconfigure · Reinstall");
    const hasToken = !!me?.has_token;
    const curMode = me?.slack_connection_mode === "socket" ? "socket" : "webhook";
    // 현재 방식 표시(읽기 전용) — 변경은 '다시 설정·재설치' 안에서.
    const modeChip = state === "not_connected"
      ? ""
      : curMode === "socket"
        ? `<span class="inline-flex items-center gap-1 text-[11px] ${me?.socket_ready ? "text-accent-greenSoft" : "text-txt-amber"}"><span class="h-1 w-1 rounded-full ${me?.socket_ready ? "bg-accent-green" : "bg-txt-amber"}"></span>${pick("방식", "Method")} Socket Mode${me?.socket_ready ? "" : pick(" · App Token 필요", " · App Token needed")}</span>`
        : `<span class="text-[11px] text-slate-500">${pick("· 방식 Event URL", "· Method Event URL")}</span>`;
    host.innerHTML = `
      <div class="mt-8 pt-5 border-t border-surface-3">
        <div class="flex items-center justify-between mb-2">
          <div class="text-xs font-semibold uppercase tracking-widest text-slate-500">${pick("Slack 연동", "Slack integration")} <span class="normal-case tracking-normal text-slate-600 font-normal">· ${pick("옵션 채널", "optional channel")}</span></div>
          ${stateBadge(state)}
        </div>
        <div class="text-[12px] text-slate-400 mb-3 leading-relaxed">Bot User ID <code class="text-slate-300">${identity}</code> · ${pick("앱", "App")} <span class="text-slate-300">${appName}</span> ${modeChip}</div>
        <div class="flex flex-wrap items-center gap-2">
          <button id="sl-check" class="${btnGhost}">${pick("연결 확인", "Check connection")}</button>
          <button id="sl-open" class="${btnPrimary}">${connectLabel}</button>
          ${hasToken ? `<button id="sl-revoke" class="text-[13px] font-medium px-3.5 py-2 rounded-lg border border-txt-red/30 bg-surface-2 text-txt-red/80 hover:text-txt-red hover:border-txt-red/50 transition-colors">${pick("연동 해제", "Disconnect")}</button>` : ""}
          <span id="sl-check-msg" class="text-[12px] text-slate-500 flex-1 leading-snug"></span>
        </div>
        <div id="sl-wizard" class="mt-3">${open ? wizardHtml() : ""}</div>
      </div>`;
    wire();
  };

  const wire = () => {
    host.querySelectorAll<HTMLButtonElement>(".sl-copy").forEach((b) => {
      b.addEventListener("click", async () => {
        const ok = await clip(b.dataset.copy ?? "");
        const orig = b.textContent; b.textContent = ok ? pick("복사됨 ✓", "Copied ✓") : pick("복사 실패", "Copy failed");
        setTimeout(() => { b.textContent = orig; }, 1400);
      });
    });

    const checkBtn = host.querySelector<HTMLButtonElement>("#sl-check");
    const checkMsg = host.querySelector<HTMLElement>("#sl-check-msg");
    checkBtn?.addEventListener("click", async () => {
      const done = setBtnBusy(checkBtn, pick("⏳ 확인 중…", "⏳ Checking…"));
      if (checkMsg) { checkMsg.textContent = pick("Slack 연결 확인 중…", "Checking Slack connection…"); checkMsg.className = "text-[12px] text-slate-500 flex-1 leading-snug"; }
      try {
        const r = await fetch(`${apiBase()}/api/members/${encodeURIComponent(agentId)}/slack/test-post`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
        const j = await r.json().catch(() => ({}));
        if (checkMsg) {
          if (j.ok) { checkMsg.textContent = pick(`✅ 연결 정상 — ${esc(j.channel ?? "")}에 게시 확인`, `✅ Connection OK — posted to ${esc(j.channel ?? "")}`); checkMsg.className = "text-[12px] text-accent-greenSoft flex-1 leading-snug"; }
          else { checkMsg.textContent = "✗ " + (j.hint || j.error || pick("연결 실패", "Connection failed")); checkMsg.className = "text-[12px] text-txt-red flex-1 leading-snug"; }
        }
      } catch (e) {
        if (checkMsg) { checkMsg.textContent = pick("오류: ", "Error: ") + (e as Error).message; checkMsg.className = "text-[12px] text-txt-red flex-1 leading-snug"; }
      }
      done();
    });

    host.querySelector<HTMLButtonElement>("#sl-open")?.addEventListener("click", () => {
      open = !open;
      // 열 때 방식 초기화: 신규 연결은 Socket 기본(권장 — 공개 URL 불필요), 기존 연결은 현 방식 유지(working webhook 안 깨뜨림).
      if (open) {
        wizardMode = me?.state === "not_connected"
          ? "socket"
          : (me?.slack_connection_mode === "socket" ? "socket" : "webhook");
      }
      if (open && !info) { render(); loadInfo(); } else render();
    });
    host.querySelector<HTMLButtonElement>("#sl-cancel")?.addEventListener("click", () => { open = false; render(); });

    const revokeBtn = host.querySelector<HTMLButtonElement>("#sl-revoke");
    revokeBtn?.addEventListener("click", async () => {
      if (!await showConfirm({ message: pick(`${agentId}의 Slack 연동을 해제할까요?\n저장된 봇 토큰이 삭제됩니다(신원도 함께 정리). 되돌리려면 재연동 필요.`, `Disconnect ${agentId}'s Slack integration?\nThe saved bot token will be deleted (identity cleared too). Reconnecting is needed to undo this.`), danger: true })) return;
      const done = setBtnBusy(revokeBtn, pick("⏳ 해제 중…", "⏳ Disconnecting…"));
      try {
        const r = await fetch(`${apiBase()}/api/members/${encodeURIComponent(agentId)}/slack/revoke`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
        me = await fetchStatus(); info = null; open = false; render();
      } catch (e) { await showAlert(pick("해제 실패: ", "Disconnect failed: ") + (e as Error).message); done(); }
    });

    const saveBtn = host.querySelector<HTMLButtonElement>("#sl-save");
    const msg = host.querySelector<HTMLElement>("#sl-msg");
    saveBtn?.addEventListener("click", async () => {
      const inputs = Array.from(host.querySelectorAll<HTMLInputElement>(".sl-pf"));
      const body: Record<string, string> = {};
      for (const el of inputs) { const v = el.value.trim(); if (v) body[el.dataset.key!] = v; }
      for (const el of inputs) if (el.type === "password") el.value = "";
      body.slack_connection_mode = wizardMode; // 고른 방식 함께 저장
      // 신규 연결이면 봇 토큰 필수. Socket이면 app_token도(없으면 서버가 400으로 안내).
      if (!me?.has_token && !body.slack_bot_token) {
        if (msg) { msg.textContent = pick("Bot Token(xoxb-)을 입력하세요.", "Enter the Bot Token (xoxb-)."); msg.className = "text-[12px] text-txt-red flex-1 leading-snug"; }
        return;
      }
      if (wizardMode === "socket" && !me?.has_app_token && !body.slack_app_token) {
        if (msg) { msg.textContent = pick("Socket Mode엔 App-Level Token(xapp-)이 필요합니다.", "Socket Mode needs an App-Level Token (xapp-)."); msg.className = "text-[12px] text-txt-red flex-1 leading-snug"; }
        return;
      }
      const done = setBtnBusy(saveBtn, pick("⏳ 저장 중…", "⏳ Saving…"));
      if (msg) { msg.textContent = pick("저장 중…", "Saving…"); msg.className = "text-[12px] text-slate-400 flex-1 leading-snug"; }
      try {
        const r = await fetch(`${apiBase()}/api/members/${encodeURIComponent(agentId)}/slack`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j.hint || j.error || `HTTP ${r.status}`);
        if (msg) { msg.textContent = pick("저장됨 ✓ — 연결 검증 중…", "Saved ✓ — verifying connection…"); msg.className = "text-[12px] text-slate-400 flex-1 leading-snug"; }
        const cr = await fetch(`${apiBase()}/api/members/${encodeURIComponent(agentId)}/slack/test-post`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
        const cj = await cr.json().catch(() => ({}));
        me = await fetchStatus();
        const okMsg = cj.ok ? pick(`✅ 연동 완료 — ${esc(cj.channel ?? "")} 게시 확인`, `✅ Connected — posted to ${esc(cj.channel ?? "")}`) : pick("저장됨, 검증: ", "Saved, verify: ") + (cj.hint || cj.error || pick("확인 필요", "needs checking"));
        // 전체 재렌더 — 상태배지·mode chip·identity·연동해제 버튼까지 최신화(부분 패치 stale 방지). 성공 메시지는 메인 줄에.
        render();
        const cmsg = host.querySelector<HTMLElement>("#sl-check-msg");
        if (cmsg) { cmsg.textContent = okMsg; cmsg.className = `text-[12px] flex-1 leading-snug ${cj.ok ? "text-accent-greenSoft" : "text-txt-amber"}`; }
      } catch (e) {
        if (msg) { msg.textContent = pick("실패: ", "Failed: ") + (e as Error).message; msg.className = "text-[12px] text-txt-red flex-1 leading-snug"; }
        done();
      }
    });

    // 마법사 안 연결 방식 선택 — 로컬 상태만 바꾸고 다시 그림(서버 persist는 '저장 & 검증' 때 함께).
    // 모순(소켓인데 Event URL 절차) 제거: 고른 방식의 절차·매니페스트·입력칸만 보인다.
    host.querySelectorAll<HTMLButtonElement>("[data-wmode]").forEach((b) => {
      b.addEventListener("click", () => {
        const m = b.dataset.wmode as "webhook" | "socket";
        if (m === wizardMode) return;
        // 입력 보존: 모드 전환 render가 innerHTML을 갈아엎어 입력값(특히 양모드 공유 Bot Token)이 날아가는 것 방지.
        // 토큰은 value 속성 대신 .value(라이브 DOM)로만 재시드 → HTML/로그 노출 없음.
        const draft: Record<string, string> = {};
        host.querySelectorAll<HTMLInputElement>(".sl-pf").forEach((el) => { if (el.value) draft[el.dataset.key!] = el.value; });
        wizardMode = m;
        render();
        host.querySelectorAll<HTMLInputElement>(".sl-pf").forEach((el) => { const v = draft[el.dataset.key!]; if (v != null) el.value = v; });
      });
    });
  };

  (async () => { me = await fetchStatus(); render(); loadInfo(); })();
}
