// gateway liveness — openclaw·hermes 팀원의 게이트웨이 프로세스가 실제로 떠 있는지.
//
// runtimeEssentials 는 설정 파일(토큰·계정·plist)만 본다. 그래서 게이트웨이가 launchd 에서
// 내려가 있거나(disabled·bootout) 프로세스가 죽어 있어도 "필수 항목 정상" 으로 나온다 —
// 설정은 그대로이기 때문이다. 이 모듈은 healthCheck 가 essentials 와 함께 부르는 '지금 살아 있나' 검사다.
//
// essentials 레지스트리에 넣지 않은 이유: activation 의 waitForEssentialSettings 도 그 레지스트리를
// 쓴다. 영입·재활성화 도중 게이트웨이 재시작 구간에서 대기가 길어지거나 실패로 바뀌면 안 된다.
//
// 잴 수 없으면(macOS 가 아님·launchctl 실행 실패) 아무것도 보고하지 않는다 — '모름' 을 '고장' 으로
// 바꾸지 않는다.
import { spawnSync } from "node:child_process";
import type { AgentRecord } from "../types";

export type LaunchdState = { loaded: boolean; pid: number | null };
/** null = 잴 수 없음(판정 보류). */
export type LaunchdProbe = (label: string) => LaunchdState | null;

export const defaultLaunchdProbe: LaunchdProbe = (label) => {
  if (process.platform !== "darwin") return null;
  const r = spawnSync("launchctl", ["list", label], { encoding: "utf8", timeout: 5000 });
  if (r.error || r.status === null) return null;
  // launchctl list <label>: 로드돼 있으면 0, 없는 라벨이면 0 이 아닌 값(실측 113).
  if (r.status !== 0) return { loaded: false, pid: null };
  const m = /"PID"\s*=\s*(\d+);/.exec(r.stdout ?? "");
  return { loaded: true, pid: m ? Number(m[1]) : null };
};

/** 그 팀원이 기대는 게이트웨이의 launchd 라벨. 게이트웨이가 없는 런타임이면 null. */
export function gatewayLabel(agent: Pick<AgentRecord, "id" | "runtime" | "hermes_profile">): string | null {
  if (agent.runtime === "openclaw") return "ai.openclaw.gateway";
  if (agent.runtime === "hermes_agent") return `ai.hermes.gateway-${agent.hermes_profile ?? agent.id}`;
  return null;
}

/** 빠진 항목 목록(essentials 의 missing 과 같은 모양). 정상이거나 잴 수 없으면 []. */
export function checkGatewayLiveness(
  agent: Pick<AgentRecord, "id" | "runtime" | "hermes_profile">,
  probe: LaunchdProbe = defaultLaunchdProbe,
): string[] {
  const label = gatewayLabel(agent);
  if (!label) return [];
  const state = probe(label);
  if (state === null) return [];
  if (!state.loaded) return [`gateway:${label} launchd 미로드`];
  if (state.pid === null) return [`gateway:${label} 프로세스 없음`];
  return [];
}
