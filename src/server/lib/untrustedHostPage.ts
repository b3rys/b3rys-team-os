// 신뢰 관문이 assets도 차단하므로 안내 페이지는 CSS·JS·이미지에 외부 의존성이 없어야 한다. 위젯별 실패 대신 한 페이지로 접근 조건을 설명한다.

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
  // 사용자가 그대로 복사해 팀원에게 붙여넣을 문장. 자기 주소가 이미 들어 있어 되물을 게 없다.
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
  .warn { margin-top:10px; padding:10px 12px; border-radius:6px; background:#2a2118; border:1px solid #4a3a22; color:#d9c08a; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  @media (prefers-color-scheme: light) {
    body { background:#f6f7f9; color:#1b1f27; }
    .card { background:#fff; border-color:#e2e5ea; }
    p { color:#4d5563; } .host, pre { background:#f1f3f6; color:#1b1f27; } pre { border-color:#e2e5ea; }
    .why { color:#6b7280; border-top-color:#e2e5ea; }
    .warn { background:#fdf6e3; border-color:#e8d9a8; color:#7a5c14; }
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
    단, <code>TEAM_BIND</code> 가 루프백(<code>127.0.0.1</code>·<code>localhost</code>)일 때만 적용되며,
    서버를 외부에 직접 열어둔 상태에서는 등록해도 무시됩니다.
    <div class="warn">등록하는 순간 <b>그 주소로 들어온 사람은 누구든 팀리드 권한</b>을 얻습니다.
    내부망 주소이거나, 앞에 로그인 관문(Cloudflare Access·사내 SSO 등)이 있는 주소만 등록하세요.</div>
  </div>
</div></body></html>`;
}
