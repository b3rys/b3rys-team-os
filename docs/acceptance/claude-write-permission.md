# Claude file-write permission adapter

## Scope

The folder-mode Claude permission callback checks the canonical target, invokes a separate tool-free Sonnet checker, and requests an owner card only after both checks allow the operation. The card binds the original tool input and canonical target to a single execution. Issuance, callback and handoff verify the owner generation. Missing ownership, expired approval, changed input, malformed checker output and checker timeout deny execution.

This PR covers Write requests reaching this adapter. It does not establish a common execution gate for folder-autoallowed operations, power mode or Codex. Bash approval remains a separate change. **Next PR:** hardlink handling and link-replacement races. These are not covered by the canonical-path checks here.

## Feature and verification map

| Feature | Source | Focused check | Result |
|---|---|---|---|
| Tool-free checker, 30-second deadline, fail-closed parsing | cogsChecker.ts, cogsCheckerPolicy.json | cogsChecker.test.ts | 7 tests passed; error-to-allow mutant detected |
| Input redaction | cogsChecker.ts | structured secret fields, secret-file payload, access_key/accessKey regression | missing-access-key mutant detected |
| Canonical target classification | cogsPathGate.ts | cogsPathGate.test.ts | 16 assertions passed, including symlink/.. and dangling links |
| Protected target → checker → card | cogsPermissionGate.ts | cogsPermissionGate.test.ts | failures create no card; one execution-correlated audit |
| Owner-bound approval handoff | cogsCardApprover.ts | cogsCardApprover.test.ts, ownerBinding.test.ts | fresh owner succeeds; generation change denies |
| Explicit MCP transport | cogsPermissionMcp.ts, cogsRunner.ts | gate IPC and runner tests; real CLI below | callback reached after CLI configuration correction |

The card-enabled CLI uses explicit settings and strict MCP configuration, with inherited setting sources, hooks, plugins, memory and slash commands disabled. CLI safe/restricted mode disables the approval MCP itself; it therefore remains on the tool-free checker but is not used for the card-enabled execution CLI. This is a configuration distinction, not a claim of identical isolation.

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
