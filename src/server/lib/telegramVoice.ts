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

/** Only local file paths reach argv. A cached model path prevents implicit network downloads. */
export async function transcribeLocalVoice(path: string, dir: string, prompt: string, opts: {
  timeoutMs?: number;
  spawn?: (argv: string[]) => { exited: Promise<number>; kill: () => void };
} = {}): Promise<string> {
  const model = join(process.env.HOME ?? "", ".cache/whisper/large-v3-turbo.pt");
  if (!await Bun.file(model).exists()) throw new Error("local voice model missing");
  const argv = [
    "/opt/homebrew/bin/whisper", path, "--model", model,
    "--language", "ko", "--device", "cpu", "--fp16", "False", "--threads", "4",
    "--initial_prompt", prompt.slice(0, 1000), "--output_format", "txt", "--output_dir", dir,
  ];
  const child = opts.spawn ? opts.spawn(argv) : (() => {
    const process = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
    return { exited: process.exited, kill: () => { process.kill("SIGKILL"); } };
  })();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, opts.timeoutMs ?? 120_000);
  try {
    if (await child.exited !== 0 || timedOut) throw new Error("local voice process failed");
    return await readFile(join(dir, "voice.txt"), "utf8");
  } finally { clearTimeout(timer); }
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
