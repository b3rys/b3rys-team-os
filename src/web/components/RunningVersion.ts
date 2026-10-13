import { apiBase } from "../ws";

export function versionLabel(data: { version?: unknown; commit?: unknown }): string {
  const version = typeof data.version === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(data.version) ? `v${data.version}` : "version unavailable";
  const commit = typeof data.commit === "string" && /^[a-f0-9]{7,40}$/.test(data.commit) ? data.commit : "commit unavailable";
  return `b3os ${version} · ${commit}`;
}

export async function renderRunningVersion(target: HTMLElement): Promise<void> {
  target.textContent = "b3os version unavailable";
  try {
    const response = await fetch(`${apiBase()}/api/version`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok) return;
    target.textContent = versionLabel(await response.json());
  } catch { /* Keep an explicit unavailable state. */ }
}
