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

The focused privacy/reaction suite passes 27 tests. Full runtime regression passes 877 tests, with 5 live Codex CLI/model integration tests skipped and no failures. TypeScript 5.9.3 type checking, web build and diff checking pass. Actual iOS rendering, model execution, live approval callbacks and production delivery remain unverified. No deployment or restart is part of this verification.

`uiStrings.test.ts` covers matching ko/en key sets, external overrides with bundled fallback, structured Cogs approvals and callback codes, folder-wide root metadata and stable permission identity across display languages. `scheduleUi.test.ts` covers hidden scheduling control markers, LLM explanations of tool results and metadata-only closure after summary exceptions. The pre-fix code fails the two marker/exception regression cases; the fixed code passes all three scheduling cases.

Cogs approval producers require the server changes in cogs PR #119. The server adds localized compatibility `text` to coded buttons/callbacks for old cores. Ordinary Cogs activity args remain only `target` and `count`; approval cards have their own `request_id`, `operation_code`, `detail`, `risks` and optional `grant_root` fields. Telegram and legacy dashboard strings render from locale resources. `B3OS_UI_LOCALE=ko|en` selects display language; `B3OS_UI_LOCALES_DIR` can override catalog entries. Permission identity text uses a fixed Korean representation to preserve existing grant keys across UI language changes.
