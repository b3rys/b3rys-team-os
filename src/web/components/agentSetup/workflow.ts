import { pick } from "../../i18n";
import { escape, section, sourceLinks } from "./ui-helpers";

function table(headers: string[], rows: string[][]): string {
  return `<div class="overflow-x-auto rounded-lg border border-surface-3" tabindex="0" role="region" aria-label="${escape(headers.join(" · "))}"><table class="w-full min-w-[640px] text-left text-xs leading-5"><thead class="bg-surface-2 text-slate-100"><tr>${headers.map(h => `<th scope="col" class="px-3 py-2 font-semibold">${escape(h)}</th>`).join("")}</tr></thead><tbody class="text-slate-300">${rows.map(row => `<tr class="border-t border-surface-3">${row.map((cell, i) => i === 0 ? `<th scope="row" class="px-3 py-3 align-top font-semibold text-slate-100">${escape(cell)}</th>` : `<td class="px-3 py-3 align-top">${escape(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function bullets(items: string[]): string {
  return `<ul class="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-slate-300">${items.map(s => `<li>${escape(s)}</li>`).join("")}</ul>`;
}

export function workflowDiagram(): string {
  const step = (text: string) => `<div class="rounded-lg border border-surface-3 bg-surface-2 p-3 text-sm font-semibold text-slate-100">${text}</div>`;
  const arrow = '<div class="py-1 text-center text-slate-400" aria-hidden="true">↓</div>';
  return `<figure class="rounded-xl border border-dashed border-emerald-500/50 p-3 sm:p-5">
    <figcaption class="mb-3 text-sm font-semibold text-txt-green">${pick("SF — 프로젝트일 때 감싸는 틀", "SF — wraps BWF only for projects")}</figcaption>
    <div class="rounded-lg border border-surface-3 bg-surface-1 p-3 sm:p-4">
      <p class="mb-3 text-sm font-semibold text-slate-100">${pick("BWF — 요청 하나를 닫는 6단계", "BWF — six steps that close one request")}</p>
      ${step(pick("① 계획 · 완료기준 · 칸반 카드", "① Plan · done criteria · kanban card"))}${arrow}
      ${step(pick("② 배정 · 접수", "② Assign · acknowledge"))}${arrow}
      <div class="rounded-lg border border-dashed border-emerald-500/50 p-3">
        <p class="mb-3 text-xs font-semibold text-txt-green">${pick("FPFC — 네 역할 (순서 아님)", "FPFC — four roles (not an order)")}</p>
        <div class="mb-3 grid grid-cols-2 gap-2 text-xs text-slate-300">${[pick("Find · 찾기", "Find"), pick("Pick · 고르기", "Pick"), pick("Fix · 만들기·고치기", "Fix · build or fix"), pick("Check · 확인", "Check")].map(s => `<span class="rounded border border-surface-3 bg-surface-2 p-2">${s}</span>`).join("")}</div>
        ${step(pick("③ 실행", "③ Execute"))}${arrow}${step(pick("④ 검증", "④ Verify"))}
      </div>${arrow}
      ${step(pick("⑤ 보고", "⑤ Report"))}${arrow}${step(pick("⑥ 학습", "⑥ Learn"))}
    </div>
  </figure>`;
}

export function workflowPage(): string {
  return `
${section(pick("작업 플로우", "Workflow"), "SF · BWF · FPFC · verification", `<p class="mb-4 text-sm leading-6 text-slate-300">${escape(pick("b3os 팀은 실행할 일 하나를 BWF(b3os workflow) 6단계로 끝냅니다. 요구가 계속 쌓이는 소프트웨어 프로젝트는 SF(Software Factory)로 운영하고, 그 안의 요청 하나하나를 다시 BWF 로 닫습니다. BWF ③ 실행과 ④ 검증의 일은 FPFC, 곧 Find(찾기) · Pick(고르기) · Fix(만들기 · 고치기) · Check(확인) 네 역할이 나눠 맡습니다. FPFC 는 순서가 아니라 역할 이름이고, 새 기능을 포함한 모든 요청에 씁니다. 새 기능은 Fix(만들기)로 들어와 리뷰(Find)가 찾은 문제를 Pick → Fix → Check 로 닫고, 수정 · 버그는 Find 로 들어옵니다. BWF ④ 는 검증하는 칸이고, verification 은 그 칸(과 그 전의 범위 선언 · 완료 조건 합의)에서 쓰는 방법입니다(정본 스킬 b3os-verification). SF 의 시험 · 손맛(사용자가 화면과 손으로 느끼는 반응) · 출고 단계도 이 방법을 씁니다.", "Every task the lead confirms runs through BWF (b3os workflow), six steps: ① plan, done criteria and a kanban card → ② assign and acknowledge → ③ execute → ④ verify → ⑤ report → ⑥ learn. A software project whose requests keep piling up is run inside SF (Software Factory); each request in it is still closed with one BWF pass. The work in ③ and ④ is split into four roles — Find, Pick, Fix (build or fix) and Check. They are role names, not an order: a fix enters at Find; a new feature enters at Fix (build), and whatever the review (Find) turns up goes Pick → Fix → Check. The agent that built something never checks it. Verification is the method step ④ uses to prove a result with evidence (skills/b3os-verification)."))}</p>${workflowDiagram()}
${bullets([pick("점선 바깥 상자(SF)는 프로젝트일 때만 감싸는 틀, 가운데 상자(BWF)는 요청 하나, ③ · ④ 를 묶은 점선 상자(FPFC)는 그 두 칸의 일을 나눠 맡는 네 역할입니다(순서 아님). 요청이 올 때마다 가운데 상자가 한 번 돕니다.", "The dashed outer box (SF) wraps projects only. The middle box (BWF) closes one request. FPFC groups ③ and ④ into four roles, not a sequence. Each request runs BWF once."),
    pick("완료기준은 무엇이 되면 끝인지 미리 적은 목록입니다. 칸반 카드는 팀 Tasks 보드에 과제 하나를 담당 · 상태와 함께 적는 칸이고, 접수는 일을 받은 팀원이 받았다고 답하는 일입니다.", "Done criteria state what must be true to finish. A kanban card records one task with its owner and status on Tasks. Acknowledgement means the assigned teammate confirms receipt.")
  ])}`)}
${section(pick("넷을 한 줄씩", "Four concepts at a glance"), "scope & ownership", table([pick("개념", "Concept"),
    pick("무엇", "What"),
    pick("누가 쥐나", "Owner"),
    pick("언제 쓰나", "When"),
    pick("범위", "Scope")], [
[pick("BWF", "BWF"),
    pick("일 하나를 끝까지 끌고 가는 6단계: ① PM 계획 → ② 팀 배정 → ③ 실행+품질 → ④ 검증 → ⑤ 보고+카드 → ⑥ 학습", "Six steps to close one task: ① PM plan → ② assign → ③ execute + quality → ④ verify → ⑤ report + card → ⑥ learn"),
    pick("PM — 과제를 받아 끝까지 맡는 팀원", "PM — the teammate responsible from start to finish"),
    pick("팀장이 확인한 실행 · 위임 과제. 구현 · 리서치 · 리뷰 · 릴리즈 모두", "Execution and delegation confirmed by the lead: implementation, research, review and release"),
    pick("과제 하나", "One task")],
[pick("SF", "SF"),
    pick("프로젝트를 운영하는 틀: 요구 목록 · 바꾸기 비싼 설계 · 구조 · 시험 전략 · 손맛 · 출고 · 운영 · 지식", "A framework for projects: requirements, costly design decisions, structure, test strategy, feel, release, operations and knowledge"),
    pick("프로젝트를 맡은 PM", "Project PM"),
    pick("팀장 요구가 여러 번 쌓이는 앱 · 서비스 · 긴 기능", "Apps, services and long-running features with repeated requests"),
    pick("프로젝트 전체", "Whole project")],
[pick("FPFC", "FPFC"),
    pick("③ · ④ 의 일을 나눈 네 역할 이름(순서 아님): Find 찾기 · Pick 고르기 · Fix 만들기·고치기 · Check 확인", "Four role names for ③ and ④ (not an order): Find, Pick, Fix (build or fix), Check"),
    pick("역할마다 agent 나 팀원. Pick 은 PM 판단, 개선은 팀장이 고름", "An agent or teammate per role. PM picks defects; the lead picks improvements"),
    pick("모든 요청(새 기능 포함)", "Every request, including new features"),
    pick("BWF ③ · ④ 안", "Inside BWF ③ and ④")],
[pick("verification", "verification"),
    pick("결과가 맞다는 것을 증거로 보이고, 다음 변경에서도 그 증거가 유지되게 하는 방법", "Prove results with evidence and keep that evidence valid through later changes"),
    pick("② 에서 정한 검증자", "Verifier chosen in ②"),
    pick("④ 검증과 그 전의 범위 선언 · PR 완료 조건. FPFC 의 Check · SF 의 시험 · 손맛 · 출고", "④ and earlier scope declarations / PR done criteria; FPFC Check; SF testing, feel and release"),
    pick("변경 하나 ~ 출고 하나", "One change to one release")],
]))}
${section(pick("역할과 사람", "Roles and people"), "responsibility", `<p class="text-sm leading-6 text-slate-300">${escape(pick("FPFC 는 SF 의 원칙 「만든 AI 와 리뷰하는 AI 를 나눈다」에 역할 이름을 붙인 것입니다. 내용은 b3os-sf 「만들기 · 리뷰」 규칙(리뷰는 보고만, 고칠 것은 고른 뒤, 오류 수정은 그 오류만)에 있습니다.", "FPFC names the separation between builder and reviewer already required by b3os-sf: reviews report only, fixes follow selection, and bug fixes address only that bug."))}</p>${bullets([pick("한 사람이 여러 역할을 맡을 수 있습니다. 다만 만든 쪽과 리뷰 · 확인하는 쪽은 다른 agent 로 나눕니다.", "One person can hold several roles, but building and reviewing / checking must be assigned to different agents."),
    pick("Pick: 실제로 깨지는 것은 PM 이 판단해 고르고, 개선은 팀장이 고른 것만 합니다.", "Pick: the PM selects actual breakages; only improvements selected by the lead are implemented."),
    pick("구현은 구현 담당이 합니다. 담당이 밀려 PM 이 직접 구현할 때는 먼저 알리고 합니다(예외).", "Implementation belongs to its assigned implementer. If the PM takes over because that person is busy, announce it first (an exception)."),
    pick("harness 의 orchestrator(sub agent 를 띄우고 순서와 종합을 맡는 쪽)는 일을 직접 하지 않습니다.", "The harness orchestrator, which launches sub agents and coordinates order and synthesis, does not do the work itself.")
  ])}`)}
${section(pick("harness 운영 방법", "Running a harness"), "roles · model · reasoning", `<p class="mb-3 text-sm leading-6 text-slate-300">${pick("역할마다 모델과 추론 강도를 따로 정합니다. 기본은 일반 모델 + 중간 추론입니다.", "Set the model and reasoning for every role. The default is a regular model with medium reasoning.")}</p>${table([pick("역할", "Role in the harness"),
    pick("FPFC", "Role"),
    pick("모델 · 추론", "Model + reasoning"),
    pick("지키는 것", "Rule")], [
[pick("구현", "Implementation"),
    pick("Fix", "Fix"),
    pick("일반 모델 + 중간 추론", "regular model + medium reasoning"),
    pick("고른 것만 가장 작게 고친다", "change only what was picked, as small as possible")],
[pick("아키텍처 리뷰", "Architecture review"),
    pick("Find", "Find"),
    pick("상위 모델 + 높은 추론", "top model + high reasoning"),
    pick("읽기 전용(도구에서 수정 권한을 뺌) · 출고 묶음마다 1회 + 설계 판단 전 · 반환 = 건드리는 기능 + 확인 목록 + 막는 문제", "read-only · once per release bundle and before design decisions · returns affected features, a check list and blockers")],
[pick("깊은 원인 분석", "Deep root-cause analysis"),
    pick("Find", "Find"),
    pick("상위 모델 + 높은 추론", "top model + high reasoning"),
    pick("원인이 얽힌 버그 · 장애에만 쓰고, 보고만 한다", "only for tangled bugs or incidents · report only")],
[pick("실앱 · 시험 검사", "App / test checks"),
    pick("Check", "Check"),
    pick("일반 모델 + 중간 추론", "regular model + medium reasoning"),
    pick("시험 · 실앱 검사를 돌리고 결과를 읽는다. 앱 검사는 기계 잠금을 잡고 한 번에 하나만 돈다", "run the checks and read the results · one app check per machine at a time")],
])}${bullets([pick("아키텍처 리뷰는 잘되던 기능이 깨지면 비용이 커서 상위 모델 + 높은 추론으로 둡니다. 출고 묶음마다 1회, 그 묶음의 diff 전체를 읽고 기능 영향과 코드 위치(맞는 파일 · 층, 규칙 중복)를 봅니다. 고치는 동안 백그라운드로 돌려 출고 시간은 늘리지 않습니다. 설계 판단(리팩토링 여부 · 큰 수정 방향)을 내리기 전에도 아키텍처 리뷰에 먼저 묻습니다(b3os-sf).", "Architecture review uses a top model with high reasoning because regressions are costly. Once per release bundle, read the whole diff for affected features and code placement (the right file / layer and duplicate rules). Run it in the background while implementation proceeds. Consult it before design decisions such as refactoring or a major fix direction (b3os-sf)."),
    pick("인증 · 결제 · 데이터 정합성처럼 위험이 큰 영역이거나 같은 수정이 거듭 실패하면 구현 · Check 도 상위 모델로 올리고 이유를 남깁니다. b3os-harness-playbook 의 「핵심 최종 검증」은 이 표의 아키텍처 리뷰입니다.", "For high-risk areas such as authentication, payments and data consistency, or repeated failures of the same fix, raise implementation and Check to a top model and record why. The harness playbook's core final verification is the architecture review in this table."),
    pick("추론만 올리면 모델은 기본값 그대로입니다. 그래서 역할마다 위 표대로 모델을 적습니다. 비워 두면 세션 모델을 물려받으므로, 물려받기를 고른 경우에만 비우고 그 사실을 적습니다.", "Raising reasoning alone keeps the default model. Set a model for every role. Leaving it blank inherits the session model; do so only when inheritance is intentional, and record it."),
    pick("실행 뒤에는 실행 기록에서 요청한 모델 · 실제 모델 ID · 요청한 추론 강도를 확인합니다. 런타임이 agent 마다 모델을 정할 수 없으면 지정했다고 쓰지 않고 그 사실을 보고에 적습니다.", "After the run, verify the requested model, actual model ID and requested reasoning in the execution log. If the runtime cannot set a model per agent, report that limitation rather than claiming it was set."),
    pick("모델 이름은 `skills/b3os-harness-playbook/references/model-selection.md` 표 한 곳에만 두고, 문서와 스킬에는 「상위 모델 + 높은 추론」처럼 역할로 씁니다. 그 표의 모델은 검증을 거쳐 도입하는 후보입니다. 팀원의 런타임에서 실제로 고를 수 있는지는 실행 전에 확인합니다.", "Model names live only in skills/b3os-harness-playbook/references/model-selection.md; docs and skills use role names such as ‘top model + high reasoning’. Models in that table are candidates introduced through verification. Check runtime availability before running."),
    pick("모델 검토: AI 담당 팀원이 주마다(새 출시 소식이 오면 그때도) 프론티어 점검을 합니다. 변화(새 모델 · 가격 · 지원 종료 등)가 있거나 점검이 실패 · 미확인으로 끝나면(한 번이라도) PM 에게 「하네스 모델 검토」 과제가 넘어갑니다. 변화가 있으면 PM 이 BWF 카드로 활성화 게이트(실제 과제로 비교) → 변경안 하나 → 팀장 승인 순으로 진행합니다. 실패 · 미확인이면 원인을 고치거나 담당을 정하고, 다음 점검 전에 다시 확인합니다. 그때까지는 마지막으로 검증한 매핑을 씁니다. 팀원 런타임의 모델 교체는 b3os-model-rollout 으로 합니다.", "The AI specialist checks frontier models weekly and when a release is announced. A change (new model, price or end of support), or even one failed / unconfirmed check, opens a harness model review task for the PM. For a change, use a BWF card to compare on real tasks, propose one change and await lead approval. For a failed / unconfirmed check, fix the cause or assign an owner and recheck before the next scheduled check. Keep the last verified mapping meanwhile. Teammate runtime model changes use b3os-model-rollout.")
  ])}`)}
${sourceLinks(["skills/b3os-bwf/SKILL.md", "skills/b3os-sf/SKILL.md", "skills/b3os-verification/SKILL.md", "skills/b3os-harness-playbook/SKILL.md", "skills/b3os-harness-playbook/references/model-selection.md"])}
`;
}
