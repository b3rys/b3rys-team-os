// 서버는 기동 시 코드를 읽고 화면은 디스크의 빌드 결과를 읽으므로 배포 신원을 별도로 보관한다. 확인할 수 없는 값은 null이다.
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** 층 하나의 신원. 못 읽으면 commit=null — 모른다는 사실 자체가 값이다. */
export interface LayerIdentity {
  commit: string | null;
  /** 서버는 기동 시각, 웹은 빌드 시각. ISO8601(UTC). */
  at: string | null;
}

export interface DeploymentIdentity {
  server: LayerIdentity;
  web: LayerIdentity;
}

/** 빌드가 `dist/web` 안에 남기는 표식 파일 이름. 빌드 산출물과 같은 자리 에 둬야 원자성이 성립한다. */
export const BUILD_MANIFEST = "BUILD.json";

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * `.git` 을 연다. 워크트리에서는 `.git` 이 디렉토리가 아니라 파일 이고 안에 `gitdir: <경로>` 가 들어 있다.
 * 그 경우 HEAD 는 그 gitdir 에 있지만 refs 는 공용 디렉토리(commondir)에 있다 — 둘을 갈라서 돌려준다.
 * (처음엔 워크트리를 null 로 뒀는데, 워크트리에서 빌드하면 표식이 모름 이 됐다. 값을 알 수 있는데
 *  모른다고 말하는 건 이 파일이 없애려는 바로 그 상태다.)
 */
export function gitDirs(repoRoot: string): { headDir: string; commonDir: string } | null {
  const dotGit = join(repoRoot, ".git");
  if (!existsSync(dotGit)) return null;
  if (statSync(dotGit).isDirectory()) return { headDir: dotGit, commonDir: dotGit };
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
  if (!m) return null;
  const raw = m[1]!.trim();
  // 상대경로일 수 있다: `git worktree add` 는 절대경로를 쓰지만
  //   서브모듈 등은 상대경로를 쓴다. 그대로 쓰면 프로세스 cwd 기준 으로 풀려서, 멀쩡한 배치를
  //   cwd 가 다르다는 이유로 null 로 오판한다. 기준은 언제나 repoRoot 다.
  const headDir = isAbsolute(raw) ? raw : resolve(repoRoot, raw);
  if (!existsSync(headDir)) return null;
  const commonFile = join(headDir, "commondir");
  if (!existsSync(commonFile)) return { headDir, commonDir: headDir };
  const rel = readFileSync(commonFile, "utf8").trim();
  return { headDir, commonDir: rel.startsWith("/") ? rel : join(headDir, rel) };
}

/**
 * 저장소 HEAD 를 읽는다. git 명령을 쓰지 않는다 — 서버 부팅 경로에서 외부 프로세스를 띄우지 않기 위해서다.
 * `.git/HEAD` → (심볼릭이면) 참조 파일 → 없으면 `packed-refs` 순으로 본다. 어느 단계든 실패하면 null.
 */
export function readHeadCommit(repoRoot: string): string | null {
  try {
    const dirs = gitDirs(repoRoot);
    if (!dirs) return null;
    const headPath = join(dirs.headDir, "HEAD");
    if (!existsSync(headPath)) return null;
    const head = readFileSync(headPath, "utf8").trim();
    if (!head.startsWith("ref:")) {
      return SHA_RE.test(head) ? head : null; // detached HEAD
    }
    const ref = head.slice(4).trim();
    const refPath = join(dirs.commonDir, ref);
    if (existsSync(refPath)) {
      const sha = readFileSync(refPath, "utf8").trim();
      return SHA_RE.test(sha) ? sha : null;
    }
    // 느슨한 ref 파일이 없으면 packed-refs 에 있다(gc 후 흔한 상태).
    const packed = join(dirs.commonDir, "packed-refs");
    if (!existsSync(packed)) return null;
    for (const line of readFileSync(packed, "utf8").split("\n")) {
      if (line.startsWith("#")) continue;
      const [sha, name] = line.trim().split(/\s+/);
      if (sha && name === ref && SHA_RE.test(sha)) return sha;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 빌드 표식을 읽는다. 요청 시점에 읽는다 — 화면은 재시작 없이 바뀌므로 기동 시 캐시하면 옛 값을 말한다.
 * 대신 mtime 이 그대로면 파싱을 건너뛴다(/health 는 감시가 주기적으로 부른다).
 */
let webCache: { mtimeMs: number; value: LayerIdentity } | null = null;
export function readWebBuild(distWeb: string): LayerIdentity {
  const file = join(distWeb, BUILD_MANIFEST);
  try {
    const st = statSync(file);
    if (webCache && webCache.mtimeMs === st.mtimeMs) return webCache.value;
    const raw = JSON.parse(readFileSync(file, "utf8")) as { commit?: unknown; built_at?: unknown };
    const commit = typeof raw.commit === "string" && /^[0-9a-f]{40}$/.test(raw.commit) ? raw.commit : null;
    const at = typeof raw.built_at === "string" && raw.built_at ? raw.built_at : null;
    const value: LayerIdentity = { commit, at };
    webCache = { mtimeMs: st.mtimeMs, value };
    return value;
  } catch {
    // 표식이 없거나(옛 빌드) 깨졌으면 모른다. 캐시하지 않는다 — 다음 빌드가 만들어 줄 수 있다.
    return { commit: null, at: null };
  }
}

/** 시험에서 캐시가 새지 않게. 운영에서는 부르지 않는다. */
export function resetWebBuildCache(): void {
  webCache = null;
}

/**
 * 기동 시점에 한 번 확정되는 서버 층 신원. 재시작해야 바뀌는 값이라 여기서 굳히는 게 맞다.
 */
export function captureServerIdentity(repoRoot: string, now: Date): LayerIdentity {
  return { commit: readHeadCommit(repoRoot), at: now.toISOString() };
}

export function deploymentIdentity(server: LayerIdentity, distWeb: string): DeploymentIdentity {
  return { server, web: readWebBuild(distWeb) };
}
