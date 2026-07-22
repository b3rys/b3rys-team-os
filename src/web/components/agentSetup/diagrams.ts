// AgentSetup diagrams — SVG/grid HTML-string builders (2026-06-06 ④ split).
// Extracted from AgentSetup.ts; behavior unchanged.
import { renderIcon } from "../../icons";
import { escape, policyCard, flowStep, codeBlock } from "./ui-helpers";
import { pick } from "../../i18n";

function manualVars(extra = ""): string {
  return [
    "--m-card:rgb(var(--surface-3))",
    "--m-card-soft:rgb(var(--surface-2))",
    "--m-ink:rgb(var(--slate-100))",
    "--m-sub:rgb(var(--slate-500))",
    "--m-line:rgb(var(--border))",
    "--m-green:var(--txt-green)",
    "--m-amber:var(--txt-amber)",
    "--m-blue:var(--txt-blue)",
    "--m-violet:var(--txt-violet)",
    "--m-orange:var(--txt-orange)",
    "--m-green-t:color-mix(in srgb, var(--txt-green) 13%, rgb(var(--surface-3)))",
    "--m-amber-t:color-mix(in srgb, var(--txt-amber) 14%, rgb(var(--surface-3)))",
    "--m-blue-t:color-mix(in srgb, var(--txt-blue) 14%, rgb(var(--surface-3)))",
    "--m-violet-t:color-mix(in srgb, var(--txt-violet) 13%, rgb(var(--surface-3)))",
    "--m-orange-t:color-mix(in srgb, var(--txt-orange) 13%, rgb(var(--surface-3)))",
    "--m-slate-t:color-mix(in srgb, rgb(var(--slate-500)) 10%, rgb(var(--surface-3)))",
    extra,
  ].filter(Boolean).join(";");
}

function manualCard(title: string, subtitle: string, body: string): string {
  return `
    <div class="rounded-xl border border-surface-3 bg-surface-0 p-4" style="${manualVars()}">
      <div class="mb-3">
        <div class="text-sm font-semibold text-slate-100">${escape(title)}</div>
        <div class="mt-1 text-xs leading-5 text-slate-400">${escape(subtitle)}</div>
      </div>
      ${body}
    </div>`;
}

export function teamMapDiagram(): string {
  const agentNode = (x: number, y: number, name: string, role: string, tone: string) => `
    <rect x="${x}" y="${y}" width="148" height="62" rx="8" fill="${tone}" stroke="#334155" />
    <text x="${x + 74}" y="${y + 25}" text-anchor="middle" fill="#f8fafc" font-size="16" font-weight="700">${escape(name)}</text>
    <text x="${x + 74}" y="${y + 46}" text-anchor="middle" fill="#cbd5e1" font-size="11">${escape(role)}</text>`;
  return `
    <div class="rounded-xl border border-surface-3 bg-surface-0 p-4">
      <svg viewBox="0 0 980 480" class="h-auto w-full" role="img" aria-label="b3rys team map">
        <defs>
          <marker id="teamArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#34d399" />
          </marker>
        </defs>
        <rect x="0" y="0" width="980" height="480" rx="14" fill="#0b1220" />
        <rect x="390" y="24" width="200" height="70" rx="10" fill="#064e3b" stroke="#34d399" />
        <text x="490" y="54" text-anchor="middle" fill="#ecfdf5" font-size="20" font-weight="800">${pick("팀장", "The team lead")}</text>
        <text x="490" y="78" text-anchor="middle" fill="#a7f3d0" font-size="13">${pick("요청과 최종 결정", "Requests and final decisions")}</text>

        <rect x="96" y="136" width="270" height="76" rx="10" fill="#0f172a" stroke="#475569" />
        <text x="231" y="168" text-anchor="middle" fill="#e2e8f0" font-size="18" font-weight="700">${pick("1:1 직접 호출", "1:1 direct call")}</text>
        <text x="231" y="192" text-anchor="middle" fill="#94a3b8" font-size="13">${pick("팀장이 특정 팀원에게 바로 요청", "The team lead asks a specific member directly")}</text>

        <rect x="614" y="136" width="270" height="76" rx="10" fill="#0f172a" stroke="#475569" />
        <text x="749" y="168" text-anchor="middle" fill="#e2e8f0" font-size="18" font-weight="700">${pick("팀방 호출", "Team-room call")}</text>
        <text x="749" y="192" text-anchor="middle" fill="#94a3b8" font-size="13">${pick("모두가 같은 맥락을 보는 회의실", "A room where everyone sees the same context")}</text>

        ${agentNode(44, 286, "Alice", pick("접수 · 종합", "Intake · Synthesis"), "#111827")}
        ${agentNode(204, 286, "Bob", pick("인프라 · 운영", "Infra · Ops"), "#111827")}
        ${agentNode(364, 286, "Carol", pick("제품 구현", "Product build"), "#111827")}
        ${agentNode(524, 286, "Dave", pick("리서치", "Research"), "#111827")}
        ${agentNode(684, 286, "Erin", pick("데이터 분석", "Data analysis"), "#111827")}
        ${agentNode(844, 286, "Frank", pick("뉴스 · 트렌드", "News · Trends"), "#111827")}

        <line x1="430" y1="94" x2="286" y2="136" stroke="#38bdf8" stroke-width="3" marker-end="url(#teamArrow)" />
        <line x1="550" y1="94" x2="694" y2="136" stroke="#34d399" stroke-width="3" marker-end="url(#teamArrow)" />

        <path d="M231 212 C190 246 140 254 118 286" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-dasharray="7 7" marker-end="url(#teamArrow)" />
        <path d="M231 212 C236 246 266 254 278 286" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-dasharray="7 7" marker-end="url(#teamArrow)" />
        <path d="M231 212 C302 246 402 254 438 286" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-dasharray="7 7" marker-end="url(#teamArrow)" />
        <path d="M231 212 C350 250 548 252 598 286" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-dasharray="7 7" marker-end="url(#teamArrow)" />
        <path d="M231 212 C416 252 708 252 758 286" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-dasharray="7 7" marker-end="url(#teamArrow)" />
        <path d="M231 212 C480 254 868 252 918 286" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-dasharray="7 7" marker-end="url(#teamArrow)" />

        <path d="M749 212 C650 252 170 252 118 286" fill="none" stroke="#34d399" stroke-width="2" marker-end="url(#teamArrow)" />
        <path d="M749 212 C688 252 330 252 278 286" fill="none" stroke="#34d399" stroke-width="2" marker-end="url(#teamArrow)" />
        <path d="M749 212 C714 252 490 252 438 286" fill="none" stroke="#34d399" stroke-width="2" marker-end="url(#teamArrow)" />
        <path d="M749 212 C740 252 650 252 598 286" fill="none" stroke="#34d399" stroke-width="2" marker-end="url(#teamArrow)" />
        <path d="M749 212 C762 252 770 252 758 286" fill="none" stroke="#34d399" stroke-width="2" marker-end="url(#teamArrow)" />
        <path d="M749 212 C810 252 890 252 918 286" fill="none" stroke="#34d399" stroke-width="2" marker-end="url(#teamArrow)" />

        <rect x="232" y="410" width="18" height="4" rx="2" fill="#38bdf8" />
        <text x="258" y="417" fill="#cbd5e1" font-size="12">${pick("파란 점선: 팀장이 1:1로 바로 맡기는 흐름", "Blue dashed: the team lead assigns directly 1:1")}</text>
        <rect x="568" y="410" width="18" height="4" rx="2" fill="#34d399" />
        <text x="594" y="417" fill="#cbd5e1" font-size="12">${pick("초록 실선: 팀방에서 필요한 팀원을 깨우는 흐름", "Green solid: waking only the needed members from the team room")}</text>
      </svg>
      <p class="mt-3 text-xs leading-5 text-slate-400">
        ${pick(
          "팀장은 팀방에서 부를 수도 있고, 특정 팀원에게 1:1로 바로 맡길 수도 있습니다. 1:1로 받은 팀원은 그 요청의 담당자가 됩니다. 팀방 요청은 라우터나 담당자가 필요한 팀원만 깨워 답을 모읍니다.",
          "The team lead can call out in the team room, or assign a specific member directly 1:1. A member who receives a 1:1 request becomes that request's owner. For a team-room request, the router or the owner wakes only the needed members and gathers their answers.",
        )}
      </p>
    </div>`;
}

