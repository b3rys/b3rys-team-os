// 팀원 모델 전환 — 런타임별로 "지금 무엇을 쓰나 · 새 모델이 실제로 되나 · 바꾸고 확인하고 안 되면 되돌린다".
//
// 왜: 새 프론티어 모델이 나올 때마다 런타임(hermes · codex · openclaw)별로 설정 파일 위치·모양·재시작 방법·
// 확인 방법이 달라 사람이 손으로 했다. 이 모듈이 그 절차를 한 곳에 둔다.
//
// 원칙
//   · 기본은 미리보기(dry-run). 실제로 바꾸는 것은 apply 에 yes=true 를 줄 때만.
//   · 한 팀원씩: 백업 → 설정 한 줄 → 그 팀원만 재시작 → 실제 응답 모델 확인 → 실패하면 백업 복원 + 재시작.
//   · "목록에 있다" 와 "쓸 수 있다" 를 가른다. check 는 실제 호출(hermes·codex) 또는 런타임 자신의 판정(openclaw)을 본다.
//   · 인증·한도 실패는 "지원 안 됨" 이 아니라 "확인 불가" 로 보고한다.
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

export type Runtime = "hermes_agent" | "codex" | "openclaw";

export interface RunResult { code: number; stdout: string; stderr: string }
export type Runner = (cmd: string[], opts?: { env?: Record<string, string>; timeoutMs?: number; cwd?: string }) => Promise<RunResult>;

export interface Member {
  id: string;
  runtime: Runtime;
  /** 설정 파일 경로(hermes config.yaml · codex config.toml · openclaw openclaw.json) */
  configPath: string;
  /** 재시작 단위(launchd 라벨). openclaw 는 게이트웨이 하나를 모두가 쓴다. */
  serviceLabel: string;
  /** hermes 프로필 이름 · codex CODEX_HOME · openclaw agent id */
  handle: string;
  /** hermes 는 provider 도 같이 넘겨야 one-shot 이 된다 */
  provider?: string;
}

export interface CurrentModel { model: string | null; effort: string | null }

export interface Env {
  home: string;
  uid: number;
  launchdPrefix: string;
  codexBin: string;
  hermesPython: string;
  openclawBin: string;
}

export function defaultEnv(env: Record<string, string | undefined> = process.env): Env {
  const home = env.HOME ?? homedir();
  return {
    home,
    uid: process.getuid?.() ?? 501,
    launchdPrefix: (env.TEAMOS_LAUNCHD_PREFIX?.trim() || `com.${env.USER?.trim() || "local"}`).replace(/\.$/, ""),
    codexBin: env.CODEX_BIN ?? "codex",
    hermesPython: env.HERMES_PYTHON ?? join(home, ".hermes/hermes-agent/venv/bin/python"),
    openclawBin: env.OPENCLAW_BIN ?? "openclaw",
  };
}

// ─── 설정 읽기·쓰기 (순수 함수 — 테스트 대상) ───────────────────────────────────────

/** YAML 의 최상위 블록(`name:`) 안에서 `key:` 줄을 찾는다. 들여쓰기 1단계만 본다. */
function yamlBlockRange(lines: string[], block: string): [number, number] | null {
  const start = lines.findIndex((l) => l === `${block}:` || l.startsWith(`${block}: `) && l.trim() === `${block}:`);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (lines[end]!.startsWith(" ") || lines[end]!.trim() === "")) end++;
  return [start, end];
}

