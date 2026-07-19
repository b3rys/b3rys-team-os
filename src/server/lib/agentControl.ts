// 팀원 onoff 서킷브레이커 — 서버 executor 가 런타임별로 에이전트를 정지/기동(터미널 0).
//   비상 시 OWNER 가 팀방 /onoff 탭으로 폭주 팀원을 즉시 끈다(2026-06-11 forin 자율-폭주 인시던트 대응).
//
// 보안: self-mod 실행 → APPROVAL_EXECUTION_ENABLED=1(팀장 터미널-직접 무장) + OWNER 인증 탭에서만 호출.
//
// ★ 핵심 설계 (인시던트 교훈):
//   - openclaw off = 계정 enabled=false + 게이트웨이 'restart'(stop 아님). 게이트웨이는 떠 있어
//     auto-heal 이 안 건드린다(auto-heal 은 게이트웨이 PID만 보지 개별 에이전트는 안 봄). 'gateway stop'
//     했더니 auto-heal 이 게이트웨이를 되살려 forin 이 부활한 게 인시던트의 2차 원인.
//   - claude off = 봇 LaunchAgent bootout. 단 auto-heal(bot-liveness-monitor)이 죽은 봇을 team-os up 으로
//     되살리므로, **var/agent-off.txt(의도적 off 명단)** 를 같이 기록하고 monitor 가 이를 존중(skip)해야 한다.
//   - hermes off = 프로필 게이트웨이 stop.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { codexBridgeLaunchdLabel, writeCodexBridgeFiles } from "../runtimes/codex/launcher";
import { REPO_ROOT } from "./personaTemplates";
import { ambientAgents } from "./registry";

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

/** 퇴사/재영입 시 off-list에서 제거 — 안 지우면 재영입 agent가 게이트웨이는 떠도 버스에서 suppress됨(deleted≠off, 하네스 #1 systemic breaker. openclaw/hermes 재영입 실패 근본). OWNER 2026-07-01. */
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
  // detached tmux 봇 종료(claude-<id>) — bootout(KeepAlive=false 잡 언로드)만으론 실행 중 tmux 세션이 안 죽어 고아가 됨(하네스 #4). 인라인(순환 import 회피).
  try { await run(["tmux", "kill-session", "-t", `claude-${id}`]); } catch { /* best-effort */ }
  const r = await run(["launchctl", "bootout", `gui/${uid}/${label}`]);
  return { ok: r.code === 0, detail: r.code === 0 ? `claude ${id} 정지(봇 tmux kill + LaunchAgent bootout)` : `정지 실패: ${r.out.slice(-150)}` };
}

/** hermes 에이전트: 프로필 게이트웨이 stop/start. */
async function setHermes(id: string, enabled: boolean): Promise<ControlResult> {
  // 프로필 = agent.hermes_profile ?? id (restartAgent와 동일) — HERMES_PROFILE=id 하드코딩이면 프로필≠id(기존 hermes=b3ryshermes)일 때 on/off가 엉뚱한 프로필을 건드림(Codex 크로스리뷰 지적). OWNER 2026-07-01.
  const agent = ambientAgents().find((a) => a.id === id);
  const profile = agent?.hermes_profile ?? id;
  if (enabled) {
    const r = await run(["hermes", "gateway", "start"], { HERMES_PROFILE: profile });
    return { ok: r.code === 0, detail: r.code === 0 ? `hermes ${id} 기동(프로필 ${profile})` : `기동 실패: ${r.out.slice(-150)}` };
  }
  // 정지: 게이트웨이 stop + LaunchAgent bootout. bootout 안 하면 KeepAlive LaunchAgent가 게이트웨이를 되살려 '퇴사해도 계속 응답'(OWNER 2026-07-01 mes 실측 버그). 프로필별 라벨 타겟.
  const stopR = await run(["hermes", "gateway", "stop"], { HERMES_PROFILE: profile });
  const uid = process.getuid?.() ?? 0;
  await run(["launchctl", "bootout", `gui/${uid}/ai.hermes.gateway-${profile}`]);
  return { ok: true, detail: `hermes ${id} 정지(게이트웨이 stop + LaunchAgent bootout, 프로필 ${profile})${stopR.code !== 0 ? " [stop 경고]" : ""}` };
}

/** codex 런타임: ①버스 어댑터(in-process)는 off 명단(markOff)+adapter isAgentOff로 차단 ②per-member 텔레그램 브리지는
 *  LaunchAgent bootstrap/bootout. off 명단도 같이 기록돼 auto-heal이 안 되살림(claude 패턴 동일). */
