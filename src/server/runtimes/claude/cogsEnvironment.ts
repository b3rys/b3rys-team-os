export function claudeCogsEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key])=>
    !key.startsWith("TELEGRAM_") && !key.startsWith("CODEX_") && key !== "CLAUDECODE" && key !== "CLAUDE_CODE_SESSION_ID"));
}
