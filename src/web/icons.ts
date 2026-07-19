// Lucide icon paths (MIT licensed, lucide.dev). 24x24 viewBox, stroke-only, single color via currentColor.
// 디자인 원칙: 단색 톤, 심플 outline.

export const ICONS: Record<string, string> = {
  // Brand — b3rys 마크 (assets/b3rys-icon.svg, 라인). 상단바 브랜드 아이콘.
  b3rys: '<circle cx="8.5" cy="16.5" r="3.7"/><circle cx="16" cy="16.5" r="3.3"/><path d="M8.5 12.8 C10 6.5 15 4.5 18.5 4.2"/><path d="M16 13.2 C16.2 8.5 16 6 18.5 4.2"/><path d="M18.5 4.2 c2.4 -.7 4.1 .8 3.6 3.3 c-2.4 .7 -4.1 -.8 -3.6 -3.3Z"/>',
  // Agent personas — semantic match per role
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  "flask-conical": '<path d="M10 2v7.31"/><path d="M14 9.3V1.99"/><path d="M8.5 2h7"/><path d="M14 9.3a6.5 6.5 0 1 1-4 0"/><path d="M5.52 16h12.96"/>',
  "flask-triangle": '<path d="M9 3h6"/><path d="M10 3v6l-5.4 9.3A1 1 0 0 0 5.5 20h13a1 1 0 0 0 .9-1.7L14 9V3"/><path d="M7 14h10"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
  landmark: '<line x1="3" x2="21" y1="22" y2="22"/><line x1="6" x2="6" y1="18" y2="11"/><line x1="10" x2="10" y1="18" y2="11"/><line x1="14" x2="14" y1="18" y2="11"/><line x1="18" x2="18" y1="18" y2="11"/><polygon points="12 2 20 7 4 7"/>',
  newspaper: '<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6Z"/>',
  // Thread kinds
  "message-square": '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  // Mobile tabs
  "user-circle": '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.66A8 8 0 1 1 17 20.66"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/>',
  "hard-drive": '<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7H6.5a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  "file-text": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.82l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.91a1 1 0 0 0 0-1.82Z"/><path d="m22 12.5-9.17 4.17a2 2 0 0 1-1.66 0L2 12.5"/><path d="m22 17.5-9.17 4.17a2 2 0 0 1-1.66 0L2 17.5"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  workflow: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M9 6h6"/><path d="M18 9v6"/><path d="M12 18H9a3 3 0 0 1-3-3V9"/>',
  "panel-right-close": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m8 9 3 3-3 3"/>',
  "panel-right-open": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m11 9-3 3 3 3"/>',
  // Misc
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  "circle-dot": '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  // Nav (이모지 대체 — 심플 outline 통일)
  activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  "share-2": '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  "list-todo": '<rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  // Settings/action buttons (이모지 🔄🔁🔴 대체 — 라인 SVG 통일)
  "refresh-cw": '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  "rotate-ccw": '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  power: '<path d="M12 2v10"/><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>',
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-up": '<path d="m18 15-6-6-6 6"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
};

export const AGENT_ICON: Record<string, string> = {
  bill: "wrench",
  steve: "code",
  demis: "flask-conical",
  codex: "cpu",
  dbak: "landmark",
  brief: "newspaper",
};

export function agentIconName(id: string): string {
  return AGENT_ICON[id] ?? "bot";
}

export function threadKindIcon(kind: string): string {
  if (kind === "meeting") return "users";
  if (kind === "broadcast") return "megaphone";
  return "message-square";
}

