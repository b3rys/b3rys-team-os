# Cogs activity metadata privacy

Cogs activity requests carry structured codes and sanitized data separately from human/model message text. Raw runtime display lines and the retired `command`/`query` argument keys must not reach app requests.

| Behavior | Source | Headless verification | Deliberate regression | App verification |
| --- | --- | --- | --- | --- |
| Activity target contains only an executable with an explicitly allowed subcommand, basename, hostname, or sanitized search text; file counts remain numeric | `cogsActivity.ts`, `bridge.ts` | `cogsActivityPrivacy.test.ts` (15 tests), `reactionResponse.test.ts` (12 tests) | Raw command in target; legacy command/query keys; lost edit arguments | Not run; mock HTTP verifies producer requests |

Run from the repository root:

```sh
bun test src/server/runtimes/codex/cogsActivityPrivacy.test.ts src/server/runtimes/codex/reactionResponse.test.ts
bun run typecheck
```

Synthetic fixtures cover curl headers/body/URL credentials, command arrays, environment assignments, shell wrappers, known/unknown subcommands, file paths/counts, hostname extraction and search redaction. Integration tests drive `handleMessage` through `tgEdit` and, after a simulated edit failure, `tgSend`. Every captured request must omit raw activity text and old command/query keys at both top level and inside args. Receipt text is empty; final text is model output.

Changing the formatter to emit a raw target or restore legacy fields makes the structured fixture tests fail. Dropping the edit wrapper's activity arguments makes the HTTP edit test fail. All mutations are restored before the final verification run.

The focused suite passes 27 tests. The existing `cogsActivity.test.ts` currently has 3 failures in legacy display-label expectations after the locale/code refactor; its other 3 tests pass. The complete bridge refactor remains a draft. Full runtime regression, actual iOS rendering and live delivery are unverified. No deployment or restart is part of this verification.
