# Auto-heal core

`scripts/auto-heal-core.sh` is a small, opt-in recovery loop for:

- a configured tmux bot whose session is positively absent;
- a configured bot poller whose PID file contains a valid PID that is positively dead;
- a configured launchd gateway that is unregistered, stopped (`-`), or has a positively dead PID;
- Claude's `How is Claude doing this session` survey, dismissed with the literal `0` key while preserving the prompt input line.

The core is safe-fail: missing tools, failed inventories, malformed or missing PID
files, duplicate matches, permission ambiguity, and verification failures are
reported as `NOOP` or `FAILED`. They never trigger a fallback restart or extra
keystroke.

## Configuration

Create a pipe-delimited file. Blank lines and lines beginning with `#` are
ignored.

```text
bot|worker|claude-worker|/path/to/worker.pid|on|/path/to/team-os.sh|up|worker
gateway|openclaw|ai.openclaw.gateway|-|on|/path/to/team-os.sh|up|openclaw
bot|paused-worker|claude-paused|/path/to/paused.pid|off|/path/to/team-os.sh|up|paused-worker
```

Fields are:

1. `bot` or `gateway`;
2. a display name;
3. the exact tmux session or launchd label;
4. the poller PID file (`-` for gateways);
5. `on` or `off`;
6. an executable recovery program followed by zero or more argv fields.

The file is parsed as data and is never sourced or evaluated. Do not use `|` or
newlines inside fields. Only configured records are inspected; an `off` record
is skipped.

Run once:

```bash
scripts/auto-heal-core.sh --config /path/to/auto-heal.conf
```

Preview possible actions without restarting services or sending keys:

```bash
scripts/auto-heal-core.sh --config /path/to/auto-heal.conf --dry-run
```

Use a scheduler only after testing the exact configuration and recovery
programs. This repository does not install a scheduler or modify an existing
local monitor.

## Recovery boundary

The script does not probe application health. A live PID is never restarted,
even if the application looks stuck. A missing poller PID file is also not
proof of death and results in `NOOP`.

Recovery is attempted once. A non-zero recovery result is reported without
force-clean, escalation, retry, alert delivery, database cleanup, or any other
fallback.

For the Claude survey, the script sends exactly one literal `0`, then verifies
that the survey disappeared and the `❯` input line is byte-for-byte unchanged.
If verification fails, it reports the failure and sends no restore or retry
keys.

## Harness

The harness replaces `tmux`, `launchctl`, `kill`, `ps`, and the recovery program
with local mocks. It covers positive death, live state, missing/ambiguous state,
configured-off targets, survey preservation, and the invariant that uncertain
state invokes recovery zero times.

```bash
scripts/auto-heal-core-harness.sh
```
