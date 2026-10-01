#!/usr/bin/env bun
// 팀원 모델 전환 CLI — 로직은 src/server/lib/modelRollout.ts.
//
//   bun model-rollout.ts inventory                     # 팀원별 런타임·지금 모델·effort
//   bun model-rollout.ts check  --model M [--effort E] [--members a,b]   # 실제로 되는지(설정 안 바꿈)
//   bun model-rollout.ts apply  --model M [--effort E] [--members a,b]   # 미리보기(바꾸지 않음)
//   bun model-rollout.ts apply  --model M ... --yes                      # 실제 전환(백업·재시작·확인·실패 시 되돌림)
//   공통: --json · --registry <agents.json>(기본 저장소 루트) · --host <ssh 이름> --remote-repo <경로>(다른 맥에서 실행)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  applyAll, checkMember, defaultEnv, listMembers, readCurrent, type Member, type Runner,
} from "../../../src/server/lib/modelRollout";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i <= 0) return undefined;
  const v = process.argv[i + 1];
  // 값 자리에 다음 옵션이 오면(예: --model --yes) 값이 없는 것으로 본다.
  if (v === undefined || v.startsWith("--")) { console.error(`--${name} 뒤에 값이 없습니다`); process.exit(2); }
  return v;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const run: Runner = (cmd, opts) => new Promise((done) => {
  const p = spawn(cmd[0]!, cmd.slice(1), { env: { ...process.env, ...(opts?.env ?? {}) }, cwd: opts?.cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  p.stdout.on("data", (d) => { stdout += String(d); });
  p.stderr.on("data", (d) => { stderr += String(d); });
  const t = opts?.timeoutMs ? setTimeout(() => { p.kill("SIGKILL"); }, opts.timeoutMs) : null;
  p.on("close", (code, signal) => { if (t) clearTimeout(t); done({ code: signal === "SIGKILL" ? 124 : code ?? 1, stdout, stderr }); });
  p.on("error", (e) => { if (t) clearTimeout(t); done({ code: 127, stdout, stderr: String(e) }); });
});

async function main() {
  const sub = process.argv[2];
  if (!sub || has("help")) {
    console.log(readFileSync(import.meta.path, "utf-8").split("\n").slice(1, 9).join("\n"));
    process.exit(sub ? 0 : 1);
  }

  // 다른 맥: 같은 스크립트를 그쪽 저장소에서 그대로 돌린다(--host 와 그 값만 빼고 넘긴다).
  const host = arg("host");
  if (host) {
    const remoteRepo = arg("remote-repo") ?? "~/b3rys-team-os";
    const rest = process.argv.slice(2).filter((a, i, all) => a !== "--host" && all[i - 1] !== "--host" && a !== "--remote-repo" && all[i - 1] !== "--remote-repo");
    const quoted = rest.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
    const r = await run(["ssh", "-o", "BatchMode=yes", host, `export PATH=$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH; cd ${remoteRepo} && bun skills/b3os-model-rollout/scripts/model-rollout.ts ${quoted}`], { timeoutMs: 1_800_000 });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    process.exit(r.code);
  }

  // 팀 서버가 쓰는 codex 실행 파일을 같이 쓴다(.env 의 CODEX_BIN 한 줄만 읽는다 — 다른 값은 보지 않는다).
  if (!process.env.CODEX_BIN) {
    try {
      const line = readFileSync(join(REPO_ROOT, ".env"), "utf-8").split("\n").find((l) => l.startsWith("CODEX_BIN="));
      if (line) process.env.CODEX_BIN = line.slice("CODEX_BIN=".length).trim().replace(/^["']|["']$/g, "");
    } catch { /* .env 없으면 PATH 의 codex */ }
  }
  const env = defaultEnv();
  const registry = arg("registry") ?? process.env.TEAM_AGENT_REGISTRY ?? join(REPO_ROOT, "agents.json");
  let members: Member[] = listMembers(registry, env);
  const only = arg("members")?.split(",").map((s) => s.trim()).filter(Boolean);
  if (only) members = members.filter((m) => only.includes(m.id));
  const json = has("json");

  if (sub === "inventory") {
    const rows = members.map((m) => {
      let cur = { model: null as string | null, effort: null as string | null };
      try { cur = readCurrent(m, readFileSync(m.configPath, "utf-8")); } catch { /* 읽기 실패는 빈 값 */ }
      return { member: m.id, runtime: m.runtime, model: cur.model, effort: cur.effort, config: m.configPath, service: m.serviceLabel };
    });
    if (json) console.log(JSON.stringify(rows, null, 2));
    else for (const r of rows) console.log(`${r.member.padEnd(14)} ${r.runtime.padEnd(13)} ${String(r.model).padEnd(14)} ${String(r.effort ?? "-").padEnd(7)} ${r.config}`);
    return;
  }

  const model = arg("model");
  const effort = arg("effort") ?? null;
  if (!model) { console.error("--model 이 필요합니다"); process.exit(2); }

  if (sub === "check") {
    const results = [];
    // openclaw 는 게이트웨이 판정이 한 번이면 된다(모두 같은 게이트웨이).
    let ocDone: Awaited<ReturnType<typeof checkMember>> | null = null;
    for (const m of members) {
      if (m.runtime === "openclaw" && ocDone) { results.push({ ...ocDone, member: m.id }); continue; }
      const r = await checkMember(m, { model, effort }, env, run);
      if (m.runtime === "openclaw") ocDone = r;
      results.push(r);
      if (!json) console.log(`${m.id.padEnd(14)} ${m.runtime.padEnd(13)} ${r.verdict.padEnd(14)} ${r.actualModel ?? "-"} · ${r.detail}`);
    }
    if (json) console.log(JSON.stringify(results, null, 2));
    process.exit(results.every((r) => r.verdict === "works") ? 0 : 3);
  }

  if (sub === "apply") {
    const yes = has("yes");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    const steps = await applyAll(members, { model, effort }, env, run, yes, stamp);
    if (json) console.log(JSON.stringify({ dryRun: !yes, steps }, null, 2));
    else {
      if (!yes) console.log("미리보기 — 아무것도 바꾸지 않았습니다. 실제 전환은 --yes.");
      for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.member.padEnd(14)} ${s.action.padEnd(10)} ${s.detail}`);
    }
    process.exit(steps.every((s) => s.ok) ? 0 : 3);
  }

  console.error(`모르는 명령: ${sub}`);
  process.exit(2);
}

void main();
