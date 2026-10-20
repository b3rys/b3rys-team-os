#!/usr/bin/env bun
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { transcribeLocalVoice } from "../src/server/lib/telegramVoice";

/** A private directory and stable basename also isolate CPU Whisper's voice.txt output. */
export async function transcribeVoiceFile(audio: string, opts: {
  tempRoot?: string;
  transcribe?: typeof transcribeLocalVoice;
} = {}): Promise<string> {
  let dir: string | undefined;
  try {
    if (!audio || !(await stat(audio)).isFile()) throw new Error();
    dir = await mkdtemp(join(opts.tempRoot ?? tmpdir(), "b3os-voice-cli-"));
    const ext = extname(audio);
    const local = join(dir, "voice" + (/^\.[a-zA-Z0-9]{1,8}$/.test(ext) ? ext : ".audio"));
    await copyFile(audio, local);
    const text = (await (opts.transcribe ?? transcribeLocalVoice)(local, dir, "", {warn: () => {}})).trim();
    if (!text) throw new Error();
    return text;
  } finally {
    if (dir) await rm(dir, {recursive: true, force: true});
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error();
    const text = await transcribeVoiceFile(process.argv[2]!);
    process.stdout.write(text + "\n");
  } catch {
    process.stderr.write("TRANSCRIBE_FAILED\n");
    process.exitCode = 1;
  }
}
