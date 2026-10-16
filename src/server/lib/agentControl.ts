import { readMemberChannel, type MemberChannel } from "./memberChannel";
import { claudeCogsPaths, writeClaudeCogsFiles } from "../runtimes/claude/cogsLauncher";
// 의도적 정지는 auto-heal이 되살리지 않도록 off-list에 기록한다. openclaw는 계정을 비활성화하고 게이트웨이는 재시작한다.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { codexBridgeLaunchdLabel, writeCodexBridgeFiles } from "../runtimes/codex/launcher";
import { REPO_ROOT } from "./personaTemplates";
import { ambientAgents } from "./registry";
import { COORDINATOR_CAPABILITY } from "./capabilities";
import { ensureClaudePollerUp } from "../runtimes/claude/pollerHealth";

const HOME = process.env.HOME ?? "";
function execOn(): boolean { return process.env.APPROVAL_EXECUTION_ENABLED === "1"; }

export function teamosLaunchdPrefix(): string {
  const override = process.env.TEAMOS_LAUNCHD_PREFIX?.trim();
  if (override) return override.replace(/\.$/, "");
  const user = process.env.USER?.trim() || "local";
  return `com.${user}`;
}

export function claudeTelegramLaunchdLabel(id: string): string {
  return `${teamosLaunchdPrefix()}.claude-telegram-${id}`;
}

export function botLivenessLaunchdLabel(): string {
  return `${teamosLaunchdPrefix()}.bot-liveness-monitor`;
}

export interface ControlResult { ok: boolean; detail: string }

// ── 의도적 off 명단 (auto-heal 조율) ──────────────────────────────────────
// 테스트 격리용 env 오버라이드(기본=라이브 var/agent-off.txt). 테스트가 라이브 off-file을 읽거나 오염하지 않게.
const OFF_FILE = (): string => process.env.TEAMOS_AGENT_OFF_FILE ?? `${process.cwd()}/var/agent-off.txt`;
export function isAgentOff(id: string): boolean {
  try {
    return readFileSync(OFF_FILE(), "utf-8").split(/[\s,]+/).map((s) => s.trim()).includes(id);
  } catch { return false; }
}
function markOff(id: string, off: boolean): void {
  const f = OFF_FILE();
  let ids = new Set<string>();
  try { ids = new Set(readFileSync(f, "utf-8").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)); } catch { /* 없으면 새로 */ }
  if (off) ids.add(id); else ids.delete(id);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, [...ids].join("\n") + (ids.size ? "\n" : ""), "utf-8");
}

// 재영입된 멤버가 버스에서 계속 차단되지 않도록 의도적 정지 목록에서도 제거한다.
export function clearAgentOff(id: string): void {
  markOff(id, false);
}

async function run(cmd: string[], env?: Record<string, string>): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, {
    env: { ...process.env, PATH: `${HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH ?? ""}`, ...(env ?? {}) },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, out: (out + (err ? "\n" + err : "")).trim().slice(-400) };
}

/** openclaw 에이전트: 계정 enabled 토글 → 게이트웨이 restart(stop 아님 → auto-heal 무관). */
async function setOpenclaw(id: string, enabled: boolean): Promise<ControlResult> {
  const py =
    "import json,os,sys\n" +
    "p=os.path.expanduser('~/.openclaw/openclaw.json')\n" +
    "c=json.load(open(p))\n" +
    "a=c.get('channels',{}).get('telegram',{}).get('accounts',{})\n" +
    `if '${id}' not in a:\n print('noacct'); sys.exit(0)\n` +
    `a['${id}']['enabled']=${enabled ? "True" : "False"}\n` +
    "json.dump(c,open(p,'w'),ensure_ascii=False,indent=2)\n" +
    "json.load(open(p))\nprint('ok')";
  const r1 = await run(["python3", "-c", py]);
  if (r1.out.includes("noacct")) return { ok: false, detail: `openclaw 계정 없음: ${id}` };
  if (!r1.out.includes("ok")) return { ok: false, detail: `openclaw.json 편집 실패: ${r1.out}` };
  const r2 = await run(["openclaw", "gateway", "restart"]);
  return { ok: r2.code === 0, detail: r2.code === 0 ? `openclaw ${id} ${enabled ? "기동" : "정지"}(게이트웨이 재시작, 다른 openclaw 1~2분 깜빡)` : `게이트웨이 재시작 실패: ${r2.out.slice(-150)}` };
}

