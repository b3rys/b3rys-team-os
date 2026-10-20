import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const VOICE_FAILURE_NOTICE = "음성을 못 알아들었어요 — 다시 보내 주세요";
export const voiceDeliveryText = (text: string) => `🎤 음성(받아씀): ${text}`;
export interface VoiceMessage {
  text?: string;
  caption?: string;
  from?: { id?: number | string; is_bot?: boolean };
  voice?: { file_id: string };
  audio?: { file_id: string };
}

/** All failures crossing this boundary are constant strings: fetch errors can contain bot URLs. */
export async function transcribeTelegramVoice(
  token: string,
  fileId: string,
  prompt: string,
  opts: { fetch?: typeof fetch; transcribe?: (path: string, dir: string, prompt: string) => Promise<string>; timeoutMs?: number } = {},
): Promise<string> {
  let dir: string | undefined;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 30_000);
  try {
    dir = await mkdtemp(join(tmpdir(), "b3os-voice-"));
    const request = opts.fetch ?? fetch;
    const infoRes = await request(`https://api.telegram.org/bot${token}/getFile`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId }), signal: abort.signal,
    });
    const info = await infoRes.json() as { ok?: boolean; result?: { file_path?: string } };
    const remote = info.result?.file_path;
    if (!infoRes.ok || !info.ok || !remote || !/^[a-zA-Z0-9_./-]+$/.test(remote) || remote.split("/").includes("..")) throw new Error();
    const response = await request(`https://api.telegram.org/file/bot${token}/${remote}`, { signal: abort.signal });
    if (!response.ok) throw new Error();
    const path = join(dir, "voice.ogg");
    await Bun.write(path, await response.arrayBuffer());
    // The download deadline ends before the separately bounded local process starts.
    clearTimeout(timer);
    const text = (await (opts.transcribe ?? transcribeLocalVoice)(path, dir, prompt)).trim();
    if (!text) throw new Error();
    return text;
  } catch (error) {
    if (error instanceof VoiceProcessUnreapedError) throw error;
    throw new Error("voice transcription failed");
  } finally {
    clearTimeout(timer);
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

/** Cleanup could not be proved; this capture worker must not start another voice job. */
export class VoiceProcessUnreapedError extends Error {
  constructor() { super("local voice process cleanup unconfirmed"); }
}
export const VOICE_STOPPED_NOTICE = "음성 받아쓰기를 멈췄어요. 받아쓰기 프로세스를 정리하지 못했고, 자동으로 다시 켜지지 않아요. 운영 담당자에게 남은 프로세스를 정리한 뒤 음성 수신 기능(capture worker) 또는 b3os를 재시작해 달라고 요청해 주세요. 그동안 음성 메시지는 전달되지 않고, 글 메시지는 계속 전달돼요.";

type VoiceProcessRuntime = {
  spawn?: (argv: string[], captureStderr: boolean) => Pick<ChildProcess, "pid" | "once" | "stderr">;
  signal?: (pid: number, signal: NodeJS.Signals | 0) => void;
  cleanupMs?: number;
  pollMs?: number;
};

/** Signal a job's group only while its unreaped leader is still owned. */
export async function runVoiceProcess(
  argv: string[], timeoutMs = 120_000, onStderr?: (text: string) => void,
  runtime: VoiceProcessRuntime = {},
): Promise<void> {
  const child = runtime.spawn ? runtime.spawn(argv, !!onStderr) : spawn(argv[0]!, argv.slice(1), {
    detached: true, stdio: ["ignore", "ignore", onStderr ? "pipe" : "ignore"],
  });
  if (onStderr) child.stderr?.on("data", chunk => onStderr(String(chunk)));
  const signal = runtime.signal ?? ((pid, sig) => { process.kill(pid, sig); });
  const cleanupMs = runtime.cleanupMs ?? 5_000;
  return new Promise<void>((resolve, reject) => {
    let closed = false;
    let gone = false;
    let settled = false;
    let timedOut = false;
    let cleanupStarted = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(deadlineTimer);
      clearTimeout(probeTimer);
      if (error) reject(error); else resolve();
    };
    const startCleanupDeadline = () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      // This limit includes waiting for close, even if SIGKILL fails or close never arrives.
      deadlineTimer = setTimeout(() => finish(new VoiceProcessUnreapedError()), cleanupMs);
    };
    const probe = (code: number | null) => {
      if (settled) return;
      if (!gone && child.pid) {
        try { signal(-child.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") gone = true;
          else { finish(new VoiceProcessUnreapedError()); return; }
        }
      }
      if (gone || !child.pid) {
        finish(code !== 0 || timedOut ? new Error("local voice process failed") : undefined);
      } else {
        // A reaped leader grants no right to signal this PGID again. Probe only; fail closed.
        probeTimer = setTimeout(() => probe(code), runtime.pollMs ?? 10);
      }
    };
    const timeoutTimer = setTimeout(() => {
      if (settled || closed || gone) return;
      timedOut = true;
      startCleanupDeadline();
      if (child.pid) {
        try { signal(-child.pid, "SIGKILL"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") gone = true;
          else finish(new VoiceProcessUnreapedError());
        }
      }
    }, timeoutMs);
    child.once("error", () => finish(new Error("local voice process failed")));
    child.once("close", code => {
      closed = true;
      clearTimeout(timeoutTimer);
      if (settled) return;
      startCleanupDeadline();
      probe(code);
    });
  });
}

/** Reject near-digital silence before Whisper can hallucinate speech from the roster prompt. */
export async function assertAudibleVoice(path: string): Promise<void> {
  let output = "";
  await runVoiceProcess([
    "/opt/homebrew/bin/ffmpeg", "-hide_banner", "-nostats", "-i", path,
    "-af", "volumedetect", "-vn", "-sn", "-dn", "-f", "null", "-",
  ], 30_000, text => { output = (output + text).slice(-8192); });
  const match = /max_volume:\s*(-?inf|[-\d.]+) dB/.exec(output);
  if (!match || Number(match[1]) <= -80 || match[1] === "-inf") {
    throw new Error("local voice audio is silent");
  }
}

/** Prefer offline MLX; retain CPU Whisper once if the accelerated engine is unavailable. */
export async function transcribeLocalVoice(path: string, dir: string, prompt: string, opts: {
  timeoutMs?: number;
  run?: (argv: string[], timeoutMs?: number) => Promise<void>;
  checkAudio?: (path: string) => Promise<void>;
} = {}): Promise<string> {
  await (opts.checkAudio ?? assertAudibleVoice)(path);
  const run = opts.run ?? runVoiceProcess;
  const home = process.env.HOME ?? "";
  const root = process.env.B3OS_STT_HOME ?? join(home, ".local/share/b3os-stt");
  const output = join(dir, "voice-mlx.txt");
  // A fresh output prevents a failed engine from returning an earlier result.
  await rm(output, { force: true });
  try {
    await run([
      join(root, ".venv/bin/python"), join(root, "transcribe.py"),
      path, join(root, "model"), output, prompt.slice(0, 1000),
    ], opts.timeoutMs ?? 30_000);
    const text = (await readFile(output, "utf8")).trim();
    if (!text) throw new Error("local voice result empty");
    return text;
  } catch (error) {
    // Never launch a second engine while the first process group might still exist.
    if (error instanceof VoiceProcessUnreapedError) throw error;
  }
  const model = join(home, ".cache/whisper/large-v3-turbo.pt");
  if (!await Bun.file(model).exists()) throw new Error("local voice model missing");
  await rm(join(dir, "voice.txt"), { force: true });
  await run([
    "/opt/homebrew/bin/whisper", path, "--model", model,
    "--language", "ko", "--device", "cpu", "--fp16", "False", "--threads", "4",
    "--initial_prompt", prompt.slice(0, 1000), "--output_format", "txt", "--output_dir", dir,
  ], opts.timeoutMs ?? 120_000);
  const text = (await readFile(join(dir, "voice.txt"), "utf8")).trim();
  if (!text) throw new Error("local voice result empty");
  return text;
}

/** One queue covers download + transcription + handling, preserving voice arrival order. */
export function createVoiceIngress<T extends VoiceMessage = VoiceMessage>(deps: {
  allowedIds: () => string[];
  transcribe: (fileId: string) => Promise<string>;
  handle: (text: string, msg: T) => Promise<void>;
  notify: (senderId: string, notice: string) => Promise<void>;
}) {
  let tail = Promise.resolve();
  let blocked = false;
  return (msg: T): Promise<boolean> => {
    const ref = msg.voice ?? msg.audio;
    if (!ref || msg.text?.trim() || msg.caption?.trim() || msg.from?.is_bot) return Promise.resolve(false);
    const sender = String(msg.from?.id ?? "");
    if (!sender || !deps.allowedIds().includes(sender)) return Promise.resolve(false);
    const job = tail.then(async () => {
      if (blocked) { await deps.notify(sender, VOICE_STOPPED_NOTICE); return true; }
      let text: string;
      try {
        text = (await deps.transcribe(ref.file_id)).trim();
        if (!text) throw new Error();
      } catch (error) {
        if (error instanceof VoiceProcessUnreapedError) blocked = true;
        // Direct system notification only; never feed it back into the team routing handler.
        await deps.notify(sender, blocked ? VOICE_STOPPED_NOTICE : VOICE_FAILURE_NOTICE);
        return true;
      }
      await deps.handle(text, msg);
      return true;
    });
    tail = job.then(() => {}, () => {});
    return job;
  };
}
