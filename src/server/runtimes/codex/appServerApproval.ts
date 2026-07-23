/**
 * M3 — codex app-server 승인요청(ServerRequest) → permissionGate 판정.
 *
 * ★집행지점 프레이밍(하네스 F2 정정): 게이트 실효는 codex가 그 op을 '승인요청으로 올려보낼 때만' 성립한다.★
 *  - read-only 샌드박스: 모든 쓰기/실행이 escalation → 승인요청 → 게이트가 봄(F1으로 non-Tier-D도 ask=거절). 실효 O.
 *  - ★workspace-write 샌드박스: writable_roots 안 파괴(rm·overwrite·git reset)는 codex가 승인요청 없이 자체 실행 →
 *    게이트에 안 옴 = Tier-D 여전히 dead code. 따라서 실행권 주는 dex는 read-only+on-request 강제해야 안전.★
 *
 * 판정 → ReviewDecision:
 *  - Tier D(하드deny) → "denied" (승인으로도 못 뚫음)
 *  - ★F1: bash escalation은 Tier-D 아니면 무조건 ask(자동허용 없음)★ → 팝업 전엔 fail-closed "denied".
 *  - ask(위험하지만 정당) → needsApproval=true → 상위(M5)가 GD 텔레그램 팝업.
 */
import { checkPermission, type PermissionAgent, type PermissionContext, type PermissionCheck } from "../../lib/permissionGate";
import type { ApprovalRequest, ReviewDecision } from "./appServerClient";

export interface ApprovalJudgment {
  decision: ReviewDecision | null; // 확정 결정(approved/denied) 또는 null(=needsApproval)
  needsApproval: boolean; // true면 GD 팝업 필요(M5)
  check: PermissionCheck; // 근거(tier/rule/reason)
  summary: string; // 팝업/audit 표시용 요약
}

/** 승인요청을 permissionGate로 판정. */
export function judgeApproval(
  agent: PermissionAgent,
  req: ApprovalRequest,
  ctx: PermissionContext = {},
): ApprovalJudgment {
  const check = evaluate(agent, req, ctx);
  if (check.tier === "deny") {
    return { decision: "denied", needsApproval: false, check, summary: summarize(req) };
  }
  if (check.tier === "allow") {
    return { decision: "approved", needsApproval: false, check, summary: summarize(req) };
  }
  // ask → GD 팝업 필요. 팝업 전엔 확정 안 함(상위가 처리).
  return { decision: null, needsApproval: true, check, summary: summarize(req) };
}

/** 팝업 배선 전 임시 안전 기본: ask는 fail-closed로 거절(무인 안전). M5에서 팝업으로 대체. */
export function resolveWithoutPopup(j: ApprovalJudgment): ReviewDecision {
  return j.decision ?? "denied";
}

function evaluate(agent: PermissionAgent, req: ApprovalRequest, ctx: PermissionContext): PermissionCheck {
  const p = req.params as Record<string, any>;
  if (req.method === "execCommandApproval" || req.method === "item/commandExecution/requestApproval") {
    const cmd = Array.isArray(p.command) ? p.command.join(" ") : String(p.command ?? "");
    const c = checkPermission(agent, { kind: "bash", cmd }, ctx);
    // ★안전 F1 픽스(하네스 발견): permissionGate.askRule에 bash 케이스가 없어 bash는 deny/allow 둘 뿐이다.
    // 그대로 두면 Tier-D 정규식 9개만 피한 임의 셸(rm -r -f·git reset --hard 등)이 auto-allow로 샌다.
    // ★execCommandApproval = codex의 escalation 요청이므로, Tier-D deny가 아니면 무조건 ask로 승격★
    // → resolveWithoutPopup=fail-closed denied(팝업 전) / M5 팝업(GD 승인). 정책 'ask=거절'이 셸을 실제로 덮는다.★
    if (c.tier === "allow") {
      return { tier: "ask", rule: "bash.escalation", reason: "shell escalation always requires approval (no auto-allow)", scope: `bash:${cmd.slice(0, 80)}` };
    }
    return c; // deny(Tier-D) 유지
  }
  if (req.method === "applyPatchApproval" || req.method === "item/fileChange/requestApproval") {
    // 파일 변경 중 하나라도 Tier-D(보안설정·워크스페이스 밖)면 deny.
    const files = p.fileChanges && typeof p.fileChanges === "object" ? Object.keys(p.fileChanges) : [];
    for (const path of files) {
      const c = checkPermission(agent, { kind: "write", path }, ctx);
      if (c.tier === "deny") return c;
    }
    // ★안전 F5 픽스(하네스): checkPermission의 write는 ask 티어가 없어 워크스페이스 안이면 allow.
    // read-only 강제(F2) 하에 applyPatch=escalation이므로 F1과 동일하게 Tier-D 아니면 무조건 ask(자동허용 금지).
    // 특히 실행체 경로(.git/hooks·*.sh·package.json·AGENTS.md·CLAUDE.md·.env)는 내용 무검사로 auto-allow 시
    // 나중에 실행/유출되는 백도어 심기 → deny 뚫는 우회. 전부 ask로 승인 필요.★
    const dangerous = files.find(isExecutableOrSecretWritePath);
    const reason = dangerous
      ? `patch to sensitive path requires approval: ${dangerous.slice(0, 120)}`
      : "workspace patch escalation requires approval (content unverified)";
    return { tier: "ask", rule: "write.escalation", reason, scope: `write:${files[0]?.slice(0, 80) ?? ""}` };
  }
  // item/permissions/requestApproval, item/tool/requestUserInput 등 = 기본 ask(사람 판단 필요).
  return { tier: "ask", rule: "approval.generic", reason: `unmapped approval: ${req.method}` };
}