/** claude_channel 봇: LaunchAgent bootout/bootstrap (off 명단으로 auto-heal 무력화). */
async function setClaude(id: string, enabled: boolean): Promise<ControlResult> {
  const uid = process.getuid?.() ?? 0;
  const label = claudeTelegramLaunchdLabel(id);
  const plist = `${HOME}/Library/LaunchAgents/${label}.plist`;
  if (enabled) {
    const r = await run(["launchctl", "bootstrap", `gui/${uid}`, plist]);
    // 이미 로드돼 있으면 bootstrap 실패 → kickstart 로 기동
    if (r.code !== 0) { const k = await run(["launchctl", "kickstart", "-k", `gui/${uid}/${label}`]); return { ok: k.code === 0, detail: k.code === 0 ? `claude ${id} 기동` : `기동 실패: ${k.out.slice(-150)}` }; }
    return { ok: true, detail: `claude ${id} 기동` };
  }
  // LaunchAgent bootout만으로 detached tmux 세션은 종료되지 않는다. 순환 import를 피하려고 여기서 직접 종료한다.
  try { await run(["tmux", "kill-session", "-t", `claude-${id}`]); } catch { /* best-effort */ }
  const r = await run(["launchctl", "bootout", `gui/${uid}/${label}`]);
  return { ok: r.code === 0, detail: r.code === 0 ? `claude ${id} 정지(봇 tmux kill + LaunchAgent bootout)` : `정지 실패: ${r.out.slice(-150)}` };
}

/** hermes 게이트웨이 LaunchAgent 라벨. 기동·정지가 반드시 같은 값을 써야 한다 —
 *  정지만 bootout 하고 기동이 다른 라벨을 보면 되살아나지 않는다. 그래서 한 곳에서 도출한다.
 *  gateway_service 가 있으면 그것이 정본(프로필명과 라벨이 다른 설치본 대응). */
export function hermesLaunchdLabel(agent: { gateway_service?: string | null } | undefined, profile: string): string {
  const explicit = agent?.gateway_service?.trim();
  return explicit ? explicit : `ai.hermes.gateway-${profile}`;
}

/** hermes 에이전트: 프로필 게이트웨이 stop/start. */
async function setHermes(id: string, enabled: boolean): Promise<ControlResult> {
  // 프로필 = agent.hermes_profile ?? id (restartAgent와 동일) — HERMES_PROFILE=id 하드코딩이면 프로필≠id일 때 on/off가 엉뚱한 프로필을 건드린다.
  const agent = ambientAgents().find((a) => a.id === id);
  const profile = agent?.hermes_profile ?? id;
  const uid = process.getuid?.() ?? 0;
  const label = hermesLaunchdLabel(agent, profile);
  if (enabled) {
    // plist가 있으면 bootstrap만 사용한다. gateway start를 함께 호출하면 중복 게이트웨이가 텔레그램 폴링을 충돌시킨다.
    const plist = `${HOME}/Library/LaunchAgents/${label}.plist`;
    if (existsSync(plist)) {
      const b = await run(["launchctl", "bootstrap", `gui/${uid}`, plist]);
      // 이미 로드돼 있으면 bootstrap 이 실패한다 → kickstart 로 되살린다(codex 경로와 동일 패턴).
      if (b.code !== 0) {
        const k = await run(["launchctl", "kickstart", "-k", `gui/${uid}/${label}`]);
        return { ok: k.code === 0, detail: k.code === 0 ? `hermes ${id} 기동(LaunchAgent kickstart, 프로필 ${profile})` : `기동 실패: ${k.out.slice(-150)}` };
      }
      return { ok: true, detail: `hermes ${id} 기동(LaunchAgent bootstrap, 프로필 ${profile})` };
    }
    // plist 가 없는 설치본(활성화 전·수동 구성) → 종전대로 게이트웨이만 띄운다. launchd 보호는 없으므로 그렇게 알린다.
    const r = await run(["hermes", "gateway", "start"], { HERMES_PROFILE: profile });
    return { ok: r.code === 0, detail: r.code === 0 ? `hermes ${id} 기동(게이트웨이 직접 · LaunchAgent 없음 — 재부팅 후 수동 기동 필요, 프로필 ${profile})` : `기동 실패: ${r.out.slice(-150)}` };
  }
  // 정지: 게이트웨이 stop + LaunchAgent bootout. bootout 안 하면 KeepAlive LaunchAgent가 게이트웨이를 되살려 '퇴사해도 계속 응답'. 프로필별 라벨 타겟.
  const stopR = await run(["hermes", "gateway", "stop"], { HERMES_PROFILE: profile });
  await run(["launchctl", "bootout", `gui/${uid}/${label}`]);
  return { ok: true, detail: `hermes ${id} 정지(게이트웨이 stop + LaunchAgent bootout, 프로필 ${profile})${stopR.code !== 0 ? " [stop 경고]" : ""}` };
}

