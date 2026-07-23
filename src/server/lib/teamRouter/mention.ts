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

// 라우팅용: 인용/예시 구간 제거 → 그 안 @멘션·@all 은 트리거하지 않는다 (GD 2026-06-25).
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

// NOTE (2026-06-06 split): dead code — no caller in the current routing path. Preserved as-is
// (strangler: behavior-neutral move, no deletion). Candidate for a follow-up cleanup card.
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

/**
 * GD 개인 컨벤션(2026-06-02, config로 분리 — 외부 공개 시 미설정이면 코어는 깨끗):
 * env ROUTER_EXAMPLE_SEPARATOR="on" 일 때만, 예시/인용 영역의 @멘션을 호출에서 제외한다.
 *  - ''' ... ''' 펜스 안 (닫는 ''' 없으면 그 뒤 끝까지)
 *  - "—-" 류 구분선(2+ 대시/엠대시 단독 라인) 아래 끝까지
 * 영역 밖 @멘션은 그대로 호출. 미설정(공개 기본)이면 원문 그대로 — false-drop 없음.
 */
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

// HYBRID 전용 명시 호출 감지: 기존 별칭 앞에 @가 붙은 경우만 호출로 간주.
// GD 결정(2026-05-24): 평문 이름은 언급/컨텍스트일 수 있으므로 wake 신호가 아니다.
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
// over-summon 방지용 (GD 2026-05-24): "대상은 빌/코덱스/스티브/데미스/드박이겠지" 같은 나열에서 다 깨우지 않게.
const REQUEST_MARKER = /(의견|생각|어때|어떻|줘|해줘|봐줘|답해|답변|확인|만들|고쳐|구현|배포|세팅|설정|알려|보고|전달|리뷰|체크|들려|봐봐|해봐|부탁|질문|시켜|하라|할까|볼까|\?)/;
// NOTE (2026-06-06 split): SCOPE_MARKER + filterLiveWakeTargets are dead code (scope guard removed
// 2026-05-25; no current caller). Preserved as-is for behavior-neutral move. Cleanup card candidate.
const SCOPE_MARKER = /(대상|범위|적용\s*대상|self[-\s]?learning|셀프\s*러닝|health|status|상태\s*관리|정책|규칙|예시|케이스)/i;
void SCOPE_MARKER;

function filterLiveWakeTargets(text: string, agents: AgentRecord[], targets: string[]): string[] {
  // scope-list 가드 제거 (2026-05-25, GD 결정): @멘션 필수(detectAddressedNamesLoose) + 아래 REQUEST_MARKER
  // 체크로 이미 커버됨 — 요청 없으면 안 깬다. scope단어 가드는 "정책/규칙" 든 진짜 호출을 오판해 redundant+해로움.
  return targets.filter((id) => {
    const agent = agents.find((a) => a.id === id);
    if (!agent) return false;

    // Direct bot mention is an explicit wake, even for specialist agents.
    if (hasTelegramMention(text, agent)) return true;

    // Specialist agents wake when explicitly @-addressed with an action/question.
    // targets here came from detectAddressedNamesLoose (requires "@" prefix + drops past-refs),
    // so any id is already an explicit @-mention.
    // Fix 2026-05-25: 여러 명 명시 @멘션("@드박 @데미스 @스티브 들려?")시 lead 한 명만 깨우던 버그 →
    //   lead 제한 제거. lead 무관하게 @멘션+요청이면 깨운다.
    //   (delegation 은 analyzeDelegation 후처리로 narrow / bare 이름·scope-list 는 위에서 이미 차단)
    return REQUEST_MARKER.test(text);
  });
}
void filterLiveWakeTargets; // dead code retained (see note above)
