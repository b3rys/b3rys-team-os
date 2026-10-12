# Claude app tools

The server reads `cogs_tool_scope` from the matching member in `agents.json` at
turn startup. Missing, unknown, malformed, and duplicate-member settings use
`folder`. The chat prompt and member HTTP API cannot set this field.

```json
{"id":"example","cogs_tool_scope":"folder"}
```

`folder` exposes Read, Glob, Grep, Write, Edit, WebFetch, and WebSearch. Claude Code
runs in the member workspace's canonical path with `--restricted`, no project or
user settings sources, no hooks/plugins/MCP servers, outside-read blocking,
path-scoped write approval, and automatic denial of permission prompts.
Write/Edit of `SOUL.md`, `CLAUDE.md`, and `.claude/**` are explicitly denied,
including their resolved symlink targets. A workspace containing the server's
registry path or either the main/deployed repository root is rejected before
CLI startup, even when the registry file does not yet exist.

WebFetch/WebSearch can send readable folder contents outside the machine;
folder scope restricts file access, not web data disclosure.

Credentials named `.env`, `.env.*`, and `~/.secrets` are denied. Claude Code
2.1.296 or newer is required; older/unrecognized versions fail before execution.

`full` exposes the normal built-in tool list and grants Read, Glob, Grep, Write,
Edit, Bash, WebFetch, and WebSearch without the folder boundary. Set this only
by editing the server's member configuration file. Custom hooks, plugins, and
MCP servers remain disabled for the app channel. No live member is changed by
this code change.

Folder Bash is intentionally unavailable. The native macOS sandbox probe did
not reach a Bash invocation, so its filesystem/network isolation was not
verified. File tools use Claude Code permissions; the Bash sandbox does not
cover them. Shell read/write/network and inside-command acceptance remain
unverified. Enable folder Bash only after those checks pass with OS enforcement.

## Execution host and deployment prerequisite

The runner spawns the CLI locally on the machine running the Claude app bridge;
it does not forward turns to a separate host. It uses `CLAUDE_BIN` when configured,
otherwise `claude` from the bridge's PATH. The launcher prepends the user's
`.local/bin` to PATH and executes the bridge locally through its LaunchAgent.

Before deploying, check the effective CLI on **each bridge host**, using the
same binary selection and user as the service. For the default selection:

```sh
command -v claude
claude --version
```

For a configured override, run `"$CLAUDE_BIN" --version` instead. Do not print
other environment variables. Require 2.1.296 or newer before starting folder
teammates, then run the live probe on that host before rollout. A host at 2.1.287
will return `cogs_folder_cli_unsupported`; updating another machine does not
satisfy this check.

## Reproduce

```sh
bun test src/server/runtimes/claude/cogsRunner.test.ts src/server/runtimes/claude/cogsToolPolicy.test.ts
bun test src/server/routes/settings.test.ts -t 'cogs tool scope'
bun scripts/checks/cogs-folder-tools.ts
bun run typecheck
```

The live probe creates synthetic files under a temporary home folder and calls
the actual Claude CLI. It checks absolute `/etc` and outside-home paths, `../`,
symlink read/write, outside Glob/Grep paths, outside Write/Edit, dummy `.env` and
`.secrets` reads, inside Read/Write/Edit/Glob/Grep, and Bash absence in the actual
tool list. It discards tool contents and environment values, disables session
persistence, and prints only case verdicts. A failure/timeout is never a pass.

Rollback: revert the tool-policy commit. No service restart, deployment, or
live registry mutation is part of this change.

References: [permissions](https://code.claude.com/docs/en/permissions),
[settings reference](https://code.claude.com/docs/en/settings-reference),
[Bash sandbox](https://code.claude.com/docs/en/sandboxing).
