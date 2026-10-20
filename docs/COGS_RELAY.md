# cogs relay for an existing Claude tmux session

An optional `cogs_inbox` in a member's `agents.json` entry attaches private cogs messages to the member's existing `claude_channel` tmux session. The primary `channel` and Telegram session stay configured independently.

```json
{
  "cogs_inbox": {
    "api_base": "https://cogs.example.com",
    "token_file": "/absolute/private/path/cogs.bot-token",
    "allow_from": ["71"]
  }
}
```

`allow_from` contains **private room IDs**, not sender IDs. Only human text messages from those rooms are accepted. The token file contains the raw bot token; its value is read only when calling cogs and is never added to envelopes or error text. Use a file readable only by the server account. HTTPS is required except for local tests on `localhost` or `127.0.0.1`.

The running server observes registry reloads. A missing field, `enabled:false`, or intentional member off state prevents polling. A member using a b3chat primary bridge is rejected with `cogs_bridge_polling_conflict`; two relay members sharing a bot are rejected after the first owner in the same server. Use one server process per bot. The relay cannot detect a separate poller on another machine before that poller contacts cogs.

Incoming envelopes store `meta.cogs` with the member ID, private room ID, original message ID, and sender ID/name. Injection uses `source=cogs`, `kind=cogs`; the injected body also identifies the room and sender. Replies use:

```sh
send.sh --to broadcast --thread <thread> --in-reply-to <message> --body 'reply'
```

The original message's address takes precedence over the supplied thread. Only the owning member's bot may post, and the room must remain allowed. `direct_to_gd` and all-hands broadcasts are rejected on cogs threads. Posting failure returns HTTP 502 and a nonzero `send.sh` exit; it never falls through to Telegram. Successful `--confirm` returns after cogs confirms the post.

Outgoing deduplication uses the replying member, original room, original message and normalized body. A confirmed post blocks duplicate submissions for 60 seconds. A definite rejection records `meta.cogs_delivery.state=failed` and releases its dedupe key, allowing an immediate retry. A request awaiting acknowledgement is `pending`; a lost/malformed acknowledgement is `unknown`. Both block identical retries even after 60 seconds and across route/server restarts. Reconcile the original room before manually recovering a `pending` or `unknown` post; changing the reply body is a new submission, not reconciliation. No automatic retry can safely infer whether a lost acknowledgement means the post was delivered.

Polling offsets are stored in the local DB under a hash of the bot identity, so restarting resumes without storing token values. A clean injection failure retries the same update without inserting a second message. A possible partial injection is audited and acknowledged to avoid duplicate input; inspect `cogs_inject_failed` entries with `maybePartial:true` before manually recovering. Polling failures are recorded as `cogs_poll_failed` with a fixed error code, without remote response text.

## Verification map

| Feature and access | Sources | Headless check | Mutant | Live gap |
|---|---|---|---|---|
| Private cogs room → existing Claude tmux; kind and sender/room metadata | `workers/cogsPoll.ts`, `lib/cogsRelay.ts`, `lib/registry.ts`, `lib/tmuxInject.ts` | `bun test src/server/workers/cogsPoll.test.ts` (fake server, temporary registry/token/DB) | Disable injection: caught (12 failing fixture tests) | Actual cogs bot and live tmux require deployment verification |
| Explicit `send.sh --to broadcast` → original cogs room; failure exits nonzero | `routes/inbox.ts`, `db/inbox/messages.ts`, `skills/b3os-team-inbox/scripts/send.sh` | Same test, including CLI success/failure, same text across rooms/original messages, confirmed-failure retry, completed/pending/unknown dedupe | Force wrong room: caught (4 failing fixture tests) | Actual cogs delivery untested |
| Missing/disabled inbox, bridge conflict, token privacy | `lib/cogsRelay.ts`, `workers/cogsPoll.ts` | Same test: no requests when disabled; remote error echoes fake token; DB/audit/events/CLI checked | Store token in metadata: caught (privacy test fails) | No operational credentials used |

No performance gate is added; polling is nonblocking HTTP every three seconds, with one cycle at a time and an eight-second request deadline. No server needs to be started on an operational port for these tests.
