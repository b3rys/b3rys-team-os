---
name: b3os-verification
description: b3rys method for proving that a change or a release is correct — and for making that proof hold and get stronger over time. Use when verifying a fix, a feature, or a release candidate; when deciding what to test headless vs in the running app; when a check fails and you must tell a wrong check from a real defect; or when setting up a one-command release check. Covers the 3 principles, the 5 ratchets, a layer + rubric table with numeric pass lines, a triage table for wrong checks, shared-resource rules for a single app window, the runner contract, and how much of it to apply by project size.
trigger: verify a change / release
owner: steve
---

# b3rys Verification — Prove It, and Keep It Proven

Where this sits among the team skills:

| Skill | Question it answers |
|---|---|
| `b3os-ai-code-safety` | How do we build it? (structure, refactoring) |
| `b3os-sf` | How do we manage and report it? |
| `b3os-harness-playbook` | How do we split it across parallel agents? |
| **`b3os-verification`** | **How do we prove the result is right — now and on every later change?** |

The core idea: a check you set up once must keep protecting you. A new feature or a bug fix ends with **one row in the feature table + a test + a deliberately broken version that the test catches**. The runner does the rest, every time.

Passing the runner is evidence for review and approval (TEAM-OS §4), not a substitute for them.

**Scope:** §1–5 apply to every change. §6–7 (one app window, the app runner) apply to products with a running app; for server or script work, skip them.

---

## 1. Three principles

1. **Run it; don't read it.** A diagnosis from reading source is a *candidate*. It is not a conclusion until a repro or a measurement confirms it.
2. **The feature ↔ verification table is the single source.** One feature = one row. Each row has: source files (for change-scoped runs) · headless tests · app check (family + steps) · performance gate with baseline · the mutant and whether it is proven caught · last result (date, sha, verdict) · gaps · **access** (UI path, shortcut, probe anchor ids — so any agent can map a vague report or a screenshot to a feature and drive it).
3. **Budget first.** One fix = 10 minutes; tests and verification included = 30 minutes. If a check would blow the budget, say so early and change the method (split, parallelize, move it headless). Do not drop the spec to fit the time.

## 1a. Per PR — fix the finish line first, run only what changed

