# cogs group room enrollment

## Contract

`POST /members/b3chat/member/:memberId/rooms` accepts
`{room_id,user_id,owner_user_id,agent_id}` through the existing local link guard.
The registry supplies the API origin; the member's existing bot token authenticates
`getRoomLink` at cogs. Every proof field must match. No request-supplied URL or token
is used. Under `registryLock`, the handler reads the current registry, rechecks the
channel identity and the exact bot-token snapshot, appends the room once, and uses `writeRegistrySafely`.

Codex reads the current channel allowlist before processing each received update. An omitted `allow_from` retains the launcher seed; an explicit empty list denies all rooms.
Missing registry/channel, invalid channel, or changed API origin deny access.
Telegram keeps its existing launcher seed. `cogsPoll.ts` is a separate
`claude_channel`/`cogs_inbox` adapter and remains private-only; it is not the Codex
channel bridge. Claude group response support is outside this change.

## Checks and results

| Feature | Sources | Check | Mutant caught |
|---|---|---|---|
| Authenticated enrollment | `routes/b3chatRoomLinks.ts` | Missing key, remote caller, forwarded caller rejected without mutation | Remove route link guard |
| Trusted membership/owner proof | same | All four binding fields individually mismatched | Ignore owner mismatch |
| Idempotent preservation | same | Duplicate enrollment, concurrent distinct rooms, unrelated registry edit, channel replacement | Replace instead of extend existing allowlist |
| Live allowlist reread | `runtimes/codex/cogsAllowlist.ts`, `bridge.ts` | Observe enrollment/removal without restart; missing member denied; Telegram unchanged | Always return startup seed |

Paths are relative to `src/server/`. New tests are in `routes/b3chatRoomLinks.test.ts`.

- **44 tests passed, 0 failed, 134 assertions** across four related test files.
- `bun run typecheck`: **PASS**.
- Four mutants: assertion failures in every case; normal sources restored; final
  baseline rerun passed. No compile error was counted as a caught mutant.

```sh
TEAM_AGENT_REGISTRY=/tmp/isolated-unused-registry.json bun test \
 src/server/routes/b3chatRoomLinks.test.ts \
 src/server/routes/b3chatPermissions.test.ts \
 src/server/lib/registrySafety.test.ts \
 src/server/runtimes/codex/bridgeChannel.test.ts
bun run typecheck
```

Tests create temporary registries and simulated bot credentials; no live registry,
model turn, production credential, or service restart is involved.

## Regression checks

- Omitted list keeps seed `[10]`; explicit `[]` yields no allowed rooms.
- Replacing bot identity 42 with 99 during verification returns 503 without enrollment.
- Rotating only the credential for bot 42 also returns 503; a new verification request can then enroll.
- Both regression mutants were caught by assertions: restore null-to-empty fallback; remove token snapshot comparison. Normal source restored and the related suite/typecheck passed.
- The external reproduction scenarios were rerun with corrected assertions: observed seed `[10]`, stale-identity response 503, no allowlist write. The original reproduction file was not modified.

## Dependencies and gaps

- Builds on the registry lock/link guard in PR #586; the PR is stacked on that branch.
- Requires the companion cogs `getRoomLink` implementation.
- **Real running Codex new-room mention → response has not been verified.** The
  reread function and existing bridge channel regressions are tested, not a live model.
- Actual two-process relay integration and iOS UI remain unverified.
- Already-linked room removal is not synchronized back to `allow_from` here. cogs
  membership gates remain authoritative; explicit revocation sync is a follow-up.

## Structure and rollback

One dedicated enrollment route and one allowlist-read function; shared index/bridge
only call them. Registry read-modify-write is under one lock; no duplicate policy
service or new polling worker. Revert this feature commit without reverting #586.
Existing room entries remain in registry; no automatic deletion is part of rollback.
