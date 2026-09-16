// 프로젝트 문서를 "절" 로 자른다 — Projects 문서 화면의 절 탭(Reports 폼 탭과 같은 모양) 재료.
// 입력은 서버 응답 그대로: 정제된 `html`(헤딩 `id` = toc anchor) + `toc`(level·text·anchor).
// 절 = 문서의 최상위 헤딩. `#` 이 하나뿐이면 그 아래 `##` 로, `##` 가 없으면 `###` 로 내려간다.
// 절 앞(제목~첫 절 헤딩 전)에 본문이 있으면 "개요" 절이 앞에 붙는다. 헤딩이 없으면 문서 전체가 절 하나.

import { pick } from "../i18n";

export interface TocEntry { level: number; text: string; anchor: string }
export interface DocSection {
  /** 절 헤딩의 id(= toc anchor). 개요 절은 제목 헤딩 id, 헤딩이 없으면 "". */
  anchor: string;
  /** 탭 라벨 원문(헤딩 텍스트 전체). 자르기는 화면 몫. */
  label: string;
  /** 절 헤딩 level(1~6). 개요·헤딩 없음은 0. */
  level: number;
  /** 그 절의 HTML(절 헤딩 포함). */
  html: string;
  /** 절 안 하위 헤딩 — 탭 줄 아래 링크 줄 재료. */
  children: TocEntry[];
}

const HEADING = /^H([1-6])$/;

/** 절을 나누는 헤딩 level. min level 이 하나뿐이면 그 다음 level 로 내려간다(한 번만). */
export function sectionLevel(toc: readonly TocEntry[]): number {
  const levels = toc.map((t) => t.level).filter((l) => l >= 1 && l <= 6);
  if (!levels.length) return 0;
  const min = Math.min(...levels);
  if (levels.filter((l) => l === min).length > 1) return min;
  const deeper = levels.filter((l) => l > min);
  return deeper.length ? Math.min(...deeper) : min;
}

/** 탭 라벨 — 24자 넘으면 자르고 … . 전체 텍스트는 title 속성으로. */
export function sectionTabLabel(text: string, max = 24): string {
  const chars = Array.from(text.trim());
  return chars.length > max ? chars.slice(0, max).join("") + "…" : chars.join("");
}

function hasBody(nodes: readonly Node[], skipTitle: Element | null): boolean {
  for (const n of nodes) {
    if (n === skipTitle) continue;
    if (n.nodeType === 3) { if ((n.textContent ?? "").trim()) return true; continue; }
    if (n.nodeType === 1) return true;
  }
  return false;
}

function serialize(nodes: readonly Node[]): string {
  return nodes.map((n) => (n.nodeType === 1 ? (n as Element).outerHTML : (n.textContent ?? ""))).join("");
}

function headingsIn(nodes: readonly Node[], above: number): TocEntry[] {
  const out: TocEntry[] = [];
  for (const n of nodes) {
    if (n.nodeType !== 1) continue;
    const el = n as Element;
    const own = el.tagName.match(HEADING);
    const list: Element[] = own ? [el] : Array.from(el.querySelectorAll("h1,h2,h3,h4,h5,h6"));
    for (const h of list) {
      const level = Number(h.tagName.slice(1));
      if (level > above && h.id) out.push({ level, text: (h.textContent ?? "").trim(), anchor: h.id });
    }
  }
  return out;
}

/**
 * 순수 함수. `html` 을 DOM 으로 파싱해 최상위 자식 중 절 level 헤딩에서 자른다.
 * 결과는 항상 1개 이상(헤딩 없음 → 전체가 절 하나).
 */
export function splitSections(html: string, toc: readonly TocEntry[]): DocSection[] {
  const level = sectionLevel(toc);
  const root = document.createElement("div");
  root.innerHTML = html;
  const nodes = Array.from(root.childNodes);
  const overview = pick("개요", "Overview");
  if (level === 0) return [{ anchor: "", label: overview, level: 0, html, children: [] }];

  const isCut = (n: Node) => n.nodeType === 1 && (n as Element).tagName === `H${level}`;
  const first = nodes.findIndex(isCut);
  if (first < 0) return [{ anchor: "", label: overview, level: 0, html, children: headingsIn(nodes, level) }];

  const out: DocSection[] = [];
  const pre = nodes.slice(0, first);
  const title = pre.find((n): n is Element => n.nodeType === 1 && HEADING.test((n as Element).tagName)) ?? null;
  if (hasBody(pre, title)) {
    out.push({ anchor: title?.id ?? "", label: overview, level: 0, html: serialize(pre), children: headingsIn(pre, level) });
  }
  let i = first;
  while (i < nodes.length) {
    let j = i + 1;
    while (j < nodes.length && !isCut(nodes[j]!)) j++;
    const chunk = nodes.slice(i, j);
    const h = nodes[i] as Element;
    out.push({ anchor: h.id, label: (h.textContent ?? "").trim(), level, html: serialize(chunk), children: headingsIn(chunk.slice(1), level) });
    i = j;
  }
  return out;
}