export function manualSystemDiagram(): string {
  return manualCard(
    "b3os 시스템 구조",
    "채널이 들어오고, 중앙 서버가 라우팅·기록하고, 각 런타임의 AI 팀원이 실행합니다.",
    `
      <svg viewBox="0 0 980 660" class="h-auto w-full" role="img" aria-label="b3os system architecture">
        <defs>
          <marker id="manualSysArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--m-sub)"/></marker>
          <marker id="manualSysGreenArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--m-green)"/></marker>
        </defs>

        <text x="95" y="30" text-anchor="middle" font-size="12" font-weight="800" fill="var(--m-sub)">채널 (입력)</text>
        <rect x="20" y="48" width="150" height="46" rx="9" fill="var(--m-violet-t)" stroke="var(--m-violet)"/>
        <text x="95" y="70" text-anchor="middle" font-size="13" font-weight="700" fill="var(--m-violet)">텔레그램</text>
        <text x="95" y="86" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">팀장 1:1 · 그룹방</text>
        <rect x="20" y="104" width="150" height="46" rx="9" fill="var(--m-violet-t)" stroke="var(--m-violet)"/>
        <text x="95" y="126" text-anchor="middle" font-size="13" font-weight="700" fill="var(--m-violet)">슬랙</text>
        <text x="95" y="142" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">소켓 · app_mention</text>
        <rect x="20" y="160" width="150" height="46" rx="9" fill="var(--m-violet-t)" stroke="var(--m-violet)"/>
        <text x="95" y="182" text-anchor="middle" font-size="13" font-weight="700" fill="var(--m-violet)">대시보드</text>
        <text x="95" y="198" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">웹 UI · 영입·설정</text>
        <line x1="170" y1="71" x2="242" y2="120" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#manualSysArrow)"/>
        <line x1="170" y1="127" x2="242" y2="127" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#manualSysArrow)"/>
        <line x1="170" y1="183" x2="242" y2="140" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#manualSysArrow)"/>

        <rect x="244" y="20" width="512" height="620" rx="14" fill="var(--m-blue-t)" stroke="var(--m-blue)" stroke-width="1.5"/>
        <text x="500" y="44" text-anchor="middle" font-size="14" font-weight="800" fill="var(--m-blue)">b3os 서버 · Bun / Hono</text>
        <rect x="262" y="58" width="476" height="52" rx="8" fill="var(--m-card)" stroke="var(--m-line)"/>
        <text x="278" y="78" font-size="11.5" font-weight="700" fill="var(--m-ink)">캡처 워커</text>
        <text x="278" y="96" font-size="10.5" fill="var(--m-sub)">텔레그램·슬랙 수신 · 1:1 DM 싱크(dmSyncWorker, 10초)</text>

        <rect x="262" y="124" width="150" height="60" rx="8" fill="var(--m-card)" stroke="var(--m-green)"/>
        <text x="337" y="148" text-anchor="middle" font-size="12.5" font-weight="750" fill="var(--m-green)">라우터 · Owner</text>
        <text x="337" y="166" text-anchor="middle" font-size="10" fill="var(--m-sub)">누가 답할지 결정</text>
        <line x1="412" y1="154" x2="426" y2="154" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#manualSysArrow)"/>
        <rect x="428" y="124" width="150" height="60" rx="8" fill="var(--m-card)" stroke="var(--m-green)"/>
        <text x="503" y="148" text-anchor="middle" font-size="12.5" font-weight="750" fill="var(--m-green)">버스 · Dispatcher</text>
        <text x="503" y="166" text-anchor="middle" font-size="10" fill="var(--m-sub)">깨우기 · 전달</text>
        <line x1="578" y1="154" x2="592" y2="154" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#manualSysArrow)"/>
        <rect x="594" y="124" width="144" height="60" rx="8" fill="var(--m-card)" stroke="var(--m-green)"/>
        <text x="666" y="148" text-anchor="middle" font-size="12.5" font-weight="750" fill="var(--m-green)">런타임 I/F</text>
        <text x="666" y="166" text-anchor="middle" font-size="10" fill="var(--m-sub)">어댑터 · 실행 위임</text>

        <text x="278" y="212" font-size="11.5" font-weight="700" fill="var(--m-amber)">백그라운드 배치 워커</text>
        <g font-size="10.5" fill="var(--m-ink)">
          <rect x="262" y="222" width="150" height="34" rx="6" fill="var(--m-amber-t)" stroke="var(--m-amber)"/><text x="337" y="243" text-anchor="middle">마감 추적(followup)</text>
          <rect x="424" y="222" width="150" height="34" rx="6" fill="var(--m-amber-t)" stroke="var(--m-amber)"/><text x="499" y="243" text-anchor="middle">정기 workloop</text>
          <rect x="586" y="222" width="152" height="34" rx="6" fill="var(--m-amber-t)" stroke="var(--m-amber)"/><text x="662" y="243" text-anchor="middle">헬스체크</text>
          <rect x="262" y="264" width="150" height="34" rx="6" fill="var(--m-amber-t)" stroke="var(--m-amber)"/><text x="337" y="285" text-anchor="middle">상태 probe</text>
          <rect x="424" y="264" width="150" height="34" rx="6" fill="var(--m-amber-t)" stroke="var(--m-amber)"/><text x="499" y="285" text-anchor="middle">제안 sweeper</text>
          <rect x="586" y="264" width="152" height="34" rx="6" fill="var(--m-amber-t)" stroke="var(--m-amber)"/><text x="662" y="285" text-anchor="middle">메시지 정리</text>
        </g>

        <rect x="262" y="322" width="476" height="300" rx="10" fill="var(--m-slate-t)" stroke="var(--m-line)"/>
        <text x="500" y="346" text-anchor="middle" font-size="12.5" font-weight="800" fill="var(--m-ink)">DB · SQLite (team.db)</text>
        <text x="500" y="364" text-anchor="middle" font-size="10" fill="var(--m-sub)">서버·워커가 함께 읽고 쓰는 단일 상태 저장소</text>
        <g font-size="10.5" fill="var(--m-ink)">
          <rect x="280" y="378" width="132" height="34" rx="6" fill="var(--m-card)" stroke="var(--m-line)"/><text x="346" y="399" text-anchor="middle">message</text>
          <rect x="424" y="378" width="132" height="34" rx="6" fill="var(--m-card)" stroke="var(--m-line)"/><text x="490" y="399" text-anchor="middle">dm_message</text>
          <rect x="568" y="378" width="152" height="34" rx="6" fill="var(--m-card)" stroke="var(--m-line)"/><text x="644" y="399" text-anchor="middle">message_recipient</text>
          <rect x="280" y="420" width="132" height="34" rx="6" fill="var(--m-card)" stroke="var(--m-line)"/><text x="346" y="441" text-anchor="middle">task</text>
          <rect x="424" y="420" width="132" height="34" rx="6" fill="var(--m-card)" stroke="var(--m-line)"/><text x="490" y="441" text-anchor="middle">approval_request</text>
          <rect x="568" y="420" width="152" height="34" rx="6" fill="var(--m-card)" stroke="var(--m-line)"/><text x="644" y="441" text-anchor="middle">pending_followup</text>
          <rect x="280" y="462" width="132" height="34" rx="6" fill="var(--m-card)" stroke="var(--m-line)"/><text x="346" y="483" text-anchor="middle">audit_event</text>
          <rect x="424" y="462" width="132" height="34" rx="6" fill="var(--m-card)" stroke="var(--m-line)"/><text x="490" y="483" text-anchor="middle">agent_status</text>
          <rect x="568" y="462" width="152" height="34" rx="6" fill="var(--m-card)" stroke="var(--m-line)"/><text x="644" y="483" text-anchor="middle">thread</text>
        </g>
        <text x="500" y="524" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">라우터·버스·배치 워커가 모두 이 DB를 통해 상태를 공유한다</text>
        <line x1="337" y1="184" x2="337" y2="318" stroke="var(--m-sub)" stroke-width="1" stroke-dasharray="3 3" marker-end="url(#manualSysArrow)"/>
        <line x1="503" y1="184" x2="503" y2="318" stroke="var(--m-sub)" stroke-width="1" stroke-dasharray="3 3" marker-end="url(#manualSysArrow)"/>
        <rect x="300" y="568" width="400" height="30" rx="7" fill="var(--m-card)" stroke="var(--m-line)"/>
        <text x="500" y="588" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">승인 게이트 · 검색(Team Search) · 메트릭 · MCP</text>

        <text x="880" y="30" text-anchor="middle" font-size="12" font-weight="800" fill="var(--m-sub)">런타임 (AI 팀원)</text>
        <line x1="738" y1="154" x2="798" y2="154" stroke="var(--m-green)" stroke-width="1.5" marker-end="url(#manualSysGreenArrow)"/>
        <g>
          <rect x="800" y="52" width="160" height="40" rx="8" fill="var(--m-green-t)" stroke="var(--m-green)"/><text x="880" y="70" text-anchor="middle" font-size="12" font-weight="700" fill="var(--m-green)">claude</text><text x="880" y="85" text-anchor="middle" font-size="9.5" fill="var(--m-sub)">Claude Code</text>
          <rect x="800" y="100" width="160" height="40" rx="8" fill="var(--m-green-t)" stroke="var(--m-green)"/><text x="880" y="118" text-anchor="middle" font-size="12" font-weight="700" fill="var(--m-green)">openclaw</text><text x="880" y="133" text-anchor="middle" font-size="9.5" fill="var(--m-sub)">게이트웨이 앱</text>
          <rect x="800" y="148" width="160" height="40" rx="8" fill="var(--m-green-t)" stroke="var(--m-green)"/><text x="880" y="166" text-anchor="middle" font-size="12" font-weight="700" fill="var(--m-green)">hermes</text><text x="880" y="181" text-anchor="middle" font-size="9.5" fill="var(--m-sub)">게이트웨이</text>
        </g>
        <path d="M800 264 Q770 340 756 340" fill="none" stroke="var(--m-green)" stroke-width="1.3" stroke-dasharray="4 3" marker-end="url(#manualSysGreenArrow)"/>
        <text x="812" y="308" font-size="9.5" fill="var(--m-sub)">답은 서버로 · 기록됨 ↩</text>
      </svg>
      <div class="mt-3 flex flex-wrap justify-center gap-3 text-xs text-slate-400">
        <span class="inline-flex items-center gap-1.5"><i class="h-2.5 w-2.5 rounded-sm bg-txt-violet"></i>채널</span>
        <span class="inline-flex items-center gap-1.5"><i class="h-2.5 w-2.5 rounded-sm bg-txt-green"></i>핵심 파이프 · 런타임</span>
        <span class="inline-flex items-center gap-1.5"><i class="h-2.5 w-2.5 rounded-sm bg-txt-amber"></i>백그라운드 배치</span>
        <span class="inline-flex items-center gap-1.5"><i class="h-2.5 w-2.5 rounded-sm bg-txt-blue"></i>서버 경계</span>
      </div>`,
  );
}

export function organizationLoopDiagram(): string {
  const step = (x: number, y: number, n: string, ko: string, en: string, tone: "green" | "amber" | "blue" | "violet") => `
    <g>
      <circle cx="${x}" cy="${y}" r="47" fill="var(--m-card)" stroke="var(--m-${tone})" stroke-width="1.3"/>
      <circle cx="${x - 29}" cy="${y - 29}" r="14" fill="var(--m-${tone})"/>
      <text x="${x - 29}" y="${y - 24}" text-anchor="middle" font-size="12" font-weight="800" fill="rgb(var(--surface-0))">${n}</text>
      <text x="${x}" y="${y - 4}" text-anchor="middle" font-size="14" font-weight="800" fill="var(--m-ink)">${escape(ko)}</text>
      <text x="${x}" y="${y + 18}" text-anchor="middle" font-size="10.5" font-weight="650" fill="var(--m-sub)">${escape(en)}</text>
    </g>`;

  return manualCard(
    pick("여러 AI를 한 명씩 따로 쓰지 말고, 한 팀으로", "Stop using several AIs one by one. Run them as a team."),
    pick("AI가 일하게 만드는 것뿐 아니라 담당·검증·보고·학습까지", "Not just getting AI to work, but carrying it through owner, verification, reporting, and learning."),
    `
      <svg viewBox="0 0 980 560" class="h-auto w-full" role="img" aria-label="b3os organization operating loop">
        <defs>
          <marker id="orgLoopArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--m-sub)"/></marker>
          <marker id="orgLoopGreenArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--m-green)"/></marker>
        </defs>

        <path d="M142 168 C218 72 384 62 466 144 C548 62 714 72 790 168 C882 286 798 450 640 454 C562 456 500 424 466 370 C432 424 370 456 292 454 C134 450 50 286 142 168 Z" fill="none" stroke="var(--m-line)" stroke-width="18" stroke-linecap="round" opacity="0.42"/>
        <path d="M142 168 C218 72 384 62 466 144 C548 62 714 72 790 168 C882 286 798 450 640 454 C562 456 500 424 466 370 C432 424 370 456 292 454 C134 450 50 286 142 168 Z" fill="none" stroke="var(--m-sub)" stroke-width="1.8" stroke-dasharray="2 10" stroke-linecap="round"/>

        <path d="M196 155 C265 88 370 88 432 148" fill="none" stroke="var(--m-sub)" stroke-width="2" marker-end="url(#orgLoopArrow)"/>
        <path d="M522 148 C588 88 694 88 756 155" fill="none" stroke="var(--m-sub)" stroke-width="2" marker-end="url(#orgLoopArrow)"/>
        <path d="M792 221 C836 285 812 377 744 411" fill="none" stroke="var(--m-sub)" stroke-width="2" marker-end="url(#orgLoopArrow)"/>
        <path d="M659 430 C600 454 540 433 506 388" fill="none" stroke="var(--m-sub)" stroke-width="2" marker-end="url(#orgLoopArrow)"/>
        <path d="M426 388 C392 433 332 454 273 430" fill="none" stroke="var(--m-sub)" stroke-width="2" marker-end="url(#orgLoopArrow)"/>
        <path d="M206 407 C142 372 116 291 150 224" fill="none" stroke="var(--m-sub)" stroke-width="2" marker-end="url(#orgLoopArrow)"/>
        <path d="M146 320 C104 370 100 440 146 468 C190 494 248 482 292 438" fill="none" stroke="var(--m-green)" stroke-width="2.8" marker-end="url(#orgLoopGreenArrow)"/>
        <path d="M144 378 C92 310 82 216 139 171" fill="none" stroke="var(--m-green)" stroke-width="2.8" marker-end="url(#orgLoopGreenArrow)"/>

        ${step(160, 174, "1", "담당자 배정", "Assign owner", "green")}
        ${step(466, 158, "2", "접수", "Ack", "green")}
        ${step(790, 174, "3", "위임", "Handoff", "amber")}
        ${step(816, 302, "4", "실행", "Execute", "blue")}
        ${step(690, 426, "5", "검증", "Verify", "blue")}
        ${step(490, 414, "6", "보고", "Report", "violet")}
        ${step(300, 426, "7", "종료", "Close", "violet")}
        ${step(174, 302, "8", "감사", "Audit", "violet")}
        ${step(160, 440, "9", "학습", "Learning", "green")}

        <rect x="340" y="244" width="304" height="74" rx="8" fill="var(--m-card)" stroke="var(--m-line)"/>
        <text x="492" y="273" text-anchor="middle" font-size="17" font-weight="850" fill="var(--m-ink)">AI 팀 운영체계</text>
        <text x="492" y="293" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">실행은 검증되고, 보고와 종료 후 감사·학습이</text>
        <text x="492" y="309" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">다음 담당자 배정으로 돌아갑니다.</text>

        <g font-size="10.5" fill="var(--m-sub)">
          <circle cx="278" cy="514" r="5" fill="var(--m-green)"/><text x="292" y="518">human-led</text>
          <circle cx="406" cy="514" r="5" fill="var(--m-amber)"/><text x="420" y="518">owner-driven</text>
          <circle cx="558" cy="514" r="5" fill="var(--m-blue)"/><text x="572" y="518">AI execution</text>
          <circle cx="714" cy="514" r="5" fill="var(--m-violet)"/><text x="728" y="518">audit-able closure</text>
        </g>
      </svg>`,
  );
}