- **Scope line first.** Before any test or check, write one line: changed → will run → will not run. A small change (a menu position, a label) runs the checks it reaches — its unit tests and the affected UI check — and reuses the same head's existing records; do not restart a full release run for it. Do not start a release while the lead is still choosing the spec.
- **Finish conditions are written when the PR opens, not discovered in review.** The PR body lists the checks that prove it: which tests (unit, the changed feature's app tests from the table), which captures or device checks, and what result passes. The author and the reviewer agree on the list in the first round. Later rounds add a required check only for a defect found or a risk the list missed, and say which one. "Done" is that list passing on the exact head that merges.
- **Per PR, run what the change reaches; the full suite only with approval (§1b).** The feature table maps changed files to checks (`b3os-sf` → dev-mode-operations, "검사 4단계"). The default per PR is the changed features' checks, not the full suite. The table's escalations still apply: a shared file pulls in the features that use it, a file missing from the table widens to its whole module, and a root config, a large refactor, or a change whose reach the table cannot judge is a reason to ask for the full suite. The full suite runs only with the lead's approval (§1b). When one feature keeps escalating to related checks, that is a structure signal to act on — separately from running the checks it needs now.
- **Say how far each claim got.** Every "verified" or "safe" names its level: ① asserted ② pointed at a real `file:line` ③ walked the failure path and it does not reach ④ ran real code (a test or script that fails loudly if wrong) ⑤ reproduced in the running app. Find the one fact a change is safe because of and take it to ④ or ⑤; report anything below ④ as unproven. For someone else's run, say which: a pass claim in the PR text alone is ①; an execution record checked for the same head, scope, and result (command, log, or result bundle) is "④ by the author, record checked"; a rerun by the reviewer is "④ independent". Ask for a rerun when it answers a defect, a missed risk, or doubt about the record.
- **Release tests model real use only.** Every test in the release run states, in one line, the scene a real user goes through ("type a note, then rename it from the sidebar"). A test that cannot name one stays out of the release run. Bug-hunting tests — random interleavings, hundreds of repeated rounds, load loops, every-combination matrices, timings no person produces — may be used while chasing a bug, but leave the release run once the bug is fixed; the fix keeps a realistic repro test (ratchet ①).
- **Two fixes on one premise failed → test the premise.** When two fixes that share an assumption fail the same check (a flaky test patched twice, a layout nudged twice), write the shared assumption as one sentence and run an observation that would differ if it were false, before a third fix.

## 1b. Release modes — pick one before shipping, full suite only with approval

Every release starts by naming its mode. The mode sets what runs, how long it may take, and who approves. Pick the **smallest mode that fits**; when two fit, take the smaller.

| Mode | When | What runs | Approval |
|---|---|---|---|
| dev | an in-development update for the lead or the team | the build + the required gates (launch/update path, core speed) + the changed area's checks — reuse their recorded results when they ran on the exact shipping head (§1a), rerun only what is missing | normal deploy rule |
| hotfix | a break users hit now | dev + a realistic repro test for the bug | normal deploy rule |
| fix | a user-visible feature change | dev + the changed features' app checks from the feature table | normal deploy rule |
| full | the full acceptance suite | all eligible release checks (§1a: realistic use only, no bug-hunting loops) | **the lead approves a stated reason first** |

- **Full needs a stated reason.** Ask the lead before running it: say what changed and why the scoped checks are not enough. Typical reasons: a shared module many features use, the saved-file or data format, the signing, launch, or update path, a large refactor, or a change whose reach the feature table cannot judge. A public launch or a first release after a long gap may also qualify. Without a reason like these, ship dev, hotfix, or fix. §1a's escalations and the runner (§3, §7) run within the chosen mode; when they point beyond it, that is a request for full, not a license to run it.
- **One time cap for the whole release.** 20 minutes from start to upload for dev, hotfix, and fix — build, lock waits, checks, retries, and upload included. Full gets its cap with the approval (from the last real full run). Past the cap the run keeps going and prints where it is: the last step, what it is waiting on (e.g. who holds a shared machine lock), and the commands still running. The person running it re-checks the plan with that output instead of waiting silently.
- **Put it in the program, not only in the rules** (long-lived products, §8). The release entry point takes the mode as a required argument, reports at the cap, and refuses full unless the lead's approval is recorded for it; any direct entry point to the full suite carries the same guard. Solo work and prototypes: the rule alone is enough.
- **ETA comes from the last real run** of the same mode, not a round number.

Example (a macOS notes app): `ship-quick.sh <dev|hotfix|fix|full>`; the full path and the old full-acceptance script both refuse without an approval variable set from the lead's message.

## 2. Five ratchets — verification that only gets stronger

Each moves in one direction only.

| Ratchet | Rule |
|---|---|
| ① One bug = one test | A bug fix ships with a repro test **and** a mutant (the fix reverted) on which that test fails. The same bug cannot come back silently. |
| ② Twice = a check | A review comment or feedback that repeats twice becomes an executable check (test, lint, CI rule, script guard) — not a line in a doc. Same rule as ai-code-safety's enforcement layers (a comment made twice moves one layer up). |
| ③ Baselines only tighten | Improve → re-pin. Regress → block. Never loosen silently. A baseline change records the value and the condition (load, build type). Display values the lead tuned by hand are baselines too: pin them as a pixel/geometry baseline from the last release, never from the current test's expectation. |
| ④ Wrong checks accumulate | Every check that was itself wrong becomes a triage rule (symptom → cause → action) or a known-flaky entry, so the runner classifies it next time. |
| ⑤ Gap count only goes down | Per build, count rows without an app check, without mutant proof, and UNPROVEN (a mutant that passed). The count must not rise; the runner fails the run if it does. |

**Adding a feature:** a row in the table (with access and sources) → headless tests (+ app steps if something is only visible in the app) → one mutant proven caught → a baseline if it has a performance side. Done — the runner enforces the rest.

## 3. Layers and rubric

Decision logic goes headless; the app check covers only what is visible in the app (focus, real input, input methods, animation, pixels, embedded web views).

| What | Method | Pass line (number) | When |
|---|---|---|---|
| Logic (key → action, state, computed values) | Headless tests + mutants | All pass; mutants fail | Every fix (change-scoped) |
| Incremental computation | Randomized "incremental == full recompute" comparison | Always equal | When its sources change; every build |
| Screen / keys / input method | Short app probes (anchors, key window, real key events) | Anchor on screen; typed chars = delivered chars; IME items pass | Every build |
| Speed: typing | App latency probe | ≤ baseline + ⟨margin⟩ ms (normal, large doc, heavy doc) | Every build (debug = regression gate; release measured) |
| Speed: navigation | Median of N switches, clean settings | ≤ ⟨target⟩ ms at ⟨N⟩ items | Every build |
| Speed: heavy documents | Headless benchmark | ≈ same as a document without the heavy content | When that code changes |
| Design | Pixel diff against a baseline photo; contrast | 0 px over tolerance; contrast ≥ ⟨value⟩ | When UI changes |
| Feel | Key → paint on the 3 most-used actions (e.g. switch note, move cursor, type); burst of keys; composition | Judge outliers, not the mean (p90 / p99 / max), 0 dropped. The verdict comes from the project's table — metric, status (block / report / known), margin, per-condition rows (mode, size, first-key exceptions); probes read it. Example at 60 Hz: one frame 16.7 ms, two 33 ms (Steno burst-step uses p90 33 / max 50, release policy adds 25% speed margin) | Every release (required gate) |
| Safety | Fault injection on open / edit / save | 0 duplicates, 0 lost input, user files untouched | When that code changes |
| Coverage | Gap count in the feature table | Only goes down | Every build |

**Large-volume speed tests reuse a fixed test set.** Before generating a big library or data set, check whether a prebuilt one exists and reuse it; build one once if not. Keep it in a fixed shared location with a short README and the script that made it, treat the original as read-only, and copy it to a temporary place for each run (the app under test writes into it). Regenerate only when it is broken or the scenario changes. Generating per run wastes time and tokens and makes runs incomparable.

Hard-to-measure items get a **written criterion** in the same row, never an empty cell.

## 4. Proving the checks — mutants

- Every row names a mutant: a temporary source change that injects exactly the defect the check should catch. Back up → patch → build → run that row's check → expect FAIL → restore → `git diff` must be empty.
- Add a **control mutant** (the strongest version of the defect, e.g. "never notify at all"). If even the control passes, the check sits where that defect cannot be seen.
- Some defects are **invisible at the app level** (another path redraws the view anyway). Those belong to headless tests; the app check guards what the user sees.
- When moving checks from the app to headless, prove them with **the same mutants** the app check caught.

## 5. When the check is wrong — triage

Tests are often wrong. On FAIL, first decide: **check, environment, or product?** Compare the test's expected answer with the feature's spec doc first — an old rule may be the answer. Until the cause is confirmed, report "cause under check (check / environment / product undecided)" and report the observed user impact separately — real impact such as data loss is escalated at once, whatever the cause turns out to be. Every FAIL line gets a category and the evidence line; a runner applies these rules automatically and reruns once where the rule says so.

| Symptom | Typical cause | Verdict · action |
|---|---|---|
| Every "is on screen" check fails; no anchors at all | The probe's env key is not in the anchor gate (or a mode-valued key only passes when it equals "1") | Check · add the key; a test compares keys used by scripts with the gate |
| Synthetic events all rejected as "another window's" | Events created without a window have window number 0 and screen coordinates | Check · resolve windowless events by global location |
| Animation "jumps / stalls" only in a chained run | Many phases in one long-lived app disturb frame timing | Check · run animation and photo checks standalone; rerun standalone once |
| Photo file missing | The app quit before the last chained segment wrote it | Check · photo checks run standalone |
| Pixel count below threshold after a style change | A fixed colour counted; overlapping layers / display colour space shift it | Check · measure relative to the same photo's background |
| Timing inflated (~2×) | Test settings accumulated state (e.g. thousands of entries from temporary libraries) that the product scans per action | Environment · reset once per run; and in product code avoid O(table) work per action |
| Fix not visible in the app | Source changed but the bundled build output was not rebuilt | Check/process · a content-hash stamp; release scripts refuse a stale bundle |
| "Looks like X" from reading source | Unconfirmed diagnosis | Check · candidate only; confirm with a repro or an anchor/log trace |
| Timing slightly over the line under load | First-sample outlier + high load | Timing · record load, rerun once; twice over = product |
| Incremental state keeps a deleted structure | Real defect | Product · repro test + mutant (ratchet ①) |
| The implementer says a failure "was already there" | Unverified claim | Check · run the same real-key pages on the previous release tag side by side; passed then, fails now = regression |
| All gates pass, but the shipped app hangs at launch on a user machine | Gates launch a re-signed probe bundle and skip the real signed launch path (keychain, permissions, iCloud) | Process · when a release touches the launch path, launch the notarized original once before upload; keep a rollback ready |
| A timing is sometimes ~1 s too long | The check waited on every animation in the window; an unrelated always-running one (an editor caret blink) was still going | Check · judge only the target pane; see the one-run rule below |
| A chained family fails many phases at once, logs cut off, no crash report | Something outside killed the app (another test's cleanup) | Environment · teardown kills only its own processes; record fixed causes in a data table so the repeat-flake warning skips runs before the fix |
| A file-watcher test misses a notice only in full runs | The OS event service lags under a flood of file changes | Environment · on a missed notice, probe the service: alive = real FAIL, silent = visible SKIPPED (never PASS) |

**Settle a suspicious number in one run.** Don't run the app again and again to test one hypothesis at a time. The first diagnostic run records all at once: (1) each condition the verdict waits on and its value, (2) what is still blocking (the animating layer, its key and duration, or a `sample` of a busy thread), (3) a control of the unmodified app in the same run. A chained FAIL: look for a crash report first — none means it was killed from outside. If finding a cause took an hour or more, add a row to this table when done.

## 6. Shared-resource rules (one app window)

- **One app at a time.** Before an app check, the running-instance count must be 0. If another instance appears mid-run, stop and report its pid.
- **No auto-start loops.** A "relaunch when it quits" wait loop cuts into someone else's turn. Checks run once and end; a rerun is decided by the triage rule, once.
- **Turns are explicit.** Take the window on GO, give it back with "탐침 끝" (the agreed stop phrase). Before sending GO to the next agent, get the current holder's stop.
- **Probe bundle id only.** Launch under a dedicated probe bundle id; the user's app id would overwrite user settings (scroll positions, last note, theme). To measure a given build, wrap its binary/resources under the probe id and ad-hoc re-sign.
- **Never touch user folders.** Test data lives in temp folders only; a source-scanning test enforces it.
- **Reset accumulated probe settings once per run** (not per launch — some probes relaunch within a run on purpose).

## 7. The runner contract

One command, cheapest first, one app family at a time:

```
headless fast tier → unit suite → equivalence tier → bundle stamp → app families (one at a time) → summary
```

- **Family script** (`scripts/checks/<family>.sh`): receives `APP` (probe bundle) and `OUT`; never builds; runs once; FAIL lines start with `FAIL`; the last line is `RESULT <family> PASS|FAIL key=value …` (numbers to compare with the baseline, plus `load=`); exit 0 = PASS; honours a "standalone" flag for chain-caused reruns.
- **Families table**: family · stage · command · launches · chain/standalone · scope paths (for `--changed`) · known mutant · `ready | pending-port`.
- **Guard**: refuse a non-probe bundle; BLOCKED if an app is already running; ABORT within seconds if a foreign instance appears (kill only ours); per-family timeout.
- **Output**: one table (family · verdict · numbers vs baseline · launches · time · triage line · log) + the gap count and ratchet status. FLAKY is shown, never hidden as PASS.

## 8. Apply by size

Verification rows only; the structure/code rows live in `b3os-ai-code-safety` ("Apply by project size") — read both.

| Always (solo included) | Situational (grows with the product) |
|---|---|
| Principle ① run it · ratchet ① one bug = one test | Feature ↔ verification table with access · per-feature app checks · automatic baseline comparison · bug auto-repro through the table · the full runner |

Solo work and prototypes: speed first — the left column only. A long-lived product that several agents change: both columns.

## 9. Examples (a macOS notes app)

1. **Ratchet ①** — whole-table delete left a stale block. Fix + randomized test (1,500 deletes); reverting the fix → 6 fail.
2. **Ratchet ②** — "source merged, bundle stale". A hash stamp; the release script refuses a mismatch.
3. **Wrong check** — 30 synthetic events rejected as another window's. The probe sent windowless events; fixed probe → PASS. Now a triage rule.
4. **Environment** — note switch 50 ms vs 33 ms target; ~half was 3,400 accumulated probe-settings entries. Reset once per run + write only on change → 31 ms.
5. **New feature** — notice delay 1 s: one row, a test (none at 0.5 s, shown at 1.5 s), a mutant (5 s → test fails). **By size** — solo script: example 1 only; long-lived app: §1–7.

## Sources

§1a adapts pstack (cursor/plugins `pstack`, MIT, by Lauren Tan): "state the finish condition up front" and `create-verification-skill` (guide 06), `blast-radius` (levels of proof), principle `attack-the-premise`. Adopted 2026-10-17; rewritten, not copied.
