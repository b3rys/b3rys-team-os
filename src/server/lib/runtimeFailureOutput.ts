// Hermes는 실패 문장을 stdout에 쓰고도 exit 0일 수 있다. 오류 문구 대신 usage-file의 completed === false로 실패를 판정한다.
import { readFileSync, rmSync } from "node:fs";

export interface TurnFailure {
  /** hermes 가 스스로 붙인 실패 사유 (error / failure 필드). */
  reason: string;
}

/**
 * usage-file 을 읽어 이 턴이 실패였는지 판정하고 파일을 지운다.
 * 판정 불가(파일 없음·깨짐)면 null — 모르면 실패로 몰지 않는다 (정상 답을 죽이는 게 더 나쁘다).
 */
export function readTurnFailure(usagePath: string): TurnFailure | null {
  return readTurnReport(usagePath).failure;
}

export interface TurnReport {
  /** 실패였으면 사유. 정상·판정 불가면 null. */
  failure: TurnFailure | null;
  /** hermes 가 이 턴을 담은 세션 id (`--resume` 에 넘길 값). 없으면 null. 실패 턴도 null 이다. */
  sessionId: string | null;
  /** 실패 사유가 "그 세션을 모른다" 인가 — `--resume <id>` 의 id 가 hermes 쪽에 없을 때. */
  sessionNotFound: boolean;
}

/**
 * usage-file 을 읽어 실패 여부와 session id 를 함께 돌려주고 파일을 지운다.
 * 판정 불가(파일 없음·깨짐)면 failure=null·sessionId=null — 모르면 실패로 몰지 않는다.
 */
export function readTurnReport(usagePath: string): TurnReport {
  const none: TurnReport = { failure: null, sessionId: null, sessionNotFound: false };
  let raw: string;
  try {
    raw = readFileSync(usagePath, "utf8");
  } catch {
    return none; // hermes 가 파일을 못 썼다(best-effort) → 판정 불가
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
    return none;
  }

  // 명시적 false 일 때만 실패. (true = 성공, 없음/null = 판정 불가 → 둘 다 통과)
  //
  // 성공 경로는 `agent/turn_finalizer.py:150` 에서 이렇게 계산한다:
  //   completed = final_response is not None and not failed
  //               and (api_call_count < max_iterations or normal_text_response)
  // → 정상 답변은 completed:true 라 여기 절대 안 걸린다.
  //
  // 알려진 한계: `max_iterations` 를 소진하고 텍스트 응답이 아닌 이유로 끝난 턴은
  //   진짜 본문이 있어도 completed:false 다 (도구 루프를 다 못 돈 반쪽 턴). 그건 억제된다 —
  //   그래서 호출부가 억제한 본문을 audit 에 남긴다 (조용히 사라지지 않게).
  //   usage-file 은 completed/failed/failure 만 쓴다 — error·partial 키는 없다 (oneshot.py `_write_usage_file`).
  if (report.completed === false || report.failed === true) {
    const reason =
      typeof report.failure === "string" && report.failure
        ? report.failure
        : "hermes turn did not complete (completed=false)";
    // Hermes 0.21.3에서 없는 세션 재개는 failed:true와 session not found 신호를 반환한다.
    const sessionNotFound = /^session not found\b/i.test(reason.trim());
    return { failure: { reason: reason.slice(0, 200) }, sessionId: null, sessionNotFound };
  }
  const sessionId = typeof report.session_id === "string" && report.session_id ? report.session_id : null;
  return { failure: null, sessionId, sessionNotFound: false };
}

/**
 * 2차 그물 — usage-file 을 못 읽었을 때만 의미가 있다 (hermes 의 파일 쓰기는 best-effort).
 * 실측으로 라이브 발행된 문장만 넣는다. 이게 1차 방어라고 착각하지 마라 — 실패 분기는 24개고
 * 여기 있는 건 2개다. 1차는 위의 `readTurnFailure` 다.
 */
const KNOWN_FAILURE_PROSE: RegExp[] = [
  /^codex response remained incomplete after \d+ continuation attempts\.?$/i,
  /^(api call failed after \d+ retries|billing or credits exhausted):/i,
];

/** 전체 본문이 실패 문장일 때만 true (부분 일치 금지 — 팀원이 그 에러를 '보고'하는 건 정상 답변이다). */
export function isRuntimeFailureOutput(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  const firstLine = t.split("\n")[0]!.trim();
  return KNOWN_FAILURE_PROSE.some((re) => re.test(t) || re.test(firstLine));
}
