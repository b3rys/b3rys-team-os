#!/usr/bin/env bun
/**
 * ★저장소에 남는 주석에서 '사람 귀속' 을 잡는다.★ (#322 규칙의 기계 검사)
 *
 * 왜 필요한가 — 이 규칙은 지금까지 문서에만 있었고, 같은 종류를 ★세 번★ 놓쳤다
 * (#324 → #329 → 그 뒤 남은 16건). 사람이 grep 을 새로 짤 때마다 축이 달라졌다.
 *
 * ═══ ★이름으로 재지 않는다. 이름 뒤에 오는 서술어로 잰다.★ ═══
 *   이름만 보면 오탐이 쏟아진다(실측):
 *     · 주석 안 '팀장/팀 리드' 서술 ★334건★ — 대부분 라우팅·동작 서술이라 남겨야 한다.
 *     · codex·dex·hermes·brief 는 ★런타임 id 이자 제품명★ 이다.
 *       "codex-cli 0.144.6" · "codex 가 35분째 멈췄다" 는 통과해야 한다.
 *   ★오탐이 미탐보다 위험하다★ — 334건을 빨갛게 만들면 사람이 이 검사기를 지운다.
 *
 *   그래서 축은 ★사람만 주어가 될 수 있는 서술어★ 다:
 *     리뷰·지적·제안·요청·채택·판단·말했다·물었다·시켰다·정했다·원칙·잡았다·짚었다 …
 *   시스템도 주어가 되는 서술어(멈췄다·보냈다·돌았다·null·N건)는 ★통과★ 시킨다.
 *
 * 범위: src 아래 .ts 의 ★주석 줄★ 만. 코드 줄의 문자열은 안 본다
 *       (시험 입력값 "@빌 이거 해줘" 같은 것은 지우면 시험이 죽는다).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * ★이름을 두 갈래로 나눈다.★ 여기가 이 검사기의 핵심이다.
 *   PERSON  = 사람만 가리키는 이름·역할어. 런타임 id 와 안 겹친다.
 *   AMBIG   = codex·dex·hermes 처럼 ★런타임 id 이자 제품명★ 이기도 한 것.
 * 같은 서술어라도 판정이 갈린다 — "아메스 실측" 은 사람 귀속이고
 * "codex-cli 벤더 스키마 실측" 은 제품 서술이다.
 */
//   ※ 한글 이름은 ★다른 낱말의 일부★ 가 될 수 있다 — `빌` 은 `빌드`·`빌딩` 안에 있다.
//     그래서 그 뒤를 막는다. 라틴 이름은 `\b` 로 막는다(`dex` 가 `index` 에 걸리지 않게).
const PERSON = "팀장|팀 리드|팀리드|GD|빌(?!드|딩)|데미스|스티브|아메스|루이|드밲|데본|포린|브리프|" +
  "\\b(?:bill|demis|steve|ames|lui|dbak|devon|forin|brief)\\b";
const AMBIG = "헤르메스|\\b(?:hermes|codex|dex)\\b";

/**
 * ★사람만 주어가 되는 서술어.★ 여기 없는 것은 통과시킨다(오탐을 줄이는 쪽이 기본).
 *
 * ★말했·물었 는 여기 없다.★ 런타임도 그 주어가 된다 — 실측 오탐:
 *   "hermes 가 말했다 로 기록됐다" · "hermes 가 기여자에게 다시 물었다".
 *   그래서 그 둘은 사람 전용 이름에만 붙인다(HUMAN_PERSON).
 * ★맨 명사 '제안' 도 없다.★ 이 저장소엔 proposal 기능이 있어 '제안' 이 도메인 명사다
 *   ("검토를 마친 제안만 올라간다"). 사람 행위형(제안했·제안대로)으로만 좁혔다.
 */
const HUMAN =
  "리뷰|지적|제안했|제안대로|제안한|요청했|요청함|채택|판단했|판단이|정했|결정했|" +
  "잡았|잡은|잡아낸|짚었|짚은|찾아냈|알려줬|승인했|반대했|합의|약속";

/**
 * 사람 전용 이름에만 붙이는 서술어 — ★런타임도 주어가 될 수 있어★ AMBIG 에는 안 쓴다.
 * 실측 오탐(전수 4건): "codex 도 같은 원칙으로 간다" · "hermes 와 동일 원칙" ·
 *   "hermes 잘못이 아니다. 우리가 그렇게 시켰다".
 * ★'합의' 는 여기 없다★ — "(Codex 합의 2026-06-22)" 는 진짜 귀속이라 공용으로 둔다.
 */
