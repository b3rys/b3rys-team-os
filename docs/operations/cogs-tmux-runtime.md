# Persistent cogs Claude teammates

A Claude teammate uses the persistent interactive runtime when `cogs_inbox.transport` is `tmux`. App recruitment sets this on new Claude teammates. Existing app bridges retain their current transport until explicitly migrated. The cogs poller includes unofficial members and does not advance offsets while the runtime is unavailable. Restart recovery preserves conversation history when available and starts a new conversation if no previous interactive conversation exists.

The server owns `getUpdates` for tmux transport. Before polling, it retires the old Claude bridge LaunchAgent and waits for the known bridge PID and descendants to exit. Failure to verify bridge retirement blocks polling. Runtime mutation requires `APPROVAL_EXECUTION_ENABLED=1`; automatic dead-session recovery also requires `HEALTH_AUTOFIX_ENABLED=1`. Intentionally disabled teammates stay disabled. Recovery attempts are limited to one per member per 30 seconds.

The CLI keeps the configured folder/full tool policy. It loads only the explicit `cogs_reply` MCP server. That server accepts replies only to stored messages owned by the authenticated teammate and sends through the existing inbox delivery path. A greeting is marked sent only after that path records a successful cogs delivery. `--safe-mode` must not be added: it disables MCP customizations, including the reply tool.

## Runtime status and restart contract

The server reports `setBotStatus` for cogs-connected Claude and Codex teammates, including unofficial app members. Missing runtime or intentionally off means `offline`. A live runtime with no successful `getUpdates` within 90 seconds means `stalled`. A live runtime with a recent successful poll means `ok`. Bridge poll timestamps are written atomically to `<pidFile>.poll`; the process ID and teammate ID must match the ready marker. A ready marker alone does not establish active polling. State changes report immediately on the next five-second observation, unchanged states refresh every 30 seconds. Network failures retry without logging token-bearing URLs.

`POST /team/api/members/b3chat/member/:memberId/restart` uses the same local-address and shared-secret guard as the model endpoint. Only app-created cogs teammates are eligible. Execution-disabled or intentionally off is 409, an in-flight restart is 409, and another attempt within 30 seconds is 429. Runtime failure is 503, successful restart is 200. JSON is `{ok, member_id, state, code, retryable}`. The handler does not change execution authorization or silently enable an off teammate.

## Existing teammate migration

Merge and live activation are separate steps. After live-change approval, the operator should:

1. Back up the live registry and DB using the standard infrastructure procedure. Record the teammate's existing channel, runtime, tmux session, workspace and bridge state without printing credentials.
2. Stop the old app bridge and verify its process and descendants have exited. Never run the old bridge and server poller against the same bot simultaneously.
3. Add `cogs_inbox` with `transport: "tmux"`, the existing API base, an absolute existing 0600 token-file path, and the same allowed room IDs. Preserve channel, runtime, workspace, tmux session and unofficial-member fields. Use the registry's safe atomic writer. An existing teammate such as `teammate-f04bb6867b` keeps its `claude-teammate-f04bb6867b` session name and room `14`.
4. Apply the approved server version with the existing execution gates. Verify the old bridge is absent, the configured tmux session is present, `getUpdates` has one owner, and a room message receives a reply. Verify status switches to offline/stalled when the observed condition is induced in a test runtime and recovers to ok. Validate the restart button through the server contract.

Rollback: stop the tmux transport before removing `cogs_inbox.transport`, restore the backed-up registry, and start the previous app bridge through the approved operator path. Do not delete tokens or reset update offsets. Revert the code commit if reverting the deployment. Live room replies, iPhone status and button behavior require the operator's approved live acceptance run; isolated tests do not establish those outcomes.
