import type { AgentRecord } from "../../types";
import {
  type LlmRouteDecision,
  OLLAMA_URL,
  ROUTER_MODEL,
  buildRosterText,
  classifyIntent,
} from "./_shared";
import { ambiguousOwnerId } from "../capabilities";

const OWNER_CONFIRM_RE =
  /(삭제|지워|제거|revoke|폐기|토큰|token|credential|시크릿|secret|보안|security|권한|permission|결제|비용|paid|외부\s*(공개|발신|전송)|public|배포|deploy|재시작|restart|launchctl|마이그레이션|migration|DB|데이터베이스|database)/i;

interface RawDefaultIntake {
  outcome?: "route" | "ask_owner";
  responder?: string;
  suggested?: string[];
  domain?: string;
  needs_owner_confirm?: boolean;
  reason?: string;
}

function defaultIntakePrompt(agents: AgentRecord[]): string {
  // default/fallback(애매한 무-오너) 담당 = ambiguous_owner capability 보유자(OWNER 2026-07-10: member가 아니라 빌).
  // 미설정 레지스트리는 coordinatorId 로 폴백(기존 동작 보존).
  const coord = ambiguousOwnerId(agents) ?? "";
  return `너는 b3rys 팀 채팅의 owner inference(담당자 추론) 판단기다.

이 판단은 @멘션도 없고, 답장 원문 owner도 없고, sticky owner도 없을 때만 호출된다.

전체 팀원:
${buildRosterText(agents)}

판단 규칙:
1. 메시지가 특정 팀원의 역할과 명확히 맞으면 outcome=route, responder=<id>.
2. 메시지가 팀 운영/조율/PM/애매한 일반 접수 성격이면 responder=${coord}.
3. 여러 담당이 가능하거나 확신이 낮으면 outcome=ask_owner, suggested=[후보 id]. 이 경우 시스템은 ${coord}에게 보낸다.
4. 순수 결정/승인/판단 요청이면 outcome=ask_owner. 이 경우 시스템은 ${coord}에게 보낸다.
4. 토큰/시크릿/삭제/배포/서비스 재시작/DB migration/외부 발신/비용 발생은 needs_owner_confirm=true.
5. 역할 판단은 위 agents.json 기반 역할 설명을 우선한다. 코드에 박힌 도메인 단어 목록이 있다고 가정하지 마라.
6. default/fallback 담당자는 ${coord}다. 전문 담당(specialist)은 전체 메시지를 상시 보지 않으므로, 역할이 명확할 때만 responder 로 골라라.

JSON만 출력:
{"outcome":"route|ask_owner","responder":"<id|null>","suggested":["<id>",...],"domain":"<짧은 범주>","needs_owner_confirm":true|false,"reason":"<짧게>"}`;
}

export async function routeDefaultIntakeLLM(
  text: string,
  agents: AgentRecord[],
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<LlmRouteDecision> {
  const validIds = new Set(agents.map((a) => a.id));
  // 오너가 애매/무-확신일 때의 default 담당 = ambiguous_owner(OWNER 2026-07-10: 빌). 미설정 시 coordinator 폴백.
  const ambiguousOwner = ambiguousOwnerId(agents);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 3_000);
  try {
    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: opts.model ?? ROUTER_MODEL,
        messages: [
          { role: "system", content: defaultIntakePrompt(agents) },
          { role: "user", content: JSON.stringify({ new_message: text }) },
        ],
        stream: false,
        format: "json",
        options: { temperature: 0 },
      }),
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const body = (await res.json()) as { message?: { content?: string } };
    const parsed = JSON.parse(body.message?.content ?? "{}") as RawDefaultIntake;
    const suggested = (parsed.suggested ?? []).filter((id) => validIds.has(id));
    const responder = parsed.responder && validIds.has(parsed.responder) ? parsed.responder : null;
    const needsOwnerConfirm = Boolean(parsed.needs_owner_confirm) || OWNER_CONFIRM_RE.test(text);

    if (parsed.outcome === "route" && responder) {
      return {
        targetAgentIds: [responder],
        // responder 가 default 담당(ambiguous_owner)이면 default_step(애매→기본담당), 아니면 default_intake(도메인 추론).
        reason: responder === ambiguousOwner ? "default_step" : "default_intake",
        shouldResetThread: false,
        intent: classifyIntent(text),
        domain: parsed.domain ? `owner_inference:${parsed.domain}` : "owner_inference",
        via: "llm",
        needsOwnerConfirm,
        outcome: "route",
      };
    }

    // 오너 애매/무-responder → ambiguous_owner(빌)가 받아 OWNER 께 문의(OWNER 2026-07-10). 미설정 시 coordinator 폴백.
    return {
      targetAgentIds: ambiguousOwner ? [ambiguousOwner] : [],
      reason: "default_step",
      shouldResetThread: false,
      intent: classifyIntent(text),
      domain: parsed.domain ?? "owner_inference:fallback_ambiguous_owner",
      via: "llm",
      needsOwnerConfirm,
      outcome: "route",
      suggested,
    };
  } catch {
    clearTimeout(timer);
    return {
      targetAgentIds: ambiguousOwner ? [ambiguousOwner] : [],
      reason: "default_step",
      shouldResetThread: false,
      intent: classifyIntent(text),
      domain: "owner_inference:llm_unavailable",
      via: "regex_fallback",
      needsOwnerConfirm: OWNER_CONFIRM_RE.test(text),
      outcome: "route",
      suggested: [],
    };
  }
}
