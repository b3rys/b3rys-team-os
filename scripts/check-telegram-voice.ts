// Local-only acceptance probe. No Telegram requests or server process.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { transcribeTelegramVoice } from "../src/server/lib/telegramVoice";
import { routeTeamMessageHybrid } from "../src/server/lib/teamRouter";
import type { AgentRecord } from "../src/server/types";

const dir = await mkdtemp(join(tmpdir(), "b3os-voice-probe-"));
const agents = [
  { id: "bill", display_name: "Bill", nicknames: ["빌"] },
  { id: "steve", display_name: "Steve", nicknames: ["스티브"] },
  { id: "dex", display_name: "Dex", nicknames: ["덱스"] },
] as AgentRecord[];
const prompt = agents.flatMap(a => a.nicknames ?? [a.display_name]).join(", ") + ", 모두, 여러분.";
async function run(argv: string[]) {
  const child = Bun.spawn(argv, { stdout: "ignore", stderr: "inherit" });
  assert.equal(await child.exited, 0, argv[0]);
}
try {
  for (const [name, spoken, expected, reason] of [
    ["bill", "빌, 이거 확인해줘", ["bill"], "explicit_mention"],
    ["all", "모두, 회의하자", ["bill", "steve", "dex"], "broadcast_marker"],
  ] as const) {
    const source = join(dir, `${name}.aiff`);
    const audio = join(dir, `${name}.ogg`);
    await run(["say", "-v", "Yuna", spoken, "-o", source]);
    await run(["ffmpeg", "-v", "error", "-y", "-i", source, "-af", "apad", "-t", "10", "-c:a", "libopus", audio]);
    let requests = 0;
    const request = (async () => ++requests === 1
      ? Response.json({ ok: true, result: { file_path: "voice/probe.oga" } })
      : new Response(await Bun.file(audio).arrayBuffer())) as unknown as typeof fetch;
    const start = performance.now();
    const text = await transcribeTelegramVoice("test-only", "fixture", prompt, { fetch: request });
    const seconds = (performance.now() - start) / 1000;
    const decision = await routeTeamMessageHybrid(text, agents, { source: "user" });
    assert.deepEqual(decision.targetAgentIds, [...expected]);
    assert.equal(decision.reason, reason);
    console.log(JSON.stringify({ name, durationSeconds: 10, text, seconds, targets: decision.targetAgentIds, reason }));
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
