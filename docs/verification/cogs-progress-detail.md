# Cogs progress descriptions

| Feature | Source | Headless checks | App check | Mutant | Gaps |
| --- | --- | --- | --- | --- | --- |
| Working response shows a short selected description without commands/full paths | `hooks/telegram-progress.py`, `src/server/routes/cogsProgress.ts`, `src/server/lib/cogsTyping.ts`, `src/server/lib/cogsProgressDetail.ts` | Commands below; 45 Unicode character cap, dangerous-pattern rejection, basename selection, same-tool target changes and deduplication | In a cogs conversation invoke Bash with a description, then Read/Write; confirm activity target changes in one response bubble and answer completes it | Isolated hook/server secret passthrough: both caught | Running app and live transport not exercised; pattern filtering cannot identify arbitrary unlabeled sensitive text |

Only Bash `description` and file-tool basenames are selected. Commands, file contents and other tool input fields are not forwarded. Suspect descriptions are omitted entirely. The server validates the selected detail again before sending `cogs_activity_args.target`. Unknown/absent detail retains the existing kind-only activity.

Both boundaries reject short credential prefixes, mixed alphanumeric words of eight or more characters, authentication/secret marker words, address-like words and Unicode Cc/Cf controls. File targets require a permitted source/document/image extension and must not match sensitive filenames. This deliberately omits some harmless descriptions rather than forwarding ambiguous material. The shared 30-case fixture covers the review inputs and safe controls.

The first progress update is immediate. Further activity updates in the same typing session are coalesced to the latest code/target, at least one second apart. Completion, no-reply, stop and cap expiry discard delayed activity; final answers do not wait for this timer.

## Verification

- `bun test src/server/lib/cogsProgressDetail.test.ts src/server/lib/cogsTyping.test.ts src/server/routes/cogsProgress.test.ts`: 33 pass, 0 fail, 185 assertions.
- `python3 -m unittest discover -s tests/hooks -p test_cogs_progress.py`: 12 pass.
- `python3 scripts/check-cogs-progress-detail-mutation.py`: filter removal produces 4 server test failures and 27 hook assertion/subtest failures; removing the one-second interval produces 3 server test failures. All three mutants caught. Baseline and restored copies pass. Mutations run in temporary copies, not the working tree.

## Exercised examples

- Bash description `Run activity tests` → target `Run activity tests` (command ignored).
- Read file `/Users/private/cogsTyping.ts` → target `cogsTyping.ts`.
- Write file `C:\private\note.md` → target `note.md` (content ignored).
- Description `token=fixture` or file `.env.local` → no target.

## Rollback

Revert the feature commit through a new PR. No runtime configuration, database or deployment changes are included. Existing clients that send no detail continue to work.
