// 팀원 onoff 서킷브레이커 — 서버 executor 가 런타임별로 에이전트를 정지/기동(터미널 0).
// 비상 시 GD 가 팀방 /onoff 탭으로 폭주 팀원을 즉시 끈다(2026-06-11 forin 자율-폭주 인시던트 대응).
//
// 보안: self-mod 실행 → APPROVAL_EXECUTION_ENABLED=1(팀장 터미널-직접 무장) + GD 인증 탭에서만 호출.
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

/** 퇴사/재영입 시 off-list에서 제거 — 안 지우면 재영입 agent가 게이트웨이는 떠도 버스에서 suppress됨(deleted≠off, 하네스 #1 systemic breaker. openclaw/hermes 재영입 실패 근본). */
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

/** hermes 게이트웨이 LaunchAgent 라벨. ★기동·정지가 반드시 같은 값을 써야 한다★ —
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
    // ★정지가 bootout 한 LaunchAgent 를 되돌린다★ — 이게 없어서 기동/정지가 비대칭이었다.
    //   'hermes gateway start' 는 게이트웨이 프로세스를 띄우지만 ★launchd 관리 밖★ 이라
    //   ①KeepAlive 보호 없음 ②재부팅 후 안 올라옴 ③상태 판정이 라벨을 보므로 계속 offline 이다.
    //   (2026-07-26 맥스튜디오 실측: 비상정지 뒤 대시보드 '기동' 으로 hermes 를 살릴 수 없었다.
    //    응답은 ok 인데 launchctl list 에 라벨이 없었다 — 즉 ok 가 복구를 뜻하지 않았다.)
    //   ★start 와 bootstrap 을 같이 부르면 안 된다★ — 게이트웨이가 2개 떠서 텔레그램 폴링이
    //   충돌한다(같은 날 수동 복구 중 실제로 재현). plist 가 있으면 bootstrap 으로 일원화한다.
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
const OPENCLAW_LABEL = "ai.openclaw.gateway";

/**
 * ★재시작 뒤 텔레그램 poller 가 실제로 붙었는지 확인하고, 안 붙었으면 자동 복구한다.★
 *
 * 이게 없어서 ★재시작 후 안 붙으면 아무도 안 고쳤다★(2026-07-27 GD 지적). 프로세스는 살아 있고
 * 대시보드도 정상으로 보이는데 메시지만 안 들어온다 — 오류가 없으니 사람이 눈치챌 때까지 방치된다.
 * 영입(activation)에는 같은 복구가 이미 있었다. ★한쪽에만 있는 안전장치는 없는 것과 같다.★
 *
 * 복구에 실패해도 ★재시작 자체는 성공★ 으로 보고한다(프로세스는 떴다). 대신 detail 에 미기동을
 * 명시해 사람이 볼 수 있게 한다 — 조용히 성공이라고 말하지 않는 것이 이 수정의 핵심이다.
 */
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
        if (r.code !== 0) return { ok: false, detail: `재시작 실패: ${r.out.slice(-150)}` };
        return withPollerRecovery(agentId, `claude ${agentId} 재시작(${mode})`);
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
      // ★--force 를 항상 실어 보낸다★ — 위 kill 이 실패/경합하면(세션은 살아있고 poller 만 죽은 상태가 바로 그 케이스)
      //   기동 스크립트의 idempotent 가드가 'Session already running' 으로 no-op 이 되어 ★재시작이 조용히 안 된다★.
      //   2026-07-30 실측: launchctl kickstart 로 스크립트를 다시 돌렸더니 정확히 이 no-op 에 걸려 리사가 계속 죽어 있었다.
      //   --force 는 스크립트 안에서 kill 후 기동을 보장하므로 kill 성공 여부와 무관하게 복구가 성립한다(멱등).
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
      // codex 두뇌는 매 wake마다 cwd AGENTS.md 를 새로 읽는다(stateless) — 브리지 프로세스만 kickstart 하면 된다.
      // ★단 "페르소나 갱신은 자동" 이 아니다★ — codex 는 SOUL.md 를 안 읽고, 렌더가 AGENTS.md 에 박아둔
      //   본문을 읽는다. SOUL.md 만 고치면 재렌더 전까지 옛 페르소나로 돈다. 그래서 대시보드 재시작
      //   엔드포인트가 restartAgent 전에 refreshLoadingFiles 로 되맞춘다(routes/settings.ts, 2026-08-20).
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
/** 코디네이터인가. ★`stop_all` 제외 + 맨 마지막 재시작★ 두 가지가 이 하나에 걸려 있다.
 *
 *  ★예전에는 `recovery` 라는 별도 능력이었다.★ 둘로 나눠서 얻는 게 없었고(팀장이 코디를 다시
 *  임명하면 된다), ★나뉘어 있는 동안 화면이 "코디네이터 유지" 라고 말하면서 실제로는 recovery 를
 *  거르는 어긋남★ 이 있었다. 더 나쁜 것은 ★새로 설치한 팀에는 `recovery` 보유자가 아예 없어서★
 *  (`LEAD_CAPABILITIES` 는 `coordinator`·`full_context` 만 준다) ★코디가 보호받지 못했다는 점★ 이다. */
const isCoordinator = (m: ControlMember): boolean => (m.capabilities ?? []).includes(COORDINATOR_CAPABILITY);

/** 재시작 순서를 가른다 — ★코디는 맨 마지막.★ 이 대화 세션이 잠깐 끊기므로 끝으로 미룬다.
 *  ★순서가 뒤집히면 복구할 사람이 먼저 죽는다.★ 그래서 순서를 ★따로 잴 수 있게★ 함수로 뺀다. */
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
    // stagger/mutex 없음(2026-07-25): 버전락 경합은 red herring 이었다(NON-FATAL, MCP 스폰 미차단). 재시작은
    //   플러그인 캐시가 이미 warm 이라 세션 install 이 순삭 → MCP 가 30s 핸드셰이크 안에 붙는다. 콜드 install 대비는
    //   start-telegram-channel.sh 의 pre-warm 이 담당. 별도 부팅 직렬화 불필요.
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
/** 정지 결과 한 줄. `kept` = 정지 대상에서 ★일부러 제외★ 된 멤버(복구 코디).
 *  ★화면이 이름으로 다시 추측하지 않게 서버가 표시한다.★ 예전에는 UI 가 `id !== "bill"` 로 걸렀는데,
 *  그러면 코디네이터가 바뀌거나 ★그런 이름이 아예 없는 설치(공개)★ 에서 틀린다. */
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
