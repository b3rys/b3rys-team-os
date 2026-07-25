import { expect, test } from "bun:test";
import { plistFirstProgramArgument } from "./acceptanceCheck";

const CANON = "/repo/src/server/runtimes/claude/start-telegram-channel.sh";

function plist(program: string, id = "bill"): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key><string>com.example.claude-telegram-" + id + "</string>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${program}</string>`,
    `    <string>${id}</string>`,
    "  </array>",
    "  <key>RunAtLoad</key><true/>",
    "</dict>",
    "</plist>",
  ].join("\n");
}

test("정본 런처를 가리키는 plist 는 그대로 뽑힌다", () => {
  expect(plistFirstProgramArgument(plist(CANON))).toBe(CANON);
});

test("개인 스킬 사본을 가리키면 정본과 다른 값이 뽑힌다 (drift 검출)", () => {
  const skillCopy = "/Users/someone/.claude/skills/setup-claude-telegram-bot/scripts/start-telegram-channel.sh";
  const got = plistFirstProgramArgument(plist(skillCopy, "steve"));
  expect(got).toBe(skillCopy);
  expect(got).not.toBe(CANON);
});

test("구 repo 사본을 가리켜도 검출된다", () => {
  const oldRepo = "/Users/someone/Development/old-repo/src/server/runtimes/claude/start-telegram-channel.sh";
  expect(plistFirstProgramArgument(plist(oldRepo, "lui"))).not.toBe(CANON);
});

test("ProgramArguments 가 없으면 null", () => {
  expect(plistFirstProgramArgument("<plist><dict><key>Label</key><string>x</string></dict></plist>")).toBeNull();
});

test("공백/개행이 달라도 파싱된다", () => {
  const xml = `<key>ProgramArguments</key>\n\n  <array>\n\n    <string>${CANON}</string>\n  </array>`;
  expect(plistFirstProgramArgument(xml)).toBe(CANON);
});