export function yamlGet(text: string, block: string, key: string): string | null {
  const lines = text.split("\n");
  const r = yamlBlockRange(lines, block);
  if (!r) return null;
  for (let i = r[0] + 1; i < r[1]; i++) {
    const m = /^ {2}([A-Za-z_]+):\s*(.*)$/.exec(lines[i]!);
    if (m && m[1] === key) return m[2]!.trim().replace(/^["']|["']$/g, "") || null;
  }
  return null;
}

/** 블록 안 key 줄의 값만 바꾼다. 줄이 없으면 null(새로 끼워 넣지 않는다 — 모양이 다르면 손으로). */
export function yamlSet(text: string, block: string, key: string, value: string): string | null {
  const lines = text.split("\n");
  const r = yamlBlockRange(lines, block);
  if (!r) return null;
  for (let i = r[0] + 1; i < r[1]; i++) {
    const m = /^( {2})([A-Za-z_]+):\s*(.*)$/.exec(lines[i]!);
    if (m && m[2] === key) {
      lines[i] = `${m[1]}${key}: ${value}`;
      return lines.join("\n");
    }
  }
  return null;
}

/** TOML 최상위(첫 [표] 앞) `key = "value"` 읽기. */
export function tomlTopGet(text: string, key: string): string | null {
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const m = /^([A-Za-z_]+)\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (m && m[1] === key) return m[2]!;
  }
  return null;
}

export function tomlTopSet(text: string, key: string, value: string): string | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) break;
    const m = /^([A-Za-z_]+)\s*=/.exec(lines[i]!);
    if (m && m[1] === key) {
      lines[i] = `${key} = "${value}"`;
      return lines.join("\n");
    }
  }
  return null;
}

export function readCurrent(member: Member, text: string): CurrentModel {
  if (member.runtime === "hermes_agent") {
    return { model: yamlGet(text, "model", "default"), effort: yamlGet(text, "agent", "reasoning_effort") };
  }
  if (member.runtime === "codex") {
    return { model: tomlTopGet(text, "model"), effort: tomlTopGet(text, "model_reasoning_effort") };
  }
  const cfg = JSON.parse(text) as { agents?: { defaults?: { model?: unknown }; entries?: Record<string, { model?: unknown; thinkingDefault?: string }> } };
  const entry = cfg.agents?.entries?.[member.handle];
  const raw = entry?.model ?? cfg.agents?.defaults?.model;
  const model = typeof raw === "string" ? raw : (raw as { primary?: string } | undefined)?.primary ?? null;
  return { model: model ? model.replace(/^openai\//, "") : null, effort: entry?.thinkingDefault ?? null };
}

/** 새 설정 글을 만든다. 모양이 예상과 다르면 null — 그 팀원은 건너뛰고 사람에게 넘긴다. */
export function writeModel(member: Member, text: string, model: string, effort: string | null): string | null {
  if (member.runtime === "hermes_agent") {
    let out = yamlSet(text, "model", "default", model);
    if (out && effort) out = yamlSet(out, "agent", "reasoning_effort", effort);
    return out;
  }
  if (member.runtime === "codex") {
    let out = tomlTopSet(text, "model", model);
    if (out && effort) out = tomlTopSet(out, "model_reasoning_effort", effort);
    return out;
  }
  // openclaw 는 파일을 직접 고치지 않는다 — 자기 CLI(`config set`)로 검증된 쓰기를 한다(applyMember 참고).
  return null;
}

// ─── 팀원 목록 ─────────────────────────────────────────────────────────────────────

interface RegistryAgent { id: string; runtime?: string; hermes_profile?: string; gateway_service?: string; enabled?: boolean }

export function listMembers(registryPath: string, env: Env): Member[] {
  const raw = JSON.parse(readFileSync(registryPath, "utf-8")) as RegistryAgent[] | { agents: RegistryAgent[] };
  const agents = Array.isArray(raw) ? raw : raw.agents ?? [];
  const out: Member[] = [];
  for (const a of agents) {
    if (a.enabled === false) continue;
    if (a.runtime === "hermes_agent") {
      const profile = a.hermes_profile ?? a.id;
      const configPath = join(env.home, ".hermes/profiles", profile, "config.yaml");
      let provider: string | undefined;
      try { provider = yamlGet(readFileSync(configPath, "utf-8"), "model", "provider") ?? undefined; } catch { /* 없으면 아래에서 미확인 */ }
      out.push({ id: a.id, runtime: "hermes_agent", configPath, handle: profile, provider, serviceLabel: a.gateway_service ?? `ai.hermes.gateway-${profile}` });
    } else if (a.runtime === "codex") {
      const codexHome = join(env.home, ".codex-agents", a.id);
      out.push({ id: a.id, runtime: "codex", configPath: join(codexHome, "config.toml"), handle: codexHome, serviceLabel: `${env.launchdPrefix}.codex-bridge-${a.id}` });
    }
  }
  // openclaw 팀원은 openclaw 자신의 설정에서 읽는다 — 팀 명단에 없는 openclaw 에이전트도 같은 게이트웨이를 쓴다.
  const ocPath = join(env.home, ".openclaw/openclaw.json");
  if (existsSync(ocPath)) {
    try {
      const cfg = JSON.parse(readFileSync(ocPath, "utf-8")) as { agents?: { entries?: Record<string, { model?: unknown }> } };
      for (const [id, entry] of Object.entries(cfg.agents?.entries ?? {})) {
        if (entry?.model == null) continue; // 모델을 따로 안 정한 에이전트는 기본값을 따른다 — 전환 대상 아님
        out.push({ id, runtime: "openclaw", configPath: ocPath, handle: id, serviceLabel: "ai.openclaw.gateway" });
      }
    } catch { /* 깨진 설정이면 openclaw 는 목록에서 뺀다 */ }
  }
  return out;
}

// ─── 확인(check) — 설정은 바꾸지 않는다 ─────────────────────────────────────────────

export type CheckVerdict = "works" | "not_supported" | "unknown";
export interface CheckResult { member: string; runtime: Runtime; verdict: CheckVerdict; actualModel: string | null; detail: string }

const PROBE_PROMPT = "Reply with exactly the word OK and nothing else.";

function newestSessionModel(codexHome: string, after: number): string | null {
  const root = join(codexHome, "sessions");
  let best: { path: string; mtime: number } | null = null;
  const walk = (dir: string) => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (e.endsWith(".jsonl") && st.mtimeMs >= after && (!best || st.mtimeMs > best.mtime)) best = { path: p, mtime: st.mtimeMs };
    }
  };
  walk(root);
  if (!best) return null;
  const m = /"model":"([^"]+)"/.exec(readFileSync((best as { path: string }).path, "utf-8"));
  return m ? m[1]! : null;
}