export function messageRoundTripDiagram(): string {
  return manualCard("한눈에 보는 시스템", "나 → b3os 서버 → AI 팀원 → 다시 나에게 돌아오는 왕복 흐름입니다.", `
    <p class="mb-3 text-sm leading-6 text-slate-300">내 메시지는 <span class="font-semibold text-txt-green">b3os 서버</span>를 거쳐 담당 팀원에게 가고, 팀원의 답은 다시 나에게 돌아옵니다. 그 사이 누가 답할지와 무엇을 기록할지를 서버가 정합니다.</p>
    <svg viewBox="0 0 820 200" class="h-auto w-full" role="img" aria-label="message round trip">
      <defs><marker id="roundTripArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--m-sub)"/></marker></defs>
      <rect x="18" y="74" width="120" height="52" rx="9" fill="var(--m-card)" stroke="var(--m-line)"/>
      <text x="78" y="98" text-anchor="middle" font-size="14" font-weight="700" fill="var(--m-ink)">팀장 (나)</text>
      <text x="78" y="115" text-anchor="middle" font-size="11" fill="var(--m-sub)">텔레그램·슬랙</text>
      <line x1="140" y1="100" x2="228" y2="100" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#roundTripArrow)"/>
      <rect x="230" y="40" width="300" height="120" rx="11" fill="var(--m-blue-t)" stroke="var(--m-blue)"/>
      <text x="380" y="62" text-anchor="middle" font-size="13" font-weight="800" fill="var(--m-blue)">b3os 서버</text>
      <rect x="252" y="78" width="120" height="30" rx="6" fill="var(--m-card)" stroke="var(--m-line)"/>
      <text x="312" y="98" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--m-ink)">라우터 · Owner</text>
      <rect x="388" y="78" width="120" height="30" rx="6" fill="var(--m-card)" stroke="var(--m-line)"/>
      <text x="448" y="98" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--m-ink)">버스 · 기록(DB)</text>
      <text x="380" y="140" text-anchor="middle" font-size="11" fill="var(--m-sub)">누가 답할지 정하고 · 오간 말을 남긴다</text>
      <line x1="530" y1="100" x2="618" y2="100" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#roundTripArrow)"/>
      <rect x="620" y="40" width="182" height="52" rx="9" fill="var(--m-green-t)" stroke="var(--m-green)"/>
      <text x="711" y="64" text-anchor="middle" font-size="13" font-weight="800" fill="var(--m-green)">AI 팀원들</text>
      <text x="711" y="81" text-anchor="middle" font-size="11" fill="var(--m-sub)">각자 런타임 · 봇</text>
      <rect x="620" y="108" width="182" height="52" rx="9" fill="var(--m-green-t)" stroke="var(--m-green)"/>
      <text x="711" y="130" text-anchor="middle" font-size="11" fill="var(--m-sub)">답은 온 곳으로</text>
      <text x="711" y="146" text-anchor="middle" font-size="11" fill="var(--m-sub)">되돌아온다 ↩</text>
      <line x1="620" y1="134" x2="140" y2="126" stroke="var(--m-green)" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#roundTripArrow)"/>
    </svg>`);
}

export function ownerResolutionDiagram(): string {
  return manualCard("팀방에서 누가 답하나", "주소를 고르기 전에 owner 판정이 먼저 옵니다.", `
    <p class="mb-3 text-sm leading-6 text-slate-300">서버가 담당자(owner)를 정해 그 사람만 답합니다. 순서는 <span class="font-semibold text-txt-green">@멘션 → 답장한 원글 작성자 → 직전 담당자 → 역할 폴백</span>입니다.</p>
    <svg viewBox="0 0 820 120" class="h-auto w-full" role="img" aria-label="owner resolution order">
      <defs><marker id="ownerManualArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--m-sub)"/></marker></defs>
      <rect x="14" y="40" width="150" height="42" rx="8" fill="var(--m-green-t)" stroke="var(--m-green)"/>
      <text x="89" y="60" text-anchor="middle" font-size="12.5" font-weight="700" fill="var(--m-ink)">1. @멘션 있나?</text>
      <text x="89" y="75" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">있으면 그 사람</text>
      <line x1="166" y1="61" x2="204" y2="61" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#ownerManualArrow)"/>
      <rect x="206" y="40" width="160" height="42" rx="8" fill="var(--m-card)" stroke="var(--m-line)"/>
      <text x="286" y="60" text-anchor="middle" font-size="12.5" font-weight="700" fill="var(--m-ink)">2. 답장이면?</text>
      <text x="286" y="75" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">원글 작성자</text>
      <line x1="368" y1="61" x2="406" y2="61" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#ownerManualArrow)"/>
      <rect x="408" y="40" width="160" height="42" rx="8" fill="var(--m-card)" stroke="var(--m-line)"/>
      <text x="488" y="60" text-anchor="middle" font-size="12.5" font-weight="700" fill="var(--m-ink)">3. 그것도 없으면</text>
      <text x="488" y="75" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">직전 담당자 유지</text>
      <line x1="570" y1="61" x2="608" y2="61" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#ownerManualArrow)"/>
      <rect x="610" y="40" width="196" height="42" rx="8" fill="var(--m-amber-t)" stroke="var(--m-amber)"/>
      <text x="708" y="60" text-anchor="middle" font-size="12.5" font-weight="700" fill="var(--m-amber)">4. 역할로 정함</text>
      <text x="708" y="75" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">coordinator 폴백</text>
    </svg>`);
}

export function collectionVsIndividualDiagram(): string {
  return `
    <div class="grid grid-cols-1 gap-3 md:grid-cols-2" style="${manualVars()}">
      <div class="rounded-xl border border-surface-3 bg-surface-0 p-4">
        <div class="mb-1 text-sm font-semibold text-txt-green">취합 (collection)</div>
        <p class="mb-3 text-xs leading-5 text-slate-400">"물어보고 정리해서 보고해" = 담당 1명이 모아 하나로 보고합니다.</p>
        <svg viewBox="0 0 360 150" class="h-auto w-full" role="img" aria-label="collection flow">
          <defs><marker id="collectionArrow" markerWidth="7" markerHeight="7" refX="5" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 Z" fill="var(--m-sub)"/></marker><marker id="collectionGreenArrow" markerWidth="7" markerHeight="7" refX="5" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 Z" fill="var(--m-green)"/></marker></defs>
          <rect x="12" y="58" width="86" height="36" rx="7" fill="var(--m-card)" stroke="var(--m-line)"/><text x="55" y="80" text-anchor="middle" font-size="11" font-weight="700" fill="var(--m-ink)">담당 1명</text>
          <line x1="100" y1="66" x2="150" y2="40" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#collectionArrow)"/><line x1="100" y1="76" x2="150" y2="76" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#collectionArrow)"/><line x1="100" y1="86" x2="150" y2="112" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#collectionArrow)"/>
          <rect x="152" y="26" width="70" height="28" rx="6" fill="var(--m-card)" stroke="var(--m-line)"/><text x="187" y="45" text-anchor="middle" font-size="10" fill="var(--m-sub)">팀원A</text>
          <rect x="152" y="62" width="70" height="28" rx="6" fill="var(--m-card)" stroke="var(--m-line)"/><text x="187" y="81" text-anchor="middle" font-size="10" fill="var(--m-sub)">팀원B</text>
          <rect x="152" y="98" width="70" height="28" rx="6" fill="var(--m-card)" stroke="var(--m-line)"/><text x="187" y="117" text-anchor="middle" font-size="10" fill="var(--m-sub)">팀원C</text>
          <line x1="224" y1="40" x2="270" y2="70" stroke="var(--m-green)" stroke-width="1.5" marker-end="url(#collectionGreenArrow)"/><line x1="224" y1="76" x2="270" y2="76" stroke="var(--m-green)" stroke-width="1.5" marker-end="url(#collectionGreenArrow)"/><line x1="224" y1="112" x2="270" y2="82" stroke="var(--m-green)" stroke-width="1.5" marker-end="url(#collectionGreenArrow)"/>
          <rect x="272" y="58" width="80" height="36" rx="7" fill="var(--m-green-t)" stroke="var(--m-green)"/><text x="312" y="74" text-anchor="middle" font-size="11" font-weight="700" fill="var(--m-green)">종합 1개</text><text x="312" y="87" text-anchor="middle" font-size="9.5" fill="var(--m-sub)">→ 팀장께</text>
        </svg>
      </div>
      <div class="rounded-xl border border-surface-3 bg-surface-0 p-4">
        <div class="mb-1 text-sm font-semibold text-txt-orange">개별보고 (individual)</div>
        <p class="mb-3 text-xs leading-5 text-slate-400">"각자 나한테 보고하라고 해" = 각 팀원이 따로따로 보고합니다.</p>
        <svg viewBox="0 0 360 150" class="h-auto w-full" role="img" aria-label="individual report flow">
          <defs><marker id="individualArrow" markerWidth="7" markerHeight="7" refX="5" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 Z" fill="var(--m-sub)"/></marker><marker id="individualOrangeArrow" markerWidth="7" markerHeight="7" refX="5" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 Z" fill="var(--m-orange)"/></marker></defs>
          <rect x="12" y="58" width="86" height="36" rx="7" fill="var(--m-card)" stroke="var(--m-line)"/><text x="55" y="80" text-anchor="middle" font-size="11" font-weight="700" fill="var(--m-ink)">위임자</text>
          <line x1="100" y1="66" x2="150" y2="40" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#individualArrow)"/><line x1="100" y1="76" x2="150" y2="76" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#individualArrow)"/><line x1="100" y1="86" x2="150" y2="112" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#individualArrow)"/>
          <rect x="152" y="26" width="70" height="28" rx="6" fill="var(--m-card)" stroke="var(--m-line)"/><text x="187" y="45" text-anchor="middle" font-size="10" fill="var(--m-sub)">팀원A</text>
          <rect x="152" y="62" width="70" height="28" rx="6" fill="var(--m-card)" stroke="var(--m-line)"/><text x="187" y="81" text-anchor="middle" font-size="10" fill="var(--m-sub)">팀원B</text>
          <rect x="152" y="98" width="70" height="28" rx="6" fill="var(--m-card)" stroke="var(--m-line)"/><text x="187" y="117" text-anchor="middle" font-size="10" fill="var(--m-sub)">팀원C</text>
          <line x1="224" y1="40" x2="300" y2="46" stroke="var(--m-orange)" stroke-width="1.5" marker-end="url(#individualOrangeArrow)"/><line x1="224" y1="76" x2="300" y2="76" stroke="var(--m-orange)" stroke-width="1.5" marker-end="url(#individualOrangeArrow)"/><line x1="224" y1="112" x2="300" y2="106" stroke="var(--m-orange)" stroke-width="1.5" marker-end="url(#individualOrangeArrow)"/>
          <rect x="302" y="32" width="52" height="88" rx="7" fill="var(--m-amber-t)" stroke="var(--m-orange)"/><text x="328" y="72" text-anchor="middle" font-size="11" font-weight="700" fill="var(--m-orange)">팀장</text><text x="328" y="88" text-anchor="middle" font-size="9.5" fill="var(--m-sub)">각자</text><text x="328" y="100" text-anchor="middle" font-size="9.5" fill="var(--m-sub)">직접</text>
        </svg>
      </div>
    </div>`;
}

export function oneToOneMemoryDiagram(): string {
  return manualCard("1:1 대화 기억", "팀 채널에 없는 1:1 대화도 팀원 저장소 싱크를 통해 나중에 되짚을 수 있습니다.", `
    <svg viewBox="0 0 820 120" class="h-auto w-full" role="img" aria-label="one to one memory sync">
      <defs><marker id="oneMemoryArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--m-sub)"/></marker><marker id="oneMemoryGreenArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--m-green)"/></marker></defs>
      <rect x="14" y="42" width="150" height="44" rx="8" fill="var(--m-violet-t)" stroke="var(--m-violet)"/><text x="89" y="62" text-anchor="middle" font-size="12.5" font-weight="700" fill="var(--m-violet)">팀장 1:1 대화</text><text x="89" y="78" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">팀 채널엔 없음</text>
      <line x1="164" y1="64" x2="204" y2="64" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#oneMemoryArrow)"/>
      <rect x="206" y="42" width="170" height="44" rx="8" fill="var(--m-card)" stroke="var(--m-line)"/><text x="291" y="62" text-anchor="middle" font-size="12.5" font-weight="700" fill="var(--m-ink)">팀원 저장소</text><text x="291" y="78" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">런타임마다 다름</text>
      <line x1="376" y1="64" x2="440" y2="64" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#oneMemoryArrow)"/><text x="408" y="55" text-anchor="middle" font-size="10" fill="var(--m-sub)">10초마다</text>
      <rect x="442" y="42" width="180" height="44" rx="8" fill="var(--m-card)" stroke="var(--m-line)"/><text x="532" y="62" text-anchor="middle" font-size="12" font-weight="700" fill="var(--m-ink)">b3os 싱크 워커</text><text x="532" y="78" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">긁어서 옮김</text>
      <line x1="622" y1="64" x2="662" y2="64" stroke="var(--m-green)" stroke-width="1.5" marker-end="url(#oneMemoryGreenArrow)"/>
      <rect x="664" y="42" width="142" height="44" rx="8" fill="var(--m-green-t)" stroke="var(--m-green)"/><text x="735" y="62" text-anchor="middle" font-size="12.5" font-weight="700" fill="var(--m-green)">기억됨</text><text x="735" y="78" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">나중에 되짚기</text>
    </svg>`);
}

