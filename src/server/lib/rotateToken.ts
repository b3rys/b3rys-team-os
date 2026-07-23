// 봇 토큰 교체 — 런타임별 격리 핸들러 + fail-safe (GD 2026-07-01).
// 원칙(GD): getMe로 새 토큰 검증 → 기존 백업 → 쓰기 → 재시작 → 어디서든 실패하면 기존 복원+멈춤(절대 반쯤 안 바꿈).
//   토큰 값은 파일로만 다루고 로그/응답/audit에 절대 노출하지 않는다(username만).
//   런타임별 저장소가 완전히 분리돼 있어(claude/openclaw/hermes/codex) 서로·기존 코드에 side-effect 0.
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { REPO_ROOT } from "./personaTemplates";
import type { AgentRecord } from "../types";
import { waitForEssentialSettings } from "./runtimeEssentials";

const HOME = process.env.HOME ?? "";
const GETME_TIMEOUT_MS = 8_000;

export interface RotateResult {
  ok: boolean;
  bot_username?: string;
  error?: string; // bot_token_invalid | bot_token_dead | getme_failed | unsupported_member | store_failed | restart_failed_reverted | essentials_failed
  detail: string; // 사람이 보는 설명 — 토큰 값 절대 미포함
  warning?: string; // side-effect 경고(openclaw 공유 게이트웨이 등)
}

/** 런타임별 토큰 저장소 — 읽기(백업)/쓰기 격리. resolveStore가 미지원이면 unsupported 반환. */
interface TokenStore {
  read(): string | null; // 기존 토큰(백업용). 없으면 null.
  write(token: string): void;
  warning?: string;
}