/** codex 런타임: ①버스 어댑터(in-process)는 off 명단(markOff)+adapter isAgentOff로 차단 ②per-member 텔레그램 브리지는
 *  LaunchAgent bootstrap/bootout. off 명단도 같이 기록돼 auto-heal이 안 되살림(claude 패턴 동일). */
async function setCodex(id: string, enabled: boolean, cogsClaude = false, channel?: MemberChannel): Promise<ControlResult> {
  const uid = process.getuid?.() ?? 0;
  const label = cogsClaude ? claudeCogsPaths(id).label : codexBridgeLaunchdLabel(id);
  if (enabled) {
    let p: ReturnType<typeof writeCodexBridgeFiles>;
    try { p = cogsClaude ? writeClaudeCogsFiles(id,channel) : writeCodexBridgeFiles(id); } // wrapper+plist 보장(idempotent). 토큰은 활성화 단계서 별도 배치.
    catch (e) { return { ok: false, detail: `브리지 기동 안 함: ${e instanceof Error ? e.message : String(e)}` }; }
    const r = await run(["launchctl", "bootstrap", `gui/${uid}`, p.plist]);
    if (r.code !== 0) { const k = await run(["launchctl", "kickstart", "-k", `gui/${uid}/${label}`]); return { ok: k.code === 0, detail: k.code === 0 ? `codex ${id} 브리지 기동(+버스 활성)` : `브리지 기동 실패: ${k.out.slice(-150)}` }; }
    return { ok: true, detail: `codex ${id} 브리지 기동(+버스 활성)` };
  }
  const r = await run(["launchctl", "bootout", `gui/${uid}/${label}`]);
  // bootout이 "없는 서비스"로 실패해도 off 명단(markOff)+버스 차단은 유효 → 정지 성공으로 본다.
  return { ok: true, detail: r.code === 0 ? `codex ${id} 정지(브리지 bootout + off 명단·버스 차단)` : `codex ${id} 정지(off 명단·버스 차단; 브리지 미기동이었음)` };
}

/**
 * 팀원 정지/기동. enabled=false 면 의도적 off 명단에 추가(auto-heal 이 안 되살림).
 * ⚠ self-mod 실행 — APPROVAL_EXECUTION_ENABLED=1 + 인증된 /onoff 탭에서만.
 */