export function sleepPreventionDiagram(): string {
  return manualCard("팀원 잠수 방지", "나중에 보고하겠다는 약속은 마감 안전망에 걸려 조용히 증발하지 않습니다.", `
    <svg viewBox="0 0 820 120" class="h-auto w-full" role="img" aria-label="sleep prevention followup">
      <defs><marker id="sleepArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--m-sub)"/></marker><marker id="sleepGreenArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--m-green)"/></marker></defs>
      <rect x="14" y="42" width="130" height="44" rx="8" fill="var(--m-card)" stroke="var(--m-line)"/><text x="79" y="62" text-anchor="middle" font-size="12" font-weight="700" fill="var(--m-ink)">위임</text><text x="79" y="78" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">"이거 해줘"</text>
      <line x1="144" y1="64" x2="184" y2="64" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#sleepArrow)"/>
      <rect x="186" y="42" width="150" height="44" rx="8" fill="var(--m-card)" stroke="var(--m-line)"/><text x="261" y="62" text-anchor="middle" font-size="12" font-weight="700" fill="var(--m-ink)">"나중에 보고"</text><text x="261" y="78" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">그리고 조용</text>
      <line x1="336" y1="64" x2="376" y2="64" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#sleepArrow)"/>
      <rect x="378" y="42" width="140" height="44" rx="8" fill="var(--m-amber-t)" stroke="var(--m-amber)"/><text x="448" y="62" text-anchor="middle" font-size="12" font-weight="700" fill="var(--m-amber)">마감 지남</text><text x="448" y="78" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">서버가 감지</text>
      <line x1="518" y1="64" x2="558" y2="64" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#sleepArrow)"/>
      <rect x="560" y="42" width="120" height="44" rx="8" fill="var(--m-card)" stroke="var(--m-line)"/><text x="620" y="62" text-anchor="middle" font-size="12" font-weight="700" fill="var(--m-ink)">1번 깨움</text><text x="620" y="78" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">딱 한 번</text>
      <line x1="680" y1="64" x2="720" y2="64" stroke="var(--m-green)" stroke-width="1.5" marker-end="url(#sleepGreenArrow)"/>
      <rect x="722" y="42" width="84" height="44" rx="8" fill="var(--m-green-t)" stroke="var(--m-green)"/><text x="764" y="60" text-anchor="middle" font-size="11" font-weight="700" fill="var(--m-green)">미응답</text><text x="764" y="76" text-anchor="middle" font-size="10" fill="var(--m-sub)">팀장께 알림</text>
    </svg>`);
}

export function approvalGateDiagram(): string {
  return manualCard("승인 게이트", "배포·삭제·외부 전송 같은 위험한 작업은 팀장 승인 뒤에만 실행합니다.", `
    <svg viewBox="0 0 820 150" class="h-auto w-full" role="img" aria-label="approval gate">
      <defs><marker id="approvalArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--m-sub)"/></marker><marker id="approvalGreenArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--m-green)"/></marker></defs>
      <rect x="14" y="20" width="170" height="46" rx="8" fill="var(--m-amber-t)" stroke="var(--m-amber)"/><text x="99" y="40" text-anchor="middle" font-size="12" font-weight="700" fill="var(--m-amber)">위험한 작업</text><text x="99" y="56" text-anchor="middle" font-size="10" fill="var(--m-sub)">배포·삭제·외부송신·결제</text>
      <line x1="184" y1="43" x2="224" y2="43" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#approvalArrow)"/>
      <rect x="226" y="20" width="140" height="46" rx="8" fill="var(--m-card)" stroke="var(--m-line)"/><text x="296" y="40" text-anchor="middle" font-size="12" font-weight="700" fill="var(--m-ink)">승인 요청</text><text x="296" y="56" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">범위·이유 알림</text>
      <line x1="366" y1="43" x2="406" y2="43" stroke="var(--m-sub)" stroke-width="1.5" marker-end="url(#approvalArrow)"/>
      <rect x="408" y="20" width="120" height="46" rx="8" fill="var(--m-card)" stroke="var(--m-line)"/><text x="468" y="40" text-anchor="middle" font-size="12" font-weight="700" fill="var(--m-ink)">팀장 확인</text><text x="468" y="56" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">승인</text>
      <line x1="528" y1="43" x2="568" y2="43" stroke="var(--m-green)" stroke-width="1.5" marker-end="url(#approvalGreenArrow)"/>
      <rect x="570" y="20" width="150" height="46" rx="8" fill="var(--m-green-t)" stroke="var(--m-green)"/><text x="645" y="40" text-anchor="middle" font-size="12" font-weight="700" fill="var(--m-green)">그제야 실행</text><text x="645" y="56" text-anchor="middle" font-size="10.5" fill="var(--m-sub)">승인 후에만</text>
      <rect x="14" y="90" width="330" height="44" rx="8" fill="var(--m-green-t)" stroke="var(--m-green)"/><text x="34" y="110" font-size="11.5" font-weight="700" fill="var(--m-green)">팀원끼리 팀 안에서 얘기 · 정리 · 보고</text><text x="34" y="126" font-size="10.5" fill="var(--m-sub)">= 승인 불필요 (팀 내부 일상 협업)</text>
      <text x="360" y="115" font-size="11" fill="var(--m-sub)">팀 밖으로 나가는 것만 승인 대상</text>
    </svg>`);
}

