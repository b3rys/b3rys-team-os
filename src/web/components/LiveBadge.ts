// LiveBadge — 라이브(정본) 대시보드 상단 구별 스트립. (GD 2026-07-02)
// dev.b3rys.com에서만 #app 최상단에 초록 바 + 빌드 식별자를 띄운다.
// 퍼블릭(studio.b3rys.com)·로컬·기타 origin에는 렌더하지 않는다.
// 색: #23895C(GD 확정 B) + 하얀 글씨. 빌드 식별자 = 로드된 번들 해시(index-XXXX.js).

const LIVE_HOSTS = new Set(["dev.b3rys.com"]);
// b3os 제품 버전. package.json version과 맞춰 관리.
export const APP_VERSION = "0.6.0";

export function shouldShowLiveBadge(hostname: string): boolean {
  return LIVE_HOSTS.has(hostname);
}

function buildTag(): string {
  const s = document.querySelector<HTMLScriptElement>('script[src*="/assets/index-"]');
  const m = s?.src.match(/index-([A-Za-z0-9_-]+)\.js/);
  return m?.[1] ?? "dev";
}

export function renderLiveBadge(app: HTMLElement): void {
  if (!shouldShowLiveBadge(location.hostname)) return;
  if (document.getElementById("live-badge")) return; // 멱등
  const bar = document.createElement("div");
  bar.id = "live-badge";
  bar.setAttribute(
    "style",
    "flex:0 0 auto;width:100%;background:#23895C;color:#fff;font-size:11px;font-weight:700;" +
      "line-height:1;padding:4px 12px;display:flex;align-items:center;justify-content:center;gap:10px;letter-spacing:0.02em",
  );
  bar.innerHTML =
    `<span>● LIVE · ${location.hostname} · v${APP_VERSION}</span>` +
    `<span style="opacity:0.78;font-family:ui-monospace,monospace">build ${buildTag()}</span>`;
  app.insertBefore(bar, app.firstChild);
}
