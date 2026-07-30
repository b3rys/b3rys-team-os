/**
 * 신뢰하지 않는 주소로 대시보드를 열었을 때 보여주는 페이지.
 *
 * ★왜 페이지가 필요한가★ (팀장님 지시 2026-07-30)
 * 읽기까지 막으면 화면 껍데기는 뜨는데 안의 위젯이 전부 깨진다 — 사용자에게는
 * "고장난 것 같기도 하고 아닌 것 같기도 한" 상태가 된다. 오늘 우리가 겪은 게 정확히 그거였고
 * (화면은 뜨는데 버튼만 안 먹음), 원인을 찾는 데 한참 걸렸다.
 * 그래서 조각조각 실패하게 두지 않고 ★한 장으로 무슨 일인지 말한다.★
 *
 * ★자체 포함이어야 한다★ — 이 페이지가 뜨는 상황에서는 `/team/assets/*` 도 같이 막힌다.
 * 그래서 외부 CSS·JS·이미지를 쓰지 않는다. 인라인 스타일만 쓴다.
 */

function esc(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function untrustedHostPage(host: string): string {
  const shown = host.trim() || "(주소를 읽지 못했습니다)";
  // 사용자가 그대로 복사해 팀원에게 붙여넣을 문장. ★자기 주소가 이미 들어 있어 되물을 게 없다.★
  const ask =
    `대시보드를 ${shown} 로 여는데 "등록되지 않은 주소" 라고 나옵니다. ` +
    `TEAM_TRUSTED_DASHBOARD_HOSTS 에 이 주소를 등록해 주세요.`;
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>등록되지 않은 주소 — b3os</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
         background:#0f1115; color:#e6e8ee; padding:24px; }
  .card { max-width:640px; width:100%; background:#171a21; border:1px solid #262b36;
          border-radius:12px; padding:28px 30px; }
  h1 { margin:0 0 6px; font-size:19px; font-weight:650; }
  .host { display:inline-block; margin:10px 0 18px; padding:4px 10px; border-radius:6px;
          background:#22262f; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
  p { margin:0 0 14px; color:#aeb4c2; }
  .ask { margin:18px 0 6px; font-weight:600; color:#e6e8ee; }
  pre { margin:0; padding:14px 16px; border-radius:8px; background:#22262f; border:1px solid #2d3340;
        white-space:pre-wrap; word-break:break-word; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
        font-size:13px; color:#dfe3ec; }
  .why { margin-top:22px; padding-top:16px; border-top:1px solid #262b36; font-size:13px; color:#8d94a3; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  @media (prefers-color-scheme: light) {
    body { background:#f6f7f9; color:#1b1f27; }
    .card { background:#fff; border-color:#e2e5ea; }
    p { color:#4d5563; } .host, pre { background:#f1f3f6; color:#1b1f27; } pre { border-color:#e2e5ea; }
    .why { color:#6b7280; border-top-color:#e2e5ea; }
  }
</style></head>
<body><div class="card">
  <h1>등록되지 않은 주소입니다</h1>
  <div class="host">${esc(shown)}</div>
  <p>b3os 는 서버가 도는 컴퓨터에서 연 화면(<code>127.0.0.1</code> 또는 <code>localhost</code>)과,
     관리자가 미리 등록한 주소에서만 열립니다. 이 주소는 아직 등록되어 있지 않습니다.</p>
  <p class="ask">팀원에게 이대로 물어보세요</p>
  <pre>${esc(ask)}</pre>
  <div class="why">
    등록은 서버의 <code>.env</code> 에 <code>TEAM_TRUSTED_DASHBOARD_HOSTS</code> 한 줄을 넣고
    서버를 다시 띄우면 됩니다. 콤마로 여러 개, <code>*.</code> 로 하위 주소 전체를 적을 수 있습니다.
  </div>
</div></body></html>`;
}