export function architectureDiagram(): string {
  return `
    <div class="rounded-xl border border-surface-3 bg-surface-0 p-4">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div class="text-sm font-semibold text-slate-100">team-collab system architecture diagram</div>
          <div class="mt-1 text-xs leading-5 text-slate-400">${pick("외부 채널, 중앙 서비스 경계, 라우터/버스/DB, 런타임, 보이는 응답 경로를 한 장에 묶은 구조도입니다. 박스를 클릭하면 같은 카드 아래에 상세 설명이 뜹니다.", "A one-page architecture diagram tying together external channels, the central service boundary, router/bus/DB, runtimes, and the visible reply path. Click a box to see its detail below the same card.")}</div>
        </div>
        <div class="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] text-txt-green">central service :7878</div>
      </div>

      <svg viewBox="0 0 1120 620" class="h-auto w-full" role="img" aria-label="team-collab system architecture diagram">
        <defs>
          <marker id="archArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#34d399" />
          </marker>
          <marker id="archBlueArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#38bdf8" />
          </marker>
          <marker id="archAmberArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#f59e0b" />
          </marker>
          <filter id="archShadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="#020617" flood-opacity="0.35" />
          </filter>
        </defs>

        <rect x="20" y="18" width="1080" height="584" rx="16" fill="#08111f" stroke="#1f2937" />
        <rect x="226" y="64" width="644" height="458" rx="18" fill="#0b1220" stroke="#64748b" stroke-width="2" stroke-dasharray="10 8" />
        <text x="250" y="96" fill="#e2e8f0" font-size="22" font-weight="800">team-collab Core</text>
        <text x="250" y="118" fill="#94a3b8" font-size="12">Bun/Hono service, dashboard, router, bus, workers, SQLite state</text>

        <rect x="54" y="96" width="130" height="74" rx="10" fill="#0f172a" stroke="#38bdf8" filter="url(#archShadow)" />
        <text x="119" y="126" text-anchor="middle" fill="#e0f2fe" font-size="16" font-weight="800">Telegram</text>
        <text x="119" y="149" text-anchor="middle" fill="#bae6fd" font-size="12">team room · DM</text>

        <rect x="54" y="206" width="130" height="74" rx="10" fill="#0f172a" stroke="#38bdf8" filter="url(#archShadow)" />
        <text x="119" y="236" text-anchor="middle" fill="#e0f2fe" font-size="16" font-weight="800">Slack</text>
        <text x="119" y="259" text-anchor="middle" fill="#bae6fd" font-size="12">relay · poll</text>

        <rect x="54" y="350" width="130" height="74" rx="10" fill="#111827" stroke="#475569" filter="url(#archShadow)" />
        <text x="119" y="380" text-anchor="middle" fill="#e2e8f0" font-size="16" font-weight="800">${pick("대시보드", "Dashboard")}</text>
        <text x="119" y="403" text-anchor="middle" fill="#94a3b8" font-size="12">read/status UI</text>

        <rect x="260" y="160" width="154" height="76" rx="10" fill="#082f49" stroke="#38bdf8" filter="url(#archShadow)" />
        <text x="337" y="190" text-anchor="middle" fill="#e0f2fe" font-size="15" font-weight="800">Capture Workers</text>
        <text x="337" y="212" text-anchor="middle" fill="#bae6fd" font-size="12">${pick("원문 저장 · audit", "Store originals · audit")}</text>

        <rect x="260" y="292" width="154" height="76" rx="10" fill="#082f49" stroke="#38bdf8" filter="url(#archShadow)" />
        <text x="337" y="322" text-anchor="middle" fill="#e0f2fe" font-size="15" font-weight="800">Public API</text>
        <text x="337" y="344" text-anchor="middle" fill="#bae6fd" font-size="12">/team/api/*</text>

        <rect x="484" y="128" width="166" height="76" rx="10" fill="#064e3b" stroke="#34d399" filter="url(#archShadow)" />
        <text x="567" y="158" text-anchor="middle" fill="#ecfdf5" font-size="15" font-weight="800">Router / Owner Gate</text>
        <text x="567" y="180" text-anchor="middle" fill="#a7f3d0" font-size="12">@mention · reply · sticky</text>

        <rect x="484" y="248" width="166" height="76" rx="10" fill="#064e3b" stroke="#34d399" filter="url(#archShadow)" />
        <text x="567" y="278" text-anchor="middle" fill="#ecfdf5" font-size="15" font-weight="800">Team Bus</text>
        <text x="567" y="300" text-anchor="middle" fill="#a7f3d0" font-size="12">inbox · outbox · lease</text>

        <rect x="484" y="376" width="166" height="76" rx="10" fill="#3b2b08" stroke="#f59e0b" filter="url(#archShadow)" />
        <text x="567" y="406" text-anchor="middle" fill="#fde68a" font-size="15" font-weight="800">wakeDispatcher</text>
        <text x="567" y="428" text-anchor="middle" fill="#fcd34d" font-size="12">pending recipient wake</text>

        <path d="M714 260 C714 244 824 244 824 260 L824 406 C824 424 714 424 714 406 Z" fill="#151226" stroke="#a78bfa" stroke-width="2" filter="url(#archShadow)" />
        <ellipse cx="769" cy="260" rx="55" ry="18" fill="#211b3d" stroke="#a78bfa" stroke-width="2" />
        <text x="769" y="310" text-anchor="middle" fill="#ede9fe" font-size="16" font-weight="800">SQLite</text>
        <text x="769" y="333" text-anchor="middle" fill="#c4b5fd" font-size="12">team.db</text>
        <text x="769" y="354" text-anchor="middle" fill="#a78bfa" font-size="11">messages · tasks</text>
        <text x="769" y="374" text-anchor="middle" fill="#a78bfa" font-size="11">audit · search index</text>

        <rect x="912" y="88" width="150" height="74" rx="10" fill="#111827" stroke="#f59e0b" filter="url(#archShadow)" />
        <text x="987" y="118" text-anchor="middle" fill="#fde68a" font-size="15" font-weight="800">Claude Channel</text>
        <text x="987" y="141" text-anchor="middle" fill="#fcd34d" font-size="12">tmux runtimes</text>

        <rect x="912" y="216" width="150" height="74" rx="10" fill="#111827" stroke="#34d399" filter="url(#archShadow)" />
        <text x="987" y="246" text-anchor="middle" fill="#ecfdf5" font-size="15" font-weight="800">OpenClaw</text>
        <text x="987" y="269" text-anchor="middle" fill="#a7f3d0" font-size="12">gateway · sessions</text>

        <rect x="912" y="344" width="150" height="74" rx="10" fill="#111827" stroke="#38bdf8" filter="url(#archShadow)" />
        <text x="987" y="374" text-anchor="middle" fill="#e0f2fe" font-size="15" font-weight="800">Visible Reply</text>
        <text x="987" y="397" text-anchor="middle" fill="#bae6fd" font-size="12">Telegram · Slack</text>

        <rect x="286" y="540" width="130" height="34" rx="8" fill="#0f172a" stroke="#38bdf8" />
        <text x="351" y="562" text-anchor="middle" fill="#bae6fd" font-size="12" font-weight="700">capture/read</text>
        <rect x="482" y="540" width="130" height="34" rx="8" fill="#0f172a" stroke="#34d399" />
        <text x="547" y="562" text-anchor="middle" fill="#a7f3d0" font-size="12" font-weight="700">routing/state</text>
        <rect x="678" y="540" width="130" height="34" rx="8" fill="#0f172a" stroke="#f59e0b" />
        <text x="743" y="562" text-anchor="middle" fill="#fcd34d" font-size="12" font-weight="700">runtime wake</text>

        <path d="M184 132 C214 132 230 182 260 190" fill="none" stroke="#38bdf8" stroke-width="3" marker-end="url(#archBlueArrow)" />
        <path d="M184 244 C214 244 230 214 260 206" fill="none" stroke="#38bdf8" stroke-width="3" marker-end="url(#archBlueArrow)" />
        <path d="M184 386 C220 386 234 330 260 330" fill="none" stroke="#38bdf8" stroke-width="2.5" marker-end="url(#archBlueArrow)" />
        <path d="M414 198 C444 198 452 166 484 166" fill="none" stroke="#34d399" stroke-width="3" marker-end="url(#archArrow)" />
        <path d="M650 166 C700 166 712 230 746 248" fill="none" stroke="#34d399" stroke-width="2.5" marker-end="url(#archArrow)" />
        <path d="M414 330 C454 330 454 286 484 286" fill="none" stroke="#34d399" stroke-width="3" marker-end="url(#archArrow)" />
        <path d="M650 286 C676 286 688 286 714 286" fill="none" stroke="#34d399" stroke-width="3" marker-end="url(#archArrow)" />
        <path d="M714 370 C684 384 680 414 650 414" fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-dasharray="8 7" marker-end="url(#archAmberArrow)" />
        <path d="M650 414 C770 456 848 388 912 382" fill="none" stroke="#38bdf8" stroke-width="2.5" marker-end="url(#archBlueArrow)" />
        <path d="M650 394 C760 390 850 260 912 254" fill="none" stroke="#34d399" stroke-width="2.5" marker-end="url(#archArrow)" />
        <path d="M650 394 C760 360 850 130 912 126" fill="none" stroke="#f59e0b" stroke-width="2.5" marker-end="url(#archAmberArrow)" />
        <path d="M912 382 C840 500 260 488 184 406" fill="none" stroke="#38bdf8" stroke-width="2" stroke-dasharray="7 7" marker-end="url(#archBlueArrow)" />

        <g aria-label="clickable component targets">
          <rect data-arch-node="telegram" class="arch-click-target" x="54" y="96" width="130" height="74" rx="10" />
          <rect data-arch-node="slack" class="arch-click-target" x="54" y="206" width="130" height="74" rx="10" />
          <rect data-arch-node="dashboard" class="arch-click-target" x="54" y="350" width="130" height="74" rx="10" />
          <rect data-arch-node="capture" class="arch-click-target" x="260" y="160" width="154" height="76" rx="10" />
          <rect data-arch-node="api" class="arch-click-target" x="260" y="292" width="154" height="76" rx="10" />
          <rect data-arch-node="router" class="arch-click-target" x="484" y="128" width="166" height="76" rx="10" />
          <rect data-arch-node="bus" class="arch-click-target" x="484" y="248" width="166" height="76" rx="10" />
          <rect data-arch-node="wake" class="arch-click-target" x="484" y="376" width="166" height="76" rx="10" />
          <rect data-arch-node="db" class="arch-click-target" x="714" y="242" width="110" height="184" rx="18" />
          <rect data-arch-node="claude" class="arch-click-target" x="912" y="88" width="150" height="74" rx="10" />
          <rect data-arch-node="openclaw" class="arch-click-target" x="912" y="216" width="150" height="74" rx="10" />
          <rect data-arch-node="visible" class="arch-click-target" x="912" y="344" width="150" height="74" rx="10" />
        </g>
      </svg>

      <div class="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div data-arch-info-panel class="rounded-xl border border-surface-3 bg-surface-2/70 p-4">
          <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">component detail</div>
          <div data-arch-info-title class="mt-1 text-base font-semibold text-slate-100">Router / Owner Gate</div>
          <div data-arch-info-body class="mt-2 text-sm leading-7 text-slate-300">
            ${pick("누가 답해야 하는지 결정하는 중앙 판단 지점입니다. @멘션, reply owner(답장 원문 작성자), sticky owner(직전 담당자), 기본 접수자를 이 순서로 봅니다.", "The central decision point for who should answer. It checks @mention, reply owner (author of the message being replied to), sticky owner (the previous owner), then the default intake owner, in that order.")}
          </div>
          <div data-arch-info-files class="mt-3 flex flex-wrap gap-2 text-xs text-slate-400">
            <code>src/server/lib/teamRouter.ts</code>
            <code>src/server/lib/teamRouter/*</code>
          </div>
        </div>
        <div class="rounded-xl border border-surface-3 bg-surface-2/70 p-3">
          <div class="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">click targets</div>
          <div class="grid grid-cols-2 gap-2 text-xs">
            <button data-arch-node="capture" class="arch-chip">Capture</button>
            <button data-arch-node="router" class="arch-chip" data-selected="true">Router</button>
            <button data-arch-node="bus" class="arch-chip">Team Bus</button>
            <button data-arch-node="wake" class="arch-chip">wakeDispatcher</button>
            <button data-arch-node="db" class="arch-chip">SQLite</button>
            <button data-arch-node="api" class="arch-chip">Public API</button>
            <button data-arch-node="claude" class="arch-chip">Claude</button>
            <button data-arch-node="openclaw" class="arch-chip">OpenClaw</button>
            <button data-arch-node="visible" class="arch-chip">Visible Reply</button>
            <button data-arch-node="dashboard" class="arch-chip">Dashboard</button>
          </div>
        </div>
      </div>
    </div>`;
}

export function detailedSystemDiagram(): string {
  const component = (title: string, subtitle: string, items: string[], accent = false, icon = "layers") => `
    <div class="rounded-lg border ${accent ? "border-sky-500/35 bg-sky-500/10" : "border-surface-3 bg-surface-2/60"} p-3">
      <div class="mb-2 flex items-center gap-2">
        <span class="inline-flex h-8 w-8 items-center justify-center rounded-md border border-surface-3 bg-surface-0 text-txt-green">${renderIcon(icon, { size: 17 })}</span>
        <div class="min-w-0">
          <div class="text-sm font-semibold text-slate-100">${escape(title)}</div>
          <div class="text-[11px] leading-5 text-slate-400">${subtitle}</div>
        </div>
      </div>
      <div class="mt-2 space-y-1 text-[11px] leading-5 text-slate-300">
        ${items.map((item) => `<div>· ${item}</div>`).join("")}
      </div>
    </div>`;

  return `
    <div class="space-y-3">
      <div class="grid grid-cols-1 gap-3 lg:grid-cols-3">
        ${component("External Channels", pick("외부 대화 채널", "External conversation channels"), [
          pick("<code>Telegram</code>: 팀방/DM 원문", "<code>Telegram</code>: team room/DM originals"),
          pick("<code>Slack</code>: relay/poll 경로", "<code>Slack</code>: relay/poll path"),
          pick("원문은 명령이 아니라 입력 데이터로 취급", "Originals are treated as input data, not commands"),
        ], false, "message-square")}
        ${component("team-collab Bun service", pick("중앙 서버 프로세스 <code>:7878</code>", "Central server process <code>:7878</code>"), [
          "<code>Hono</code> API: <code>/team/api/*</code>",
          "Dashboard: Vite web bundle",
          pick("Router, capture worker, bus worker를 함께 구동", "Runs the router, capture worker, and bus worker together"),
        ], false, "cpu")}
        ${component("SQLite team.db", pick("파일 기반 정본 DB(데이터베이스)", "File-based source-of-truth DB (database)"), [
          pick("<code>message/recipient</code>: 버스 메시지와 수신 상태", "<code>message/recipient</code>: bus messages and delivery state"),
          pick("<code>task</code>: 작업 카드와 continuation guard 데이터", "<code>task</code>: task cards and continuation-guard data"),
          pick("<code>team_search_*</code>: 검색용 파생 색인", "<code>team_search_*</code>: derived search indexes"),
        ], false, "database")}
      </div>

      <div class="rounded-xl border border-surface-3 bg-surface-0 p-4">
        <div class="grid grid-cols-1 gap-3 lg:grid-cols-4">
          ${component("Capture workers", pick("채널 원문 수집", "Channel original capture"), [
            "<code>telegramCapture.ts</code>",
            "<code>slackPoll.ts</code>",
            pick("메시지, 답장 맥락, audit(감사 로그) 저장", "Stores messages, reply context, and audit (audit log)"),
          ], false, "inbox")}
          ${component("Router", pick("누가 답할지 판단", "Decides who answers"), [
            "<code>teamRouter.ts</code>",
            pick("@멘션 → reply owner(답장 원작성자) → sticky owner(직전 담당자) → 기본 접수자", "@mention → reply owner (original author) → sticky owner (previous owner) → default intake owner"),
            pick("애매하면 자동 진행보다 확인 요청 (topic-shift/closure 자동감지는 2026-06-05 제거)", "When ambiguous, asks for confirmation instead of auto-proceeding (topic-shift/closure auto-detection removed 2026-06-05)"),
          ], false, "route")}
          ${component("Team Bus", pick("내부 inbox/outbox", "Internal inbox/outbox"), [
            "<code>routes/inbox.ts</code>",
            "<code>inboxQueries.ts</code>",
            pick("수신자별 delivery state(전달 상태) 저장", "Stores per-recipient delivery state"),
          ], false, "inbox")}
          ${component("wakeDispatcher", pick("깨우기 담당 백그라운드 루프", "Background loop that handles waking"), [
            "<code>wakeDispatcher.ts</code>",
            pick("1.5초마다 pending(대기) 수신자 확인", "Checks pending recipients every 1.5s"),
            pick("retry/backoff(재시도/대기)는 SQLite lease로 관리", "Manages retry/backoff via a SQLite lease"),
          ], false, "workflow")}
        </div>
      </div>

      <div class="grid grid-cols-1 gap-3 lg:grid-cols-3">
        ${component("Claude Channel runtimes", pick("Claude Code 계열 팀원", "Claude Code-family members"), [
          "Bob / Carol / Dave / Erin",
          pick("tmux session(터미널 세션) + tmux inject(터미널 주입)", "tmux session (terminal session) + tmux inject (terminal injection)"),
          pick("각자의 Telegram poller(텔레그램 확인 루프) 보유", "Each has its own Telegram poller (Telegram polling loop)"),
        ], false, "monitor")}
        ${component("OpenClaw runtimes", pick("OpenClaw 계열 팀원", "OpenClaw-family members"), [
          "Alice / Frank / Grace / Heidi",
          pick("OpenClaw gateway(게이트웨이) <code>:18789</code>", "OpenClaw gateway <code>:18789</code>"),
          pick("session wake(세션 깨우기) 경로 사용", "Uses the session wake path"),
        ], false, "bot")}
        ${component("Hermes runtime", pick("Hermes 전용 실행 경로", "Hermes-only execution path"), [
          "<code>b3ryshermes</code> profile",
          "Hermes gateway/status provider",
          pick("전략/CSO 역할의 별도 bridge", "A separate bridge for the strategy/CSO role"),
        ], false, "cpu")}
      </div>

      <div class="grid grid-cols-1 gap-3 lg:grid-cols-3">
        ${component("Dashboard polling", pick("화면 갱신용 읽기 전용 polling", "Read-only polling for screen refresh"), [
          pick("Bus Flow / Topology: 약 3초", "Bus Flow / Topology: ~3s"),
          pick("Team OS: 약 15초", "Team OS: ~15s"),
          pick("메시지 배달 루프와 별도", "Separate from the message delivery loop"),
        ], false, "monitor")}
        ${component("Team Search for AI", pick("AI용 검색/데이터플랫폼", "Search/data platform for AI"), [
          pick("V0: SQLite FTS5(내장 전문 검색) + LIKE fallback(짧은 한글 보완 검색)", "V0: SQLite FTS5 (built-in full-text search) + LIKE fallback (substring search for short Korean queries)"),
          pick("V0.5: vector/hybrid(의미+키워드 결합 검색) 평가 중", "V0.5: evaluating vector/hybrid (combined semantic+keyword search)"),
          pick("운영 vector DB(벡터 저장소)는 관리자 gate(승인 단계) 대기", "The production vector DB (vector store) awaits the admin gate (approval step)"),
        ], false, "search")}
        ${component("Safety gates", pick("운영 변경 보호 장치", "Guards for production changes"), [
          pick("운영 reindex(색인 재생성) 승인 필요", "Production reindex (index rebuild) requires approval"),
          pick("service restart(서비스 재시작) 승인 필요", "Service restart requires approval"),
          pick("토큰/비용/외부 발송은 관리자 확인", "Token/cost/external sends need admin confirmation"),
        ], false, "shield")}
      </div>
    </div>`;
}

