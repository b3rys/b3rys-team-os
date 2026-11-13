/** 플러그인·MCP·기능은 상속해 새 팀원의 기능이 좁아지지 않게 하되 정책·신뢰·정체성은 제거한다. 모델·추론값은 호스트가 아니라 팀 기본(codexSeedModel)으로 쓴다. 실행 정책은 프로토콜 한 곳에서만 정하며 설정 우선순위는 미측정이다.
 * 호스트 projects 신뢰는 권한이므로 팀원 작업폴더 하나만 새로 쓰고, 호스트 CODEX_HOME을 가리키는 값은 설정·인증 격리를 깨므로 제거한다. TOML 중복 키는 파싱 실패하므로 append 대신 제거 후 기록한다. */

/** 새 codex 팀원의 시작 모델·추론값. 호스트 값을 물려주면 그 맥의 옛 설정(예: 몇 달 전 모델·low)이 새 팀원에게 그대로 간다.
 * 팀 모델을 바꿀 때(b3os-model-rollout) 이 값도 같이 바꾼다. 설치본마다 다르게 두려면 env 로 덮는다. */
export const CODEX_TEAM_DEFAULT = { model: "gpt-6.1-sol", effort: "medium" } as const;

export interface CodexSeedModel { model: string; effort: string }

/** 시드에 쓸 모델 — env B3OS_CODEX_DEFAULT_MODEL·B3OS_CODEX_DEFAULT_EFFORT 가 있으면 그 값, 없으면 팀 기본. */
export function codexSeedModel(env: Record<string, string | undefined> = process.env): CodexSeedModel {
  return {
    model: env.B3OS_CODEX_DEFAULT_MODEL?.trim() || CODEX_TEAM_DEFAULT.model,
    effort: env.B3OS_CODEX_DEFAULT_EFFORT?.trim() || CODEX_TEAM_DEFAULT.effort,
  };
}