// ── .env 키 라인 처리(다른 설정 보존) ──
function readEnvKey(file: string, key: string): string | null {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`));
    if (m) return (m[1] ?? "").trim();
  }
  return null;
}
function writeEnvKey(file: string, key: string, value: string, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true });
  const lines = existsSync(file) ? readFileSync(file, "utf-8").split("\n") : [];
  let found = false;
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const out = lines.map((l) => (re.test(l) ? (found = true, `${key}=${value}`) : l));
  if (!found) {
    // 마지막 빈 줄 정리 후 append
    while (out.length && out[out.length - 1] === "") out.pop();
    out.push(`${key}=${value}`);
  }
  // atomic(temp+rename) — truncate-in-place 빈 창에 poller가 읽으면 토큰로드 실패로 죽음(하네스 근본원인). GD 2026-07-01.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, out.join("\n") + (out[out.length - 1] === "" ? "" : "\n"), { mode });
  try { chmodSync(tmp, mode); } catch { /* best-effort */ }
  renameSync(tmp, file);
}

// ── 단독 파일(코덱스 var/secrets, openclaw token.txt) ──
function plainFileStore(file: string, warning?: string): TokenStore {
  return {
    read: () => (existsSync(file) ? readFileSync(file, "utf-8").trim() : null),
    write: (t) => { mkdirSync(dirname(file), { recursive: true }); const tmp = `${file}.tmp`; writeFileSync(tmp, t.trim() + "\n", { mode: 0o600 }); try { chmodSync(tmp, 0o600); } catch { /* */ } renameSync(tmp, file); }, // atomic(빈창 제거)
    warning,
  };
}
function envFileStore(file: string, key: string): TokenStore {
  return { read: () => readEnvKey(file, key), write: (t) => writeEnvKey(file, key, t) };
}

/** openclaw.json 의 그 account 에 설정된 tokenFile 경로(~확장)를 반환. 인라인 토큰(botToken)·미정의·빈 계정·미존재면 null.
 *  ★파일 존재 여부는 안 본다★ — '설정상 파일기반인가'만(파일 실종된 Lui 도 tokenFile 정의돼 있으면 경로 반환 → 생성 허용).
 *  cfgPath 파라미터 = 테스트 주입용(기본=라이브 openclaw.json). malformed/미존재/파싱실패는 catch→null(deny-safe). */
export function openclawConfiguredTokenFile(account: string, cfgPath: string = `${HOME}/.openclaw/openclaw.json`): string | null {
  try {
    if (!existsSync(cfgPath)) return null;
    const j = JSON.parse(readFileSync(cfgPath, "utf-8"));
    const tf = j?.channels?.telegram?.accounts?.[account]?.tokenFile;
    if (typeof tf !== "string" || tf.trim().length === 0) return null;
    return tf.startsWith("~") ? tf.replace(/^~/, HOME) : tf; // ~ 확장
  } catch { return null; }
}

/** 런타임+id → 저장소. 미지원(인라인/미정의 config)이면 { unsupported } 반환 → fail-safe 거부. */
export function resolveTokenStore(runtime: string, id: string, agent: AgentRecord): TokenStore | { unsupported: string } {
  if (runtime === "codex") {
    return plainFileStore(`${REPO_ROOT}/var/secrets/${id}.bot-token`);
  }
  if (runtime === "claude_channel") {
    return envFileStore(`${HOME}/.claude/channels/telegram-${id}/.env`, "TELEGRAM_BOT_TOKEN");
  }
  if (runtime === "openclaw") {
    // openclaw 파일기반 계정(devon/lui/forin 등) = ~/.openclaw/credentials/telegram-<account>-token.txt. account=openclaw_agent_id ?? id.
    //   ⚠ openclaw는 게이트웨이 공유라 재시작 시 openclaw 팀원 전체가 잠깐 재시작됨(warning으로 알림). codex/brief는 토큰이 인라인(openclaw.json)이라 파일 없음 → 미지원(fail-safe).
    const account = agent.openclaw_agent_id ?? id;
    // account(openclaw_agent_id)도 path에 들어가니 id와 동일하게 형식 검증(방어적 — 하네스 LOW).
    if (!/^[a-z0-9_-]+$/i.test(account)) return { unsupported: `openclaw account 형식이 올바르지 않아요 — 변경 미지원(기존 유지).` };
    // ★파일기반 계정만 rotate 허용(GD 2026-07-05)★: openclaw.json 에 tokenFile 이 정의된 계정(lui·devon 등)만.
    //   ★파일이 실종돼도(Lui 토큰파일 사라진 케이스) 거부하지 않는다★ — '죽은 봇→새 토큰' 취지대로 새 토큰으로 파일 생성
    //   (plainFileStore.write = mkdir+atomic create; read 는 파일 없으면 null → 백업할 것 없음, fail-safe).
    //   tokenFile 미정의(인라인 토큰 codex/brief, 빈 계정)면 파일 생성이 인라인 config 와 충돌하므로 여전히 거부.
    //   저장 경로는 config 값(임의경로 traversal 위험)이 아니라 ★검증된 account 로 고정패턴★을 쓴다(원래와 동일 경로).
    const configTokenFile = openclawConfiguredTokenFile(account);
    if (!configTokenFile) {
      return { unsupported: `openclaw '${id}'의 봇 토큰이 파일기반이 아니라 openclaw.json 인라인/미정의예요 — 대시보드 변경 미지원(기존 유지). openclaw 설정에서 직접 변경하세요.` };
    }
    // ★저장은 검증된 account 로 고정패턴(traversal 방지)★. 단 config 의 tokenFile 이 이 표준경로와 다르면
    //   rotate 는 표준경로에 쓰고 게이트웨이(openclawBridge)는 config 경로를 읽어 ★성공응답+실제 미반영(silent no-op)★ 이 된다(하네스 지적).
    //   → 일치할 때만 허용하고, 비표준 tokenFile 은 거부(직접 변경 안내)해 신뢰(성공=실제 교체)를 보존한다.
    const file = `${HOME}/.openclaw/credentials/telegram-${account}-token.txt`;
    if (configTokenFile !== file) {
      return { unsupported: `openclaw '${id}'의 tokenFile 이 표준 경로가 아니에요(${configTokenFile}) — 대시보드 변경 미지원(silent 미반영 방지). openclaw 설정에서 직접 변경하세요.` };
    }
    return plainFileStore(file, `⚠ openclaw는 게이트웨이를 공유해서, 재시작 시 openclaw 팀원 전체가 1~2분 함께 재시작됩니다.${existsSync(file) ? "" : " (토큰파일이 없어 새로 생성합니다.)"}`);
  }
  if (runtime === "hermes_agent") {
    // hermes = 격리(그 팀원 프로필만). 프로필 = agent.hermes_profile ?? id (기존 hermes=b3ryshermes, 신규=id). 다중설정 .env에서 TELEGRAM_BOT_TOKEN 키 라인만 교체.
    const profile = agent.hermes_profile ?? id;
    if (!/^[a-z0-9_-]+$/i.test(profile)) return { unsupported: `hermes 프로필 형식이 올바르지 않아요 — 변경 미지원(기존 유지).` };
    return envFileStore(`${HOME}/.hermes/profiles/${profile}/.env`, "TELEGRAM_BOT_TOKEN");
  }
  return { unsupported: `런타임 '${runtime}'은 봇 토큰 변경을 지원하지 않아요(기존 유지).` };
}

/** getMe로 살아있는 봇인지 검증. 토큰은 URL에만, 반환/로그엔 username만. */
export async function validateBotToken(token: string): Promise<{ ok: true; username: string } | { ok: false; error: "bot_token_invalid" | "bot_token_dead" | "getme_failed" }> {
  if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token)) return { ok: false, error: "bot_token_invalid" };
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), GETME_TIMEOUT_MS);
    const gm = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: ac.signal });
    clearTimeout(timer);
    const data = (await gm.json().catch(() => ({}))) as any;
    if (!data?.ok || !data?.result?.username) return { ok: false, error: "bot_token_dead" };
    return { ok: true, username: String(data.result.username) };
  } catch {
    return { ok: false, error: "getme_failed" };
  }
}

/**
 * 봇 토큰 교체(fail-safe). 검증 → 백업 → 쓰기 → 재시작 → 실패 시 기존 복원.
 * @param restart 런타임 재시작 함수(agentControl.restartAgent 주입 — 순환 import 회피).
 */
export async function rotateBotToken(
  restart: (id: string, runtime: string) => Promise<{ ok: boolean; detail: string }>,
  runtime: string,
  id: string,
  agent: AgentRecord,
  newToken: string,
): Promise<RotateResult> {
  // 1) 새 토큰 검증(살아있는 봇). 실패 시 기존 안 건드림.
  const v = await validateBotToken(newToken.trim());
  if (!v.ok) {
    const detail = v.error === "bot_token_invalid" ? "BotFather 토큰 형식이 아니에요(기존 유지)."
      : v.error === "bot_token_dead" ? "토큰이 유효하지 않거나 죽은 봇이에요(getMe 실패) — 기존 토큰 유지."
      : "Telegram 검증 실패(네트워크/타임아웃) — 기존 토큰 유지. 잠시 후 다시.";
    return { ok: false, error: v.error, detail };
  }
  // 2) 저장소 확인. 미지원이면 거부(기존 유지).
  const store = resolveTokenStore(runtime, id, agent);
  if ("unsupported" in store) return { ok: false, error: "unsupported_member", detail: store.unsupported };
  // 3) 기존 토큰 백업(메모리).
  let old: string | null = null;
  try { old = store.read(); } catch { old = null; }
  // 4) 새 토큰 쓰기.
  try { store.write(newToken.trim()); } catch {
    return { ok: false, error: "store_failed", detail: "토큰 저장 실패 — 기존 유지. 잠시 후 다시 시도해 주세요." };
  }
  // 5) 재시작(새 토큰 로드).
  const r = await restart(id, runtime);
  if (!r.ok) {
    // 6) fail-safe: 재시작 실패 → 기존 토큰 복원(팀원 계속 작동, 반쯤 바뀐 상태 방지).
    let restored = false, restoreError = false;
    if (old != null) { try { store.write(old); restored = true; } catch { restoreError = true; } }
    const detail = restored
      ? `재시작에 실패해서 기존 토큰으로 복원했어요(팀원은 계속 작동). 사유: ${r.detail}`
      : restoreError
        ? `재시작 실패 + 기존 토큰 복원도 실패. 수동 점검이 필요해요. 사유: ${r.detail}`
        // old==null: 복원할 기존 토큰이 없던 경우. 새 토큰은 getMe 검증을 통과해 저장돼 있으니, 수동 재시작만 하면 됨.
        : `새 토큰은 저장(검증 완료)됐지만 재시작에 실패했어요. 수동 재시작하면 적용됩니다. 사유: ${r.detail}`;
    return { ok: false, error: "restart_failed_reverted", detail };
  }
  const rawWait = process.env.TEAMOS_POLLER_WAIT_MS;
  const pollerWaitMs = rawWait !== undefined && Number.isFinite(Number(rawWait)) ? Number(rawWait) : 28000;
  const essentials = await waitForEssentialSettings(agent, pollerWaitMs);
  if (!essentials.ok) {
    return {
      ok: false,
      error: "essentials_failed",
      detail: `새 토큰 저장·재시작은 완료됐지만 필수설정 검증에 실패했어요. 토큰은 되돌리지 않았습니다(실행 중 프로세스와 파일 상태 불일치 방지). 누락: ${essentials.missing.join(", ")}`,
    };
  }
  return { ok: true, bot_username: v.username, detail: `@${v.username} 검증·연결 완료 — 재시작됨`, warning: store.warning };
}
