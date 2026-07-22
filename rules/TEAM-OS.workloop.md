# TEAM-OS Workloop Detail

> On-demand detail for TEAM-OS §11. Use with `skills/b3os-task-loop/SKILL.md`.

## Contract

A workloop is recurring operational work started by the team operations system waking the responsible owner. Members do not create per-runtime cron jobs for standard team loops unless explicitly approved.

When receiving a `[workloop: ...]` wake:

1. identify the loop and responsible owner
2. query actual state from the canonical source
3. verify that state instead of trusting the wake itself
4. complete the loop in the same turn as one of: done, updated, reported, blocked, awaiting-confirmation, or next-wake-scheduled
5. report concise evidence and remaining risk

An automation ping is not recovery, completion, or proof.

## Ownership

The recurring-work owner is selected by capability/role in `agents.json`. If unclear, the `coordinator` capability holder is fallback. If a reduced one-person or degraded operation is used, say so in the report.

## Required Fields

Every loop needs:

- owner
- canonical source to query
- completion state
- stop rule or expiry
- fallback/escalation rule

Repeated failure escalates rather than looping indefinitely.

## Standard Loops

Kanban PM loop:

- query doing/plan cards
- flag stale or missing next-action/resume/fallback/stop-rule fields
- report the concise current state
- update own cards
- do not delete or reassign cards without approval when that changes ownership or scope

Self-learning loop:

- collect and organize candidates
- request review when required
- report kickoff/interim/final state as appropriate
- do not promote policy/security/routing/external-send changes without approval
