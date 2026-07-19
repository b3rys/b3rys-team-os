import { store } from "../store";
import { openRecruitForm } from "./Settings";
import { pick } from "../i18n";

// 첫 실행 빈 팀(0명) 온보딩 — 빈 대시보드 대신 "안내된 첫걸음"을 보여준다.
// 팀원이 0명이고 사용자가 닫지 않았을 때만 전체 오버레이로 표시. "첫 팀원 만들기"는 Settings(영입)로,
// "둘러보기"는 오버레이만 닫아 빈 대시보드를 살펴보게 한다. 팀원이 생기면 자동으로 사라진다.
// (OWNER 2026-06-24 '설치하면 빈 팀이라 막막함 → 안내'. 카피 톤 = your-team.example.com 온보딩 step과 일치.)
const STEP = (n: string, title: string, desc: string) => `
  <li class="onb-step">
    <span class="onb-step-num">${n}</span>
    <div>
      <div class="onb-step-title">${title}</div>
      <div class="onb-step-desc">${desc}</div>
    </div>
  </li>`;

export function renderOnboarding(host: HTMLElement): void {
  const overlay = document.createElement("div");
  overlay.id = "onboarding-overlay";
  host.appendChild(overlay);

  let dismissed = false;

  const update = () => {
    const { agents, agentsLoaded } = store.getState();
    // agentsLoaded 전에는 부팅 중 빈 배열이라 표시하지 않는다(리프레시 시 깜빡 방지, OWNER 2026-06-24).
    const show = agentsLoaded && agents.length === 0 && !dismissed;
    overlay.style.display = show ? "flex" : "none";
    if (!show) {
      overlay.innerHTML = "";
      return;
    }
    overlay.innerHTML = `
      <div class="onb-card">
        <span class="onb-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8.5" cy="16.5" r="3.7"/><circle cx="16" cy="16.5" r="3.3"/><path d="M8.5 12.8 C10 6.5 15 4.5 18.5 4.2"/><path d="M16 13.2 C16.2 8.5 16 6 18.5 4.2"/><path d="M18.5 4.2 c2.4 -.7 4.1 .8 3.6 3.3 c-2.4 .7 -4.1 -.8 -3.6 -3.3Z"/></svg>
        </span>
        <h2 class="onb-title">${pick("b3os에 오신 걸 환영합니다", "Welcome to b3os")}</h2>
        <p class="onb-sub">${pick("아직 팀원이 없어요. 3단계로 나만의 AI 팀을 시작하세요.", "No members yet. Start your own AI team in 3 steps.")}</p>
        <ol class="onb-steps">
          ${STEP("1", pick("첫 팀원 만들기", "Create your first member"), pick("이름과 역할을 정하면 끝. 예: “자료를 찾아주는 리서치 담당”", "Just set a name and a role. e.g. “a research member who finds information”"))}
          ${STEP("2", pick("Claude 연결하기", "Connect Claude"), pick("Claude(권장)로 시작하세요. OpenClaw·Hermes 도 연결할 수 있어요.", "Start with Claude (recommended). You can also connect OpenClaw or Hermes."))}
          ${STEP("3", pick("첫 대화로 일 맡기기", "Assign work in your first chat"), pick("팀원에게 말 걸듯 일을 맡기면 b3os가 진행을 남깁니다.", "Hand off work as if talking to a member, and b3os keeps a record of the progress."))}
        </ol>
        <div class="onb-cta">
          <button id="onb-recruit" class="onb-btn-primary">${pick("첫 팀원 만들기 →", "Create your first member →")}</button>
          <button id="onb-explore" class="onb-btn-ghost">${pick("먼저 둘러보기", "Look around first")}</button>
        </div>
      </div>`;

    overlay.querySelector<HTMLButtonElement>("#onb-recruit")?.addEventListener("click", () => {
      openRecruitForm();            // Settings 첫 렌더에서 영입 폼을 바로 펼침
      store.getState().setMainView("settings");
      store.getState().setMobilePane("main");
      dismissed = true;
      update();
    });
    overlay.querySelector<HTMLButtonElement>("#onb-explore")?.addEventListener("click", () => {
      dismissed = true;
      update();
    });
  };

  update();
  store.subscribe(update);
}
