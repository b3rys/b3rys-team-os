# TEAM-OS Learning And Compaction Detail

> On-demand detail for TEAM-OS §9. TEAM-OS.md keeps the core gates; this file holds procedure.

## Learning Flow

1. Capture lessons discovered during real work in `SHARED.md`.
2. Curate for recurrence and stability; avoid one-off noise and temporary setup failures.
3. Promote only stable lessons to TEAM-OS or skill-change candidates.
4. Review policy, security, routing, and external-send changes before applying.
5. Get the team lead's approval for TEAM-OS changes.
6. Leave what changed, why, where it was applied, how it was verified, and how to revert.

Team-level lessons do not live only in one member's personal memory. Use `SHARED.md` or the relevant team skill.

## Self-Learning Loop

The weekly self-learning loop is a bounded governance loop. It is for review, risk discovery, cleanup, and proposals; it does not expand its own authority or silently start execution.

Default deliverables:

- `SHARED.md` cleanup result
- TEAM-OS promotion candidates
- skill or personal-setting candidates
- project next actions where relevant
- explicit no-op when there is nothing useful to propose

If co-review is delayed, report the delay and interim judgment separately. Do not silently convert a pending review into approval.

## Proposal Governance

Improvement proposals should be small, evidence-backed, and reviewable.

Minimum quality bar:

- problem
- evidence
- expected value
- risk
- next check or decision
- duplicate/supersedes status when relevant

Rejected or duplicate proposals should not be recycled without a new basis. The goal is fewer, better proposals with a higher adoption rate, not more activity.

Review defaults:

- separate proposer/owner from reviewer when possible
- require at least one critical/adversarial view for risky or policy-level changes
- record decision and reason
- keep execution separate from approval

## TEAM-OS/SHARED Compacting

Compacting is a governed curation task.

Required gates:

1. preserve original source in archive or git history
2. create a compact draft/diff
3. run a DO-NOT-COMPACT checklist
4. keep owner/safety/core rules in always-load text
5. move only non-core procedure to on-demand docs or skills
6. verify behavior against real code/state/logs where behavior could change
7. obtain review
8. wait for final team lead diff approval before applying to main

DO-NOT-COMPACT checklist:

- `SECTION_CORE_RULE`
- owner routing rules
- safety/security rules
- external-send/self-mod/credential/deletion/payment approval gates
- rule-change review and behavior-verification rules

When moving detail out, leave a short summary and exact reference path in TEAM-OS.md. Avoid proper names, dated incident stories, and runtime product names in the rule body; preserve functional differences using generic descriptions such as "auto-load runtimes" and "explicit-load runtimes."

## Metrics

Periodically check whether the learning loop improves work quality. Useful signals include adoption rate, duplicate rate, blocked/reopened work, review defects found before release, and cost/time spent per accepted improvement.