export async function setAgentEnabled(agentId: string, runtime: string, enabled: boolean, channel?: MemberChannel): Promise<ControlResult> {
  if (!execOn()) return { ok: false, detail: "실행 OFF(APPROVAL_EXECUTION_ENABLED≠1) — 팀장 인가 필요" };
  // off 는 명단 먼저 기록(실행 중 auto-heal 이 끼어들어 되살리는 레이스 방지). on 은 실행 후 해제.
  if (!enabled) markOff(agentId, true);
  let res: ControlResult;
  try {
    if (runtime === "openclaw") res = await setOpenclaw(agentId, enabled);
    else if (runtime === "claude_channel") res = (channel ?? readMemberChannel(agentId)).kind === "b3chat" ? await setCodex(agentId, enabled, true,channel) : await setClaude(agentId, enabled);
    else if (runtime === "hermes_agent") res = await setHermes(agentId, enabled);
    else if (runtime === "codex") res = await setCodex(agentId, enabled);
    else res = { ok: false, detail: `지원 안 하는 런타임: ${runtime}` };
  } catch (e) {
    res = { ok: false, detail: `실행 오류: ${(e as Error).message}` };
  }
  if (enabled && res.ok) markOff(agentId, false); // 기동 성공 시 off 명단에서 제거
  if (!enabled && !res.ok) markOff(agentId, false); // 정지 실패면 명단 롤백
  return res;
}

// ── 재시작 (페르소나 reload·복구) ──────────────────────────────────────────
//   정지(off)와 다름: off 는 끄는 것, 재시작은 켜둔 채 다시 띄워 최신 페르소나/상태 로드.
//   런타임별: claude=restart-agent.sh --resume(컨텍스트 유지+새 CLAUDE.md) / openclaw·hermes=게이트웨이 in-place kickstart.
const OPENCLAW_LABEL = "ai.openclaw.gateway";

// 프로세스 생존은 poller 연결을 보장하지 않는다. 복구 실패는 재시작 성공과 구분해 detail에 노출한다.
async function withPollerRecovery(agentId: string, baseDetail: string): Promise<ControlResult> {
  const raw = process.env.TEAMOS_RESTART_POLLER_WAIT_MS;
  const waitMs = raw !== undefined && Number.isFinite(Number(raw)) ? Number(raw) : 30000;
  const res = await ensureClaudePollerUp(agentId, { waitMs });
  return { ok: true, detail: `${baseDetail} · ${res.detail}` };
}


/** 팀원 1명 재시작. off 상태는 거부(기동은 🟢). bill 도 가능 — claude_channel 이라 --resume(컨텍스트 유지)이고,
 *  재시작 실행 주체는 team-collab 서버(executor)지 bill 세션이 아니라서 bill 재시작이 작업을 끊지 않는다. */
