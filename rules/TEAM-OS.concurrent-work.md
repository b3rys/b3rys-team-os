# TEAM-OS Concurrent Work Detail

> On-demand detail for TEAM-OS §12.

## Scope

This applies when multiple members can edit the same git repository or shared working tree.

## Branch And Worktree Rules

- Edit git-tracked files only on a task branch/worktree.
- One task uses one branch.
- A task card names its branch when a branch exists.
- A review or handoff of code/docs names the branch.
- If no branch is named for a code review, the reviewer should ask for it before reviewing.

## Commit Discipline

Commit meaningful verified slices promptly. Do not leave bulk uncommitted work in a shared tree.

Before deploy, restart, or release:

- relevant changes committed
- tests/typechecks/acceptance checks run as appropriate
- review/gate complete
- rollback path or snapshot available
- coordination ping sent when another member may also restart/deploy

## Ownership Coordination

Use one owner per file or area where possible. Before touching another owner's area, coordinate first.

If a shared file has mixed changes, do not silently split or overwrite. The area owner resolves the conflict and re-reviews.

## Cleanup

Remove worktrees after their branches merge and prune stale worktrees periodically.
