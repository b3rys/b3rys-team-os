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
  state: string; event_request_url: string | null; channel: string;
  needed_scopes: string[]; manifest: unknown;
  // 공개 URL 미설정 = Event URL 방식만 불가. Socket Mode 는 그대로 된다.
  public_base_missing?: boolean; public_base_hint?: string | null;
  error?: string; hint?: string;
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

// Socket Mode용 매니페스트 변환 — socket_mode_enabled=true + request_url 제거(공개 URL 불필요).
//
// ★bot_events 를 "보존" 이 아니라 "주입" 한다★ (2026-07-27 Steve 리뷰).
//   서버는 공개 URL 이 없으면 event_subscriptions 를 아예 안 내보낸다(그 조합은 Slack 이 거부한다).
//   그래서 여기서 보존만 하면 ★공개 URL 없는 Socket 사용자가 구독을 못 받아 멘션에 반응하지 않는다★ —
//   #74 가 고쳤던 그 버그가 다른 경로로 되살아난다. Socket 은 request_url 없이 bot_events 만으로 되므로
//   이 자리에서 만들어 넣는 것이 맞다.
// export 는 최종 JSON 을 테스트하기 위한 것.
export function socketManifest(manifest: unknown): unknown {
  try {
    const m = JSON.parse(JSON.stringify(manifest ?? {})) as Record<string, any>;
    m.settings = m.settings || {};
    m.settings.socket_mode_enabled = true;
    const ev = m.settings.event_subscriptions || {};
    delete ev.request_url;                                   // Socket 은 공개 URL 이 필요없다
    if (!Array.isArray(ev.bot_events) || ev.bot_events.length === 0) ev.bot_events = ["app_mention"];
    m.settings.event_subscriptions = ev;                     // 서버가 안 줬으면 여기서 만든다
    return m;
  } catch {
    return manifest;
  }
}

// ★기존 Event URL 멤버가 공개 URL 없이 마법사를 열면★ Slack 이 거부하는 매니페스트가 나온다:
//   "Event Subscription requires either Request URL or Socket Mode Enabled"
// 이때 안내는 ★그 사람이 실제로 할 수 있는 행동★ 이어야 한다. 처음엔 "Socket Mode 를 선택하세요" 라고
// 썼는데, 방식 선택 토글을 없앤 뒤라 ★고를 버튼이 없었다★ — 막다른 안내였다(코덱스 리뷰).
// 방식 전환은 App-Level Token 재발급이 필요한 별도 작업이라 이 화면에서 시킬 수 없다.
// 그래서 공개 주소 설정을 안내한다. 그건 지금 바로 할 수 있는 일이다.
export function webhookBlockedNotice(mode: "webhook" | "socket", eventRequestUrl: string | null): string | null {
  if (mode === "socket" || eventRequestUrl) return null;
  return pick(
    "이 팀원은 Event URL 방식으로 설정돼 있는데 공개 HTTPS 주소가 없습니다. 그대로 두면 Slack 이 매니페스트를 거부합니다(Event Subscription requires either Request URL or Socket Mode Enabled). 서버에 TEAM_PUBLIC_BASE_URL 로 공개 HTTPS 주소를 설정한 뒤 이 화면을 다시 여세요.",
    "This member is set up with Event URL mode but no public HTTPS address is configured. Slack will reject the manifest (Event Subscription requires either Request URL or Socket Mode Enabled). Set TEAM_PUBLIC_BASE_URL on the server to a public HTTPS address, then reopen this screen.",
  );
}

// ★이벤트 구독을 켜는 단계가 안내에 아예 없었다★ (2026-07-27 실측 — 리사 앱을 만들다 여기서 헤맸다).
// 매니페스트에는 event_subscriptions.bot_events=["app_mention"] 이 들어 있다. 그런데 ★그게 들어 있다는 것과
// 그 앱에서 실제로 켜져 있다는 것은 다르다★ — 실제로 GD 는 Slack 화면에서 직접 토글을 올려야 했다.
// 이게 꺼져 있으면 ★봇은 멘션에 아무 반응을 하지 않는다. 오류도 안 난다.★ 사용자는 "봇이 무시한다" 로만 본다.
// 그래서 매니페스트를 믿지 말고 ★눈으로 확인하는 단계★ 를 안내에 넣는다(양쪽 방식 공통).
export function enableEventsStep(): string {
  return pick(
    `<b>Event Subscriptions</b> → <b>Enable Events</b> 토글 <b>ON</b> → 아래로 내려서 <b>Subscribe to bot events</b> → <b>Add Bot User Event</b> → <code>app_mention</code> 추가 → <b>Save Changes</b>. <span class="text-slate-500">(매니페스트에 이미 있어도 실제로 켜져 있는지 확인하세요 — 꺼져 있으면 봇이 멘션에 반응하지 않고 오류도 나지 않습니다)</span>`,
    `<b>Event Subscriptions</b> → turn <b>Enable Events</b> <b>ON</b> → scroll down to <b>Subscribe to bot events</b> → <b>Add Bot User Event</b> → add <code>app_mention</code> → <b>Save Changes</b>. <span class="text-slate-500">(it is already in the manifest, but confirm it is actually on — if it is off the bot ignores mentions and no error is shown)</span>`,
  );
}