async function setCodex(id: string, enabled: boolean): Promise<ControlResult> {
  const uid = process.getuid?.() ?? 0;
  const label = codexBridgeLaunchdLabel(id);
  if (enabled) {
    const p = writeCodexBridgeFiles(id); // wrapper+plist 보장(idempotent). 토큰은 활성화 단계서 별도 배치.
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
export async function setAgentEnabled(agentId: string, runtime: string, enabled: boolean): Promise<ControlResult> {
  if (!execOn()) return { ok: false, detail: "실행 OFF(APPROVAL_EXECUTION_ENABLED≠1) — 팀장 인가 필요" };
  // off 는 명단 먼저 기록(실행 중 auto-heal 이 끼어들어 되살리는 레이스 방지). on 은 실행 후 해제.
  if (!enabled) markOff(agentId, true);
  let res: ControlResult;
  try {
    if (runtime === "openclaw") res = await setOpenclaw(agentId, enabled);
    else if (runtime === "claude_channel") res = await setClaude(agentId, enabled);
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
const HERMES_LABEL = "ai.hermes.gateway-b3ryshermes";
const OPENCLAW_LABEL = "ai.openclaw.gateway";

/** 팀원 1명 재시작. off 상태는 거부(기동은 🟢). bill 도 가능 — claude_channel 이라 --resume(컨텍스트 유지)이고,
 *  재시작 실행 주체는 team-collab 서버(executor)지 bill 세션이 아니라서 bill 재시작이 작업을 끊지 않는다. */
export async function restartAgent(agentId: string, runtime: string, fresh = false): Promise<ControlResult> {
  if (!execOn()) return { ok: false, detail: "실행 OFF(APPROVAL_EXECUTION_ENABLED≠1) — 팀장 인가 필요" };
  if (isAgentOff(agentId)) return { ok: false, detail: `${agentId} 는 정지(off) 상태 — 재시작 말고 🟢 기동을 쓰세요` };
  const uid = process.getuid?.() ?? 0;
  try {
    if (runtime === "claude_channel") {
      // fresh=새 세션(컨텍스트 비움, --fresh) / 기본=컨텍스트 유지(--resume). 둘 다 최신 CLAUDE.md 로드.
      const flag = fresh ? "--fresh" : "--resume";
      const mode = fresh ? "--fresh · 새 세션(컨텍스트 비움)+새 CLAUDE.md" : "--resume · 새 CLAUDE.md 로드+컨텍스트 유지";

      // ★공개 클론에서 조용히 실패하던 지점★ — 공개 릴리즈는 /scripts/ 를 제외하는데(make-public-release.sh)
      // 여기서 scripts/restart-agent.sh 를 호출했다. 주력 런타임(claude_channel)의 "멤버 재시작" 버튼이
      // 공개 설치본에서 늘 실패했다는 뜻이다. → 스크립트가 있으면 쓰고(내부: recall 주입 등 부가기능 포함),
      // 없으면 repo 안에 vendoring 된 기동 스크립트로 직접 재시작한다(공개 설치본에서도 실제로 동작).
      const opsScript = `${REPO_ROOT}/scripts/restart-agent.sh`;
      if (existsSync(opsScript)) {
        const r = await run(["bash", opsScript, agentId, flag]);
        return { ok: r.code === 0, detail: r.code === 0 ? `claude ${agentId} 재시작(${mode})` : `재시작 실패: ${r.out.slice(-150)}` };
      }

      // vendoring 경로(공개 설치본): repo 내 기동 스크립트로 재기동.
      // ★기동 수단을 먼저 확인하고 나서 죽인다★ — 순서가 뒤집히면(먼저 kill → 기동 스크립트 없음)
      // 멀쩡히 돌던 멤버를 죽여놓고 못 살린다. '재시작 실패'보다 나쁜 '멤버 영구 다운'이 된다.
      // 되살릴 수 없으면 아무것도 건드리지 않는다. (Bill 리뷰 blocker, 2026-07-12)
      const starter = `${REPO_ROOT}/src/server/runtimes/claude/start-telegram-channel.sh`;
      if (!existsSync(starter)) {
        return { ok: false, detail: `재시작 불가 — 기동 스크립트가 없습니다(세션은 그대로 둡니다): ${starter}` };
      }
      // 기동 수단이 확보된 뒤에야 기존 세션을 정리한다. start-telegram-channel.sh 는 --resume 지원(없으면 새 세션).
      try { await run(["tmux", "kill-session", "-t", `claude-${agentId}`]); } catch { /* 없으면 그만 */ }
      const args = fresh ? [agentId] : [agentId, "--resume"];
      const r = await run(["bash", starter, ...args]);
      return { ok: r.code === 0, detail: r.code === 0 ? `claude ${agentId} 재시작(${mode})` : `재시작 실패: ${r.out.slice(-150)}` };
    }
    // openclaw/hermes 는 게이트웨이 in-place 재시작이라 '새 세션' 개념이 claude 처럼 없음 — fresh 무시.
    if (runtime === "openclaw") {
      const r = await run(["launchctl", "kickstart", "-k", `gui/${uid}/${OPENCLAW_LABEL}`]);
      return { ok: r.code === 0, detail: r.code === 0 ? `openclaw 게이트웨이 재시작(${agentId} 등 새 IDENTITY/AGENTS 로드 · 다른 openclaw 1~2분 깜빡 · 정지된 forin 은 그대로 off)` : `재시작 실패: ${r.out.slice(-150)}` };
    }
    if (runtime === "hermes_agent") {
      // 프로필별 게이트웨이 타겟(기존 hermes=b3ryshermes, 신규 영입=id) — HERMES_LABEL 하드코딩이면 신규 hermes 재시작 불가였음(하네스). OWNER 2026-07-01.
      const agent = ambientAgents().find((a) => a.id === agentId);
      const label = agent?.gateway_service ?? `ai.hermes.gateway-${agent?.hermes_profile ?? agentId}`;
      const r = await run(["launchctl", "kickstart", "-k", `gui/${uid}/${label}`]);
      return { ok: r.code === 0, detail: r.code === 0 ? `hermes ${agentId} 재시작(게이트웨이 in-place: ${label})` : `재시작 실패: ${r.out.slice(-150)}` };
    }
    if (runtime === "codex") {
      // codex 두뇌는 매 wake마다 cwd AGENTS.md 새로 로드(stateless) — 페르소나 갱신은 자동. 브리지 프로세스만 kickstart.
      const label = codexBridgeLaunchdLabel(agentId);
      const r = await run(["launchctl", "kickstart", "-k", `gui/${uid}/${label}`]);
      return { ok: r.code === 0, detail: r.code === 0 ? `codex ${agentId} 브리지 재기동(두뇌는 매 턴 cwd 페르소나 자동 재로드)` : `브리지 재기동 실패(미기동이었을 수 있음): ${r.out.slice(-120)}` };
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
const isRecovery = (m: ControlMember): boolean => (m.capabilities ?? []).includes("recovery");

export async function restartAll(members: ControlMember[]): Promise<Array<{ id: string; ok: boolean; detail: string }>> {
  if (!execOn()) return [{ id: "*", ok: false, detail: "실행 OFF(APPROVAL_EXECUTION_ENABLED≠1) — 팀장 인가 필요" }];
  const out: Array<{ id: string; ok: boolean; detail: string }> = [];
  let openclawDone = false;
  // recovery capability 팀원(복구 코디)은 맨 마지막에 재시작 — 이 대화 세션 깜빡(~15s)을 끝으로 미룬다.
  const recoveryMembers: ControlMember[] = [];
  for (const m of members) {
    if (isRecovery(m)) { recoveryMembers.push(m); continue; }
    if (isAgentOff(m.id)) { out.push({ id: m.id, ok: true, detail: "건너뜀(정지 중 — 🟢 기동으로 켜세요)" }); continue; }
    if (m.runtime === "openclaw") {
      if (openclawDone) { out.push({ id: m.id, ok: true, detail: "openclaw 게이트웨이 일괄 재시작에 포함" }); continue; }
      const r = await restartAgent(m.id, m.runtime); openclawDone = true;
      out.push({ id: m.id, ok: r.ok, detail: r.detail }); continue;
    }
    const r = await restartAgent(m.id, m.runtime);
    out.push({ id: m.id, ok: r.ok, detail: r.detail });
  }
  // 복구 코디는 맨 마지막(--resume 이라 이 대화 컨텍스트 유지하고 ~15s 후 복귀).
  for (const m of recoveryMembers) {
    if (isAgentOff(m.id)) { out.push({ id: m.id, ok: true, detail: "건너뜀(정지 중)" }); }
    else { const r = await restartAgent(m.id, m.runtime); out.push({ id: m.id, ok: r.ok, detail: r.detail + " ← 맨 마지막(이 대화 ~15s 깜빡 후 복귀)" }); }
  }
  return out;
}

/**
 * 비상 전체 정지 (서킷브레이커) — bill(복구 코디용)·이미 off 는 제외하고 전원 정지.
 * 폭주·이상 시 OWNER 가 대시보드 빨강 버튼(더블컨펌)으로 즉시 호출. openclaw 는 각 계정 disable +
 * 게이트웨이 restart(stop 아님 → auto-heal 무관)라 멤버 수만큼 게이트웨이가 깜빡일 수 있다(비상이라 허용).
 */
export async function stopAll(members: ControlMember[]): Promise<Array<{ id: string; ok: boolean; detail: string }>> {
  if (!execOn()) return [{ id: "*", ok: false, detail: "실행 OFF(APPROVAL_EXECUTION_ENABLED≠1) — 팀장 인가 필요" }];
  const out: Array<{ id: string; ok: boolean; detail: string }> = [];
  for (const m of members) {
    if (isRecovery(m)) { out.push({ id: m.id, ok: true, detail: "제외(복구 코디용 — 끄려면 개별 정지)" }); continue; }
    if (isAgentOff(m.id)) { out.push({ id: m.id, ok: true, detail: "이미 정지" }); continue; }
    const r = await setAgentEnabled(m.id, m.runtime, false);
    out.push({ id: m.id, ok: r.ok, detail: r.detail });
  }
  return out;
}