export function renderIcon(name: string, opts: { size?: number; className?: string } = {}): string {
  const path = ICONS[name];
  if (!path) return "";
  const size = opts.size ?? 20;
  const cls = opts.className ?? "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">${path}</svg>`;
}

// ---------------------------------------------------------------------------
// 아이콘 → JPG 다운로드 (텔레그램 BotFather·슬랙 아바타 업로드용). OWNER 2026-06-10.
// SVG 글리프를 배경색 정사각형에 올려 캔버스로 래스터화 → JPEG. 서버 불필요(브라우저 only).
// ---------------------------------------------------------------------------

/** 아이콘을 정사각형 JPG 로 만들어 data URL 반환. bg=배경, fg=글리프 색. */
export function agentIconToJpegDataUrl(
  agentId: string,
  opts: { size?: number; bg?: string; fg?: string; icon?: string } = {},
): Promise<string> {
  const size = opts.size ?? 512;
  const bg = opts.bg ?? "#0e1a14"; // b3rys dark surface
  const fg = opts.fg ?? "#34d399"; // accent green
  // 저장된 icon(agents.json) 우선 → 없을 때만 id 기본맵(AGENT_ICON). 비창립멤버가 bot(로봇)로 떨어지던 버그 fix.
  const path = ICONS[opts.icon || agentIconName(agentId)] ?? ICONS["bot"] ?? "";
  const inner = size * 0.54; // 글리프 영역(여백 포함)
  const scale = inner / 24;
  const off = (size - inner) / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="${bg}"/>` +
    `<g transform="translate(${off},${off}) scale(${scale})" fill="none" stroke="${fg}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${path}</g>` +
    `</svg>`;
  return new Promise((resolve, reject) => {
    const img = new Image();
    const svgUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("no 2d ctx"));
      ctx.fillStyle = bg; // JPEG 알파 없음 — 배경 먼저 채움
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
      resolve(canvas.toDataURL("image/jpeg", 0.92));
    };
    img.onerror = () => reject(new Error("svg image load failed"));
    img.src = svgUrl;
  });
}

type DownloadResult = "saved" | "cancelled";

type AppShellBridgeReceiver = {
  receive?: (body: { id?: string; result?: { ok?: boolean; cancelled?: boolean }; error?: string }) => void;
};

function nativeBridge(): { postMessage: (body: unknown) => void } | null {
  return (window as unknown as {
    webkit?: { messageHandlers?: { bridge?: { postMessage: (body: unknown) => void } } };
  }).webkit?.messageHandlers?.bridge ?? null;
}

function sendNativeBridge(
  command: string,
  payload: Record<string, unknown>,
): Promise<{ ok?: boolean; cancelled?: boolean }> {
  const bridge = nativeBridge();
  if (!bridge) return Promise.reject(new Error("native bridge unavailable"));

  const host = window as unknown as { __appShellBridge?: AppShellBridgeReceiver };
  const previous = host.__appShellBridge;
  const previousReceive = previous?.receive;
  const id = `b3rys-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (host.__appShellBridge?.receive === receive) {
        if (previous) host.__appShellBridge = previous;
        else delete host.__appShellBridge;
      }
      reject(new Error("native bridge timeout"));
    }, 120000);

    const receive = (body: { id?: string; result?: { ok?: boolean; cancelled?: boolean }; error?: string }) => {
      if (body?.id !== id) {
        previousReceive?.call(previous, body);
        return;
      }
      window.clearTimeout(timer);
      if (previous) host.__appShellBridge = previous;
      else delete host.__appShellBridge;
      if (body.error) reject(new Error(body.error));
      else resolve(body.result ?? {});
    };

    host.__appShellBridge = { ...previous, receive };
    bridge.postMessage({ id, command, payload });
  });
}

function splitDataUrl(dataUrl: string): { mimeType: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return null;
  const [, mimeType, base64] = match;
  if (!mimeType || !base64) return null;
  return { mimeType, base64 };
}

/** 아이콘 JPG 를 파일로 다운로드 (<agentId>-icon.jpg). iconName=agents.json 저장 icon(없으면 기본맵). */
export async function downloadAgentIconJpg(agentId: string, iconName?: string): Promise<DownloadResult> {
  const dataUrl = await agentIconToJpegDataUrl(agentId, { icon: iconName });
  const filename = `${agentId}-icon.jpg`;
  const nativePayload = splitDataUrl(dataUrl);
  if (nativePayload && nativeBridge()) {
    const result = await sendNativeBridge("shell.saveFile", { filename, ...nativePayload });
    return result.cancelled ? "cancelled" : "saved";
  }

  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return "saved";
}
