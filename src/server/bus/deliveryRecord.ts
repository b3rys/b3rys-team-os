/**
 * ★배달 기록 — "서버가 무엇을, 누구에게, 실제로 내보냈는가".★ (2026-07-12)
 *
 * ■ 왜 필요한가 (오늘 하루의 근본)
 * ★서버는 자기 팀원이 팀장께 뭘 보냈는지 몰랐다.★ audit 엔 "보냈다" 만 있고 ★본문이 없었다.★
 * 팀원의 최종 종합은 브릿지가 텔레그램으로 쏘고 끝 — ★DB 에 아무 흔적도 안 남는다.★
 *
 * 그래서 우리는 ★검증할 수 없는 것을 고치고 있었다★:
 *   · "팀원은 분명히 답했는데 종합에서 빠졌다" → ★종합 본문이 없으니 확인할 방법이 없었다★
 *   · "종합이 정확히 1번 갔나" → 버스에 남은 건 ★중간 ack★ 일 수도 있는데 ★내용으로 구별할 수 없었다★
 * ★관측할 수 없으면 검증할 수 없다.★ 이 파일은 그 구멍을 메운다.
 *
 * ■ ★이건 수집 구현이 아니라 '통신 기록' 이다★
 * collector 가 서버든(수집 오케스트레이션) 팀원 자신이든(자가수집), ★"무엇을 누구에게 보냈나"는 언제나
 * 남아야 한다.★ 구현을 바꿔도 이 기록은 계속 유효하고, ★수집을 없앨수록 오히려 더 필요하다★ —
 * 그때는 이게 ★유일한 증거★ 이기 때문이다.
 *
 * ■ ★ack 과 종합을 내용으로 추측하지 않는다★
 * 구별 기준은 ★"배달 기록이 있느냐"★ 다. 이 기록은 ★턴의 최종 답변이 실제로 나갈 때만★ 쓰인다.
 * 에이전트가 턴 도중 send.sh 로 보내는 중간 ack 은 ★배달 기록을 남기지 않는다★ → 자연히 갈린다.
 * (본문을 보고 "이건 ack 같다"고 추측하는 순간 또 틀린 신호 위에 짓는 것이다.)
 *
 * ■ ★안전★
 *  · ★fail-soft★: 기록이 실패해도 ★발송을 막지 않는다.★ 기록은 관측용이지 발송 경로가 아니다.
 *  · ★시크릿 마스킹★: 본문에 토큰·키가 실려 있으면 그대로 DB 에 박힌다. 패턴을 지우고 저장한다.
 *  · ★길이 제한★: preview 는 잘라서 넣는다(전문 저장이 목적이 아니다 — 검증에 필요한 만큼만).
 */
import type { Database } from "bun:sqlite";
import { appendAudit } from "../db/queries";

/** 어디로 나갔나. ★경로가 달라도 '나갔다'는 사실은 한 곳에서 조회 가능해야 한다★ (그래야 수트가 하나로 본다). */
export type DeliveryChannel = "telegram_group" | "telegram_dm" | "bus";

/** 배달됨 / 배달실패 — ★실패도 반드시 남긴다.★ 조용히 흘리면 collector 는 '보냈다'고 믿고 팀장은 못 받는다. */
export const DELIVERED = "report_delivered";
export const DELIVERY_FAILED = "report_delivery_failed";

/** preview 최대 길이. 검증(팀원 답 조각·미응답자 이름 찾기)에 충분하고, DB 를 본문 저장소로 만들지 않는다. */
const PREVIEW_MAX = Number(process.env.BUS_DELIVERY_PREVIEW_MAX ?? 1500);

/**
 * ★본문에서 시크릿으로 보이는 것을 지운다.★
 * 종합 본문에 토큰·키가 섞여 들어오면 ★그대로 DB 에 영구 기록된다.★ (감사로그는 오래 남는다)
 * 완벽한 탐지는 불가능하다 — ★명백한 패턴만 지운다. 못 잡는 게 있다는 걸 전제로 길이도 제한한다.★
 */
export function maskSecrets(s: string): string {
  return s
    // Bot API 토큰 (숫자:영숫자_-) · Slack(xoxb-/xapp-) · GitHub(ghp_/gho_) · OpenAI(sk-) · Anthropic(sk-ant-)
    .replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, "[REDACTED_BOT_TOKEN]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/\bxapp-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_APP_TOKEN]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]")
    // 'KEY=값' / 'token: 값' 꼴 (env 를 통째로 붙여넣는 경우)
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*\S+/gi, "$1=[REDACTED]")
    // eyJ… (JWT)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[REDACTED_JWT]");
}

/** 마스킹 + 길이 제한. */
export function previewOf(body: string): string {
  const masked = maskSecrets(body ?? "");
  return masked.length > PREVIEW_MAX ? masked.slice(0, PREVIEW_MAX) + " …(생략)" : masked;
}

/**
 * ★턴의 최종 답변이 실제로 나갔다(또는 못 나갔다)를 DB 에 남긴다.★
 *
 * ★fail-soft★ — 이 함수는 ★절대 throw 하지 않는다.★ 기록에 실패해도 발송은 이미 됐거나 될 것이고,
 * 관측 실패가 통신을 막는 건 ★수단이 목적을 죽이는 것★이다. 대신 실패 자체를 다시 audit 에 남긴다.
 */
export function recordReportDelivery(
  db: Database,
  input: {
    actor: string;                 // 보낸 팀원 (collector)
    channel: DeliveryChannel;
    recipient: string;             // 'gd' | group id | 팀원 id | 'broadcast'
    threadId: string | null;       // ★원래 위임이 오간 thread★ — 이 종합이 '어느 위임의 답'인지 연결하는 키
    destThread?: string | null;    // 실제 목적지(팀장 DM thread 등). 관측용이지 연결 키가 아니다.
    refId: string | null;          // 관련 message id (관측용)
    body: string;
    ok: boolean;
    error?: string | null;
  },
): void {
  try {
    appendAudit(db, input.actor, input.ok ? DELIVERED : DELIVERY_FAILED, input.refId, {
      to: input.recipient,
      channel: input.channel,
      thread_id: input.threadId,
      ...(input.destThread ? { dest_thread: input.destThread } : {}),
      // ★body_preview 가 이 기록의 존재 이유다★ — "무엇을 보냈나" 를 모르면 아무것도 검증할 수 없다.
      body_preview: previewOf(input.body),
      ...(input.error ? { error: String(input.error).slice(0, 300) } : {}),
    });
  } catch (e) {
    // ★기록이 실패해도 발송을 막지 않는다.★ 다만 조용히 넘기지도 않는다.
    try {
      appendAudit(db, input.actor, "report_delivery_record_failed", input.refId, {
        to: input.recipient,
        channel: input.channel,
        error: e instanceof Error ? e.message : String(e),
      });
    } catch {
      /* audit 조차 안 되면 여기서 끝 — 발송 경로는 건드리지 않는다 */
    }
  }
}