/** 호스트 설정의 모델·추론값이 시드 값과 다르면 경고 문장, 같거나 호스트에 값이 없으면 null. */
export function hostModelDrift(hostConfig: string | null, target: CodexSeedModel): string | null {
  if (!hostConfig) return null;
  const lines = hostConfig.split("\n");
  const end = topLevelEnd(lines);
  const get = (key: string): string | null => {
    for (const l of lines.slice(0, end)) {
      const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`).exec(l);
      if (m) return m[1]!;
    }
    return null;
  };
  const model = get("model"), effort = get("model_reasoning_effort");
  const diff = (model && model !== target.model) || (effort && effort !== target.effort);
  if (!diff) return null;
  return `호스트 ~/.codex/config.toml 은 ${model ?? "(없음)"} · ${effort ?? "(없음)"} 이지만 새 팀원은 ${target.model} · ${target.effort} 로 시드한다 — 호스트 설정이 옛 값인지 확인`;
}

/** ① 정책 — 걷어내는 최상위 키. */
export const POLICY_KEYS = ["sandbox_mode", "approval_policy"] as const;
/** ① 정책 — 걷어내는 테이블. */
export const POLICY_TABLES = ["sandbox_workspace_write"] as const;
/** ② 신뢰 — 이 접두사로 시작하는 테이블은 전부 걷어낸다. */
export const TRUST_TABLE_PREFIX = "projects.";

/** 첫 테이블 헤더([...]) 앞까지가 최상위 스코프다. */
function topLevelEnd(lines: string[]): number {
  const i = lines.findIndex((l) => /^\s*\[/.test(l));
  return i === -1 ? lines.length : i;
}

/** 최상위 key 를 지운다. 테이블 안의 같은 이름은 건드리지 않는다. */
export function removeTopLevelKey(toml: string, key: string): string {
  const lines = toml.split("\n");
  const end = topLevelEnd(lines);
  const re = new RegExp(`^\\s*${key}\\s*=`);
  return lines.filter((l, i) => !(i < end && re.test(l))).join("\n");
}

/**
 * 최상위 문자열 key 를 값 끝까지 지운다 — `model`·`"model"`·`'model'` 표기와 여러 줄 문자열(따옴표 세 개)까지.
 * removeTopLevelKey 는 대입 첫 줄만 지우므로, 여러 줄 값이면 나머지가 남아 TOML 이 깨진다.
 */
export function removeTopLevelStringKey(toml: string, key: string): string {
  const lines = toml.split("\n");
  const end = topLevelEnd(lines);
  const re = new RegExp(`^\\s*(?:${key}|"${key}"|'${key}')\\s*=\\s*(.*)$`);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = i < end ? re.exec(lines[i]!) : null;
    if (!m) { out.push(lines[i]!); continue; }
    const v = m[1]!;
    const delim = v.startsWith('"""') ? '"""' : v.startsWith("'''") ? "'''" : null;
    if (delim && !v.slice(3).includes(delim)) {
      // 닫는 따옴표가 나오는 줄까지 같이 지운다.
      while (i + 1 < lines.length && !lines[i + 1]!.includes(delim)) i++;
      i++;
    }
  }
  return out.join("\n");
}

/** [table] 을 통째로 지운다(다음 테이블 헤더 직전까지). */
export function removeTable(toml: string, table: string): string {
  const lines = toml.split("\n");
  const start = lines.findIndex((l) => l.trim() === `[${table}]`);
  if (start === -1) return toml;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) { end = i; break; }
  }
  lines.splice(start, end - start);
  return lines.join("\n");
}

/** 접두사로 시작하는 테이블을 전부 지운다(`[projects."..."]` 처럼 이름이 가변인 경우). */
export function removeTablesWithPrefix(toml: string, prefix: string): string {
  const lines = toml.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const l of lines) {
    if (/^\s*\[/.test(l)) skipping = l.trim().startsWith(`[${prefix}`);
    if (!skipping) out.push(l);
  }
  return out.join("\n");
}

/**
 * 값이 특정 경로를 가리키는 줄을 지운다(정체성 누출 차단).
 * 키 이름이 아니라 값 으로 판정한다 — CODEX_HOME 만 막으면 같은 값을 다른 이름으로 실은 줄이 남는다.
 */
export function removeLinesReferencing(toml: string, needle: string): string {
  if (needle === "") return toml;
  // 경계까지 보고 비교한다. 단순 포함으로 재면 needle 이 `~/.codex` 일 때
  //   `~/.codex-agents/<팀원>` 을 가리키는 줄까지 같이 걸린다 — 그건 그 팀원 자신의 폴더다.
  const hit = (line: string): boolean => {
    let from = 0;
    for (;;) {
      const i = line.indexOf(needle, from);
      if (i === -1) return false;
      const next = line[i + needle.length];
      // 경로가 거기서 끝나거나(따옴표·공백 등) 하위 경로로 이어질 때만 같은 경로다.
      if (next === undefined || next === "/" || !/[A-Za-z0-9._-]/.test(next)) return true;
      from = i + needle.length;
    }
  };
  return toml
    .split("\n")
    .filter((l) => !(/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l) && hit(l)))
    .join("\n");
}

/** 호스트 설정이 없을 때. 상속할 것이 없어도 팀원은 떠야 한다. */
export function renderFallbackCodexConfig(): string {
  return [
    "# Generated by b3rys team-collab (host ~/.codex/config.toml 이 없어 빈 설정으로 시드).",
    "# 실행 모드는 이 파일이 아니라 appServerRunner 가 codex 프로토콜로 명시한다.",
    "",
  ].join("\n");
}

/** Bun 의 TOML 파서로 읽히는지. */
export function parsesAsToml(text: string): boolean {
  try { Bun.TOML.parse(text); return true; } catch { return false; }
}

/** TOML 문자열 리터럴(경로에 공백·따옴표가 있어도 안전). */
export function tomlString(v: string): string {
  return JSON.stringify(v);
}

/**
 * 시드할 config 본문. 능력은 물려주고 정책·신뢰·정체성은 걷어낸다.
 * `workdir` 는 그 팀원의 작업 폴더, `hostCodexHome` 은 호스트 CODEX_HOME 경로다.
 */
export function renderSeededCodexConfig(
  hostConfig: string | null,
  opts: { workdir: string; hostCodexHome: string; model?: CodexSeedModel },
): string {
  let out = hostConfig?.trim() ? hostConfig : renderFallbackCodexConfig();
  if (opts.model) {                                                 // ⓪ 모델은 팀 기본으로 — 호스트 값을 물려주지 않는다
    const head = `model = ${tomlString(opts.model.model)}\nmodel_reasoning_effort = ${tomlString(opts.model.effort)}\n`;
    const stripped = head + removeTopLevelStringKey(removeTopLevelStringKey(out, "model"), "model_reasoning_effort");
    // 지우고 다시 쓴 결과가 TOML 로 안 읽히면(못 본 표기) 호스트 상속을 포기하고 빈 설정 + 팀 모델로 시드한다 — 깨진 config 는 재시드도 안 된다.
    out = parsesAsToml(stripped) ? stripped : head + renderFallbackCodexConfig();
  }
  for (const k of POLICY_KEYS) out = removeTopLevelKey(out, k);   // ① 정책
  for (const t of POLICY_TABLES) out = removeTable(out, t);
  out = removeTablesWithPrefix(out, TRUST_TABLE_PREFIX);           // ② 신뢰
  out = removeLinesReferencing(out, opts.hostCodexHome);           // ③ 정체성
  // 그 팀원의 작업 폴더만 새로 신뢰한다.
  const tail = out.endsWith("\n") ? "" : "\n";
  return `${out}${tail}\n[projects.${tomlString(opts.workdir)}]\ntrust_level = "trusted"\n`;
}
