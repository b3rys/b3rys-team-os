# Agent-friendly codebase — full notes on the source talk, with our adoption verdict

Source: a video introducing a Cursor engineer's talk (YouTube `o_7vTaHOL28`). Watched through auto-translated captions, so wording is approximate. The talk describes one engineer merging about 1,000 PRs a month with agents, and the codebase ("Grokbot", built on an in-house agent-oriented app framework) that made it possible. Everything below is the talk's content; the **Verdict** column is ours.

Verdicts: **Adopt** = use as is · **Adapt** = use in our form · **Later** = useful once the prerequisite exists · **Skip** = not for us now (reason given).

## 1. Trust comes in order

| Talk says | Verdict | Our form |
|---|---|---|
| Agents scale only as far as you trust one agent's output. Plot: number of agents vs. trust; you move right only after trust rises. Don't jump to 100 agents — you burn tokens. | Adopt | Parallel teammates only on work whose verification is automated; otherwise one owner + review. |
| Order: verification → skills → codebase structure → move review rules into lint/CI → scale out. Don't skip steps. | Adopt | Same order in project setup; each step is a row in the feature ↔ verification table. |
| A manager who doesn't trust the team watches over shoulders; the team then moves at the supervisor's speed. | Adapt | Remove the relay work (a human copying screenshots/errors, re-running checks by hand); keep the required review and approval gates (TEAM-OS §4). |

## 2. Verification is the first capability

| Talk says | Verdict | Our form |
|---|---|---|
| The agent must run the code itself: drive the app (Chrome DevTools Protocol for Electron/web, simulator utilities for iOS), take CPU traces and heap snapshots. "Don't read the code and judge — run it and check." | Adopt | App probes with anchors; CPU/timing traces; headless-first for logic. |
| If a human copies screenshots/console errors to the agent, the human is the blocker. | Adopt | Agents own repro and evidence; the human only decides direction. |
| An early "control the app" skill was the first skill built. | Adopt | Probe launch + anchors are shared tooling, not per-task scripts. |
| **Feature map**: a file telling the agent how to reach every feature (UI path, keyboard shortcuts, element names/attributes for CDP). Vague reports or a lone screenshot with "?" can then be mapped to a feature. | Adopt | The "access" column in the feature ↔ verification table. |
| A plugin skill generates the verification setup and the feature map for a codebase. | Later | After our runner and table stabilise, generate rows from the source. |
| A cloud agent picks up every incoming bug report automatically, reproduces it on a desktop running the app, and reports, e.g. "reproduced, but already fixed on main — ship a new build". | Later | Needs a runner that works unattended and an app host that can take a key window; start with local repro-before-fix. |
| Start local (watch the agent run the app yourself), then move to the cloud so the whole team benefits. | Adopt | Local first. |

## 3. Skills and evals

| Talk says | Verdict | Our form |
|---|---|---|
| A skill is markdown that encodes instructions and context; give the model high-quality tokens from the start. | Adopt | Team skills. |
| Watch every tool call and thought; each failure mode you see becomes a skill ("stop hallucinating; search the code yourself"). Be an active driver, not a passive observer. | Adopt | Failures → skills / rules / checks (the ratchet). |
| Keeping skills current: evals are unit tests for skills. An orchestrator creates sub-agents in separate directories with neutral names so they don't know they are being evaluated (they change behaviour if they know). | Adapt | Eval a skill change against real past cases before merging it; blind naming where practical. |
| Run evals across several models; use a different model as a juror to score, reducing self-bias. | Adapt | Cross-model review (we already use external models for review). |
| "Hill-climb" an eval with a loop command until it scores 10/10. | Adapt | Only with a fixed rubric and a stop condition, never open-ended. |
| Maintaining skills is hard and needs taste and observation. | Adopt | — |

## 4. The codebase is the strongest lever

| Talk says | Verdict | Our form |
|---|---|---|
| "Never rewrite" is the conventional wisdom; the speaker argues it is worth considering. Big-tech monorepos are already built for the least capable engineer (frameworks, guard rails, credentials that stop an intern deleting production) — agents do well there for the same reason. | Adapt | Guard rails first; a rewrite needs its own cost case (not implied). |
| Vibe-coded prototypes have no guard rails; agents take the easiest path and you get stuck in code nobody understands. A new codebase needs a strong foundation. | Adopt (scope) | Applies to long-lived, multi-agent codebases. **Not** to prototypes or small throwaway projects. |
| The speaker spent heavily (600+ PRs of refactoring) moving Grokbot to a new architecture, and now barely reads the code; designers, PMs and GTM staff can add features without breaking it. | Later | Only where the ROI is clear (a product with a long life). |
| Architecture doc, first line: an agent works from one command, a narrow space and neighbouring files, without the whole picture. Five typical behaviours: mimic the nearest pattern; put code in the open file; take the shortest path that compiles (`any`, reaching into another folder); add a new function next to the old one; follow the instruction even against the rules. | Adopt | The habit table in SKILL.md. |
| Behaviour is a predictable input to design. Rules: the right path must be the shortest; one folder per feature with fixed file names and one pattern; forbidden dependencies break mechanically (CI blocks the import); new features go in isolated files, not a new case in a shared router switch. | Adopt | SKILL.md structural answers + a dependency check in CI. |
| Everything for a feature lives in one directory ("80% of the work is already encapsulated there"). | Adapt | For new features; existing large files are not a violation by themselves. |
| Framework-specific bans enforced in CI, e.g. React `useEffect` banned in their framework. | Adapt | Per-stack bans only for patterns we have seen cause bugs, each with a failing example. |
| Code comments banned, because 99% of agent comments record history ("someone said never do X") instead of explaining code. | Adapt | We keep "why" comments; history goes to commits/docs, not code. A check for history-style comments is a candidate, not a rule. |
| Five enforcement layers: codebase structure; blocked dependencies + static analysis (lint, compiler diagnostics); rule files; skills; bug-bot review. The first two are hard; the rest are soft and can be forgotten. Invest in the hard ones. | Adopt | Enforcement layers in SKILL.md. |
| Language choice matters: a strict compiler (Rust's borrow checker) lets you trust "it compiled" more. | Adapt | Prefer strict typing/compile checks where we choose the stack; not a reason to switch stacks. |
| If code review keeps making the same comment, treat it as a smell: turn it into a CI failure or remove the possibility. | Adopt | Ratchet: a comment made twice moves up a layer. |
| PRs of 50–1,000 lines; atomic PRs make git history a rich context and changes easy to revert. | Adopt | Small atomic commits/PRs per change. |

## 5. Cost

| Talk says | Verdict | Our form |
|---|---|---|
| Asked about tokens: the speaker works at a lab with effectively unlimited tokens; others can get there without going broke. For a tech lead it is an ROI question: spend tokens preparing the codebase so even a weak agent can work, instead of hiring into a fragile original. | Adapt | Spend on guard rails and verification where the product lives long; measure the return. |
| 1,000 PRs a month doesn't mean the agent got faster; it shows an environment where humans no longer sit in the middle. When the agent keeps making mistakes, look at what the environment lacks before rewriting the prompt. | Adopt | Fix the environment (checks, structure, map) before the prompt. |

## When this does not apply

- Prototypes, spikes, solo and short-lived projects put speed first: keep the structure-and-code basics (SKILL.md "Always" column) and skip the situational tooling (feature map, CI bans, evals, cloud repro, full runner).
- A working area you are not changing: don't restructure it to match these notes.
- Anything seen once: note it; turn it into a check only when it repeats.
