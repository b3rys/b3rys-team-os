// Chat — 대시보드 1:1 채팅 (b3os 메신저 v0). 팀원별 user↔agent DM.
// 기존 버스 재사용: 보내기 POST /team/api/inbox {from:'user', to:<agent>, body, type:'dm', source:'user', dispatch:true},
// 읽기 GET /team/api/threads/:thread_id 폴링(~1.5s). dispatch:true 라야 버스가 그 팀원을 깨움(user 메시지지만).
import { store, type Message } from "../store";
import { apiBase } from "../ws";
import { agentIconName, renderIcon } from "../icons";
import { renderAgentIcon } from "../agentColors";
import { pick } from "../i18n";

function api(path: string): string { return `${apiBase()}/api${path}`; }
function escape(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function parseDate(s: string | null): Date | null {
  if (!s) return null;
  const n = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s) ? s.replace(" ", "T") + (s.includes("Z") || s.includes("+") ? "" : "Z") : s;
  const d = new Date(n);
  return isNaN(d.getTime()) ? null : d;
}
function hhmm(s: string | null): string {
  const d = parseDate(s);
  if (!d) return "";
  const p = (n: number) => (n < 10 ? "0" : "") + n;
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// user↔agent 1:1 DM = 고정 room thread id. (2026-06-10 fix: 매 전송마다 thread_id 없이 보내
// 서버가 새 thread를 만들던 버그 → 메시지가 안 쌓이고 1개만 보였음. 안정 id로 한 방에 누적.)
function dmThreadId(agentId: string): string { return ("dm-user-" + agentId).slice(0, 32); }

export function renderChat(root: HTMLElement): void {
  let curAgent: string | null = null;
  let threadId: string | null = null;
  let msgs: Message[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let sending = false;
  let loadedShell = false;

  const isActive = () => store.getState().mainView === "chat";

  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  function startPoll() { stopPoll(); pollTimer = setInterval(() => void fetchMsgs(), 1500); }

  async function fetchMsgs(): Promise<void> {
    if (!threadId) return;
    try {
      const r = await fetch(api("/threads/" + encodeURIComponent(threadId)), { headers: { accept: "application/json" } });
      if (!r.ok) return;
      const body = await r.json();
      if (Array.isArray(body.messages)) { msgs = body.messages; paintMessages(); }
    } catch { /* transient */ }
  }

  async function send(body: string): Promise<void> {
    if (!curAgent || sending) return;
    sending = true;
    try {
      const res = await fetch(api("/inbox"), {
        method: "POST", headers: { "content-type": "application/json" },
        // thread_id 고정 → 한 방에 누적. source:'user' + dispatch:true → user 메시지지만 버스가 그 팀원을 깨움
        // (텔레그램 user는 completed라 더블웨이크 0). Bill 2026-06-09 · thread_id fix 2026-06-10.
        body: JSON.stringify({ thread_id: threadId ?? dmThreadId(curAgent), from_agent_id: "user", to_agent_id: curAgent, body, type: "dm", source: "user", dispatch: true }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { flashError(j.error || pick(`전송 실패 (HTTP ${res.status})`, `Send failed (HTTP ${res.status})`)); return; }
      threadId = j.message?.thread_id ?? threadId ?? dmThreadId(curAgent);
      await fetchMsgs();
      startPoll();
    } catch (e) {
      flashError(pick("전송 실패: ", "Send failed: ") + (e as Error).message);
    } finally {
      sending = false;
    }
  }

  function flashError(text: string): void {
    const el = root.querySelector<HTMLElement>("#chat-err");
    if (el) { el.textContent = text; el.classList.remove("hidden"); setTimeout(() => el.classList.add("hidden"), 4000); }
  }

  // 에이전트 전환 시 재초기화(스레드 재해석 + 히스토리 로드).
  function reinit(agentId: string | null): void {
    stopPoll();
    curAgent = agentId; threadId = null; msgs = [];
    if (!agentId) { paintShell(); return; }
    threadId = dmThreadId(agentId);   // 고정 방 — 메시지 누적
    paintShell();
    void fetchMsgs(); startPoll();
  }

  function paintMessages(): void {
    const wrap = root.querySelector<HTMLElement>("#chat-msgs");
    if (!wrap) return;
    if (!msgs.length) {
      wrap.innerHTML = `<div class="h-full flex items-center justify-center text-slate-500 text-sm">${pick("아직 대화가 없습니다. 첫 메시지를 보내보세요.", "No messages yet. Send the first one.")}</div>`;
      return;
    }
    const agents = store.getState().agents;
    const nameOf = (id: string) => agents.find((a) => a.id === id)?.display_name ?? id;
    wrap.innerHTML = msgs.map((m) => {
      const mine = m.from_agent_id === "user";
      const bubble = mine
        ? "bg-accent-green/15 border border-accent-green/25 text-slate-100"
        : "bg-surface-2 border border-surface-3 text-slate-200";
      const align = mine ? "items-end" : "items-start";
      const meta = mine ? pick("나", "Me") : escape(nameOf(m.from_agent_id));
      return `
        <div class="flex flex-col ${align} gap-0.5">
          <div class="text-[10px] text-slate-500 px-1">${meta} · ${hhmm(m.created_at)}</div>
          <div class="max-w-[78%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap ${bubble}">${escape(m.body)}</div>
        </div>`;
    }).join("");
    wrap.scrollTop = wrap.scrollHeight;
  }

  function paintShell(): void {
    const agents = store.getState().agents;
    const agent = agents.find((a) => a.id === curAgent);
    if (!curAgent || !agent) {
      root.innerHTML = `<div class="flex-1 flex items-center justify-center text-slate-500 text-sm p-6 text-center">${pick("왼쪽에서 팀원을 선택하면 1:1 대화가 열립니다.", "Select a member on the left to open a 1:1 chat.")}</div>`;
      loadedShell = false;
      return;
    }
    root.innerHTML = `
      <div class="flex-1 flex flex-col min-h-0">
        <div class="h-12 flex items-center gap-2.5 px-4 border-b border-surface-3 shrink-0 bg-surface-1">
          <span class="inline-flex w-7 h-7 items-center justify-center rounded-md bg-surface-0">${renderAgentIcon(agentIconName(agent.id), agent.icon_color, 18)}</span>
          <div class="min-w-0">
            <div class="text-sm font-semibold text-slate-100 truncate">${escape(agent.display_name)} <span class="text-slate-500 font-normal">· 1:1</span></div>
            <div class="text-[11px] text-slate-500 truncate">${escape(agent.role)}</div>
          </div>
        </div>
        <div id="chat-msgs" class="flex-1 overflow-y-auto p-4 flex flex-col gap-3"></div>
        <div id="chat-err" class="hidden mx-4 mb-1 text-[12px] text-txt-red"></div>
        <form id="chat-form" class="border-t border-surface-3 p-3 flex gap-2 shrink-0">
          <input id="chat-input" type="text" autocomplete="off"
            class="flex-1 bg-surface-0 border border-surface-3 rounded-lg px-3.5 py-2 text-sm text-slate-100 focus:outline-none focus:border-accent-green/40 placeholder:text-slate-600"
            placeholder="${pick(`${escape(agent.display_name)}에게 메시지… (Enter 전송)`, `Message ${escape(agent.display_name)}… (Enter to send)`)}" />
          <button type="submit" class="px-4 py-2 rounded-lg bg-accent-btn text-accent-on text-sm font-semibold hover:bg-accent-btnHover">${pick("전송", "Send")}</button>
        </form>
      </div>`;
    loadedShell = true;
    paintMessages();
    const form = root.querySelector<HTMLFormElement>("#chat-form");
    const input = root.querySelector<HTMLInputElement>("#chat-input");
    form?.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = input?.value.trim();
      if (!v || !curAgent) return;
      input!.value = "";
      // optimistic: 엔터 즉시 내 말풍선 표시(폴링 안 기다림). fetchMsgs 가 곧 서버본으로 교체. 2026-06-10.
      msgs = msgs.concat([{
        id: "opt-" + msgs.length, thread_id: threadId ?? "", from_agent_id: "user", to_agent_id: curAgent,
        type: "dm", body: v, source: "user", hop_count: 0, in_reply_to: null, read_at: null,
        delivery_status: "pending", retry_count: 0, expires_at: null, priority: "normal",
        dedupe_key: null, created_at: new Date().toISOString(),
      }]);
      paintMessages();
      void send(v);
    });
    input?.focus();
  }

  const update = () => {
    const { selectedAgentId, mainView } = store.getState();
    if (mainView !== "chat") { stopPoll(); return; }   // 탭 떠나면 폴링 정지
    if (selectedAgentId !== curAgent) { reinit(selectedAgentId); return; }
    if (!loadedShell) paintShell();
    if (threadId && !pollTimer) startPoll();            // 탭 복귀 시 폴링 재개
  };

  update();
  store.subscribe(update);
}