//   ★'시켰' 은 앞이 한글이면 다른 낱말이다★ — "유실★시켰★다" 가 그렇게 걸렸다.
const HUMAN_PERSON_ONLY = "말했|말한 것|말씀|물었|원칙|(?<![가-힣])시켰";

/**
 * PERSON 에만 붙는 ★관찰 귀속★ — 누가 쟀는지를 적은 것이다.
 * AMBIG 에는 안 붙인다: "codex 가 35분째 멈췄다" · "codex 실측" 은 런타임·제품 서술이다.
 */
const OBSERVE = "실측|확인했|재봤|제보|발견했|보고했";

/** 이름 바로 뒤가 제품명 꼴이면 사람이 아니다: codex-cli · codex 0.144 · dex.ts */
//   ★연도를 버전으로 읽지 않는다★ — "리뷰(Bill 2026-07-27)" 의 2026 을 버전으로 보고
//   진짜 귀속을 통과시켰다. 버전은 `v` 접두 또는 점이 든 수(0.144.6)여야 한다.
const PRODUCTISH = /^(?:[-_.][A-Za-z0-9]|\s+v\d|\s+\d+\.\d)/;

/**
 * ★이름 앞이 역할 명사면 사람 귀속이 아니라 '역할 지정' 이다.★ 실측 오탐:
 *   "제안자 lui 는 리뷰 불가" · "요청자(bill)를 '이미 물어본 사람' 이라고 하면"
 * 여긴 이름이 ★데이터★ 다 — 시나리오·역할을 말하는 자리라 지우면 뜻이 사라진다.
 */
