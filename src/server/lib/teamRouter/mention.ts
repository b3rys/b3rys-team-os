import type { AgentRecord } from "../../types";
import { hasCapability } from "../capabilities";

// restricted_mention capability 를 가진 agent(예: codex)의 명시 @멘션 판정에 쓰는 lookahead.
// 기존 CODEX_ALLOWED_MENTION 정규식의 동작을 그대로 보존 — 단 토큰을 agents.json 별칭(aliasesFor)에서
// 생성해 코드에 실명을 박지 않는다. (한글 별칭은 조사 lookahead, latin/봇유저명은 경계 lookahead.)
const RESTRICTED_KOREAN_LOOKAHEAD = "(?=[\\s,.:;!?]|$|[이가은는도만을를께에게한테야아님])";
const RESTRICTED_LATIN_LOOKAHEAD = "(?=[\\s,.:;!?]|$)";

const CALL_VERBS = [
  "해보자",
  "하자",
  "해줘",
  "해주세요",
  "봐줘",
  "봐주세요",
  "맡아",
  "맡아줘",
  "담당",
  "진행",
  "검토",
  "리뷰",
  "체크",
  "확인",
  "답변",
];

function normalizeBotUsername(username: string): string {
  return username.replace(/^@/, "").toLowerCase();
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
}

// 라우팅용: 인용/예시 구간 제거 → 그 안 @멘션·@all 은 트리거하지 않는다.
// 제거: ``` ``` · ''' ''' · """ """ 펜스 안 + 대시/em대시만으로 된 구분선("—-"·"---"·"—" 등) 아래 전체.
// 라이브 멘션은 보통 펜스/구분선 '위'(상단)에 오므로 그 부분만 남아 판정된다.
export function stripQuotedForRouting(text: string): string {
  let t = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/'''[\s\S]*?'''/g, " ")
    .replace(/"""[\s\S]*?"""/g, " ");
  const lines = t.split("\n");
  const sep = lines.findIndex((l) => /^[\s>]*[—–-]{2,}\s*$/.test(l));
  if (sep >= 0) t = lines.slice(0, sep).join("\n");
  return t;
}

export function aliasesFor(agent: AgentRecord): string[] {
  // 별칭 정본 = agents.json 의 nicknames(영입만으로 자동 로드). BUILTIN_ALIASES 폴백은 제거됨
  // (모든 agent 가 nicknames 보유 — 코드 실명 0). nicknames 없으면 id/display_name/@봇유저명만.
  const aliases = new Set<string>(agent.nicknames ?? []);
  aliases.add(agent.id);
  aliases.add(agent.display_name);
  if (agent.telegram_bot_username) aliases.add("@" + normalizeBotUsername(agent.telegram_bot_username));
  return [...aliases].filter(Boolean);
}

export function hasTelegramMention(text: string, agent: AgentRecord): boolean {
  if (!agent.telegram_bot_username) return false;
  const username = normalizeBotUsername(agent.telegram_bot_username);
  return new RegExp("(^|\\s)@" + escapeRegex(username) + "\\b", "i").test(text);
}

function hasAtAlias(text: string, alias: string): boolean {
  const raw = alias.replace(/^@/, "");
  if (!raw) return false;
  const latin = /^[a-z0-9_-]+$/i.test(raw);
  if (latin) return new RegExp("(^|[\\s,.:;!?])@" + escapeRegex(raw) + "([\\s,.:;!?]|$)", "i").test(text);
  return new RegExp("(^|[\\s,.:;!?])@" + escapeRegex(raw) + "(?=[\\s,.:;!?야아이가은는도만께님한]|$)", "i").test(text);
}

/**
 * restricted_mention agent 의 명시 @멘션 판정. 토큰을 aliasesFor(agent)에서 생성한다.
 * codex 의 경우 기존 CODEX_ALLOWED_MENTION 과 동치(@codex/@코덱스+조사/@example_openclaw_bot).
 */
