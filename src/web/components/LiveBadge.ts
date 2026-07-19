// LiveBadge — 라이브(정본) 대시보드 상단 구별 스트립. (OWNER 2026-07-02)
// 웹 대시보드 origin이 your-team.example.com(정본 라이브)일 때만 #app 최상단에 초록 바 + 빌드 식별자.
// 퍼블릭(localhost:7878)·기타 origin에는 렌더하지 않음 → 라이브를 한눈에 구별.
// (네이티브 맥앱 바 A안은 OWNER "차이 두지 말고 맥앱 흰색" 지시로 폐기 → 구별 표식은 웹 전용으로 유지.)
// 색: #23895C(OWNER 확정 B) + 하얀 글씨. 빌드 식별자 = 로드된 번들 해시(index-XXXX.js).

const LIVE_HOSTS = new Set(["your-team.example.com"]);
// b3os 제품 버전 (OWNER 2026-07-02: 0.5.0). package.json version과 맞춰 관리.
const APP_VERSION = "0.5.0";

function buildTag(): string {
  const s = document.querySelector<HTMLScriptElement>('script[src*="/assets/index-"]');
  const m = s?.src.match(/index-([A-Za-z0-9_-]+)\.js/);
  return m?.[1] ?? "dev";
}

export function renderLiveBadge(app: HTMLElement): void {
  if (!LIVE_HOSTS.has(location.hostname)) return;
  if (document.getElementById("live-badge")) return; // 멱등
  const bar = document.createElement("div");
  bar.id = "live-badge";
  bar.setAttribute(
    "style",
    "flex:0 0 auto;width:100%;background:#23895C;color:#fff;font-size:11px;font-weight:700;" +
      "line-height:1;padding:4px 12px;display:flex;align-items:center;justify-content:center;gap:10px;letter-spacing:0.02em",
  );
  bar.innerHTML =
    `<span>● LIVE · your-team.example.com · v${APP_VERSION}</span>` +
    `<span style="opacity:0.78;font-family:ui-monospace,monospace">build ${buildTag()}</span>`;
  app.insertBefore(bar, app.firstChild);
}
