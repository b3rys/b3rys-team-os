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
import { readdirSync, readFileSync, statSync } from "node:fs";
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

/** ★사람만 주어가 되는 서술어.★ 여기 없는 것은 통과시킨다(오탐을 줄이는 쪽이 기본). */
const HUMAN =
  "리뷰|지적|제안|요청했|요청함|채택|판단했|판단이|말했|말한 것|말씀|물었|시켰|정했|결정했|" +
  "원칙|잡았|잡은|잡아낸|짚었|짚은|찾아냈|알려줬|승인했|반대했|합의|약속";

/**
 * PERSON 에만 붙는 ★관찰 귀속★ — 누가 쟀는지를 적은 것이다.
 * AMBIG 에는 안 붙인다: "codex 가 35분째 멈췄다" · "codex 실측" 은 런타임·제품 서술이다.
 */
const OBSERVE = "실측|확인했|재봤|제보|발견했|보고했";

/** 이름 바로 뒤가 제품명 꼴이면 사람이 아니다: codex-cli · codex 0.144 · dex.ts */
const PRODUCTISH = /^(?:[-_.][A-Za-z0-9]|\s+v?\d)/;

/** 이름 → (25자 안) 서술어. PERSON 은 관찰 귀속까지 잡고, AMBIG 은 사람 전용 서술어만 잡는다. */
const HIT_PERSON = new RegExp(`(${PERSON})(.{0,25}?)(${HUMAN}|${OBSERVE})`, "i");
const HIT_AMBIG = new RegExp(`(${AMBIG})(.{0,25}?)(${HUMAN})`, "i");
/** 이름이 괄호 안에 뒤따라 오는 꼴도 귀속이다: `실측(루이)` · `(dbak 리뷰 …)` */
const HIT_PAREN = new RegExp(`(${HUMAN}|${OBSERVE})\\s*\\((${PERSON})[^)]*\\)`, "i");

function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

export type Finding = { file: string; line: number; text: string };

export function scanText(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  text.split("\n").forEach((line, i) => {
    if (!isCommentLine(line)) return;
    const m = HIT_PERSON.exec(line) ?? HIT_AMBIG.exec(line) ?? HIT_PAREN.exec(line);
    if (!m) return;
    const after = line.slice((m.index ?? 0) + m[1]!.length);
    if (PRODUCTISH.test(after)) return; // 제품명·버전 (codex-cli · codex 0.144)
    out.push({ file, line: i + 1, text: line.trim() });
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

if (import.meta.main) {
  const root = process.argv[2] ?? "src";
  const findings = walk(root).flatMap((f) => scanText(f, readFileSync(f, "utf8")));
  for (const f of findings) console.log(`${f.file}:${f.line}  ${f.text.slice(0, 120)}`);
  console.log(`\n사람 귀속으로 걸린 주석: ${findings.length}건`);
  process.exit(findings.length ? 3 : 0);
}