export function hasRestrictedMention(text: string, agent: AgentRecord): boolean {
  const parts: string[] = [];
  for (const alias of aliasesFor(agent)) {
    const raw = alias.replace(/^@/, "");
    if (!raw) continue;
    const latin = /^[a-z0-9_-]+$/i.test(raw);
    parts.push("@" + escapeRegex(raw) + (latin ? RESTRICTED_LATIN_LOOKAHEAD : RESTRICTED_KOREAN_LOOKAHEAD));
  }
  if (!parts.length) return false;
  return new RegExp("(^|[\\s,.:;!?])(" + parts.join("|") + ")", "i").test(text);
}

function hasAddressedAlias(text: string, alias: string): boolean {
  if (alias.startsWith("@")) return new RegExp("(^|\\s)" + escapeRegex(alias) + "\\b", "i").test(text);

  const latin = /^[a-z0-9_-]+$/i.test(alias);
  if (latin) {
    const rx = new RegExp("(^|[\\s,.:;!?])" + escapeRegex(alias) + "([\\s,.:;!?]|$)", "i");
    return rx.test(text);
  }

  // Korean direct address: "빌, ...", "코덱스야 ...".
  const direct = new RegExp("(^|[\\s,.:;!?])" + escapeRegex(alias) + "((야|아)([\\s,.:;!?]|$)|([,.:;!?]|$))", "i");
  if (direct.test(text)) return true;

  const reference = new RegExp(
    escapeRegex(alias) + "[이가은는의]?\\s{0,4}(전에|이전에|말한|의견|설정|답변|메시지|내용)",
    "i",
  );
  if (reference.test(text)) return false;

  // Mid-sentence assignment: "게임은 스티브가 해보자". Avoid historical references like
  // "빌이 전에 말한" by requiring an action verb shortly after the particle.
  const assignment = new RegExp(
    escapeRegex(alias) + "[이가은는]?\\s{0,8}[^.!?]{0,24}(" + CALL_VERBS.map(escapeRegex).join("|") + ")",
    "i",
  );
  return assignment.test(text);
}
void hasAddressedAlias; // dead code retained (see note above)

// 예시·인용 영역의 멘션 제외는 ROUTER_EXAMPLE_SEPARATOR=on일 때만 적용한다. 미설정 설치에서는 원문을 유지한다.
export function stripExampleRegions(text: string): string {
  if (process.env.ROUTER_EXAMPLE_SEPARATOR !== "on") return text;
  let t = text.replace(/'''[\s\S]*?'''/g, " ");
  const lone = t.indexOf("'''");
  if (lone !== -1) t = t.slice(0, lone);
  const lines = t.split("\n");
  const sepIdx = lines.findIndex((ln) => /^\s*[—–\-]{2,}\s*$/.test(ln));
  return sepIdx === -1 ? t : lines.slice(0, sepIdx).join("\n");
}

export function detectExplicitTargets(text: string, agents: AgentRecord[]): string[] {
  const scan = stripExampleRegions(text);
  const targets: string[] = [];
  for (const agent of agents) {
    if (hasCapability(agent, "restricted_mention")) {
      if (hasRestrictedMention(scan, agent)) targets.push(agent.id);
      continue;
    }
    if (hasTelegramMention(scan, agent) || aliasesFor(agent).some((alias) => hasAtAlias(scan, alias))) {
      targets.push(agent.id);
    }
  }
  return [...new Set(targets)];
}

// 과거/상태/산출물 참조("코덱스가 전에 말한", "데미스가 만든", "Demis 가 일어났네") 는 호출이 아니므로 제외.
const NAME_REFERENCE_TAIL = /^(이|가|은|는|의)?\s{0,4}(전에|이전에|아까|말한|얘기한|설정한|답변한|보낸|만든|작성한|일어났|깨어났|응답한)/;

// 평문 호출은 발신자가 확인된 사람 메시지의 선두에서만 해석한다.
export function hasLeadingAllAddress(text: string): boolean {
  return /^(모두|다들|전체|얘들아)(?=[,.\s]|$)/.test(text.trimStart());
}

