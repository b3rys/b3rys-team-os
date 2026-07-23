// LiveBadge — 배포된(비-localhost) 대시보드 상단 구별 스트립. (GD 2026-07-02)
// 로컬 개발(localhost/127.0.0.1)에는 렌더하지 않고, 배포 origin이면 #app 최상단에 초록 바 +
// ★자기 hostname★ + 빌드 식별자를 띄운다 → 로컬 dev 와 배포 인스턴스를 한눈에 구별.
// (특정 도메인 하드코딩 없이 origin 기준으로 판단 — public=source: 어느 배포처든 자기 hostname 표시.)
// 색: #23895C(GD 확정 B) + 하얀 글씨. 빌드 식별자 = 로드된 번들 해시(index-XXXX.js).

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", ""]);
// b3os 제품 버전. package.json version과 맞춰 관리.
const APP_VERSION = "0.5.0";

function buildTag(): string {
  const s = document.querySelector<HTMLScriptElement>('script[src*="/assets/index-"]');
  const m = s?.src.match(/index-([A-Za-z0-9_-]+)\.js/);
  return m?.[1] ?? "dev";
}

export function renderLiveBadge(app: HTMLElement): void {
  if (LOCAL_HOSTS.has(location.hostname)) return;
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
