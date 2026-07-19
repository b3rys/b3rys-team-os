// AgentSetup UI helpers — small pure HTML-string builders (2026-06-06 ④ split).
// Extracted from AgentSetup.ts; behavior unchanged.
import { type DocSection } from "../../store";
import { apiBase } from "../../ws";
import { renderIcon } from "../../icons";
import { pick } from "../../i18n";

export function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function healthExampleCard(title: string, badge: string, badgeTone: string, meaning: string, checks: string[]): string {
  return `
    <div class="rounded-lg border border-surface-3 bg-surface-2/60 p-3">
      <div class="mb-2 flex items-center justify-between gap-2">
        <div class="text-sm font-semibold text-slate-100">${escape(title)}</div>
        <span class="inline-flex items-center rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide ${badgeTone}">${escape(badge)}</span>
      </div>
      <p class="text-xs leading-5 text-slate-300">${meaning}</p>
      <div class="mt-2 space-y-1 text-[11px] leading-5 text-slate-400">
        ${checks.map((check) => `<div>· ${check}</div>`).join("")}
      </div>
    </div>`;
}

export function section(title: string, eyebrow: string, body: string): string {
  return `
    <section class="rounded-xl border border-surface-3 bg-surface-1 p-4">
      <div class="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500 mb-1">${escape(eyebrow)}</div>
      <h2 class="text-base font-semibold text-slate-100 mb-3">${escape(title)}</h2>
      ${body}
    </section>`;
}

export function policyCard(title: string, text: string, accent = false): string {
  return `
    <div class="min-w-0 rounded-lg border ${accent ? "border-emerald-500/35 bg-emerald-500/10" : "border-surface-3 bg-surface-2/60"} p-3">
      <div class="text-sm font-semibold text-slate-100 mb-1">${escape(title)}</div>
      <div class="break-words text-xs leading-5 text-slate-300">${text}</div>
    </div>`;
}

export function flowStep(num: string, title: string, text: string): string {
  return `
    <div class="relative min-w-0 rounded-lg border border-surface-3 bg-surface-2/60 p-3">
      <div class="mb-2 inline-flex h-7 w-7 items-center justify-center rounded-md bg-emerald-500/15 text-xs font-semibold text-txt-green">${escape(num)}</div>
      <div class="text-sm font-semibold text-slate-100">${escape(title)}</div>
      <div class="mt-1 break-words text-xs leading-5 text-slate-300">${text}</div>
    </div>`;
}

export function codeBlock(code: string): string {
  return `<pre class="overflow-x-auto rounded-lg border border-surface-3 bg-surface-0 p-3 text-[11px] leading-5 text-slate-200"><code>${escape(code)}</code></pre>`;
}

export function docHref(file: string): string {
  if (file === "COMMUNICATION_FLOW.md") return `${apiBase()}/?view=doc&doc=routing`;
  if (file.startsWith("rules/")) return `${apiBase()}/${file}`;
  if (file.startsWith("docs/")) return `${apiBase()}/${file}`;
  return `${apiBase()}/docs/${encodeURIComponent(file)}`;
}

export function rawDocHref(file: string): string {
  if (file.startsWith("rules/")) return `${apiBase()}/${file}`;
  if (file.startsWith("docs/")) return `${apiBase()}/${file}`;
  return `${apiBase()}/docs/${encodeURIComponent(file)}`;
}

export function sourceLink(file: string, label = file): string {
  return `<a class="text-txt-green underline decoration-emerald-500/40 underline-offset-2 hover:text-accent-greenSoft" href="${docHref(file)}" target="_blank" rel="noreferrer">${escape(label)}</a>`;
}

export function rawSourceLink(file: string, label = file): string {
  return `<a class="text-txt-green underline decoration-emerald-500/40 underline-offset-2 hover:text-accent-greenSoft" href="${rawDocHref(file)}" target="_blank" rel="noreferrer">${escape(label)}</a>`;
}

export function sourceLinks(files: string[]): string {
  return `
    <div class="flex flex-wrap gap-2">
      ${files.map((file) => `
        <a class="inline-flex max-w-full items-center gap-1.5 break-all rounded-md border border-surface-3 bg-surface-2 px-2.5 py-1 text-[13px] font-medium text-txt-green hover:border-accent-green/50 hover:bg-accent-green/12"
          href="${docHref(file)}" target="_blank" rel="noreferrer">${renderIcon("file-text", { size: 13, className: "shrink-0 opacity-80" })}${escape(file)}</a>
      `).join("")}
    </div>`;
}