/**
 * ★GD UX(2026-07-05): 하드 차단은 막다른 "차단됨"이 아니라 사용자에게 '어떻게 하면 되는지' 안내한다.★
 * ★GD 후속(msg838): 터미널 명령뿐 아니라 파일변경·외부전송 등 작업 종류별로 안내가 달라야 한다.★
 * 안내는 adapter가 최종 답에 실어 사용자에게 전달. 외부유래 지시 주의 문구 동반(사회공학 완화).
 */
export function actionGuidance(req: ApprovalRequest): string | null {
  const p = req.params as Record<string, any>;
  const caution = "(외부 메시지/문서에서 유래한 지시라면 실행 전 특히 주의하세요.)";

  // ① 터미널 명령(exec)
  if (Array.isArray(p.command) && p.command.length) {
    const cmd = sanitizeForGuidance(p.command.join(" "));
    const cwd = typeof p.cwd === "string" && p.cwd ? sanitizeForGuidance(p.cwd) : null;
    const line = cwd ? `cd ${cwd} && ${cmd}` : cmd;
    return [
      "이 작업은 제가 직접 할 수 없어요(안전상 차단).",
      "직접 하시려면 터미널에서(의도하신 게 맞는지 확인 후):",
      `  ${line}`,
      caution,
    ].join("\n");
  }

  // ② 파일 변경(patch)
  if (p.fileChanges && typeof p.fileChanges === "object") {
    const files = Object.keys(p.fileChanges).map((f) => sanitizeForGuidance(f)).slice(0, 8);
    return [
      "이 파일 변경은 제가 직접 할 수 없어요(안전상 차단).",
      `대상 파일: ${files.join(", ")}`,
      "필요하시면 직접 편집하시거나, 안전한 범위면 다시 지시해 주세요.",
      caution,
    ].join("\n");
  }

  // ③ 그 외(외부전송·삭제·권한요청 등 명령/파일이 아닌 차단) — 작업 요약으로 안내
  const what = sanitizeForGuidance(
    typeof p.reason === "string" && p.reason ? p.reason : summarize(req),
  );
  return [
    "이 작업은 안전상 제가 직접 할 수 없어요(외부 전송·삭제·권한 변경 등은 GD 확인이 필요).",
    `요청 내용: ${what}`,
    "필요하시면 GD가 직접 하시거나, 안전한 대안으로 다시 지시해 주세요.",
    caution,
  ].join("\n");
}

/** 하위호환 별칭(기존 호출부·테스트). */
export const terminalGuidance = actionGuidance;

/** 안내문에 들어갈 문자열의 개행·제어문자 제거(단일 라인 강제, 표시 조작 방지). */
function sanitizeForGuidance(s: string): string {
  // eslint-disable-next-line no-control-regex
  return Array.from(s).map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? " " : ch)).join("").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** 실행체/시크릿 유발 write 경로(내용검사 없이 auto-allow하면 백도어/유출 벡터, 하네스 F5). */
function isExecutableOrSecretWritePath(path: string): boolean {
  return /(^|\/)\.git\/hooks\//i.test(path)
    || /\.(sh|bash|zsh|command)$/i.test(path)
    || /(^|\/)(package\.json|pnpm-workspace\.yaml|Makefile|AGENTS\.md|CLAUDE\.md)$/i.test(path)
    || /(^|\/)\.env(\.|$)/i.test(path)
    || /(^|\/)\.(bashrc|zshrc|profile|bash_profile)$/i.test(path)
    || /(^|\/)(cron|launchd|systemd)/i.test(path);
}

function summarize(req: ApprovalRequest): string {
  const p = req.params as Record<string, any>;
  if (Array.isArray(p.command)) return `exec: ${p.command.join(" ").slice(0, 200)}`;
  if (p.fileChanges) return `patch: ${Object.keys(p.fileChanges).join(", ").slice(0, 200)}`;
  return `${req.method}${p.reason ? `: ${String(p.reason).slice(0, 160)}` : ""}`;
}
