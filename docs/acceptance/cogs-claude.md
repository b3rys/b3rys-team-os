# App-channel Claude teammates

The app can provision Codex or Claude teammates. Claude app teammates use a
separate LaunchAgent and headless runner, rather than the Telegram plugin launcher.
New Claude configs start with `model = "sonnet"`; the model API offers Sonnet and
Opus. Existing configs are preserved when the launcher is regenerated. Codex offers
gpt-6-luna and gpt-6.1-sol. Each runtime reads the selected model at the next request.

The Claude child process strips TELEGRAM_* and CODEX_* variables, uses an isolated
stable runtime directory, disables hooks and installed customizations with safe mode,
and passes an empty MCP config with `--strict-mcp-config`. The teammate persona is
provided explicitly. Conversation sessions survive model changes. This runner
currently exposes WebSearch as its only tool; it does not execute workspace commands.

Runtime activation, stop, cleanup, status and essential checks recognize the app
bridge. Telegram liveness monitoring excludes app-channel Claude teammates. The
monitor treats a valid registry without Telegram teammates as an empty set.

Validation: Swift 74 tests, Go race suite, Bun 282 tests across nine relevant files,
and TypeScript checking passed. Additional monitoring/status regression cases were
added and rerun. The existing-format SQLite migration preserves text and sequence.
The environment and cwd isolation regression test fails when either guard is removed.

The real Claude runner returned replies from observed models claude-sonnet-5-5 and
claude-opus-5-5, forwarded partial text, and remembered a number across a Sonnet→Opus
session. The child had no Telegram variables or app bot token, its initialization
reported no MCP servers and no Telegram plugin, and the injected project hook did not
execute. Codex gpt-6-luna and gpt-6.1-sol also passed real response probes.

Actual LaunchAgent provisioning, removal and live app-to-server teammate creation
remain deployment acceptance checks. No live configuration or service was changed.
Rollback the feature commits and use the previous builds; existing teammate model
migration is a separate approved operation.
