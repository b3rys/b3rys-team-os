/**
 * ★실패한 턴은 답변이 아니다.★ (2026-07-13)
 *
 * ═══ 무엇이 잘못됐었나 ═══
 * hermes 는 턴을 못 끝내도 ★exit 0★ 으로 실패 문장을 stdout 에 찍는다. 브리지는 stdout 을
 * ★그 팀원의 답★ 으로 알고 버스에 발행한다:
 *   hermes → bill      "Codex response remained incomplete after 3 continuation attempts"  (7건)
 *   hermes → broadcast "API call failed after 3 retries: HTTP 429: The usage limit …"      (팀 전체에)
 * ★런타임 에러가 팀원의 말로 배달된다.★ 받는 쪽은 wake 를 소모하고, 스레드가 오염되고,
 * 수트 판정기는 "답이 왔다"로 읽는다. ★조용히 실패해야 할 것이 시끄럽게 성공한 척한다.★
 *
 * ═══ 왜 문장 매칭이 아니라 ★구조화 신호★ 인가 (적대 리뷰가 내 1차 fix 를 반증했다) ═══
 * 1차 fix 는 저 문장 2개를 정규식으로 걸렀다. ★틀린 모양이다★ —
 * `agent/conversation_loop.py` 의 실패 분기는 ★24개★ 고, 문장은 upstream 이 바꿀 때마다 조용히 뚫린다.
 *
 * hermes 는 이미 ★구조화 신호★ 를 준다: `-z --usage-file <PATH>` → 실행 후 JSON 을 쓴다.
 * ★실패해도 쓴다★ (oneshot.py `_write_usage_file`: "Written even on failure").
 *
 * ★핵심 사실(실측)★: `"completed"` 를 세팅하는 24곳이 ★전부 False★ 다 — 전부 실패 분기.
 *   ★성공 경로는 이 키를 아예 안 쓴다★ (→ undefined).
 * 그래서 판정식은 ★`completed === false` 일 때만 실패★ 다:
 *   · 실패 분기 24개를 ★한 번에★ 덮는다 (문장·언어·upstream 변경과 무관)
 *   · 정상 답변은 ★구조적으로 못 죽인다★ (성공은 이 값을 절대 false 로 안 만든다)
 *   · 팀원이 그 에러를 ★인용해 보고하는 것★ 도 안전하다 (그 턴은 completed:false 가 아니다)
 */
import { readFileSync, rmSync } from "node:fs";

export interface TurnFailure {
  /** hermes 가 스스로 붙인 실패 사유 (error / failure 필드). */
  reason: string;
}

/**
 * usage-file 을 읽어 ★이 턴이 실패였는지★ 판정하고 파일을 지운다.
 * 판정 불가(파일 없음·깨짐)면 null — ★모르면 실패로 몰지 않는다★ (정상 답을 죽이는 게 더 나쁘다).
 */
export function readTurnFailure(usagePath: string): TurnFailure | null {
  let raw: string;
  try {
    raw = readFileSync(usagePath, "utf8");
  } catch {
    return null; // hermes 가 파일을 못 썼다(best-effort) → 판정 불가
  } finally {
    try {
      rmSync(usagePath, { force: true });
    } catch {
      /* 청소 실패는 무시 */
    }
  }

  let report: Record<string, unknown>;
  try {
    report = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  // ★명시적 false 일 때만★ 실패. (true = 성공, 없음/null = 판정 불가 → 둘 다 통과)
  //
  // 성공 경로는 `agent/turn_finalizer.py:150` 에서 이렇게 계산한다:
  //   completed = final_response is not None and not failed
  //               and (api_call_count < max_iterations or normal_text_response)
  // → ★정상 답변은 completed:true★ 라 여기 절대 안 걸린다.
  //
  // ★알려진 한계★: `max_iterations` 를 소진하고 텍스트 응답이 아닌 이유로 끝난 턴은
  //   ★진짜 본문이 있어도★ completed:false 다 (도구 루프를 다 못 돈 반쪽 턴). 그건 억제된다 —
  //   그래서 호출부가 ★억제한 본문을 audit 에 남긴다★ (조용히 사라지지 않게).
  //   usage-file 은 completed/failed/failure 만 쓴다 — ★error·partial 키는 없다★ (oneshot.py `_write_usage_file`).
  if (report.completed === false || report.failed === true) {
    const reason =
      typeof report.failure === "string" && report.failure
        ? report.failure
        : "hermes turn did not complete (completed=false)";
    return { reason: reason.slice(0, 200) };
  }
  return null;
}

/**
 * ★2차 그물★ — usage-file 을 못 읽었을 때만 의미가 있다 (hermes 의 파일 쓰기는 best-effort).
 * 실측으로 라이브 발행된 문장만 넣는다. ★이게 1차 방어라고 착각하지 마라★ — 실패 분기는 24개고
 * 여기 있는 건 2개다. 1차는 위의 `readTurnFailure` 다.
 */
const KNOWN_FAILURE_PROSE: RegExp[] = [
  /^codex response remained incomplete after \d+ continuation attempts\.?$/i,
  /^(api call failed after \d+ retries|billing or credits exhausted):/i,
];

/** ★전체 본문이 실패 문장일 때만★ true (부분 일치 금지 — 팀원이 그 에러를 '보고'하는 건 정상 답변이다). */
export function isRuntimeFailureOutput(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  const firstLine = t.split("\n")[0]!.trim();
  return KNOWN_FAILURE_PROSE.some((re) => re.test(t) || re.test(firstLine));
}