const ROLE_BEFORE = /(제안자|요청자|작성자|리뷰어|승인자|소유자|수신자|발신자|담당자|owner|author|requester)\s*\(?$/;

/**
 * ★백틱 안의 이름은 값이다.★ 실측 오탐:
 *   "서버가 hermes 에게 `--to bill` 이라고 정확히 말했는데도"
 * 여기서 bill 은 사람이 아니라 ★명령 인자★ 다.
 */
function inCodeSpan(line: string, at: number): boolean {
  let ticks = 0;
  for (let i = 0; i < at; i++) if (line[i] === "`") ticks++;
  return ticks % 2 === 1;
}

/**
 * ★따옴표로 감싼 구간은 예시·인용이다★ — 백틱 예외와 같은 축이다.
 *
 * 왜 필요해졌나: 기본 범위에 `scripts` 를 넣자 ★이 검사기 자신이 24건 걸렸다.★
 * 걸린 것 대부분이 규칙을 설명하려고 적어둔 반례 문장이다:
 *   `*   "(2026-08-06 실측 42건). steve 가 확인했다"      ← 괄호 실측 거부권이 …`
 * ★규칙을 설명하는 문장이 그 규칙에 걸리면 사람이 검사기를 지운다.★
 * (같은 함정을 승인 판정부도 겪었다 — 그 기능을 설명하는 문서가 예시 서명을 담고 있었다.)
 *
 * ★이 예외는 계약과 어긋나지 않는다★ — 이 검사기는 처음부터 ★귀속만 보고 발언 인용은 안 본다.★
 * 따옴표 안은 인용이므로 애초에 이 검사기의 대상이 아니다.
 */
function inQuotedSpan(line: string, at: number): boolean {
  let straight = 0;
  let curly = 0;
  for (let i = 0; i < at; i++) {
    const c = line[i];
    if (c === '"') straight++;
    else if (c === "“" || c === "”") curly++;
  }
  return straight % 2 === 1 || curly % 2 === 1;
}

/**
 * ★한 줄에 후보가 여러 개다.★ 첫 후보만 보고 끝내면 ★통과 규칙이 뒤쪽 진짜를 덮는다.★
 * 실측 반례:
 *   "제안자 lui 는 데이터다. bill 리뷰로 수정했다"   ← 앞의 역할 지정이 뒤의 귀속을 덮었다
 *   "`--to bill` 은 값이다. steve 리뷰로 수정했다"   ← 백틱 예외가 줄 전체를 끝냈다
 *   "(2026-08-06 실측 42건). steve 가 확인했다"      ← 괄호 실측 거부권이 뒤 귀속을 지웠다
 * 그래서 ★이름마다 따로 판정하고, 예외는 그 후보만 건너뛴다.★
 */
const NAME_G = new RegExp(`(${PERSON}|${AMBIG})`, "gi");
const PERSON_RE = new RegExp(`^(?:${PERSON})$`, "i");
const PRED_PERSON = new RegExp(`^(.{0,25}?)(${HUMAN}|${HUMAN_PERSON_ONLY}|${OBSERVE})`, "i");
const PRED_AMBIG = new RegExp(`^(.{0,25}?)(${HUMAN})`, "i");
/**
 * 이름 바로 뒤 행위 명사(붙여쓰기). "(루이 제안)" 은 귀속, "…검토를 마친 제안" 은 도메인 명사.
 *
 * ★요청·설계도 같은 자리다★ — `(팀 리드 요청 2026-08-18)` 꼴이 검출을 빠져나갔다.
 * 이 규칙은 ★이름 바로 뒤★ 만 보므로("승인 요청" 처럼 이름이 앞에 없는 것은 대상이 아니다),
 * 그리고 ★PERSON 에만 적용된다★(런타임 이름은 이 경로를 타지 않는다) — 넓히는 폭이 좁다.
 * 파생어는 기존 배제가 그대로 받는다: 요청★서★ · 설계★도★ 는 걸리지 않는다.
 *
 * ★'지시' 는 넣지 않는다★ — 전수 대조에서 그 낱말로만 4건이 늘었고 ★넷 다 오탐★ 이었다:
 *   로그 예시의 메시지 제목(`[팀장 지시 수집] 질문`) · 데이터 출처 분류(`user/system(GD 지시)`) ·
 *   동작 서술(`// 팀장 지시 전달`). 우리 코드에서 '지시' 는 사람의 공을 돌리는 자리보다
 *   ★분류어·데이터 예시★ 로 훨씬 자주 쓰인다. 넣으면 오탐이 5% → 그 이상으로 올라가고,
 *   ★오탐이 늘면 사람이 검사기를 지운다.★
 */
const PRED_ADJACENT = /^\s{0,2}(제안|검토|판단|요청|설계)(?!\s*(?:대기|중))(?![가-힣]*(?:서|화면|기능|도))/;
/** 이름이 괄호 안에 뒤따르는 꼴: `실측(루이)` · `(dbak 리뷰 …)` 의 앞쪽 서술어. */
const PRED_BEFORE = new RegExp(`(${HUMAN}|${OBSERVE})\\s*\\(?\\s*$`, "i");

/**
 * 그 줄에서 ★검사할 주석 구간★ 을 준다. 주석이 없으면 null.
 *
 * ★줄 시작 주석만 보면 코드 뒤 주석을 통째로 놓친다★ (2026-08-18 실측):
 *   `const label = makeLabel(id); // 사람이름이 정한 규칙이다`
 * 이런 꼴이 검사 밖이었다. 귀속은 주석이 어디서 시작하든 귀속이다.
 *
 * ★코드 뒤 주석은 `//` 부터만 돌려준다★ — 앞의 코드까지 넘기면 앞쪽 판정(ROLE_BEFORE·PRED_BEFORE)이
 * 코드를 보고 오작동한다. 줄 시작 주석은 줄 전체를 그대로 넘긴다(기존 동작 유지).
 *
 * ★문자열 안의 `//` 는 주석이 아니다★ — `const u = "https://x"` 를 주석으로 읽으면
 * 코드 문자열이 검사 대상이 되어 이 검사기의 범위 계약("주석만 본다")이 깨진다.
 */
export function commentSegment(line: string): string | null {
  const t = line.trimStart();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return line;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "/" && line[i + 1] === "/") return line.slice(i);
  }
  return null;
}

export type Finding = { file: string; line: number; text: string };

/**
 * ★'실측' 이 괄호 안에 있으면, ★그 괄호 안에★ 이름이 있어야 귀속이다.★
 *
 * 글자 거리로 자르면 안 된다 — 8건에 직접 대본 실측:
 *   "(2026-08-10 배포본 실측: steve 확인 · bill 판단)" 은 이름이 ★실측 뒤★ 에 있고,
 *   "(빌 뮤턴트 실측: …)" 은 사이에 낱말이 끼어 있다. 거리로 자르면 ★진짜 5건이 사라진다.★
 * 반대로 "(2026-07-14 실측)" · "(2026-08-06 실측 42건)" 은 괄호 안에 이름이 없다 —
 * 앞 절의 '팀장' 은 ★수신처★ 이지 잰 사람이 아니다.
 */
function observeInParenWithoutName(line: string, at: number, nameRe: RegExp): boolean {
  const open = line.lastIndexOf("(", at);
  if (open < 0) return false;
  const close = line.indexOf(")", at);
  if (close < 0) return false;
  const inner = line.slice(open + 1, close);
  if (!new RegExp(`(?:${OBSERVE})`).test(inner)) return false; // 괄호 안에 실측류가 없다
  return !nameRe.test(inner);                                   // 이름이 없으면 귀속 아님
}

