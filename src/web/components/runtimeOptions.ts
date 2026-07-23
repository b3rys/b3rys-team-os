import { apiBase } from "../ws";

export interface RuntimeOption {
  runtime: "claude_channel" | "hermes_agent" | "openclaw" | "codex";
  label: string;
  recommended: boolean;
  tier: "default" | "advanced_byo";
  disabled: boolean;
  reason: string;
  setup_ref: string | null;
}

export const FALLBACK_RUNTIME_OPTIONS: RuntimeOption[] = [
  { runtime: "claude_channel", label: "Claude", recommended: true, tier: "default", disabled: false, reason: "기본 권장 런타임", setup_ref: null },
  { runtime: "hermes_agent", label: "Hermes (BYO)", recommended: false, tier: "advanced_byo", disabled: true, reason: "연동 상태를 확인할 수 없습니다.", setup_ref: "skills/b3os/references/runtime-setup.md#hermes-agent" },
  { runtime: "openclaw", label: "OpenClaw (BYO)", recommended: false, tier: "advanced_byo", disabled: true, reason: "연동 상태를 확인할 수 없습니다.", setup_ref: "skills/b3os/references/runtime-setup.md#openclaw" },
];

// 서버 /runtime-options 는 빌드모드에 따라 공개 3종 또는 내부 3종+codex 를 준다.
//   공개(PUBLIC_BUILD=true) = claude_channel,hermes_agent,openclaw
//   내부(PUBLIC_BUILD=false) = 위 3종 + codex
// 2차방어(형태검증)는 두 형태만 허용 — 그 외(누출·손상)는 보수적으로 공개3종 fallback 으로 되돌린다.
const PUBLIC_RUNTIME_SHAPE = "claude_channel,hermes_agent,openclaw";
const INTERNAL_RUNTIME_SHAPE = "claude_channel,hermes_agent,openclaw,codex";

export async function fetchRuntimeOptions(): Promise<RuntimeOption[]> {
  try {
    const response = await fetch(`${apiBase()}/api/runtime-options`, { headers: { accept: "application/json" } });
    if (!response.ok) return FALLBACK_RUNTIME_OPTIONS;
    const body = await response.json() as { options?: RuntimeOption[]; public_build?: boolean };
    if (!Array.isArray(body.options)) return FALLBACK_RUNTIME_OPTIONS;
    const shape = body.options.map((o) => o.runtime).join(",");
    if (shape !== PUBLIC_RUNTIME_SHAPE && shape !== INTERNAL_RUNTIME_SHAPE) return FALLBACK_RUNTIME_OPTIONS;
    return body.options;
  } catch {
    return FALLBACK_RUNTIME_OPTIONS;
  }
}

export function runtimeLabel(runtime: string, options: RuntimeOption[] = FALLBACK_RUNTIME_OPTIONS): string {
  return options.find((option) => option.runtime === runtime)?.label ?? runtime;
}

export function runtimeSetupHref(setupRef: string | null | undefined): string {
  const anchor = String(setupRef ?? "").split("#")[1] ?? "";
  return `${apiBase()}/docs/runtime-setup.md${anchor ? `#${encodeURIComponent(anchor)}` : ""}`;
}