/** 실제 호출로 확인한다. override=null 이면 설정 파일의 기본값으로(적용 뒤 검증용). */
export async function checkMember(member: Member, target: { model: string | null; effort: string | null }, env: Env, run: Runner): Promise<CheckResult> {
  const base = { member: member.id, runtime: member.runtime };
  const bad = validateTarget(target);
  if (bad) return { ...base, verdict: "unknown", actualModel: null, detail: bad };
  if (member.runtime === "hermes_agent") {
    const dir = mkdtempSync(join(tmpdir(), "model-rollout-"));
    const usage = join(dir, "usage.json");
    const cmd = [env.hermesPython, "-m", "hermes_cli.main", "--profile", member.handle];
    if (target.model) cmd.push("--provider", member.provider ?? "openai-codex", "-m", target.model);
    cmd.push("-z", PROBE_PROMPT, "--usage-file", usage);
    const r = await run(cmd, { env: { HERMES_HOME: join(env.home, ".hermes/profiles", member.handle) }, timeoutMs: 150_000, cwd: dir });
    let u: { model?: string; completed?: boolean; failed?: boolean } = {};
    try { u = JSON.parse(readFileSync(usage, "utf-8")); } catch { /* 아래 판정 */ }
    if (u.completed && !u.failed && u.model) {
      const ok = !target.model || u.model === target.model;
      return { ...base, verdict: ok ? "works" : "not_supported", actualModel: u.model, detail: ok ? "one-shot 응답" : `요청 ${target.model} → 실제 ${u.model}` };
    }
    const why = classifyFailure(r);
    return { ...base, verdict: why === "모델을 모름" ? "not_supported" : "unknown", actualModel: u.model ?? null, detail: why };
  }
  if (member.runtime === "codex") {
    const dir = mkdtempSync(join(tmpdir(), "model-rollout-"));
    const before = Date.now() - 1000;
    const cmd = [env.codexBin, "exec", "--skip-git-repo-check", "--sandbox", "read-only"];
    if (target.model) cmd.push("-m", target.model);
    if (target.effort) cmd.push("-c", `model_reasoning_effort=${target.effort}`);
    cmd.push("--json", PROBE_PROMPT);
    const r = await run(cmd, { env: { CODEX_HOME: member.handle }, timeoutMs: 150_000, cwd: dir });
    const actual = newestSessionModel(member.handle, before);
    if (r.code === 0 && actual) {
      const ok = !target.model || actual === target.model;
      return { ...base, verdict: ok ? "works" : "not_supported", actualModel: actual, detail: ok ? "exec 응답(세션 기록)" : `요청 ${target.model} → 실제 ${actual}` };
    }
    const why = classifyFailure(r);
    return { ...base, verdict: why === "모델을 모름" ? "not_supported" : "unknown", actualModel: actual, detail: why };
  }
  // openclaw: 게이트웨이 자신의 판정(models list 의 available)을 본다. 목록에 없으면 설정으로는 못 연다.
  const r = await run([env.openclawBin, "models", "list", "--json"], { timeoutMs: 120_000 });
  if (r.code !== 0) return { ...base, verdict: "unknown", actualModel: null, detail: classifyFailure(r) };
  let items: Array<{ key?: string; available?: boolean | null }> = [];
  try {
    const d = JSON.parse(r.stdout) as unknown;
    items = Array.isArray(d) ? d as typeof items : ((d as { models?: typeof items }).models ?? []);
  } catch { return { ...base, verdict: "unknown", actualModel: null, detail: "models list 출력을 읽지 못함" }; }
  const want = target.model ? `openai/${target.model}` : null;
  if (!want) return { ...base, verdict: "unknown", actualModel: null, detail: "openclaw 는 모델을 지정해야 확인" };
  const hit = items.find((m) => m.key === want);
  if (hit?.available === true) return { ...base, verdict: "works", actualModel: target.model, detail: "게이트웨이 목록 available=true" };
  return { ...base, verdict: "not_supported", actualModel: null, detail: hit ? `게이트웨이 목록 available=${hit.available}` : "게이트웨이 목록에 없음(openclaw 버전이 모름)" };
}

