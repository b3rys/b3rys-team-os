// 팀원 아이콘 색 — 퍼블릭 팀에서 멤버를 한눈에 구분하기 위한 색(OWNER 2026-06-26).
// green(기본)은 기존 text-accent-greenSoft 클래스를 그대로 쓰고, 나머지 색만 인라인 color 적용.
// SVG 아이콘은 stroke="currentColor"라 부모 span의 color로 물든다(icons.ts 참고).
import { renderIcon } from "./icons";

export const AGENT_ICON_COLORS: { key: string; label: string; hex: string }[] = [
  { key: "green", label: "초록", hex: "#34d399" }, // 기본 — 실제 렌더는 text-accent-greenSoft 사용
  { key: "orange", label: "주황", hex: "#f59e0b" },
  { key: "yellow", label: "노랑", hex: "#eab308" },
  { key: "blue", label: "파랑", hex: "#3b82f6" },
  { key: "red", label: "빨강", hex: "#ef4444" },
  { key: "violet", label: "보라", hex: "#8b5cf6" },
];

export const ICON_COLOR_KEYS = AGENT_ICON_COLORS.map((c) => c.key);
export const DEFAULT_ICON_COLOR = "green";

// green/미설정 → null(기본 greenSoft 클래스 사용 신호). 그 외 → hex.
export function iconColorHex(key?: string | null): string | null {
  const c = AGENT_ICON_COLORS.find((x) => x.key === key);
  return c && c.key !== "green" ? c.hex : null;
}

// 아이콘을 팀원 색으로 렌더. green/미설정이면 기존 text-accent-greenSoft 유지(시각적 변화 없음).
export function renderAgentIcon(name: string, colorKey?: string | null, size = 18, extraClass = ""): string {
  const hex = iconColorHex(colorKey);
  return hex
    ? `<span class="inline-flex ${extraClass}" style="color:${hex}">${renderIcon(name, { size })}</span>`
    : `<span class="text-accent-greenSoft inline-flex ${extraClass}">${renderIcon(name, { size })}</span>`;
}