export async function restartAgent(agentId: string, runtime: string, fresh = false): Promise<ControlResult> {
  if (!execOn()) return { ok: false, detail: "실행 OFF(APPROVAL_EXECUTION_ENABLED≠1) — 팀장 인가 필요" };
  if (isAgentOff(agentId)) return { ok: false, detail: `${agentId} 는 정지(off) 상태 — 재시작 말고 🟢 기동을 쓰세요` };
  const uid = process.getuid?.() ?? 0;
  try {
    if (runtime === "claude_channel" && readMemberChannel(agentId).kind === "b3chat") {
      const stopped = await setCodex(agentId, false, true);
      return stopped.ok ? await setCodex(agentId, true, true) : stopped;
    }
    if (runtime === "claude_channel") {
      // fresh=새 세션(컨텍스트 비움, --fresh) / 기본=컨텍스트 유지(--resume). 둘 다 최신 CLAUDE.md 로드.
      const flag = fresh ? "--fresh" : "--resume";
      const mode = fresh ? "--fresh · 새 세션(컨텍스트 비움)+새 CLAUDE.md" : "--resume · 새 CLAUDE.md 로드+컨텍스트 유지";

      // 공개 설치에는 scripts/restart-agent.sh가 없을 수 있어 저장소 안의 기동 스크립트로 폴백한다.
      const opsScript = `${REPO_ROOT}/scripts/restart-agent.sh`;
      if (existsSync(opsScript)) {
        const r = await run(["bash", opsScript, agentId, flag]);
        if (r.code !== 0) return { ok: false, detail: `재시작 실패: ${r.out.slice(-150)}` };
        return withPollerRecovery(agentId, `claude ${agentId} 재시작(${mode})`);
      }

      // 복구 스크립트가 없으면 종료 뒤 되살릴 수 없으므로 기동 수단을 먼저 확인한다.
      const starter = `${REPO_ROOT}/src/server/runtimes/claude/start-telegram-channel.sh`;
      if (!existsSync(starter)) {
        return { ok: false, detail: `재시작 불가 — 기동 스크립트가 없습니다(세션은 그대로 둡니다): ${starter}` };
      }
      // 기동 수단이 확보된 뒤에야 기존 세션을 정리한다. start-telegram-channel.sh 는 --resume 지원(없으면 새 세션).
      try { await run(["tmux", "kill-session", "-t", `claude-${agentId}`]); } catch { /* 없으면 그만 */ }
      // kill 실패·경합 시에도 재기동하도록 --force를 전달한다. 없으면 기존 세션 감지가 poller 복구를 no-op으로 끝낼 수 있다.
      const args = fresh ? [agentId, "--force"] : [agentId, "--resume", "--force"];
      const r = await run(["bash", starter, ...args]);
      if (r.code !== 0) return { ok: false, detail: `재시작 실패: ${r.out.slice(-150)}` };
      return withPollerRecovery(agentId, `claude ${agentId} 재시작(${mode})`);
    }
    // openclaw/hermes 는 게이트웨이 in-place 재시작이라 '새 세션' 개념이 claude 처럼 없음 — fresh 무시.
    if (runtime === "openclaw") {
      const r = await run(["launchctl", "kickstart", "-k", `gui/${uid}/${OPENCLAW_LABEL}`]);
      return { ok: r.code === 0, detail: r.code === 0 ? `openclaw 게이트웨이 재시작(${agentId} 등 새 IDENTITY/AGENTS 로드 · 다른 openclaw 1~2분 깜빡 · 정지된 forin 은 그대로 off)` : `재시작 실패: ${r.out.slice(-150)}` };
    }
    if (runtime === "hermes_agent") {
      // 프로필별 게이트웨이 타겟(profile≠id인 기존 멤버 포함).
      const agent = ambientAgents().find((a) => a.id === agentId);
      const label = agent?.gateway_service ?? `ai.hermes.gateway-${agent?.hermes_profile ?? agentId}`;
      const r = await run(["launchctl", "kickstart", "-k", `gui/${uid}/${label}`]);
      return { ok: r.code === 0, detail: r.code === 0 ? `hermes ${agentId} 재시작(게이트웨이 in-place: ${label})` : `재시작 실패: ${r.out.slice(-150)}` };
    }
    if (runtime === "codex") {
      // codex는 매 wake마다 AGENTS.md를 읽지만 SOUL.md는 자동 로드하지 않는다. 재시작 전 로딩파일을 재렌더해야 변경된 페르소나가 반영된다.
      const label = codexBridgeLaunchdLabel(agentId);
      const r = await run(["launchctl", "kickstart", "-k", `gui/${uid}/${label}`]);
      return { ok: r.code === 0, detail: r.code === 0 ? `codex ${agentId} 브리지 재기동(다음 턴부터 현재 AGENTS.md 로 돈다)` : `브리지 재기동 실패(미기동이었을 수 있음): ${r.out.slice(-120)}` };
    }
    return { ok: false, detail: `지원 안 하는 런타임: ${runtime}` };
  } catch (e) { return { ok: false, detail: `실행 오류: ${(e as Error).message}` }; }
}

/**
 * 전체 재시작 — 모든 팀원(멤버) 재시작. off 팀원만 건너뛴다(기동은 🟢). **bill 포함** — 단 가장 마지막에
 * 재시작해서 이 대화 세션 깜빡(~15s, --resume 컨텍스트 유지)을 맨 끝으로 미룬다. 실행 주체는 서버라 bill
 * 재시작이 이 작업 자체를 끊지 않는다. openclaw 는 게이트웨이 1개 공유 → 1회만 kickstart(나머지는 '포함').
 * collab 서버·b3rys-dev 같은 인프라는 건드리지 않는다.
 */
type ControlMember = { id: string; runtime: string; capabilities?: string[] };
// 코디네이터는 전체 정지에서 제외하고 마지막에 재시작해 복구 담당을 유지한다.
const isCoordinator = (m: ControlMember): boolean => (m.capabilities ?? []).includes(COORDINATOR_CAPABILITY);