// src 모듈 구조도 — 현재 책임 기준.
export function srcModuleMapDiagram(): string {
  const g = (s: string) => `<span class="text-accent-greenSoft">${s}</span>`;
  const c = (s: string) => `<span class="text-slate-500">${s}</span>`;
  const tree =
`src/
├─ server/
│  ├─ ${g("bus/")}        wakeDispatcher.ts ${c(pick("— 수신자 깨우기, 재시도, backoff", "— wake recipients, retry, backoff"))}
│  │              antiPingpong.ts
│  ├─ ${g("db/")}         inboxQueries.ts · inbox/{messages·dispatch·stats·lifecycle}
│  │              queries · taskQueries · searchQueries · migrate
│  ├─ ${g("lib/")}        teamRouter.ts · teamRouter/{mention·gate·ownerDecision}
│  │              groupOwner · slack · teamosProbe
│  ├─ ${g("routes/")}     inbox · slack · router · bus · tasks · search · reports
│  └─ ${g("workers/")}    telegramCapture ${c(pick("(fmt*·replyAuthor 추출)", "(fmt*·replyAuthor extraction)"))} · slackPoll · tmuxTail · statusProbe
├─ shared/
│  └─ envelopeSchema · searchQualityCases
└─ web/
   ├─ ${g("components/")} Reports · TasksKanban · BusFlow · TopologyView · TeamSearch
   │              AgentSetup.ts · agentSetup/{ui-helpers·diagrams}
   ├─ store.ts    ${c("zustand — MainView · AppState")}
   └─ main.ts     ${c("bootstrap · renderTabs · renderMainContent")}`;

  const map = (file: string, responsibility: string, modules: string, why: string) => `
    <div class="rounded-lg border border-surface-3 bg-surface-2/60 p-3">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <code class="break-all text-sm font-semibold text-slate-100">${escape(file)}</code>
        <span class="rounded border border-surface-3 bg-surface-0 px-2 py-0.5 text-[11px] text-slate-400">${escape(responsibility)}</span>
      </div>
      <div class="mt-2 text-xs leading-6 text-accent-greenSoft">${modules}</div>
      <div class="mt-1 text-xs leading-6 text-slate-400">${why}</div>
    </div>`;

  return `
    <div class="space-y-3">
      <div class="rounded-xl border border-surface-3 bg-surface-0 p-4">
        <div class="mb-2 text-base font-semibold text-slate-100">${pick("현재 모듈 트리", "Current module tree")}</div>
        <pre class="overflow-x-auto rounded-lg border border-surface-3 bg-surface-0 p-3 text-sm leading-7 text-slate-300"><code>${tree}</code></pre>
        <p class="mt-3 text-sm leading-7 text-slate-400">
          ${pick(
            `<span class="text-accent-greenSoft">초록</span>은 현재 운영 경로에서 자주 보는 핵심 모듈 묶음입니다.
          이 구조도는 과거 파일 크기 비교가 아니라 지금 코드를 읽을 때의 책임 경계를 보여줍니다.`,
            `<span class="text-accent-greenSoft">Green</span> marks the core module groups you see most often on the current operating path.
          This diagram shows the responsibility boundaries as you read the code today, not a past file-size comparison.`,
          )}
        </p>
      </div>
      <div class="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        ${map("server/db/inboxQueries.ts", pick("버스 DB", "Bus DB"), "inbox/{messages · dispatch · stats · lifecycle}", pick("메시지 저장, 수신자별 전달 상태, 통계, 오래된 항목 정리를 담당합니다.", "Handles message storage, per-recipient delivery state, stats, and cleanup of old entries."))}
        ${map("server/lib/teamRouter.ts", pick("담당자 판단", "Owner decision"), "teamRouter/{mention · gate · ownerDecision}", pick("@멘션, 답장 원작성자, sticky owner(직전 담당자), 기본 접수자를 결정합니다.", "Decides @mention, reply author, sticky owner (previous owner), and default intake owner."))}
        ${map("server/bus/wakeDispatcher.ts", pick("런타임 깨우기", "Runtime wake"), "build plan · invoke adapter · record outcome", pick("pending(대기) 수신자를 찾아 Claude Channel, OpenClaw, Hermes 실행 경로로 전달합니다.", "Finds pending recipients and routes them to the Claude Channel, OpenClaw, and Hermes execution paths."))}
        ${map("server/workers/telegramCapture.ts", pick("채널 캡처", "Channel capture"), "telegram polling · reply context · audit", pick("텔레그램 원문과 답장 맥락을 수집하고 라우터/버스가 쓸 입력으로 저장합니다.", "Collects Telegram originals and reply context and stores them as input for the router/bus."))}
        ${map("web/components/AgentSetup.ts", pick("문서 화면", "Docs screen"), "agentSetup/{ui-helpers · diagrams}", pick("지금 보는 운영 문서 탭을 조립하고, 다이어그램과 UI 헬퍼를 분리해 관리합니다.", "Assembles the operating-docs tab you are viewing now, keeping diagrams and UI helpers separated."))}
      </div>
      <p class="text-sm leading-7 text-slate-400">
        ${pick("자세한 구현 근거와 테스트 목록은 <code>docs/SRC_REFACTOR.md</code>에서 확인할 수 있습니다.", "The detailed implementation rationale and test list are in <code>docs/SRC_REFACTOR.md</code>.")}
      </p>
    </div>`;
}

