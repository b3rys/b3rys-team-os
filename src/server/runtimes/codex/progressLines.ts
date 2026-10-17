/** 진행 버블은 편집 2초·미리보기 40자·연속 중복 접기를 사용한다. Telegram 4096 UTF-16 한도에서 여유 64를 뺀 4032를 넘으면 새 버블로 이어간다.
 * 표시 판단을 순수 함수로 두어 Telegram 없이 검증하고 편집·타이머는 브리지가 관리한다. */

/** 한 줄 미리보기 길이. 넘으면 뒤를 자르고 … 를 붙인다. */
export const PREVIEW_MAX = 40;
/** 한 버블의 최대 길이(UTF-16 code unit). 텔레그램 4096 - 여유 64. */
export const BUBBLE_MAX_UNITS = 4032;
/** 편집 이벤트는 2초 동안 모아 화면 깜빡임을 줄이고 Telegram 편집 제한에도 여유를 둔다. */
export const EDIT_MIN_INTERVAL_MS = 2000;

export interface ProgressLine {
  text: string;
  /** 같은 줄이 연속으로 몇 번 왔나. 1이면 표시하지 않는다. */
  count: number;
  /** 항목 id — 같은 id 가 다시 오면 그 줄을 교체 한다(시작 때 비었다가 끝나면 구체화되는 항목용). */
  id?: string;
}

/** 줄바꿈·앞뒤 공백을 걷고 길면 자른다. 자를 때 길이는 … 포함 PREVIEW_MAX 다. */
export function previewOf(raw: string, max: number = PREVIEW_MAX): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, Math.max(0, max - 1)) + "…";
}

/**
 * 줄을 누적한다. 연속으로 같은 줄이면 새 줄을 만들지 않고 세기만 올린다.
 * 같은 도구를 반복 호출할 때 버블이 같은 문장으로 채워지는 것을 막는다.
 * 빈 줄은 버린다(이벤트는 왔지만 보여줄 것이 없는 경우).
 */
export function appendLine(
  lines: ProgressLine[],
  raw: string,
  max: number = PREVIEW_MAX,
  id?: string,
): ProgressLine[] {
  const text = previewOf(raw, max);
  if (text === "") return lines;

  // 같은 항목이 다시 오면 새 줄을 만들지 않고 그 자리를 바꾼다.
  //   웹 검색은 시작할 때 검색어가 비어 있고 끝날 때 채워져 온다 — 두 줄로 쌓이면
  //   같은 검색이 두 번 일어난 것처럼 보인다.
  if (id !== undefined) {
    const at = lines.findIndex((l) => l.id === id);
    if (at !== -1) {
      if (lines[at]!.text === text) return lines; // 바뀐 게 없으면 그대로
      const next = lines.slice();
      next[at] = { text, count: lines[at]!.count, id };
      return next;
    }
  }

  const last = lines[lines.length - 1];
  if (last && last.text === text && last.id === undefined && id === undefined) {
    const next = lines.slice(0, -1);
    next.push({ text, count: last.count + 1 });
    return next;
  }
  return [...lines, { text, count: 1, ...(id !== undefined ? { id } : {}) }];
}

/** 버블 본문. header 는 "⏳ 작업 중…" 같은 첫 줄이다. */
/** 줄별 아이콘은 개수를 구분하기 쉽게 바꾸되 자리로 고정한다. 무작위로 고르면 편집 때마다 그림이 바뀌어 화면이 흔들린다. */
export const WORK_ICONS = ["🛠️", "⚙️", "🔧", "📎", "🧩", "📐"] as const;

export function iconFor(index: number): string {
  return WORK_ICONS[index % WORK_ICONS.length] as string;
}

export function renderBubble(header: string, lines: ProgressLine[]): string {
  // 반복되는 단계 상태는 머리글 한 자리에서 교체해 화면을 채우지 않게 하고 실제 작업 줄만 아래에 쌓는다.
  if (lines.length === 0) return header;
  const body = lines
    .map((l, i) => (l.count > 1 ? `${iconFor(i)} ${l.text} (×${l.count})` : `${iconFor(i)} ${l.text}`))
    .join("\n");
  return `${header}\n${body}`;
}

/**
 * 이 버블에 줄을 더 담을 수 있나. 담을 수 없으면 호출자가 새 버블을 연다.
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
