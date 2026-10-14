# Cogs human reactions in the Codex bridge

Cogs sends `message_reaction` to the author bot only. The bridge requests this
update kind, verifies `cogs_message_sender_id` against `getMe.result.id`, and
requires `cogs_message_text` and `cogs_reactor_is_master`. Missing metadata,
Telegram events, bot reactors, positive bot hops and disallowed chats are ignored.
The server currently defines master as an administrator human; room IDs and
names are not used to infer approval.

`src/server/lib/reactionInput.ts` contains the runtime-neutral labels, input
format, reaction instructions and inbox. The polling/steer integration lives in
Codex because there is no shared polling loop: Claude uses its channel plugin,
while OpenClaw and Hermes use their own transports. This change does not claim to
add reaction delivery to those runtimes.

Only OK (`👌`, `🆗`, `OK`) and uncertainty (`🤔`) start or steer a turn, including
their removal. Other reactions wait in memory for the next input in the same
conversation. These deferred entries do not survive a bridge restart.
A running turn receives reaction instructions directly, without a receipt bubble
or the normal message instruction to reply. If steer fails, the serial queue
starts a turn instead. Deferred reactions are removed after successful steer;
failed steer preserves them for the queued turn.

Master OK additions carry `승인=예`; other OKs and removals carry `승인=아니오`.
The input instructs the model to act on one approved proposal, ask which proposal
when there are several, ask which part is concerning for uncertainty, remain
silent for other reactions, and stop and ask when OK is removed. These are model
instructions, not a mechanical command cancellation mechanism.

Cogs no longer sends automatic receipt `👀` in the ordinary, running-turn, or
bridge-window paths. Its server manages read receipts. Telegram receipt reactions
are retained because Telegram does not have the same Cogs read receipt mechanism.

The poll offset advances to `update_id + 1` and repeated update IDs are skipped.
Cogs reaction delivery confirmation (server PR #88) happens on the next poll with
that offset; it means the update was received, not that the AI completed its work.
The server metadata and author restriction are supplied by cogs PR #96.

## Verification

```
bun test src/server/runtimes/codex/reactionInput.test.ts
bun test src/server/runtimes/codex
bun run typecheck
```

The focused tests cover author routing, heart deferral, cancellation, bot/hop
filtering, update dedupe, master approval, running-turn steer without a receipt,
steer failure, arrivals during steer, Unicode previews, poll subscription and
Cogs receipt removal. Network, model execution and live service processes are
replaced by test dependencies; live UI behavior and semantic model compliance
require post-deployment checks.

Fault injection: force every reaction to wake (four focused tests fail), or
force ordinary human OK to carry approval (one focused test fails). Restore the
source before the normal verification run. Rollback is a revert of this PR's
commit; there is no database migration.