// 핵심 코드 스닛펫 + '무엇을·왜'. 변경 이력과 테스트 근거 = docs/SRC_REFACTOR.md.
export function coreSnippets(): string {
  const snippet = (title: string, tag: string, code: string, what: string) => `
    <div class="rounded-xl border border-surface-3 bg-surface-0 p-4">
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div class="text-sm font-semibold text-slate-100">${escape(title)}</div>
        <span class="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-txt-green">${escape(tag)}</span>
      </div>
      ${codeBlock(code)}
      <div class="mt-2 text-xs leading-6 text-slate-400">${what}</div>
    </div>`;

  return `
    <div class="space-y-3">
      ${snippet(
        pick("wakeDispatcher — dispatchRow 3단계", "wakeDispatcher — dispatchRow in 3 stages"),
        "server/bus",
        `// dispatchRow = thin orchestrator (진입점·시그니처 불변)
async function dispatchRow(db, row, agents, claude, openclaw, hermes) {
  const plan = buildDispatchPlan(db, row, agents, claude, openclaw, hermes);
  if (plan.kind === "skip") return;          // 8개 preflight 게이트가 terminal 처리
  const outcome = await invokeWakeAdapter(    // ← 유일한 side-effect (wake 1회)
    plan.adapter, plan.targetAgent, row, plan.teamContext);
  recordDispatchOutcome(db, row, plan.targetAgent, outcome, syncDeps); // 상태머신+audit
}`,
        pick(
          "<b>무엇</b>: 360줄짜리 단일 함수를 <code>판정(plan)→실행(invoke)→기록(record)</code> 3단계로 분리. " +
          "<b>왜</b>: plan은 어댑터를 <b>인자 주입</b>받아 순수해져 실 tmux/openclaw 없이 8개 게이트(unknown·owner-set·collect-only·pingpong·shadow·allowlist·broadcast·unsupported)를 직접 테스트할 수 있고, side-effect는 invoke 한 곳에만 모입니다. 원자 claim은 worker/tick에 남겨 동시성 보존.",
          "<b>What</b>: Splits a single 360-line function into three stages — <code>decide(plan)→execute(invoke)→record(record)</code>. " +
          "<b>Why</b>: <code>plan</code> takes the adapters by <b>argument injection</b>, so it becomes pure and its 8 gates (unknown·owner-set·collect-only·pingpong·shadow·allowlist·broadcast·unsupported) can be tested directly without real tmux/openclaw, while the side effect is concentrated in <code>invoke</code> alone. The atomic claim stays in worker/tick to preserve concurrency.",
        )
      )}
      ${snippet(
        pick("teamRouter — ownerDecision 우선순위 사다리", "teamRouter — ownerDecision priority ladder"),
        "server/lib",
        `// routeTeamMessage — 동기 fallback (팀 룰: @멘션 > reply > sticky)
if (isBroadcast(ctx))        return broadcastTargets(ctx);     // @all 등
const explicit = detectExplicitTargets(ctx);
if (explicit.length)         return { owners: explicit };      // @멘션 최우선
if (ctx.replyAuthor)         return { owners: [ctx.replyAuthor] };   // 답장 원작성자
if (ctx.activeAssignee)      return { owners: [ctx.activeAssignee] };// sticky(직전 담당)
const coord = coordinatorId(agents);                           // coordinator capability 보유자(팀 리드)
return { owners: coord ? [coord] : [] };                       // 그 외 → coordinator, 없으면 ask_owner`,
        pick(
          "<b>무엇</b>: '누가 답할지'를 한 곳에서 사다리로 결정. <b>왜</b>: @멘션이 항상 최우선, sticky(직전 담당자)는 명시 멘션·답장이 오기 전엔 유지됩니다(topic-shift 자동감지는 2026-06-05 제거 — 조용히 주인이 바뀌던 버그 차단). characterization 6케이스로 이 순서를 회귀 고정.",
          "<b>What</b>: Decides 'who answers' in one place via a ladder. <b>Why</b>: @mention is always top priority, and the sticky owner (previous owner) is kept until an explicit mention or reply arrives (topic-shift auto-detection removed 2026-06-05 — blocking the bug where ownership silently changed). 6 characterization cases lock this order against regression.",
        )
      )}
      ${snippet(
        pick("Report Portal — 요청 → 담당자 깨움 + 추적", "Report Portal — request → wake owner + track"),
        "routes/portal · web",
        `// POST /reports/api/:id/request  (대시보드 Reports 탭에서 호출)
const assignee = body.assignee ?? report.author;        // 미지정 → 보고서 작성자
insertMessage(db, { to_agent_id: assignee, body: text });  // 버스로 전달 = 깨움
createTask(db, { title: \`보고서 요청: \${report.title}\`, owner: assignee });
return { ok: true, assignee, thread_id };

// web/Reports.ts — forms 배열 동적 렌더 (pdf/pptx 추가돼도 무수정)
showForm(forms[0]); // md→미니 마크다운 · html→sandbox iframe · 기타→다운로드 안내`,
        pick(
          "<b>무엇</b>: <code>/reports</code>에서 보고서를 보고 바로 담당자에게 요청 → 버스 디스패치로 깨우고 추적 task 생성. <b>왜</b>: 읽기-요청-실행을 한 화면에서 닫습니다. 프론트는 forms를 하드코딩하지 않고 배열로 받아 타입별 뷰를 자동 선택하며, API는 origin 루트 <code>/reports/*</code>로 직접 호출해 대시보드 <code>/team</code> 번들과 독립적으로 붙습니다.",
          "<b>What</b>: View a report at <code>/reports</code> and request its owner right there → wake via bus dispatch and create a tracking task. <b>Why</b>: It closes read-request-execute on one screen. The frontend doesn't hardcode forms but receives them as an array and auto-selects the per-type view, while the API is called directly at the origin root <code>/reports/*</code>, attaching independently of the dashboard <code>/team</code> bundle.",
        )
      )}
    </div>`;
}

export function searchSystemDiagram(): string {
  return `
    <div class="rounded-xl border border-surface-3 bg-surface-0 p-4">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div class="text-sm font-semibold text-slate-100">Team Search system architecture diagram</div>
          <div class="mt-1 text-xs leading-5 text-slate-400">${pick("출처 수집, 정책 게이트, 색인 저장소, 검색 API, AI 팀원 근거 제공을 한 장에 묶은 구조도입니다.", "A one-page architecture diagram tying together source collection, the policy gate, the index store, the search API, and evidence delivery to AI members.")}</div>
        </div>
        <div class="rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-[11px] text-txt-blue">retrieval layer for agents</div>
      </div>
      <svg viewBox="0 0 1120 650" class="h-auto w-full" role="img" aria-label="team search system architecture">
        <defs>
          <marker id="searchArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#34d399" />
          </marker>
          <marker id="searchBlueArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#38bdf8" />
          </marker>
          <marker id="gateArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#f59e0b" />
          </marker>
          <filter id="searchShadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="#020617" flood-opacity="0.35" />
          </filter>
        </defs>

        <rect x="20" y="18" width="1080" height="614" rx="16" fill="#08111f" stroke="#1f2937" />
        <rect x="260" y="58" width="560" height="420" rx="18" fill="#0b1220" stroke="#64748b" stroke-width="2" stroke-dasharray="10 8" />
        <text x="286" y="92" fill="#e2e8f0" font-size="22" font-weight="800">Team Search Core</text>
        <text x="286" y="115" fill="#94a3b8" font-size="12">source registry, policy gate, chunk/index pipeline, search API</text>

        <rect x="58" y="86" width="154" height="74" rx="10" fill="#0f172a" stroke="#38bdf8" filter="url(#searchShadow)" />
        <text x="135" y="116" text-anchor="middle" fill="#e0f2fe" font-size="16" font-weight="800">Team Sources</text>
        <text x="135" y="139" text-anchor="middle" fill="#bae6fd" font-size="12">messages · tasks · docs</text>

        <rect x="58" y="206" width="154" height="74" rx="10" fill="#0f172a" stroke="#38bdf8" filter="url(#searchShadow)" />
        <text x="135" y="236" text-anchor="middle" fill="#e0f2fe" font-size="16" font-weight="800">Team Knowledge</text>
        <text x="135" y="259" text-anchor="middle" fill="#bae6fd" font-size="12">safe exports</text>

        <rect x="58" y="326" width="154" height="74" rx="10" fill="#3b2b08" stroke="#f59e0b" filter="url(#searchShadow)" />
        <text x="135" y="356" text-anchor="middle" fill="#fde68a" font-size="16" font-weight="800">Raw Memory</text>
        <text x="135" y="379" text-anchor="middle" fill="#fcd34d" font-size="12">opt-in only</text>

        <rect x="298" y="158" width="150" height="72" rx="10" fill="#082f49" stroke="#38bdf8" filter="url(#searchShadow)" />
        <text x="373" y="187" text-anchor="middle" fill="#e0f2fe" font-size="15" font-weight="800">Source Registry</text>
        <text x="373" y="209" text-anchor="middle" fill="#bae6fd" font-size="12">scope · owner · type</text>

        <rect x="298" y="288" width="150" height="72" rx="10" fill="#3b2b08" stroke="#f59e0b" filter="url(#searchShadow)" />
        <text x="373" y="317" text-anchor="middle" fill="#fde68a" font-size="15" font-weight="800">Policy Gate</text>
        <text x="373" y="339" text-anchor="middle" fill="#fcd34d" font-size="12">privacy · permission</text>

        <rect x="520" y="110" width="156" height="72" rx="10" fill="#064e3b" stroke="#34d399" filter="url(#searchShadow)" />
        <text x="598" y="139" text-anchor="middle" fill="#ecfdf5" font-size="15" font-weight="800">Reindex Job</text>
        <text x="598" y="161" text-anchor="middle" fill="#a7f3d0" font-size="12">collect · normalize</text>

        <rect x="520" y="238" width="156" height="72" rx="10" fill="#064e3b" stroke="#34d399" filter="url(#searchShadow)" />
        <text x="598" y="267" text-anchor="middle" fill="#ecfdf5" font-size="15" font-weight="800">Chunker</text>
        <text x="598" y="289" text-anchor="middle" fill="#a7f3d0" font-size="12">split + metadata</text>

        <path d="M532 364 C532 350 678 350 678 364 L678 430 C678 446 532 446 532 430 Z" fill="#151226" stroke="#a78bfa" stroke-width="2" filter="url(#searchShadow)" />
        <ellipse cx="605" cy="364" rx="73" ry="18" fill="#211b3d" stroke="#a78bfa" stroke-width="2" />
        <text x="605" y="392" text-anchor="middle" fill="#ede9fe" font-size="15" font-weight="800">Search Indexes</text>
        <text x="605" y="414" text-anchor="middle" fill="#c4b5fd" font-size="12">SQLite FTS5 · LanceDB</text>

        <rect x="876" y="116" width="160" height="72" rx="10" fill="#111827" stroke="#38bdf8" filter="url(#searchShadow)" />
        <text x="956" y="145" text-anchor="middle" fill="#e0f2fe" font-size="15" font-weight="800">${pick("대시보드", "Dashboard")}</text>
        <text x="956" y="167" text-anchor="middle" fill="#bae6fd" font-size="12">direct search UI</text>

        <rect x="876" y="254" width="160" height="72" rx="10" fill="#111827" stroke="#34d399" filter="url(#searchShadow)" />
        <text x="956" y="283" text-anchor="middle" fill="#ecfdf5" font-size="15" font-weight="800">AI Team Agents</text>
        <text x="956" y="305" text-anchor="middle" fill="#a7f3d0" font-size="12">context before answer</text>

        <rect x="842" y="402" width="194" height="72" rx="10" fill="#064e3b" stroke="#34d399" filter="url(#searchShadow)" />
        <text x="939" y="431" text-anchor="middle" fill="#ecfdf5" font-size="15" font-weight="800">Search API</text>
        <text x="939" y="453" text-anchor="middle" fill="#a7f3d0" font-size="12">lexical · semantic · hybrid</text>

        <rect x="454" y="520" width="240" height="56" rx="10" fill="#111827" stroke="#475569" />
        <text x="574" y="543" text-anchor="middle" fill="#e2e8f0" font-size="15" font-weight="800">Evidence Pack</text>
        <text x="574" y="564" text-anchor="middle" fill="#94a3b8" font-size="12">excerpt · source ref · freshness · confidence</text>

        <path d="M212 123 C250 123 260 194 298 194" fill="none" stroke="#38bdf8" stroke-width="3" marker-end="url(#searchBlueArrow)" />
        <path d="M212 243 C250 243 260 208 298 206" fill="none" stroke="#38bdf8" stroke-width="3" marker-end="url(#searchBlueArrow)" />
        <path d="M212 363 C252 363 260 326 298 324" fill="none" stroke="#f59e0b" stroke-width="3" stroke-dasharray="8 7" marker-end="url(#gateArrow)" />
        <path d="M448 194 C488 194 488 146 520 146" fill="none" stroke="#34d399" stroke-width="3" marker-end="url(#searchArrow)" />
        <path d="M448 324 C490 324 486 274 520 274" fill="none" stroke="#f59e0b" stroke-width="2.5" marker-end="url(#gateArrow)" />
        <line x1="598" y1="182" x2="598" y2="238" stroke="#34d399" stroke-width="3" marker-end="url(#searchArrow)" />
        <line x1="598" y1="310" x2="605" y2="346" stroke="#34d399" stroke-width="3" marker-end="url(#searchArrow)" />
        <path d="M842 438 C748 432 706 414 678 404" fill="none" stroke="#34d399" stroke-width="3" marker-end="url(#searchArrow)" />
        <path d="M876 152 C820 188 838 386 842 428" fill="none" stroke="#38bdf8" stroke-width="2.5" marker-end="url(#searchBlueArrow)" />
        <path d="M876 290 C826 330 828 390 842 438" fill="none" stroke="#34d399" stroke-width="2.5" marker-end="url(#searchArrow)" />
        <path d="M842 454 C760 510 696 532 694 548" fill="none" stroke="#38bdf8" stroke-width="2.5" marker-end="url(#searchBlueArrow)" />
        <path d="M454 548 C330 548 188 478 135 400" fill="none" stroke="#64748b" stroke-width="2" stroke-dasharray="7 7" marker-end="url(#searchBlueArrow)" />

        <rect x="272" y="600" width="160" height="30" rx="8" fill="#0f172a" stroke="#38bdf8" />
        <text x="352" y="620" text-anchor="middle" fill="#bae6fd" font-size="12" font-weight="700">source/read</text>
        <rect x="480" y="600" width="160" height="30" rx="8" fill="#0f172a" stroke="#34d399" />
        <text x="560" y="620" text-anchor="middle" fill="#a7f3d0" font-size="12" font-weight="700">index/query</text>
        <rect x="688" y="600" width="160" height="30" rx="8" fill="#0f172a" stroke="#f59e0b" />
        <text x="768" y="620" text-anchor="middle" fill="#fcd34d" font-size="12" font-weight="700">approval gate</text>
      </svg>
      <p class="mt-3 text-sm leading-7 text-slate-400">
        ${pick("핵심은 모든 파일을 한 번에 넣는 것이 아니라 source registry(검색 출처 목록)와 policy gate(권한/공개 범위 검문)를 먼저 두는 것입니다.", "The key is not to ingest every file at once, but to put a source registry (list of search sources) and a policy gate (permission/visibility check) in front first.")}
      </p>
    </div>`;
}

export function searchWorkflowDiagram(): string {
  return `
    <div class="grid grid-cols-1 gap-3 lg:grid-cols-3">
      ${policyCard("1. Reindex", pick("유지보수 job(작업)이 허용된 source(출처)만 모읍니다. chunk(조각)로 나누고 SQLite FTS5(키워드 검색)와 vector index(의미 검색 색인)에 씁니다.", "A maintenance job collects only the allowed sources. It splits them into chunks and writes to SQLite FTS5 (keyword search) and the vector index (semantic search index)."), true)}
      ${policyCard("2. Agent Query", pick("팀원은 답하기 전에 search API(검색 API)에 짧게 묻습니다. 결과는 원문 일부와 source ref(출처 참조)를 붙인 evidence pack(근거 묶음)으로 받습니다.", "A member briefly queries the search API before answering. Results come back as an evidence pack (bundle of grounds) with a snippet of the original and a source ref (source reference)."), true)}
      ${policyCard("3. Knowledge Export", pick("팀원 경험은 raw memory(원본 개인 메모리)를 바로 넣지 않고 team-knowledge export(팀 공유용 정리본)로 승격한 뒤 검색에 넣습니다.", "A member's experience is not indexed as raw memory (raw personal memory) directly; it is promoted to a team-knowledge export (a shared write-up) before going into search."), true)}
    </div>`;
}

export function flowDiagram(): string {
  return `
    <div class="space-y-4">
      <div class="rounded-xl border border-surface-3 bg-surface-0 p-4">
        <svg viewBox="0 0 1040 390" class="h-auto w-full" role="img" aria-label="b3rys communication flow">
          <defs>
            <marker id="commArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#34d399" />
            </marker>
          </defs>

          <rect x="0" y="0" width="1040" height="390" rx="14" fill="#0b1220" />
          <rect x="28" y="54" width="150" height="70" rx="8" fill="#0f172a" stroke="#334155" />
          <text x="103" y="84" text-anchor="middle" fill="#e2e8f0" font-size="17" font-weight="700">Telegram</text>
          <text x="103" y="107" text-anchor="middle" fill="#94a3b8" font-size="12">${pick("그룹 · DM", "Group · DM")}</text>

          <rect x="28" y="154" width="150" height="70" rx="8" fill="#0f172a" stroke="#334155" />
          <text x="103" y="184" text-anchor="middle" fill="#e2e8f0" font-size="17" font-weight="700">Slack</text>
          <text x="103" y="207" text-anchor="middle" fill="#94a3b8" font-size="12">relay · poll</text>

          <rect x="236" y="104" width="160" height="78" rx="8" fill="#062d2c" stroke="#10b981" />
          <text x="316" y="135" text-anchor="middle" fill="#d1fae5" font-size="17" font-weight="700">Capture / Adapter</text>
          <text x="316" y="158" text-anchor="middle" fill="#99f6e4" font-size="12">${pick("원문 저장 · 채널 변환", "Store originals · channel adapt")}</text>

          <rect x="456" y="104" width="145" height="78" rx="8" fill="#0f172a" stroke="#334155" />
          <text x="528" y="135" text-anchor="middle" fill="#e2e8f0" font-size="17" font-weight="700">Router</text>
          <text x="528" y="158" text-anchor="middle" fill="#94a3b8" font-size="12">${pick("누가 답할지 판단", "Decides who answers")}</text>

          <rect x="661" y="104" width="150" height="78" rx="8" fill="#064e3b" stroke="#34d399" />
          <text x="736" y="135" text-anchor="middle" fill="#ecfdf5" font-size="17" font-weight="700">Team Bus</text>
          <text x="736" y="158" text-anchor="middle" fill="#a7f3d0" font-size="12">${pick("내부 inbox · 상태", "Internal inbox · state")}</text>

          <rect x="872" y="104" width="140" height="78" rx="8" fill="#0f172a" stroke="#334155" />
          <text x="942" y="135" text-anchor="middle" fill="#e2e8f0" font-size="17" font-weight="700">SQLite DB</text>
          <text x="942" y="158" text-anchor="middle" fill="#94a3b8" font-size="12">${pick("메시지 · 작업 · 검색", "Messages · Tasks · Search")}</text>

          <rect x="166" y="282" width="190" height="64" rx="8" fill="#111827" stroke="#475569" />
          <text x="261" y="309" text-anchor="middle" fill="#e2e8f0" font-size="15" font-weight="700">Claude runtimes</text>
          <text x="261" y="330" text-anchor="middle" fill="#94a3b8" font-size="12">Bob · Carol · Dave · Erin</text>

          <rect x="420" y="282" width="190" height="64" rx="8" fill="#111827" stroke="#475569" />
          <text x="515" y="309" text-anchor="middle" fill="#e2e8f0" font-size="15" font-weight="700">OpenClaw runtimes</text>
          <text x="515" y="330" text-anchor="middle" fill="#94a3b8" font-size="12">Ace · Bea · Cam · Dana</text>

          <rect x="674" y="282" width="190" height="64" rx="8" fill="#111827" stroke="#475569" />
          <text x="769" y="309" text-anchor="middle" fill="#e2e8f0" font-size="15" font-weight="700">Hermes runtime</text>
          <text x="769" y="330" text-anchor="middle" fill="#94a3b8" font-size="12">Hermes bridge</text>

          <line x1="178" y1="89" x2="236" y2="126" stroke="#34d399" stroke-width="3" marker-end="url(#commArrow)" />
          <line x1="178" y1="189" x2="236" y2="162" stroke="#34d399" stroke-width="3" marker-end="url(#commArrow)" />
          <line x1="396" y1="143" x2="456" y2="143" stroke="#34d399" stroke-width="3" marker-end="url(#commArrow)" />
          <line x1="601" y1="143" x2="661" y2="143" stroke="#34d399" stroke-width="3" marker-end="url(#commArrow)" />
          <line x1="811" y1="143" x2="872" y2="143" stroke="#34d399" stroke-width="3" marker-end="url(#commArrow)" />
          <path d="M736 182 C690 246 330 242 261 282" fill="none" stroke="#38bdf8" stroke-width="2.5" marker-end="url(#commArrow)" />
          <path d="M736 182 C700 246 560 242 515 282" fill="none" stroke="#38bdf8" stroke-width="2.5" marker-end="url(#commArrow)" />
          <path d="M736 182 C734 246 760 244 769 282" fill="none" stroke="#38bdf8" stroke-width="2.5" marker-end="url(#commArrow)" />
          <path d="M420 296 C290 258 154 244 103 224" fill="none" stroke="#64748b" stroke-width="2" stroke-dasharray="7 7" marker-end="url(#commArrow)" />
          <path d="M610 298 C766 260 908 240 942 182" fill="none" stroke="#64748b" stroke-width="2" stroke-dasharray="7 7" marker-end="url(#commArrow)" />
        </svg>
      </div>
      <div class="grid grid-cols-1 gap-3 md:grid-cols-5">
        ${flowStep("01", pick("수신", "Receive"), pick("Telegram/Slack 원문과 답장 맥락을 캡처하고 DB(데이터베이스)에 저장합니다.", "Captures Telegram/Slack originals and reply context and stores them in the DB (database)."))}
        ${flowStep("02", pick("판정", "Decide"), pick("Router(라우터)가 @멘션 → 이어받을 담당자(sticky) → 위임 여부를 규칙으로 판단합니다. (종료·주제전환 자동감지는 제거됐고 sticky 유지가 현행입니다.)", "The router decides by rule: @mention → sticky owner → whether to delegate. (Closure/topic-shift auto-detection was removed; sticky is the current behavior.)"))}
        ${flowStep("03", pick("버스 기록", "Bus record"), pick("Team Bus(팀 내부 메시지함)가 수신자와 전달 상태를 기록합니다.", "The Team Bus (internal team mailbox) records recipients and delivery state."))}
        ${flowStep("04", pick("런타임 깨우기", "Wake runtime"), pick("Claude/OpenClaw/Hermes runtime(실행 환경)을 각자 맞는 경로로 깨웁니다.", "Wakes the Claude/OpenClaw/Hermes runtime (execution environment) via each one's own path."))}
        ${flowStep("05", pick("답변 반환", "Return reply"), pick("답변은 필요하면 Telegram/Slack에 보이고, 내부 기록과 검색 DB에도 남습니다.", "The reply is shown on Telegram/Slack when needed, and also kept in internal records and the search DB."))}
      </div>
    </div>`;
}

export function communicationPrinciplesDiagram(): string {
  return `
    <div class="rounded-xl border border-surface-3 bg-surface-0 p-4">
      <div class="mb-3">
        <div class="text-sm font-semibold text-slate-100">${pick("통신 원리 핵심 순서", "Communication principles order")}</div>
        <div class="mt-1 text-xs leading-5 text-slate-400">${pick("보낼 곳을 고르기 전에 먼저 내가 답할 차례인지 판정합니다. 그 다음 경로와 실제 수신 대상을 선택합니다.", "Before choosing where to send, first decide whether it is my turn to answer. Then choose the path and actual recipient.")}</div>
      </div>
      <svg viewBox="0 0 1120 430" class="h-auto w-full" role="img" aria-label="communication principles timeline">
        <defs>
          <marker id="principleArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#34d399" />
          </marker>
        </defs>
        <rect x="0" y="0" width="1120" height="430" rx="14" fill="#0b1220" />

        <rect x="38" y="42" width="210" height="86" rx="10" fill="#111827" stroke="#475569" />
        <text x="143" y="76" text-anchor="middle" fill="#e2e8f0" font-size="17" font-weight="800">${pick("불변식", "Invariants")}</text>
        <text x="143" y="102" text-anchor="middle" fill="#cbd5e1" font-size="12">${pick("보낸 것만 말한 것", "Only sent messages count")}</text>

        <rect x="316" y="42" width="210" height="86" rx="10" fill="#082f49" stroke="#38bdf8" />
        <text x="421" y="76" text-anchor="middle" fill="#e0f2fe" font-size="17" font-weight="800">${pick("3경로", "Three paths")}</text>
        <text x="421" y="102" text-anchor="middle" fill="#bae6fd" font-size="12">${pick("버스 · 그룹방 · OWNER 1:1", "Bus · Group · OWNER 1:1")}</text>

        <rect x="594" y="42" width="210" height="86" rx="10" fill="#064e3b" stroke="#34d399" />
        <text x="699" y="76" text-anchor="middle" fill="#ecfdf5" font-size="17" font-weight="800">${pick("Owner 판정", "Owner decision")}</text>
        <text x="699" y="102" text-anchor="middle" fill="#a7f3d0" font-size="12">${pick("내가 답할 차례인가", "Is it my turn?")}</text>

        <rect x="872" y="42" width="210" height="86" rx="10" fill="#111827" stroke="#475569" />
        <text x="977" y="76" text-anchor="middle" fill="#e2e8f0" font-size="17" font-weight="800">${pick("답장 주소", "Reply address")}</text>
        <text x="977" y="102" text-anchor="middle" fill="#cbd5e1" font-size="12">${pick("kind에 맞춰 선택", "Choose by kind")}</text>

        <line x1="248" y1="85" x2="316" y2="85" stroke="#34d399" stroke-width="3" marker-end="url(#principleArrow)" />
        <line x1="526" y1="85" x2="594" y2="85" stroke="#34d399" stroke-width="3" marker-end="url(#principleArrow)" />
        <line x1="804" y1="85" x2="872" y2="85" stroke="#34d399" stroke-width="3" marker-end="url(#principleArrow)" />

        <rect x="100" y="188" width="188" height="64" rx="9" fill="#0f172a" stroke="#334155" />
        <text x="194" y="214" text-anchor="middle" fill="#e2e8f0" font-size="14" font-weight="700">${pick("협업 패턴", "Collaboration")}</text>
        <text x="194" y="235" text-anchor="middle" fill="#cbd5e1" font-size="12">${pick("위임 · 취합 · 개별", "Delegate · collect · individual")}</text>

        <rect x="348" y="188" width="188" height="64" rx="9" fill="#0f172a" stroke="#334155" />
        <text x="442" y="214" text-anchor="middle" fill="#e2e8f0" font-size="14" font-weight="700">${pick("마감 · workloop", "Deadline · workloop")}</text>
        <text x="442" y="235" text-anchor="middle" fill="#cbd5e1" font-size="12">${pick("대기와 재개를 기록", "Record wait and resume")}</text>

        <rect x="596" y="188" width="188" height="64" rx="9" fill="#3b2b08" stroke="#f59e0b" />
        <text x="690" y="214" text-anchor="middle" fill="#fde68a" font-size="14" font-weight="700">${pick("승인", "Approval")}</text>
        <text x="690" y="235" text-anchor="middle" fill="#fcd34d" font-size="12">${pick("큰 변경 전 확인", "Confirm before big changes")}</text>

        <rect x="844" y="188" width="188" height="64" rx="9" fill="#0f172a" stroke="#334155" />
        <text x="938" y="214" text-anchor="middle" fill="#e2e8f0" font-size="14" font-weight="700">${pick("구현 부록", "Implementation")}</text>
        <text x="938" y="235" text-anchor="middle" fill="#cbd5e1" font-size="12">${pick("파일과 API 근거", "Files and API evidence")}</text>

        <path d="M977 128 C968 166 962 176 938 188" fill="none" stroke="#34d399" stroke-width="2.5" marker-end="url(#principleArrow)" />
        <line x1="288" y1="220" x2="348" y2="220" stroke="#34d399" stroke-width="2.5" marker-end="url(#principleArrow)" />
        <line x1="536" y1="220" x2="596" y2="220" stroke="#34d399" stroke-width="2.5" marker-end="url(#principleArrow)" />
        <line x1="784" y1="220" x2="844" y2="220" stroke="#34d399" stroke-width="2.5" marker-end="url(#principleArrow)" />

        <rect x="64" y="318" width="992" height="58" rx="10" fill="#111827" stroke="#475569" />
        <text x="560" y="345" text-anchor="middle" fill="#e2e8f0" font-size="15" font-weight="800">${pick("Hermes 검수 반영: owner 판정이 주소 선택보다 먼저 옵니다.", "Hermes review: owner decision comes before address selection.")}</text>
        <text x="560" y="366" text-anchor="middle" fill="#cbd5e1" font-size="12">${pick("group kind를 항상 broadcast로 오독하지 않도록, 먼저 내가 owner인지 확인한 뒤 envelope kind에 맞는 주소를 고릅니다.", "To avoid reading every group kind as broadcast, first check whether I am the owner, then choose the address from the envelope kind.")}</text>
      </svg>
    </div>`;
}
