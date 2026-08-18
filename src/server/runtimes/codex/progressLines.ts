/**
 * 진행 줄 버블 — "작업 중…" 메시지에 지금 무엇을 하는 중인지 누적해 보여준다.
 *
 * 값의 출처는 hermes v0.19.1 실구현이다(같은 문제를 이미 푼 곳):
 *   편집 최소 간격 1.5초 · 미리보기 40자 · 연속 중복은 (×N) 으로 접기 ·
 *   텔레그램 4096 UTF-16 code unit 에서 여유 64 를 뺀 4032 에서 새 버블로 넘김.
 *
 * 이 파일은 순수 함수만 둔다 — 편집 호출·타이머는 bridge 가 쥔다.
 * 그래야 "무엇을 그릴지" 를 텔레그램 없이 잰다.
 */

/** 한 줄 미리보기 길이. 넘으면 뒤를 자르고 … 를 붙인다. */
export const PREVIEW_MAX = 40;
/** 한 버블의 최대 길이(UTF-16 code unit). 텔레그램 4096 - 여유 64. */
export const BUBBLE_MAX_UNITS = 4032;
/** 편집 최소 간격(ms). 이 사이에 온 이벤트는 모아 한 번에 친다. */
export const EDIT_MIN_INTERVAL_MS = 1500;

export interface ProgressLine {
  text: string;
  /** 같은 줄이 연속으로 몇 번 왔나. 1이면 표시하지 않는다. */
  count: number;
}

/** 줄바꿈·앞뒤 공백을 걷고 길면 자른다. 자를 때 길이는 … 포함 PREVIEW_MAX 다. */
export function previewOf(raw: string, max: number = PREVIEW_MAX): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, Math.max(0, max - 1)) + "…";
}

/**
 * 줄을 누적한다. ★연속으로 같은 줄이면 새 줄을 만들지 않고 세기만 올린다.★
 * 같은 도구를 반복 호출할 때 버블이 같은 문장으로 채워지는 것을 막는다.
 * 빈 줄은 버린다(이벤트는 왔지만 보여줄 것이 없는 경우).
 */
export function appendLine(lines: ProgressLine[], raw: string, max: number = PREVIEW_MAX): ProgressLine[] {
  const text = previewOf(raw, max);
  if (text === "") return lines;
  const last = lines[lines.length - 1];
  if (last && last.text === text) {
    const next = lines.slice(0, -1);
    next.push({ text, count: last.count + 1 });
    return next;
  }
  return [...lines, { text, count: 1 }];
}

/** 버블 본문. header 는 "⏳ 작업 중…" 같은 첫 줄이다. */
export function renderBubble(header: string, lines: ProgressLine[]): string {
  if (lines.length === 0) return header;
  const body = lines.map((l) => (l.count > 1 ? `🛠️ ${l.text} (×${l.count})` : `🛠️ ${l.text}`)).join("\n");
  return `${header}\n${body}`;
}

/**
 * 이 버블에 줄을 더 담을 수 있나. ★담을 수 없으면 호출자가 새 버블을 연다.★
 * 자르지 않고 넘기는 이유: 이미 보낸 줄을 지우면 어디까지 했는지가 사라진다.
 */
export function fits(header: string, lines: ProgressLine[], maxUnits: number = BUBBLE_MAX_UNITS): boolean {
  // JS 문자열 length 가 곧 UTF-16 code unit 수다 — 텔레그램이 세는 단위와 같다.
  return renderBubble(header, lines).length <= maxUnits;
}

/**
 * 텔레그램 429 의 retry_after(초)를 어떻게 다룰지.
 * 짧으면 기다렸다 한 번 더, 길면 편집을 포기하고 호출자가 다른 길로 간다.
 */
export const RETRY_WAIT_MAX_SEC = 5;
export function retryPlan(retryAfterSec: number): { wait: boolean; waitMs: number } {
  if (retryAfterSec > 0 && retryAfterSec <= RETRY_WAIT_MAX_SEC) return { wait: true, waitMs: retryAfterSec * 1000 };
  return { wait: false, waitMs: 0 };
}
