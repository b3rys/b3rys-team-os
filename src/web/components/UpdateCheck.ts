// UpdateCheck — 배포 감지 "업데이트" 핀 (오른쪽 상단).
// 대시보드가 자기 재배포를 감지: 주기적으로 index.html을 받아 참조 번들 해시(index-XXXX.js)를
// 현재 로드된 번들 해시와 비교. 다르면 새 배포 → 오른쪽 상단에 작은 "업데이트" 핀 표시(자동 reload X).
// 누르면 location.reload()로 최신 반영(그 전까지 화면·입력 상태 유지). 서버 엔드포인트 불필요(정적 index.html).
// GD 2026-06-26: 맥앱은 자동업데이트 안 됨 → 배포 후 이 핀으로 알리고 사용자가 새로고침.

import { pick } from "../i18n";

function currentBundleHash(): string | null {
  const s = document.querySelector<HTMLScriptElement>('script[src*="/assets/index-"]');
  const m = s?.src.match(/index-([A-Za-z0-9_-]+)\.js/);
  return m?.[1] ?? null;
}

function indexBase(): string {
  // 번들 src가 .../team/assets/index-XXXX.js → base = .../team/
  const s = document.querySelector<HTMLScriptElement>('script[src*="/assets/index-"]');
  const src = s?.src ?? location.href;
  const i = src.indexOf("/assets/");
  return i >= 0 ? src.slice(0, i + 1) : location.pathname.replace(/[^/]*$/, "");
}

export function renderUpdateCheck(host: HTMLElement): void {
  const current = currentBundleHash();
  const base = indexBase();

  const pill = document.createElement("button");
  pill.id = "update-pill";
  pill.type = "button";
  pill.title = pick("새 버전이 배포됐어요 — 눌러서 새로고침", "A new version is available — click to refresh");
  pill.setAttribute("aria-label", pick("새 버전 — 새로고침", "New version — refresh"));
  pill.innerHTML = `<span class="update-dot"></span>${pick("업데이트", "Update")}`;
  pill.addEventListener("click", () => location.reload());
  host.appendChild(pill);

  let shown = false;
  const check = async () => {
    if (shown || !current) return;
    try {
      const r = await fetch(`${base}?_=${Date.now()}`, { cache: "no-store", headers: { accept: "text/html" } });
      if (!r.ok) return;
      const html = await r.text();
      const m = html.match(/assets\/index-([A-Za-z0-9_-]+)\.js/);
      const server = m?.[1] ?? null;
      if (server && server !== current) {
        pill.classList.add("show");
        shown = true;
      }
    } catch {
      /* offline/터널다운 등은 무시 — 다음 주기에 재시도 */
    }
  };

  setTimeout(check, 30_000);          // 첫 감지(빠르게)
  setInterval(check, 60_000);         // 이후 1분마다
}
