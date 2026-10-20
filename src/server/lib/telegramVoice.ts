import { spawn } from "node:child_process";
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
  } catch {
    throw new Error("voice transcription failed");
  } finally {
    clearTimeout(timer);
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

/** Each job owns a process group, including Whisper's ffmpeg subprocesses. */
export async function runVoiceProcess(
  argv: string[], timeoutMs = 120_000, onStderr?: (text: string) => void,
): Promise<void> {
  const child = spawn(argv[0]!, argv.slice(1), {
    detached: true, stdio: ["ignore", "ignore", onStderr ? "pipe" : "ignore"],
  });
  if (onStderr) child.stderr?.on("data", chunk => onStderr(String(chunk)));
  const killGroup = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  let timedOut = false;
  let killError: unknown;
  const timer = setTimeout(() => {
    timedOut = true;
    try { killGroup(); } catch (error) { killError = error; }
  }, timeoutMs);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    // Also clean up a decoder left behind by a failed parent before releasing the queue.
    killGroup();
    if (child.pid) {
      const deadline = Date.now() + 5_000;
      while (true) {
        try { process.kill(-child.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
          throw error;
        }
        if (Date.now() >= deadline) throw new Error("local voice process cleanup failed");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    if (killError || code !== 0 || timedOut) throw new Error("local voice process failed");
  } finally {
    clearTimeout(timer);
    killGroup();
  }
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

/** Only local file paths reach argv. A cached model path prevents implicit network downloads. */
export async function transcribeLocalVoice(path: string, dir: string, prompt: string, opts: {
  timeoutMs?: number;
  run?: (argv: string[], timeoutMs?: number) => Promise<void>;
  checkAudio?: (path: string) => Promise<void>;
} = {}): Promise<string> {
  await (opts.checkAudio ?? assertAudibleVoice)(path);
  const model = join(process.env.HOME ?? "", ".cache/whisper/large-v3-turbo.pt");
  if (!await Bun.file(model).exists()) throw new Error("local voice model missing");
  const argv = [
    "/opt/homebrew/bin/whisper", path, "--model", model,
    "--language", "ko", "--device", "cpu", "--fp16", "False", "--threads", "4",
    "--initial_prompt", prompt.slice(0, 1000), "--output_format", "txt", "--output_dir", dir,
  ];
  await (opts.run ?? runVoiceProcess)(argv, opts.timeoutMs);
  return await readFile(join(dir, "voice.txt"), "utf8");
}

/** One queue covers download + transcription + handling, preserving voice arrival order. */
export function createVoiceIngress<T extends VoiceMessage = VoiceMessage>(deps: {
  allowedIds: () => string[];
  transcribe: (fileId: string) => Promise<string>;
  handle: (text: string, msg: T) => Promise<void>;
  notify: (senderId: string, notice: string) => Promise<void>;
}) {
  let tail = Promise.resolve();
  return (msg: T): Promise<boolean> => {
    const ref = msg.voice ?? msg.audio;
    if (!ref || msg.text?.trim() || msg.caption?.trim() || msg.from?.is_bot) return Promise.resolve(false);
    const sender = String(msg.from?.id ?? "");
    if (!sender || !deps.allowedIds().includes(sender)) return Promise.resolve(false);
    const job = tail.then(async () => {
      let text: string;
      try {
        text = (await deps.transcribe(ref.file_id)).trim();
        if (!text) throw new Error();
      } catch {
        // Direct system notification only; never feed it back into the team routing handler.
        await deps.notify(sender, VOICE_FAILURE_NOTICE);
        return true;
      }
      await deps.handle(text, msg);
      return true;
    });
    tail = job.then(() => {}, () => {});
    return job;
  };
}