/**
 * ★이름 양옆이 화살표면 그 이름은 '거르는 대상의 예시' 다★
 *   "남의 딴-대화(예: codex→demis 리뷰 팬아웃)를 걷어낸다"
 * 여기서 걸리는 이름은 화살표 ★뒤★ 의 demis 라, 앞뒤를 다 본다.
 */
const ARROW_AFTER = /^\s*(?:→|->|=>)/;
/**
 * ★화살표 ★반대편에도 이름★ 이 있어야 데이터 예시다.★
 * 안 그러면 ★인과 화살표★ 를 라우팅 화살표로 오해한다 — 실측 미탐 2건:
 *   "압축이 또 삭제 → steve 리뷰가 잡음" · "아무도 몰랐다 → 빌이 …"
 * 여기 화살표는 ★그래서★ 라는 뜻이지 보내는 방향이 아니다.
 */
const ARROW_BEFORE = new RegExp(`(?:${PERSON}|${AMBIG})\\s*(?:→|->|=>)\\s*$`, "i");

export function scanText(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const OBSERVE_RE = new RegExp(`(?:${OBSERVE})`, "i");
  // 괄호 안 이름 검사에는 AMBIG 도 넣는다 — "(codex 리뷰 실측…)" 의 codex 를 '이름 없음' 으로 읽었다.
  const ANY_NAME = new RegExp(`(?:${PERSON}|${AMBIG})`, "i");
  text.split("\n").forEach((rawLine, i) => {
    // ★검사 대상은 주석 구간이다★ — 코드 뒤 주석이면 `//` 부터. 보고는 원본 줄로 한다.
    const line = commentSegment(rawLine);
    if (line === null) return;
    NAME_G.lastIndex = 0;
    for (let nm = NAME_G.exec(line); nm; nm = NAME_G.exec(line)) {
      const name = nm[1]!;
      const at = nm.index;
      const after = line.slice(at + name.length);
      const before = line.slice(0, at);

      // ── 이 후보를 건너뛸 이유들(줄 전체를 끝내지 않는다) ──
      if (PRODUCTISH.test(after)) continue;        // codex-cli · codex 0.144
      if (ROLE_BEFORE.test(before)) continue;      // 제안자 lui · 요청자(bill)
      if (inCodeSpan(line, at)) continue;          // `--to bill`
      if (inQuotedSpan(line, at)) continue;        // "… steve 가 확인했다" ← 예시·인용
      if (ARROW_AFTER.test(after)) continue;       // codex→…
      if (ARROW_BEFORE.test(before)) continue;     // …codex→demis

      // ── 이 후보에 붙는 서술어 찾기 ──
      const isPerson = PERSON_RE.test(name);
      const m = (isPerson ? PRED_PERSON : PRED_AMBIG).exec(after);
      const adj = isPerson ? PRED_ADJACENT.exec(after) : null;
      const pre = isPerson ? PRED_BEFORE.exec(before) : null;
      const pred = m?.[2] ?? adj?.[1] ?? pre?.[1];
      if (!pred) continue;

      // ── 관찰 귀속 거부권은 ★그 서술어★ 자리에서만 판단한다(줄의 첫 관찰어가 아니라) ──
      if (OBSERVE_RE.test(pred)) {
        const predAt = m
          ? at + name.length + (m[1]?.length ?? 0)
          : pre
            ? before.length - (pre[0]?.length ?? 0)
            : at;
        if (observeInParenWithoutName(line, predAt, ANY_NAME)) continue;
      }

      out.push({ file, line: i + 1, text: rawLine.trim() });
      return; // 한 줄에 하나만 보고한다
    }
  });
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

/**
 * ★기본 범위에 scripts 를 넣는다★ (2026-08-18).
 * 전에는 `src` 만이라 ★이 검사기 자신(scripts/…)이 검사 밖★ 이었다.
 * 규칙을 강제하는 파일이 그 규칙에서 면제되면, 가장 먼저 새는 곳이 거기다.
 * 없는 폴더는 조용히 건너뛴다 — 다른 저장소에서 이 스크립트만 가져다 쓸 수 있어야 한다.
 */
export const DEFAULT_ROOTS = ["src", "scripts"] as const;

if (import.meta.main) {
  const roots = process.argv[2] ? [process.argv[2]] : DEFAULT_ROOTS.filter((d) => existsSync(d));
  const findings = roots.flatMap((root) => walk(root)).flatMap((f) => scanText(f, readFileSync(f, "utf8")));
  for (const f of findings) console.log(`${f.file}:${f.line}  ${f.text.slice(0, 120)}`);
  console.log(`\n사람 귀속으로 걸린 주석: ${findings.length}건`);
  process.exit(findings.length ? 3 : 0);
}
