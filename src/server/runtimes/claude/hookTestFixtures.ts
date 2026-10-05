import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Mirror the shared dependencies installed beside each deployed Python hook. */
export function copyChannelDescriptorFixture(destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const file of ["channel_descriptor.py", "channel-descriptors.json"]) {
    copyFileSync(join(import.meta.dir, file), join(destination, file));
  }
}

export function seedChannelDescriptorRepo(repoRoot: string): void {
  copyChannelDescriptorFixture(join(repoRoot, "src/server/runtimes/claude"));
}

/** Do not inherit live state, log paths, credentials, or the user's HOME. */
export function isolatedHookEnvironment(root: string, overrides: Record<string, string> = {}): Record<string, string> {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return {
    PATH: process.env.PATH ?? "", HOME: home, TMPDIR: tmpdir(),
    PYTHONDONTWRITEBYTECODE: "1", ...overrides,
  };
}
