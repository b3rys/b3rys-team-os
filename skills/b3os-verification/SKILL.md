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
| `b3os-project-mgmt` | How do we manage and report it? |
| `b3os-harness-playbook` | How do we split it across parallel agents? |
| **`b3os-verification`** | **How do we prove the result is right — now and on every later change?** |

The core idea: a check you set up once must keep protecting you. A new feature or a bug fix ends with **one row in the feature table + a test + a deliberately broken version that the test catches**. The runner does the rest, every time.

---

## 1. Three principles

1. **Run it; don't read it.** A diagnosis from reading source is a *candidate*. It is not a conclusion until a repro or a measurement confirms it.
2. **The feature ↔ verification table is the single source.** One feature = one row. Each row has: source files (for change-scoped runs) · headless tests · app check (family + steps) · performance gate with baseline · the mutant and whether it is proven caught · last result (date, sha, verdict) · gaps · **access** (UI path, shortcut, probe anchor ids — so any agent can map a vague report or a screenshot to a feature and drive it).
3. **Budget first.** One fix = 10 minutes; tests and verification included = 30 minutes. If a check would blow the budget, say so early and change the method (split, parallelize, move it headless). Do not drop the spec to fit the time.

## 2. Five ratchets — verification that only gets stronger

Left alone, verification decays: code moves and checks stop meaning anything, thresholds loosen quietly, the same mistake comes back. These five only move one way.

| Ratchet | Rule |
|---|---|
| ① One bug = one test | A bug fix ships with a repro test **and** a mutant (the fix reverted) on which that test fails. The same bug cannot come back silently. |
| ② Twice = a check | A review comment or feedback that repeats twice becomes an executable check (test, lint, CI rule, script guard) — not a line in a doc. |
| ③ Baselines only tighten | Improve → re-pin. Regress → block. Never loosen silently. A baseline change records the value and the condition (load, build type). |
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
| Feel | Key → paint; dropped keys; composition | ≤ 16.7 ms; 0 dropped | Every build |
| Safety | Fault injection on open / edit / save | 0 duplicates, 0 lost input, user files untouched | When that code changes |
| Coverage | Gap count in the feature table | Only goes down | Every build |

Hard-to-measure items get a **written criterion** in the same row, never an empty cell.

## 4. Proving the checks — mutants

- Every row names a mutant: a temporary source change that injects exactly the defect the check should catch. Back up → patch → build → run that row's check → expect FAIL → restore → `git diff` must be empty.
- Add a **control mutant** (the strongest version of the defect, e.g. "never notify at all"). If even the control passes, the check sits where that defect cannot be seen.
- Some defects are **invisible at the app level** (another path redraws the view anyway). Those belong to headless tests; the app check guards what the user sees.
- When moving checks from the app to headless, prove them with **the same mutants** the app check caught.

## 5. When the check is wrong — triage

Tests are often wrong. On FAIL, first decide: **check, environment, or product?** Every FAIL line gets a category and the evidence line; a runner applies these rules automatically and reruns once where the rule says so.

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

## 6. Shared-resource rules (one app window)

- **One app at a time.** Before an app check, the running-instance count must be 0. If another instance appears mid-run, stop and report its pid.
- **No auto-start loops.** A "relaunch when it quits" wait loop cuts into someone else's turn. Checks run once and end; a rerun is decided by the triage rule, once.
- **Turns are explicit.** Take the window on GO, give it back with "탐침 끝". Before sending GO to the next agent, get the current holder's stop.
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

| Always (solo included) | Situational (grows with the product) |
|---|---|
| Principle ① run it · ratchet ① one bug = one test · the structure/code basics (one representative pattern per concept, hot paths kept light, dangerous paths fail loudly) | Feature ↔ verification table with access · forbidden-dependency CI · per-feature app checks · automatic baseline comparison · bug auto-repro through the table · the full runner |

Solo work and prototypes: speed first — the left column only. A long-lived product that several agents change: both columns. The structure/code cell is never optional.

## 9. Examples (from a macOS notes app)

1. **Ratchet ① — whole-table delete.** Deleting a whole Markdown table left the incremental block list pointing at it; later edits failed. The fix shipped with a randomized test (1,500 whole-table deletes); reverting the one-line fix made 6 of those tests fail.
2. **Ratchet ② — the bundle stamp.** "Source merged, bundle not rebuilt, app shows old behaviour" happened twice. Now a stamp holds the input hash and the bundle hash; the notarization script refuses to start on a mismatch. Nobody has to remember.
3. **A wrong check — windowless synthetic events.** A panel-scroll check failed with all 30 events rejected as "another window's". The probe sent windowless events; fixing the probe made all 3 steps pass. The runner now classifies this symptom as "check".
4. **A suspicious number — inflated timing.** Note switching measured 50 ms against a 33 ms target. Broken down, about half came from ~3,400 entries accumulated in the probe's settings, scanned on every switch. The product now writes that record only on change; the runner resets it once per run. Clean result: 31 ms in debug and release (from 721 ms before the switch work).
5. **Adding a feature — a notice delay 5 s → 1 s.** One table row (access: delete a note → undo), a test (no notice at 0.5 s, notice at 1.5 s), and a mutant (restore 5 s → the test fails). That is the whole job; the runner guards it from then on.
6. **By size.** A one-person script: when fixing a bug, add the one test (example 1). A product like the notes app: sections 1–7 in full.
