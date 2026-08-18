/**
 * 모델이 쓴 Markdown 을 텔레그램 MarkdownV2 로 옮긴다.
 *
 * 지금 dex 답은 ★원문 그대로★ 나간다. 그래서 굵게 표시의 별표와 코드 백틱이 글자로 보인다.
 *
 * ★원문 Markdown 에 parse_mode 만 붙이면 안 된다.★ MarkdownV2 는 예약문자를 전부 이스케이프해야 하고
 * ★하나만 빠져도 메시지 전체가 400 으로 안 나간다.★ 예약문자를 일괄 치환하는 것도 안 된다 —
 * 코드블록 안까지 망가진다.
 *
 * 그래서 hermes 실구현 순서를 그대로 따른다(아메스 확인, 소스 d7c24f264):
 *   ① 코드(펜스·인라인)와 링크를 먼저 자리표시자로 ★보호★
 *   ② 제목·굵게를 MarkdownV2 표현으로 ★변환★
 *   ③ 남은 예약문자를 ★이스케이프★
 *   ④ 보호했던 것을 되돌린다(코드 안에서는 백슬래시와 백틱만 이스케이프)
 *
 * 보내는 쪽은 실패하면 ★표시를 걷어낸 순수 텍스트로 한 번 더★ 시도한다(호출자 책임).
 * 그 폴백이 없으면 이스케이프 한 곳이 어긋났을 때 답이 통째로 사라진다.
 *
 * 지원 범위를 넘는 것(표 등)은 ★글자 그대로★ 남긴다 — 깨뜨리느니 그대로 두는 편이 낫다.
 */

/** 텔레그램 한 메시지 한도(UTF-16 code unit). 글자 수가 아니다. */
export const TG_LIMIT_UNITS = 4096;

/** MarkdownV2 예약문자 전부를 이스케이프한다. */
export function escapeAll(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (ch) => "\\" + ch);
}

/** 코드 안에서는 백슬래시와 백틱만 이스케이프한다(텔레그램 규칙). */
export function escapeInCode(s: string): string {
  return s.replace(/[`\\]/g, (ch) => "\\" + ch);
}

interface Held {
  key: string;
  out: string;
}

/** 자리표시자 — 이스케이프에 걸리지 않는 글자만 쓴다(영문+숫자). */
function keyFor(i: number): string {
  return " zZq" + i + "qZz ";
}

/** Markdown → MarkdownV2. */
export function toMarkdownV2(md: string): string {
  const held: Held[] = [];
  const hold = (out: string): string => {
    const key = keyFor(held.length);
    held.push({ key, out });
    return key;
  };

  let work = md;
  const fence = "```";

  // ① 코드 펜스 — 인라인보다 먼저(더 길다)
  work = work.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_m, lang: string, body: string) =>
    hold(fence + (lang ? escapeAll(lang) : "") + "\n" + escapeInCode(body.replace(/\n$/, "")) + "\n" + fence),
  );
  // ② 인라인 코드
  work = work.replace(/`([^`\n]+)`/g, (_m, body: string) => hold("`" + escapeInCode(body) + "`"));
  // ③ 링크
  work = work.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) =>
    hold("[" + escapeAll(label) + "](" + url.replace(/[)\\]/g, (c) => "\\" + c) + ")"),
  );
  // ④ 제목 → 굵게 (텔레그램에 제목 문법이 없다)
  work = work.replace(/^#{1,6}[ \t]+(.+)$/gm, (_m, t: string) => hold("*" + escapeAll(t.trim()) + "*"));
  // ⑤ 굵게
  work = work.replace(/\*\*([^*\n]+)\*\*/g, (_m, t: string) => hold("*" + escapeAll(t.trim()) + "*"));

  // ⑥ 남은 것 전부 이스케이프
  work = escapeAll(work);

  // ⑦ 되돌리기 — 자리표시자에는 예약문자가 없으므로 그대로 찾을 수 있다
  for (const h of held) work = work.split(h.key).join(h.out);
  return work;
}

/** UTF-16 code unit 수 — 텔레그램이 세는 단위. */
export function unitsOf(s: string): number {
  return s.length;
}

/**
 * 한도에 맞춰 ★자르지 않고 나눈다.★
 * 줄 경계를 우선하고, 코드 펜스 안에서 끊기면 앞 조각을 닫고 다음 조각에서 다시 연다.
 * (닫힘 줄에 조각 번호를 붙이면 parse 가 거부된다 — hermes 사고 a. 번호는 붙이지 않는다.)
 */
export function splitForTelegram(text: string, limit: number = TG_LIMIT_UNITS): string[] {
  if (unitsOf(text) <= limit) return [text];
  const fence = "```";
  const out: string[] = [];
  let cur = "";
  let fenceOpen = false;

  const flush = (): void => {
    if (cur === "") return;
    out.push(fenceOpen ? cur + "\n" + fence : cur);
    cur = fenceOpen ? fence + "\n" : "";
  };

  for (const rawLine of text.split("\n")) {
    // ★줄 하나가 한도보다 길면 줄 경계로는 못 나눈다.★ 그때만 글자 단위로 쪼갠다 —
    //   단, `\.` 같은 ★이스케이프 쌍 사이를 끊으면★ 남은 백슬래시가 다음 글자를 먹어 parse 가 깨진다.
    for (const line of hardSplit(rawLine, limit - fence.length - 1)) {
    const addition = cur === "" ? line : "\n" + line;
    // 닫는 펜스 자리를 남겨 둔다 — 닫고 나서 한도를 넘으면 안 된다
    if (cur !== "" && unitsOf(cur) + unitsOf(addition) > limit - fence.length - 1) flush();
    cur += cur === "" ? line : "\n" + line;
    if (/^\s*```/.test(line)) fenceOpen = !fenceOpen;
    }
  }
  if (cur !== "") out.push(cur);
  return out.filter((c) => c.trim() !== "");
}

/**
 * 줄 하나가 한도를 넘을 때만 쓰는 글자 단위 분할.
 * ★이스케이프 쌍(백슬래시+예약문자) 사이를 끊지 않는다★ — 끊으면 남은 백슬래시가
 * 다음 글자를 먹어 조각 전체가 parse 거부된다.
 */
export function hardSplit(line: string, limit: number): string[] {
  if (limit <= 1 || line.length <= limit) return [line];
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    let end = Math.min(i + limit, line.length);
    // 끝나는 자리가 이스케이프의 백슬래시면 한 글자 물린다
    if (end < line.length) {
      let bs = 0;
      for (let k = end - 1; k >= i && line[k] === "\\"; k--) bs++;
      if (bs % 2 === 1) end -= 1;
    }
    if (end <= i) end = Math.min(i + limit, line.length); // 물러설 곳이 없으면 그대로
    out.push(line.slice(i, end));
    i = end;
  }
  return out;
}

/** MarkdownV2 표시를 걷어낸 순수 텍스트 — 전송이 실패했을 때 쓰는 마지막 수단. */
export function toPlain(mdv2: string): string {
  return mdv2.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1");
}