/** 마법사의 사람 단계 목록. 렌더에서 분리해 ★안내 내용 자체를 테스트할 수 있게★ 한다
 *  (빠진 단계는 화면을 봐야만 드러났다 — 그래서 회귀로 고정한다). */
export function wizardSteps(opts: { appLink: string; scopes: string; channel: string }): string[] {
  const { appLink, scopes, channel } = opts;
  const inviteStep = pick(
    `봇을 <b>${channel ? esc(channel) : pick("사용할 채널", "your channel")}</b>에 초대: <code>/invite @봇이름</code>.${channel ? "" : pick(" <span class=\"text-slate-500\">(채널이 아직 설정되지 않았습니다 — 아래 채널 칸에 입력하세요)</span>", "")}`,
    `Invite the bot to <b>${channel ? esc(channel) : "your channel"}</b>: <code>/invite @botname</code>.${channel ? "" : " <span class=\"text-slate-500\">(no channel configured yet — set it in the Channel field below)</span>"}`);
  const installStep = pick(
    `<b>Install to Workspace</b> → Allow (권한 승인). 필요 scope: <code>${esc(scopes || "—")}</code>.`,
    `<b>Install to Workspace</b> → Allow (approve permissions). Scopes needed: <code>${esc(scopes || "—")}</code>.`);

  // ★Event URL 분기를 없앤다★ — 지원하지 않는 경로가 화면에 남아 있으면 사용자는 그걸 선택지로 읽는다.
  return [
    pick(
      `Slack 앱 생성: ${appLink} → <b>From a manifest</b> → 워크스페이스 선택 → 아래 <b>매니페스트</b> 붙여넣기. <span class="text-slate-500">(Socket Mode 켜진 매니페스트 — 공개 URL 불필요)</span>`,
      `Create the Slack app: ${appLink} → <b>From a manifest</b> → select a workspace → paste the <b>manifest</b> below. <span class="text-slate-500">(manifest with Socket Mode on — no public URL needed)</span>`),
    enableEventsStep(),
    installStep,
    pick(
      `<b>Basic Information</b> → <b>App-Level Tokens</b> → Generate Token → scope <code>connections:write</code> 추가 → <b>App-Level Token</b>(<code>xapp-…</code>) 복사.`,
      `<b>Basic Information</b> → <b>App-Level Tokens</b> → Generate Token → add scope <code>connections:write</code> → copy the <b>App-Level Token</b>(<code>xapp-…</code>).`),
    pick(
      `<b>OAuth & Permissions</b> → <b>Bot User OAuth Token</b>(<code>xoxb-…</code>) 복사 → 아래 폼에 <b>xoxb</b>·<b>xapp</b> 붙여넣기.`,
      `<b>OAuth & Permissions</b> → copy the <b>Bot User OAuth Token</b>(<code>xoxb-…</code>) → paste <b>xoxb</b> and <b>xapp</b> into the form below.`),
    inviteStep,
  ];
}

