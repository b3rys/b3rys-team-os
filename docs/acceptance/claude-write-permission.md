# Claude file-write permission adapter

## Scope

The folder-mode Claude permission callback checks the canonical target, invokes a separate tool-free Sonnet checker, and requests an owner card only after both checks allow the operation. The card binds the original tool input and canonical target to a single execution. Issuance, callback and handoff verify the owner generation. Missing ownership, expired approval, changed input, malformed checker output and checker timeout deny execution.

This PR covers Write requests reaching this adapter. It does not establish a common execution gate for folder-autoallowed operations, power mode or Codex. Bash approval remains a separate change. **Next PR:** hardlink handling and link-replacement races. These are not covered by the canonical-path checks here.

## Feature and verification map

| Feature | Source | Focused check | Result |
|---|---|---|---|
| Tool-free checker, 30-second deadline, fail-closed parsing | cogsChecker.ts, cogsCheckerPolicy.json | cogsChecker.test.ts | 7 tests passed; error-to-allow mutant detected |
| Input redaction | cogsChecker.ts, redactSecrets.ts | structured secrets, secret-file payload, access keys, Authorization/Proxy-Authorization Bearer and Basic in ordinary content | access-key and header-redaction removal mutants detected |
| Canonical target classification | cogsPathGate.ts | cogsPathGate.test.ts | 16 assertions passed, including symlink/.. and dangling links |
| Audit privacy | cogsPermissionGate.ts | checker reason quotes synthetic content and raw path | regression failed before fix; fixed-code audit passes without either value |
| Protected target → checker → card | cogsPermissionGate.ts | cogsPermissionGate.test.ts | failures create no card; one execution-correlated audit |
| Owner-bound approval handoff | cogsCardApprover.ts | cogsCardApprover.test.ts, ownerBinding.test.ts | fresh owner succeeds; generation change denies |
| Explicit MCP transport | cogsPermissionMcp.ts, cogsRunner.ts | gate IPC and runner tests; real CLI below | callback reached after CLI configuration correction |

The card-enabled CLI uses explicit settings and strict MCP configuration, with inherited setting sources, hooks, plugins, memory and slash commands disabled. CLI safe/restricted mode disables the approval MCP itself; it therefore remains on the tool-free checker but is not used for the card-enabled execution CLI. This is a configuration distinction, not a claim of identical isolation. In an independent CLI 2.1.310 input-assembly probe, user and parent CLAUDE.md automatic loading was absent; the workspace CLAUDE.md was present because the runner reads it and supplies it via `--append-system-prompt`. This is not a claim that all CLAUDE.md files are blocked. Installed-plugin and managed-policy fixtures, and the minimum supported CLI version, were not measured by that probe.

## Actual CLI fixture results

All paths and contents were temporary synthetic fixtures. No real credential files, live card sends or live databases were used. Sonnet ran both the execution CLI and the separate checker. Card decisions were supplied by a fake approval callback.

| Case | Observed result |
|---|---|
| Ordinary outside Write | Checker allowed, one card callback, file created with expected content |
| Synthetic secret-file Write | Checker denied, zero card callbacks, no file created |
| Protected audit fixture | Zero card callbacks, original file unchanged; permission callback denial observed |
| Ordinary outside writes, five samples | 5/5 checker allow; 5/5 one card callback and file creation; approximately 7.6–8.3 seconds per sample |

The protected existing-file fixture granted Read on that exact synthetic file to remove the CLI's unread-file precondition. Write permissions and the production gate were unchanged. An earlier unread-file failure is not counted as protection evidence. The five-sample result is an observation, not a reliability guarantee or a full usability evaluation. The prompt was unchanged across these samples.

## Validation boundaries

Focused T3 checks: 37 tests / 173 assertions passed across six files. After the CLI configuration and redaction fixes, the affected checker/gate/runner checks passed 17 tests / 108 assertions. Typecheck and `git diff --check` passed. Independent T1 review identified an access-key redaction defect; it was fixed with a regression check. Final-head independent review is tracked in the PR rather than inferred from earlier heads.

Not validated here: live owner-card transport, live deployment, all environment isolation paths, all possible secret encodings, hardlink/race protection, full-mode/Codex common gating. No merge, deployment or service restart was performed.

## Rollback

Revert this PR before deployment. No migration was applied to a live database by these checks. The owner-binding column introduced by this branch is nullable and intentionally does not backfill legacy approvals.

Audit privacy follow-up: the new regression failed on the pre-fix gate (2 pass / 1 fail). After replacing checker prose in audit records with fixed reason codes, gate and checker checks passed 10 tests / 69 assertions; typecheck and diffcheck passed. Caller-facing denial remains separate from the audit record. This change does not constitute a new actual-CLI run.

## Header and runtime-configuration follow-up

Authorization and Proxy-Authorization Bearer/Basic credentials are masked in ordinary string content before the checker receives it. Regression cases cover case-insensitive header/scheme names, tab separators, CRLF content and JSON-quoted headers; original input remains unchanged for owner-bound execution. The header test failed before the fix (7 pass / 1 fail); removing the masking rule also failed (mutant exit 1).

The first-layer protected paths retain all of `~/.claude`, `~/.codex` and `~/.openclaw`, and additionally include `~/.claude.json`, which can contain MCP configuration outside the directory. No media/downloads/tmp exception is introduced. The runner IPC fixture submits path names only and observes `protected_path` for these four targets, no checker call and no card call; it does not read or write those targets.

Focused checker, runner, gate, path and shared-redaction consumer checks: 33 tests / 309 assertions passed. This follow-up is not a new actual-CLI or live-card run. To undo only this follow-up before deployment, revert its commit; no live data migration is involved.