/** 인증·한도·시간초과는 '지원 안 됨' 이 아니다. */
export function classifyFailure(r: RunResult): string {
  const text = `${r.stdout}\n${r.stderr}`;
  if (r.code === 142 || r.code === 124 || /timed? ?out/i.test(text)) return "시간 초과(미확인)";
  if (/quota|usage limit|rate limit|429/i.test(text)) return "한도(미확인)";
  if (/401|unauthori[sz]ed|token_invalidated|sign in|login/i.test(text)) return "인증(미확인)";
  if (/unknown model|model_not_found|does not exist|not supported/i.test(text)) return "모델을 모름";
  return `실패(exit ${r.code})`;
}

// ─── 입력 검사 — 설정 파일에 그대로 쓰이므로 줄바꿈·따옴표·옵션 이름이 들어오면 안 된다 ────────────
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const MODEL_RE = /^[A-Za-z0-9._:\/-]+$/;

/** 문제가 있으면 이유, 없으면 null. */
export function validateTarget(target: { model: string | null; effort: string | null }): string | null {
  if (target.model != null && (!MODEL_RE.test(target.model) || target.model.startsWith("-"))) return `모델 이름이 올바르지 않음: ${JSON.stringify(target.model)}`;
  if (target.effort != null && !(EFFORTS as readonly string[]).includes(target.effort)) return `effort 는 ${EFFORTS.join("·")} 중 하나: ${JSON.stringify(target.effort)}`;
  return null;
}

