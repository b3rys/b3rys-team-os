/** Claude app-channel bridge. Telegram launcher and plugin state are never used. */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { codexBridgePaths, renderBridgePlist, type CodexBridgePaths } from "../codex/launcher";
import { assertChannelUsable, channelEnvLines, DEFAULT_CHANNEL, readMemberChannel, type MemberChannel } from "../../lib/memberChannel";
import { REPO_ROOT } from "../../lib/personaTemplates";

export function claudeCogsPaths(id: string, channel = DEFAULT_CHANNEL): CodexBridgePaths {
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(id)) throw new Error("invalid_member");
  const p = codexBridgePaths(id, channel);
  const label = p.label.replace(".codex-bridge-", ".claude-cogs-");
  return {...p, label, plist:p.plist.replace(p.label,label),
    wrapper:join(REPO_ROOT,"var","claude-cogs",`${id}-launch.sh`),
    pidFile:join(REPO_ROOT,"var","claude-cogs",`${id}.pid`),
    log:join(REPO_ROOT,"var","claude-cogs",`${id}.log`),
    codexHome:join(process.env.HOME ?? "", ".claude-agents",id)};
}
export function renderClaudeCogsWrapper(p: CodexBridgePaths, id: string): string {
  // Child CLI receives a filtered environment and an isolated cwd in cogsRunner.
  return ["#!/bin/bash","set -e",
    'for cogs_env_key in $(env | sed -n "s/^\\(TELEGRAM_[A-Za-z0-9_]*\\)=.*/\\1/p"); do unset "$cogs_env_key"; done',
    `export CODEX_BOT_TOKEN="$(cat "${p.tokenFile}")"`,
    `export CODEX_AGENT_ID="${id}"`, `export CODEX_WORKDIR="${p.workdir}"`,
    `export CODEX_HOME="${p.codexHome}"`, `export CODEX_ALLOW_FROM="${p.allowFrom}"`,
    `export CODEX_BRIDGE_PID_FILE="${p.pidFile}"`,
    `export B3OS_REPO_ROOT="${REPO_ROOT}"`,
    ...channelEnvLines(p.channel),
    `export PATH="${process.env.HOME}/.bun/bin:${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"`,
    `exec bun "${REPO_ROOT}/src/server/runtimes/claude/cogsBridge.ts"`, ""].join("\n");
}
export function writeClaudeCogsFiles(id: string, channel: MemberChannel = readMemberChannel(id)): CodexBridgePaths {
  assertChannelUsable(channel,"claude-cogs");
  if (channel.kind !== "b3chat") throw new Error("unsupported_channel");
  return writeClaudeCogsFilesAt(claudeCogsPaths(id,channel),id);
}
export function writeClaudeCogsFilesAt(p:CodexBridgePaths,id:string): CodexBridgePaths {
  for (const path of [p.wrapper,p.plist,join(p.codexHome,"config.toml")]) mkdirSync(dirname(path),{recursive:true});
  const config = join(p.codexHome,"config.toml");
  if (!existsSync(config)) writeFileSync(config,'model = "sonnet"\n',{mode:0o600});
  writeFileSync(p.wrapper,renderClaudeCogsWrapper(p,id),{mode:0o700}); chmodSync(p.wrapper,0o700);
  writeFileSync(p.plist,renderBridgePlist(p),"utf-8");
  return p;
}
export function removeClaudeCogsFiles(id: string): void {
  const p=claudeCogsPaths(id);
  for (const file of [p.wrapper,p.plist,p.tokenFile,p.pidFile,p.pidFile.replace(/\.pid$/,".window.json"),p.log]) rmSync(file,{force:true});
  rmSync(p.codexHome,{force:true,recursive:true});
}