/** 재시작 순서를 가른다 — 코디는 맨 마지막. 이 대화 세션이 잠깐 끊기므로 끝으로 미룬다.
 *  순서가 뒤집히면 복구할 사람이 먼저 죽는다. 그래서 순서를 따로 잴 수 있게 함수로 뺀다. */
export function partitionForRestart<T extends ControlMember>(members: readonly T[]): { others: T[]; coordinators: T[] } {
  const others: T[] = [];
  const coordinators: T[] = [];
  for (const m of members) (isCoordinator(m) ? coordinators : others).push(m);
  return { others, coordinators };
}

export async function restartAll(members: ControlMember[]): Promise<Array<{ id: string; ok: boolean; detail: string }>> {
  if (!execOn()) return [{ id: "*", ok: false, detail: "실행 OFF(APPROVAL_EXECUTION_ENABLED≠1) — 팀장 인가 필요" }];
  const out: Array<{ id: string; ok: boolean; detail: string }> = [];
  let openclawDone = false;
  // 코디네이터는 맨 마지막에 재시작 — 이 대화 세션 깜빡(~15s)을 끝으로 미룬다.
  const { others, coordinators } = partitionForRestart(members);
  for (const m of others) {
    if (isAgentOff(m.id)) { out.push({ id: m.id, ok: true, detail: "건너뜀(정지 중 — 🟢 기동으로 켜세요)" }); continue; }
    if (m.runtime === "openclaw") {
      if (openclawDone) { out.push({ id: m.id, ok: true, detail: "openclaw 게이트웨이 일괄 재시작에 포함" }); continue; }
      const r = await restartAgent(m.id, m.runtime); openclawDone = true;
      out.push({ id: m.id, ok: r.ok, detail: r.detail }); continue;
    }
    const r = await restartAgent(m.id, m.runtime);
    out.push({ id: m.id, ok: r.ok, detail: r.detail });
  }
  // 코디는 맨 마지막(--resume 이라 이 대화 컨텍스트 유지하고 ~15s 후 복귀).
  for (const m of coordinators) {
    if (isAgentOff(m.id)) { out.push({ id: m.id, ok: true, detail: "건너뜀(정지 중)" }); }
    else { const r = await restartAgent(m.id, m.runtime); out.push({ id: m.id, ok: r.ok, detail: r.detail + " ← 맨 마지막(이 대화 ~15s 깜빡 후 복귀)" }); }
  }
  return out;
}

/**
 * 비상 전체 정지 (서킷브레이커) — 코디네이터·이미 off 는 제외하고 전원 정지.
 * 폭주·이상 시 GD 가 대시보드 빨강 버튼(더블컨펌)으로 즉시 호출. openclaw 는 각 계정 disable +
 * 게이트웨이 restart(stop 아님 → auto-heal 무관)라 멤버 수만큼 게이트웨이가 깜빡일 수 있다(비상이라 허용).
 */
// kept는 복구 담당으로 남겨 둔 멤버다. UI가 특정 ID로 제외 대상을 추측하지 않도록 서버가 표시한다.
export type StopResult = { id: string; ok: boolean; detail: string; kept?: boolean };

export async function stopAll(members: ControlMember[]): Promise<StopResult[]> {
  if (!execOn()) return [{ id: "*", ok: false, detail: "실행 OFF(APPROVAL_EXECUTION_ENABLED≠1) — 팀장 인가 필요" }];
  const out: StopResult[] = [];
  for (const m of members) {
    if (isCoordinator(m)) { out.push({ id: m.id, ok: true, detail: "제외(코디네이터 — 끄려면 개별 정지)", kept: true }); continue; }
    if (isAgentOff(m.id)) { out.push({ id: m.id, ok: true, detail: "이미 정지" }); continue; }
    const r = await setAgentEnabled(m.id, m.runtime, false);
    out.push({ id: m.id, ok: r.ok, detail: r.detail });
  }
  return out;
}