// ─── 적용(apply) ──────────────────────────────────────────────────────────────────

export interface ApplyStep { member: string; action: string; ok: boolean; detail: string }

/**
 * 한 팀원 전환. yes=false 면 무엇을 할지만 돌려준다.
 * openclaw 는 게이트웨이를 여럿이 쓰므로 재시작·검증은 호출자가 모아서 한 번 한다(applyAll).
 */
export async function applyMember(member: Member, target: { model: string; effort: string | null }, env: Env, run: Runner, yes: boolean, stamp: string): Promise<ApplyStep[]> {
  const steps: ApplyStep[] = [];
  const text = readFileSync(member.configPath, "utf-8");
  const cur = readCurrent(member, text);
  if (cur.model === target.model && (!target.effort || cur.effort === target.effort || member.runtime === "openclaw")) {
    return [{ member: member.id, action: "skip", ok: true, detail: `이미 ${target.model}` }];
  }
  if (member.runtime === "openclaw") {
    steps.push({ member: member.id, action: "plan", ok: true, detail: `${cur.model} → ${target.model} (openclaw config set agents.entries.${member.handle}.model)` });
    if (!yes) return steps;
    const r = await run([env.openclawBin, "config", "set", `agents.entries.${member.handle}.model`, `openai/${target.model}`], { timeoutMs: 60_000 });
    steps.push({ member: member.id, action: "config set", ok: r.code === 0, detail: r.code === 0 ? "ok" : classifyFailure(r) });
    return steps;
  }
  const next = writeModel(member, text, target.model, target.effort);
  if (next == null) return [{ member: member.id, action: "plan", ok: false, detail: "설정 모양이 예상과 달라 건너뜀 — 손으로" }];
  steps.push({ member: member.id, action: "plan", ok: true, detail: `${cur.model}/${cur.effort} → ${target.model}/${target.effort ?? cur.effort} · ${member.configPath}` });
  if (!yes) return steps;

  const backup = `${member.configPath}.bak-rollout-${stamp}`;
  copyFileSync(member.configPath, backup);
  writeFileSync(member.configPath, next);
  steps.push({ member: member.id, action: "write", ok: true, detail: `백업 ${backup}` });

  const kick = () => run(["launchctl", "kickstart", "-k", `gui/${env.uid}/${member.serviceLabel}`], { timeoutMs: 60_000 });
  const rollback = async (why: string) => {
    try {
      copyFileSync(backup, member.configPath);
      const back = await kick();
      steps.push({ member: member.id, action: "rollback", ok: back.code === 0, detail: `${why} → 백업 복원 + 재시작` });
    } catch (e) {
      steps.push({ member: member.id, action: "rollback", ok: false, detail: `${why} → 복원 실패: ${(e as Error).message} — 백업 ${backup} 를 손으로` });
    }
  };
  // ★쓴 뒤의 모든 경로는 '성공 확인' 또는 '복원' 둘 중 하나로 끝난다★ — 예외도 복원으로.
  try {
    const restart = await kick();
    steps.push({ member: member.id, action: "restart", ok: restart.code === 0, detail: member.serviceLabel });
    // 재시작 실패면 돌고 있는 서비스는 옛 설정 그대로다. 확인(one-shot)은 새 프로세스라 그걸 대신 못 잰다 → 복원.
    if (restart.code !== 0) { await rollback(`재시작 실패(exit ${restart.code})`); return steps; }
    const verify = await checkMember(member, { model: null, effort: null }, env, run);
    const ok = verify.verdict === "works" && verify.actualModel === target.model;
    steps.push({ member: member.id, action: "verify", ok, detail: `${verify.detail} · 실제 ${verify.actualModel ?? "?"}` });
    if (!ok) await rollback("확인 실패");
  } catch (e) {
    steps.push({ member: member.id, action: "error", ok: false, detail: (e as Error).message });
    await rollback("예외");
  }
  return steps;
}