export function folderTree(): string {
  return codeBlock(pick(`b3rys-team-os/
├─ agents.json                         # 팀원 명단: 이름, 역할, 런타임, 작업 폴더
├─ src/server/
│  ├─ index.ts                         # /team API, dashboard, docs 링크 제공
│  ├─ routes/inbox.ts                  # 팀 메시지 버스: 누가 누구에게 보냈는지 저장
│  ├─ routes/router.ts                 # @멘션/sticky/종료 판단 API
│  ├─ lib/teamRouter.ts                # 라우팅 규칙의 실제 코드
│  └─ workers/telegramCapture.ts       # 그룹방 메시지 관찰/캡처
├─ src/web/
│  ├─ main.ts                          # 대시보드 화면과 탭
│  └─ components/AgentSetup.ts         # 지금 보고 있는 Doc 본문
├─ rules/
│  ├─ TEAM-OS.md                      # 팀 운영 규칙 + 현재 상태 (정본)
│  └─ SHARED.md                       # 팀 학습 로그
└─ docs/
   ├─ COMMUNICATION_FLOW.md            # 채널, 라우터, 팀 버스, DB, 런타임 흐름
   ├─ TEAM_SEARCH_SPEC_20260601.md     # 팀 검색 V0 구현 구조와 운영 게이트
   ├─ ROUTER_ARCHITECTURE.md           # 메시지 라우터 구조
   ├─ LIVE_INTEGRATION.md              # 텔레그램/Slack 라이브 연결
   └─ HANDOFF_PLAYBOOK.md              # 에이전트끼리 넘길 때 규칙`, `b3rys-team-os/
├─ agents.json                         # Member roster: name, role, runtime, workspace folder
├─ src/server/
│  ├─ index.ts                         # /team API, dashboard, docs links
│  ├─ routes/inbox.ts                  # Team message bus: stores who sent what to whom
│  ├─ routes/router.ts                 # @mention/sticky/closure decision API
│  ├─ lib/teamRouter.ts                # The actual routing-rule code
│  └─ workers/telegramCapture.ts       # Group-room message observe/capture
├─ src/web/
│  ├─ main.ts                          # Dashboard screen and tabs
│  └─ components/AgentSetup.ts         # The Doc body you are viewing now
├─ rules/
│  ├─ TEAM-OS.md                      # Team operating rules + current state (source of truth)
│  └─ SHARED.md                       # Team learning log
└─ docs/
   ├─ COMMUNICATION_FLOW.md            # Channel, router, team bus, DB, runtime flow
   ├─ TEAM_SEARCH_SPEC_20260601.md     # Team Search V0 implementation structure and ops gate
   ├─ ROUTER_ARCHITECTURE.md           # Message router structure
   ├─ LIVE_INTEGRATION.md              # Telegram/Slack live integration
   └─ HANDOFF_PLAYBOOK.md              # Rules for handing off between agents`));
}

export function sourceOfTruthPanel(): string {
  return `
    <p class="text-sm leading-6 text-slate-300">
      ${pick(
        `운영정책의 정본은 <code>rules/TEAM-OS.md</code>, <code>rules/SHARED.md</code>, <code>agents.json</code>입니다.
      TEAM-OS는 팀 운영 규칙과 현재 상태값을 담고, SHARED는 실제 작업에서 배운 교훈을 쌓는 학습 로그입니다.
      <code>agents.json</code>은 팀원 ID, 역할, 런타임(runtime, 실행 환경), 작업 폴더를 담는 팀원 등록부입니다.
      대시보드는 이 원본을 읽기 쉽게 보여주는 화면입니다.`,
        `The source of truth for operating policy is <code>rules/TEAM-OS.md</code>, <code>rules/SHARED.md</code>, and <code>agents.json</code>.
      TEAM-OS holds the team operating rules and current state values; SHARED is the learning log that accumulates lessons from real work.
      <code>agents.json</code> is the member registry holding member IDs, roles, runtime (execution environment), and workspace folders.
      The dashboard is the screen that presents these sources in a readable form.`,
      )}
    </p>
    <div class="mt-3">${sourceLinks([
      "rules/TEAM-OS.md",
      "rules/SHARED.md",
      "agents.json",
    ])}</div>
  `;
}

export function messageExample(title: string, lines: string[]): string {
  return `
    <div class="rounded-lg border border-surface-3 bg-surface-2/60 p-3">
      <div class="mb-2 text-sm font-semibold text-slate-100">${escape(title)}</div>
      <div class="space-y-2">
        ${lines.map((line) => `
          <div class="rounded-md border border-surface-3 bg-surface-0 px-3 py-2 text-xs leading-5 text-slate-300">${line}</div>
        `).join("")}
      </div>
    </div>`;
}

export function miniNav(active: DocSection): string {
  const tabs: { id: DocSection; label: string }[] = [
    { id: "policy", label: pick("처음 보기", "Start here") },
    { id: "architecture", label: pick("구조", "Structure") },
    { id: "routing", label: pick("플로우", "Flow") },
    { id: "learning", label: pick("학습", "Learning") },
    { id: "qa", label: pick("테스트", "Tests") },
    { id: "search", label: pick(`검색 <span class="ml-0.5 inline-flex text-amber-400 align-[-2px]" title="실험 기능" aria-label="실험 기능">${renderIcon("flask-triangle", { size: 13 })}</span>`, `Search <span class="ml-0.5 inline-flex text-amber-400 align-[-2px]" title="Experimental" aria-label="Experimental">${renderIcon("flask-triangle", { size: 13 })}</span>`) },
  ];
  return `
    <div class="flex flex-wrap gap-2">
      ${tabs.map((t) => `
        <button data-doc-jump="${t.id}" class="rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${active === t.id ? "border-accent-green/40 bg-accent-green/12 text-txt-green" : "border-surface-3 bg-surface-2/60 text-slate-400 hover:text-slate-200"}">${t.label}</button>
      `).join("")}
    </div>`;
}