export function detectLeadingNameTargets(text: string, agents: AgentRecord[]): string[] {
  const aliases = agents.flatMap((agent) =>
    [...new Set([...(agent.nicknames ?? []), agent.id, agent.display_name])]
      .filter((alias) => alias && !alias.startsWith("@"))
      .map((alias) => ({ alias, id: agent.id })),
  ).sort((a, b) => b.alias.length - a.alias.length);
  const targets = new Set<string>();
  let rest = text.trimStart();
  while (rest) {
    const matches = aliases.filter(({ alias }) => {
      if (!rest.toLowerCase().startsWith(alias.toLowerCase())) return false;
      const tail = rest.slice(alias.length);
      if (NAME_REFERENCE_TAIL.test(tail)) return false;
      return /^(?:(?:아|야|님)(?=[,.\s]|$)|(?=[,.\s]|$))/.test(tail);
    });
    const first = matches[0];
    if (!first) break;
    const length = first.alias.length;
    for (const match of matches.filter((m) => m.alias.length === length)) targets.add(match.id);
    rest = rest.slice(length).replace(/^(아|야|님)(?=[,.\s]|$)/, "");
    rest = rest.replace(/^[,.\s]+/, "");
  }
  return [...targets];
}

// 평문 이름은 단순 언급일 수 있어 HYBRID 호출은 @가 붙은 별칭만 인정한다.
export function detectAddressedNamesLoose(text: string, agents: AgentRecord[]): string[] {
  const targets: string[] = [];
  for (const agent of agents) {
    if (hasCapability(agent, "restricted_mention")) {
      if (hasRestrictedMention(text, agent)) targets.push(agent.id);
      continue;
    }
    if (hasTelegramMention(text, agent)) {
      targets.push(agent.id);
      continue;
    }
    for (const alias of aliasesFor(agent)) {
      if (alias.startsWith("@")) continue; // 위에서 처리
      const boundary = /^[a-z0-9_-]+$/i.test(alias)
        ? new RegExp("(^|[\\s,.:;!?])@" + escapeRegex(alias) + "([\\s,.:;!?]|$)", "i")
        : new RegExp("(^|[\\s,.:;!?])@" + escapeRegex(alias) + "(?=[\\s,.:;!?야아이가은는도만께님한]|$)");
      const m = boundary.exec(text);
      if (!m) continue;
      // 호출 직후가 과거 참조면 제외.
      const tail = text.slice((m.index ?? 0) + m[0].length);
      if (NAME_REFERENCE_TAIL.test(tail)) continue;
      targets.push(agent.id);
      break;
    }
  }
  return [...new Set(targets)];
}

// 요청/지시/질문 신호 — 이게 없으면 이름이 있어도 '호출'이 아니라 '나열·서술'일 수 있음.
// over-summon 방지용: "대상은 빌/코덱스/스티브/데미스/드박이겠지" 같은 나열에서 다 깨우지 않게.
const REQUEST_MARKER = /(의견|생각|어때|어떻|줘|해줘|봐줘|답해|답변|확인|만들|고쳐|구현|배포|세팅|설정|알려|보고|전달|리뷰|체크|들려|봐봐|해봐|부탁|질문|시켜|하라|할까|볼까|\?)/;
const SCOPE_MARKER = /(대상|범위|적용\s*대상|self[-\s]?learning|셀프\s*러닝|health|status|상태\s*관리|정책|규칙|예시|케이스)/i;
void SCOPE_MARKER;

function filterLiveWakeTargets(text: string, agents: AgentRecord[], targets: string[]): string[] {
  return targets.filter((id) => {
    const agent = agents.find((a) => a.id === id);
    if (!agent) return false;

    // Direct bot mention is an explicit wake, even for specialist agents.
    if (hasTelegramMention(text, agent)) return true;

    // 대상은 명시 멘션에서 도출된다. 요청·질문이 있으면 lead 여부와 무관하게 깨운다.
    return REQUEST_MARKER.test(text);
  });
}
void filterLiveWakeTargets; // dead code retained (see note above)