export function renderAgentSlack(host: HTMLElement, agentId: string, _displayName: string): void {
  let open = false;
  let me: SlackMember | null = null;
  let info: ReinstallInfo | null = null;
  let infoLoading = false;
  let infoError: string | null = null;
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
    infoError = null;
    try {
      const r = await fetch(`${apiBase()}/api/members/${encodeURIComponent(agentId)}/slack/reinstall-info`, { headers: { accept: "application/json" } });
      const body = await r.json().catch(() => null) as ReinstallInfo | null;
      // ★응답 성공 여부를 확인한다★ — 예전엔 r.ok 를 안 보고 body 를 그대로 info 에 넣었다. 그래서 400 이
      //   와도 화면은 '정상' 으로 그려졌고, manifest/needed_scopes 가 undefined 인 채 ★빈 매니페스트와
      //   빈 scope 를 그럴싸하게 표시★ 했다(실측). 사용자는 그걸 Slack 에 붙여넣어 ★권한 0개짜리 앱★ 을
      //   만들게 된다 — 실패보다 나쁘다. 실패면 실패라고 보여준다.
      if (!r.ok || !body || body.ok === false) {
        info = null;
        infoError = body?.hint || body?.error || `HTTP ${r.status}`;
      } else {
        info = body;
      }
    } catch (e) {
      info = null;
      infoError = e instanceof Error ? e.message : String(e);
    }
    infoLoading = false;
    render();
  };

  const wizardHtml = (): string => {
    if (infoLoading) return `<div class="rounded-lg border border-surface-3 bg-surface-0/40 p-3.5 text-[12px] text-slate-500">${pick("설정 정보 불러오는 중…", "Loading settings…")}</div>`;
    // 실패했으면 ★가짜 안내 대신 실패를 보여준다.★ 반쪽 매니페스트를 그리면 사용자가 그걸 붙여넣는다.
    if (infoError || !info) {
      return `<div class="rounded-lg border border-status-blocked/40 bg-surface-0/40 p-3.5 text-[12px] text-slate-300">
        <div class="font-semibold text-status-blocked mb-1">${pick("설정 정보를 불러오지 못했습니다", "Could not load setup info")}</div>
        <div class="text-slate-400">${esc(infoError ?? "unknown")}</div>
        <div class="text-slate-500 mt-1.5">${pick("이 상태에서는 매니페스트가 불완전해 Slack 앱이 권한 없이 만들어집니다. 원인을 먼저 해결하세요.", "The manifest would be incomplete here and the Slack app would be created without permissions. Fix the cause first.")}</div>
      </div>`;
    }
    const isSocket = wizardMode === "socket";
    const manifestStr = JSON.stringify(isSocket ? socketManifest(info.manifest) : (info.manifest ?? {}), null, 2);
    const scopes = (info.needed_scopes ?? []).join(", ");
    // ★기본값에 우리 채널명을 쓰지 않는다★ — 예전엔 "#300-gd-ai-team"(우리 채널)이 박혀 있어서, 채널이
    //   설정되지 않은 설치본에서 ★남의 채널로 초대하라는 안내★ 가 그대로 떴다(공개 소스·번들에도 포함).
    const channel = info.channel || "";
    const blockedNotice = webhookBlockedNotice(wizardMode, info.event_request_url);
    const appLink = `<a class="text-accent-greenSoft underline" href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noopener">api.slack.com/apps</a>`;

    const steps = wizardSteps({ appLink, scopes, channel });

    // Event URL 방식은 공개 HTTPS 주소가 있어야 한다. 없으면 "—" 만 띄우지 말고 ★무엇을 하면 되는지★ 알린다
    // (Socket Mode 는 이 값 없이도 되므로 그쪽으로 안내). 예전엔 이 조건에서 화면 전체가 못 뜨고 있었다.
    const eventUrlRow = info.event_request_url
      ? copyRow("Event URL", info.event_request_url)
      : `<div class="mb-1.5 rounded border border-txt-amber/30 bg-surface-0 px-2 py-1.5 text-[12px] text-txt-amber">${esc(info.public_base_hint ?? pick("Event URL 방식을 쓰려면 공개 HTTPS 주소 설정이 필요합니다. Socket Mode 는 설정 없이 됩니다.", "Event URL mode needs a public HTTPS address. Socket Mode works without it."))}</div>`;
    const copyRows = isSocket
      ? copyRow(pick("채널", "Channel"), channel, false)
      : eventUrlRow + copyRow(pick("채널", "Channel"), channel, false);

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


    return `
      <div class="rounded-lg border border-accent-green/30 bg-surface-0/60 p-3.5">
        <div class="flex flex-wrap items-center gap-2 mb-3">
          <span class="text-[12px] text-slate-500">${pick("연결 방식", "Connection method")}</span>
          <span class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold" style="color:rgb(var(--accent)/.95);background:rgb(var(--accent)/.12)">${isSocket ? "Socket Mode" : "Event URL"}</span>
          <span class="text-[11px] text-slate-500">${isSocket ? pick("공개 URL 불필요", "No public URL needed") : pick("기존 설정 유지 중", "keeping existing setup")}</span>
        </div>
        ${blockedNotice ? `<div class="rounded-md border border-txt-amber/40 bg-surface-0 p-3 mb-3 text-[12px] text-slate-300">
          <div class="font-semibold text-txt-amber mb-1">${pick("지금은 설정을 진행할 수 없습니다", "Setup cannot proceed right now")}</div>
          <div class="text-slate-400">${esc(blockedNotice)}</div>
        </div>` : `
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
        ${copyRows}`}

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
      // ★슬랙 정본은 Socket Mode 뿐이다★. 예전엔 기존 멤버의 저장된 방식을 따라가서
      //   ★지원하지 않는 Event URL 안내가 계속 떴다.★ 저장값은 과거 잔재이지 현재 정책이 아니다.
      //   기존 멤버의 ★런타임 수신 동작은 그대로다★ — 서버 경로는 안 건드린다. 앱을 다시 만들 때만 Socket 이 된다.
      //   (이 값이 항상 "socket" 이므로 아래 isSocket 분기·webhookBlockedNotice 는 자연히 Socket 쪽만 탄다.)
      if (open) wizardMode = "socket";
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

  };

  (async () => { me = await fetchStatus(); render(); loadInfo(); })();
}
