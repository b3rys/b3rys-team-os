/**
 * cogs 코덱스 팀원 정책 → 이번 턴의 실행 설정. 순수 함수(파일·DB·시간을 읽지 않는다).
 *
 * 대상 판정은 부르는 쪽이 명시한다(cogs 채널 브리지만 부른다). 프롬프트·경로 유무로 cogs 인지 추측하지 않는다.
 *   absent  → legacy: 지금 동작 그대로(정책을 안 만든 기존 팀원을 자동 전환하지 않는다).
 *   invalid → blocked: 넓혀서 돌지 않고 턴을 막는다.
 *   full    → 승인 없이 전체(never + danger-full-access) — '전체 허용 = 승인 없이' 의 뜻 그대로.
 *   그 밖   → 승인 카드(on-request) + workspace-write, 쓰기 = 작업 폴더 + 정확한 writable_roots, 인터넷 = 정책값.
 */
import type { PolicyState } from "../../lib/cogsPermissions/policy";
import { policyStamp } from "../../lib/cogsPermissions/policy";
import type { CodexSandboxMode } from "../../types";

export type CogsCodexRun =
  | { mode: "legacy" }
  | { mode: "blocked"; reason: string }
  | {
      mode: "enforced";
      /** 이 설정을 만든 정책 도장 — 바뀌면 예전 권한으로 띄운 app-server 를 다시 쓰지 않는다. */
      stamp: string;
      approvalPolicy: "never" | "on-request";
      sandbox: CodexSandboxMode;
      networkAccess?: boolean;
      writableRoots: string[];
    };

export function resolveCogsCodexRun(state: PolicyState, workdir: string | undefined): CogsCodexRun {
  if (state.state === "absent") return { mode: "legacy" };
  if (state.state === "invalid") return { mode: "blocked", reason: state.reason };
  const p = state.policy;
  if (p.runtime !== "codex") return { mode: "blocked", reason: "runtime_mismatch" };
  const stamp = policyStamp(p);
  if (p.full) return { mode: "enforced", stamp, approvalPolicy: "never", sandbox: "danger-full-access", writableRoots: [] };
  // 작업 폴더가 없으면 쓰기 범위를 지어내지 않는다 — 정책의 정확한 경로만.
  const roots = [...(workdir ? [workdir] : []), ...p.writable_roots.filter((r) => r !== workdir)];
  return { mode: "enforced", stamp, approvalPolicy: "on-request", sandbox: "workspace-write", networkAccess: p.network, writableRoots: roots };
}
