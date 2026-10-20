// Local files only; outputs transcript/timing JSON. Audio is never sent to Telegram.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { transcribeLocalVoice, runVoiceProcess } from "../../src/server/lib/telegramVoice";

const files = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
assert(files.length, "Pass local audio paths [--no-prompt]");
const prompt = process.argv.includes("--no-prompt") ? "" : "빌, 스티브, 덱스, 모두, 여러분.";
for (const file of files) {
  const dir = await mkdtemp(join(tmpdir(), "b3os-mlx-bench-"));
  const start = performance.now();
  let engines = 0;
  try {
    const text = await transcribeLocalVoice(file, dir, prompt, {
      run: async (argv, timeout) => { engines++; await runVoiceProcess(argv, timeout); },
    });
    assert.equal(engines, 1, "MLX must succeed without CPU fallback");
    console.log(JSON.stringify({ file, prompt: !!prompt, text, seconds: (performance.now()-start)/1000, engines }));
  } finally { await rm(dir, {recursive:true,force:true}); }
}
