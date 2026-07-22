# TEAM-OS Task Management Detail

> On-demand detail for TEAM-OS §10. Use with `skills/b3os-task-loop/SKILL.md` and `skills/b3os-bwf/SKILL.md`.

## Board Contract

The Tasks kanban is a status board backed by the task DB. It is not a full PM database.

A card has four fields:

- title: result or action in one line
- assignee: one final owner
- status: plan, doing, or done
- description: goal, scope, plan, completion criteria, next action, resume time, fallback, stop rule, verification evidence, and notes as needed

Blocked work stays in plan/doing with a blocked marker in the description or badge. Do not create a separate blocked column.

## When To Card

Card the work when any condition is true:

- expected to take 10+ minutes
- handoff is needed
- deploy or real-environment confirmation is needed
- wait/resume is needed
- continuation guard should be able to wake the owner

Small work may stay in the thread if owner, next action, and completion basis are explicit.

## Execution Flow

1. Discussion/specification happens in chat, not on the board.
2. Owner writes scope and completion criteria.
3. Team lead confirmation starts execution.
4. Owner creates or updates the card.
5. Owner keeps the card current until done, blocked, or awaiting confirmation.

Completion criteria must say which gate is included: code-complete, deploy-complete, real-environment-confirmed, or another explicit state.

## Owner And Handoff

Distinguish communication owner from task owner. A communication owner may need to switch to PM and delegate execution to the right capability holder.

Handoff is complete only after one of:

- receiver ack with next action or ETA
- receiver refusal with reason and recommended owner
- receiver result with verification basis
- blocked/waiting state with resume time, fallback, and stop rule

Until then, the previous owner still tracks the work.

## Status Summaries

When asked for current work, open tasks, or who was doing what:

1. query the kanban first
2. reconstruct by doing, plan, recent important done, waiting/on-hold
3. add known in-thread immediate exceptions
4. card any missing active item you own

Do not rely on memory alone.

## Autonomy Modes

- turn mode: one-question/one-answer review or discussion
- drive mode: default execution mode; keep next action, resume time, fallback, and stop rule
- full-autonomy mode: broader delegation from planning through verification/reporting; state scope, authority, and stop rule clearly

Drive mode prevents unfinished work from disappearing. It is not permission to invent unrelated work.

## Harness Sizing

Harness is a quality/execution method, not BWF itself.

Use harness only when all are true:

- work decomposes into independent pieces
- each piece reads a different actual source
- value exceeds coordination cost
- N, budget, scope, and verification are defined

If any answer is no, go solo.

Default sizing:

- turn mode: solo
- drive mode: limited harness, usually 2-3 and capped by source splits
- full-autonomy: broader harness within machine/runtime caps

The cap is a ceiling, not a target. Manual-spawn runtimes require `max_agents`, budget, stop rule, and return schema before fan-out. Ambiguous existing instructions must not run uncapped.

Large fan-out or multi-member concurrent fan-out needs team lead notice, estimated cost, and stop rule before execution.

## BWF Minimum

BWF drives confirmed execution/delegation work through:

1. PM plan and card
2. assignment and ack tracking
3. execution and quality method
4. verification
5. report and closure
6. learning hook

Small immediate work can use a light version, but the owner still reports completion basis.