export async function applyAll(members: Member[], target: { model: string; effort: string | null }, env: Env, run: Runner, yes: boolean, stamp: string): Promise<ApplyStep[]> {
  const steps: ApplyStep[] = [];
  const invalid = validateTarget(target);
  if (invalid) return [{ member: "-", action: "refuse", ok: false, detail: invalid }];
  const oc = members.filter((m) => m.runtime === "openclaw");
  const rest = members.filter((m) => m.runtime !== "openclaw");
  for (let i = 0; i < rest.length; i++) {
    const s = await applyMember(rest[i]!, target, env, run, yes, stamp);
    steps.push(...s);
    // 한 팀원에서 실패하면 멈춘다 — 안 되는 모델로 전원을 재시작·복원하지 않는다.
    if (yes && s.some((x) => !x.ok)) {
      for (const m of [...rest.slice(i + 1), ...oc]) steps.push({ member: m.id, action: "skip", ok: false, detail: `앞 팀원(${rest[i]!.id}) 실패로 중단` });
      return steps;
    }
  }
  if (oc.length === 0) return steps;

  // openclaw: 바꾸기 전에 게이트웨이가 그 모델을 아는지부터 — 모르면 아무도 안 바꾼다.
  const gate = await checkMember(oc[0]!, target, env, run);
  if (gate.verdict !== "works") {
    for (const m of oc) steps.push({ member: m.id, action: "skip", ok: false, detail: `openclaw 가 ${target.model} 을 못 씀: ${gate.detail}` });
    return steps;
  }
  const ocBackup = `${oc[0]!.configPath}.bak-rollout-${stamp}`;
  if (yes) copyFileSync(oc[0]!.configPath, ocBackup);
  const restoreOc = async (why: string) => {
    try {
      copyFileSync(ocBackup, oc[0]!.configPath);
      const back = await run([env.openclawBin, "gateway", "restart"], { timeoutMs: 180_000 });
      steps.push({ member: "openclaw", action: "rollback", ok: back.code === 0, detail: `${why} → openclaw.json 복원(${ocBackup}) + 재시작` });
    } catch (e) {
      steps.push({ member: "openclaw", action: "rollback", ok: false, detail: `${why} → 복원 실패: ${(e as Error).message} — 백업 ${ocBackup} 를 손으로` });
    }
  };
  // ★백업 뒤의 모든 경로는 '반영 확인' 또는 '복원' 으로 끝난다★ — config set 도중·재시작 도중 예외도 복원으로.
  try {
    const changed: Member[] = [];
    for (const m of oc) {
      const s = await applyMember(m, target, env, run, yes, stamp);
      steps.push(...s);
      if (s.some((x) => x.action === "config set" && x.ok)) changed.push(m);
    }
    if (!yes || changed.length === 0) return steps;
    const r = await run([env.openclawBin, "gateway", "restart"], { timeoutMs: 180_000 });
    steps.push({ member: "openclaw", action: "restart", ok: r.code === 0, detail: "게이트웨이 재시작(openclaw 팀원 전원 잠깐 멈춤)" });
    const after = readFileSync(oc[0]!.configPath, "utf-8");
    const bad = changed.filter((m) => readCurrent(m, after).model !== target.model);
    if (r.code !== 0 || bad.length > 0) await restoreOc(r.code !== 0 ? `재시작 실패(exit ${r.code})` : `반영 안 됨: ${bad.map((m) => m.id).join(",")}`);
    else steps.push({ member: "openclaw", action: "verify", ok: true, detail: `설정 ${changed.length}명 반영 · 실제 응답 모델은 각 팀원의 다음 턴 기록으로 확인 필요` });
  } catch (e) {
    steps.push({ member: "openclaw", action: "error", ok: false, detail: (e as Error).message });
    if (yes) await restoreOc("예외");
  }
  return steps;
}
