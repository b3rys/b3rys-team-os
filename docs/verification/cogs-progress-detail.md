# Cogs progress descriptions

| Feature | Source | Headless checks | App check | Mutant | Gaps |
| --- | --- | --- | --- | --- | --- |
| Working response shows a short selected description without commands/full paths | `hooks/telegram-progress.py`, `src/server/routes/cogsProgress.ts`, `src/server/lib/cogsTyping.ts`, `src/server/lib/cogsProgressDetail.ts` | Commands below; 45 Unicode character cap, dangerous-pattern rejection, basename selection, same-tool target changes and deduplication | In a cogs conversation invoke Bash with a description, then Read/Write; confirm activity target changes in one response bubble and answer completes it | Isolated hook/server secret passthrough: both caught | Running app and live transport not exercised; pattern filtering cannot identify arbitrary unlabeled sensitive text |

Only Bash `description` and file-tool basenames are selected. Commands, file contents and other tool input fields are not forwarded. Suspect descriptions are omitted entirely. The server validates the selected detail again before sending `cogs_activity_args.target`. Unknown/absent detail retains the existing kind-only activity.

## Verification

- `bun test src/server/lib/cogsProgressDetail.test.ts src/server/lib/cogsTyping.test.ts src/server/routes/cogsProgress.test.ts`: 28 pass, 0 fail.
- `python3 -m unittest discover -s tests/hooks -p test_cogs_progress.py`: 11 pass.
- `python3 scripts/check-cogs-progress-detail-mutation.py`: injected `token=` passthrough produces 2 server test failures and 1 hook test failure; both mutants caught. Mutations run in temporary copies, not the working tree.

## Exercised examples

- Bash description `Run activity tests` → target `Run activity tests` (command ignored).
- Read file `/Users/private/cogsTyping.ts` → target `cogsTyping.ts`.
- Write file `C:\private\note.md` → target `note.md` (content ignored).
- Description `token=fixture` or file `.env.local` → no target.

## Rollback

Revert the feature commit through a new PR. No runtime configuration, database or deployment changes are included. Existing clients that send no detail continue to work.
