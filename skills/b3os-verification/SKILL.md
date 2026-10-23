---
name: b3os-verification
description: b3rys method for proving that a change or a release is correct — and for making that proof hold and get stronger over time. Use when verifying a fix, a feature, or a release candidate; when deciding what to test headless vs in the running app; when a check fails and you must tell a wrong check from a real defect; or when setting up a one-command release check. Covers the 3 principles, the 5 ratchets, a layer + rubric table with numeric pass lines, a triage table for wrong checks, shared-resource rules for a single app window, the runner contract, and how much of it to apply by project size.
trigger: verify a change / release
owner: steve
---

# b3rys Verification — Prove It, and Keep It Proven

The core idea: a check you set up once must keep protecting you. A new feature or a bug fix ends with **one row in the feature table + a test + a deliberately broken version that the test catches**. The runner does the rest, every time.

Passing the runner is evidence for review and approval (TEAM-OS §4), not a substitute for them.

In `b3os-sf` this is step 5 (testing · verification) of the 8-step map, and steps 6 (feel) and 7 (release) use it too. One request is closed by BWF; its ③ execute · ④ verify cells are covered by the Find · Pick · Fix · Check roles (`b3os-bwf`), and Check uses the rules below.

Terms: **ratchet** — a metric that may only improve: a commit that worsens it is blocked, and an improvement becomes the new limit (§2). **mutant** — a copy of the code with one line deliberately broken, to prove a test fails when it should (§4). **probe / anchor** — a short program that drives the running app, and the named on-screen marker it looks for (§3, §6). **baseline** — the recorded value a new measurement is compared with. **gate** — a check that blocks the next step (merge, release) when it fails. **triage** — deciding whether a failure comes from the test, the environment, or the product (§5). **headless** — runs without the app's screen. **FLAKY** — passes and fails on the same code. **acceptance** — the final check that the result meets the request. **p90 / p99** — the value 90% / 99% of samples fall under; judge the outliers, not the mean.

**Scope:** §1–5 apply to every change. §6–7 (one app window, the app runner, app-check triage) apply to products with a running app; for server or script work, skip them.

---

## 1. Three principles

1. **Run it; don't read it.** A diagnosis from reading source is a *candidate*. It is not a conclusion until a repro or a measurement confirms it. Before copying a number or field name from an error or log, check what the code that produces it counts; if you could not, quote it verbatim and do not present your reading as fact.
2. **The feature ↔ verification table is the single source.** One feature = one row. Each row has: source files (for change-scoped runs) · headless tests · app check (family + steps) · performance gate with baseline · the mutant and whether it is proven caught · last result (date, sha, verdict) · gaps · **access** (UI path, shortcut, probe anchor ids — so any agent can map a vague report or a screenshot to a feature and drive it). A new feature that attaches state to an object (a note, an item) first adds rows to a state × event table (switch, close, quit, delete, restore, rename/move, changed from outside), with the expected behavior and a test per cell; an empty cell fails the check and the table is compared with the code automatically. A cell is ✓ only when a test exists and a mutant is caught (otherwise UNPROVEN).
3. **Budget first.** Estimates follow b3os-bwf「예상 시간 잡는 법」. If a check would blow the budget, say so early and change the method (split, parallelize, move it headless). Do not drop the spec to fit the time. A check over 1 hour is not a release condition: split it or move it to a list.

## 1a. Per PR — fix the finish line first, run only what changed

- **Scope line first.** Before any test or check, write one line: changed → will run → will not run. A small change (a menu position, a label) runs the checks it reaches — its unit tests and the affected UI check — and reuses the same head's existing records; do not restart a full release run for it. Do not start a release while the lead is still choosing the spec.
- **Finish conditions are written when the PR opens, not discovered in review.** The PR body lists the checks that prove it: which tests (unit, the changed feature's app tests from the table), which captures or device checks, and what result passes. The author and the reviewer agree on the list in the first round. Later rounds add a required check only for a defect found or a risk the list missed, and say which one. "Done" is that list passing on the exact head that merges.
- **Reviewers and check agents only read and reproduce; they never fix.** Sort what they find into 깨짐 (break) / 구조 (structure) / 개선 (improvement) and report it. The PM picks what goes back to the implementer. Roles and team size by change size: `b3os-sf` `references/development.md#fpfc-를-프로젝트에서-쓰는-법-pm-절차`.
- **Per PR, run what the change reaches; the full suite only with approval (§1b).** The feature table maps changed files to checks (`b3os-sf` → dev-mode-operations, "검사 4단계"). The default per PR is the changed features' checks, not the full suite. The table's escalations still apply: a shared file pulls in the features that use it, a file missing from the table widens to its whole module, and a root config, a large refactor, or a change whose reach the table cannot judge is a reason to ask for the full suite. The full suite runs only with the lead's approval (§1b). When one feature keeps escalating to related checks, that is a structure signal to act on — separately from running the checks it needs now.
- **Say how far each claim got.** Every "verified" or "safe" names its level: ① asserted ② pointed at a real `file:line` ③ walked the failure path and it does not reach ④ ran real code (a test or script that fails loudly if wrong) ⑤ reproduced in the running app. Find the one fact a change is safe because of and take it to ④ or ⑤; report anything below ④ as unproven. For someone else's run, say which: a pass claim in the PR text alone is ①; an execution record checked for the same head, scope, and result (command, log, or result bundle) is "④ by the author, record checked"; a rerun by the reviewer is "④ independent". Ask for a rerun when it answers a defect, a missed risk, or doubt about the record.
- **Before reporting a measurement, say what it measured.** Name the scope in the claim (this block, the whole file, the worktree), the build kind (debug/release), device, and load, and compare only like with like; if unrelated items all slow down together, suspect the build first. Report pass counts before and after (no number = not run). Run the baseline first and stop if it is not green. Check that the condition really applied (scroll position, fetch success, the substitution landed on the intended line, the repro condition is in the input). Measure pixels against a control first: if a row without the element gives the same value, you are measuring the wrong thing. If a number disagrees with what you see, crop and zoom. Say what you could not prove. A weak test (an assertion on source text) shows its weakness in its name or comment. Check claims about a ref from the committed content (`git show <ref>:<path>`), and name both HEAD and the worktree.
- **Release tests model real use only.** Every test in the release run states, in one line, the scene a real user goes through ("type a note, then rename it from the sidebar"). A test that cannot name one stays out of the release run. Bug-hunting tests — random interleavings, hundreds of repeated rounds, load loops, every-combination matrices, timings no person produces — may be used while chasing a bug, but leave the release run once the bug is fixed; the fix keeps a realistic repro test (§2 ratchet ①).
- **Two fixes on one premise failed → test the premise.** When two fixes that share an assumption fail the same check (a flaky test patched twice, a layout nudged twice), write the shared assumption as one sentence and run an observation that would differ if it were false, before a third fix.

## 1b. Release modes — pick one before shipping, full suite only with approval

Every release starts by naming its mode. The mode sets what runs, how long it may take, and who approves. Pick the **smallest mode that fits**; when two fit, take the smaller.

| Mode | When | What runs | Approval |
|---|---|---|---|
| dev | an in-development update for the lead or the team | the build + the required gates (launch/update path, core speed) + the changed area's checks — reuse their recorded results when they ran on the exact shipping head (§1a), rerun only what is missing | normal deploy rule |
| hotfix | a break users hit now | dev + a realistic repro test for the bug | normal deploy rule |
| fix | a user-visible feature change | dev + the changed features' app checks from the feature table | normal deploy rule |
| full | the full acceptance suite | all eligible release checks (§1a: realistic use only, no bug-hunting loops) | **the lead approves a stated reason first** |

`normal deploy rule` = delivering the notarized build to the team needs no approval; the upload (public release) follows TEAM-OS §4 and waits for the lead's approval.

- **Full needs a stated reason.** Ask the lead before running it: say what changed and why the scoped checks are not enough. Typical reasons: a shared module many features use, the saved-file or data format, the signing, launch, or update path, a large refactor, or a change whose reach the feature table cannot judge. A public launch or a release after changes piled up beyond what the table can judge may also qualify. Without a reason like these, ship dev, hotfix, or fix. §1a's escalations and the runner (§3, §7) run within the chosen mode; when they point beyond it, that is a request for full, not a license to run it.
- **One time cap for the whole release.** 20 minutes from start to upload for dev, hotfix, and fix — build, lock waits, checks, retries, and upload included. Full gets its cap with the approval (from the last real full run). Past the cap the run keeps going and prints where it is: the last step, what it is waiting on (e.g. who holds a shared machine lock), and the commands still running. The person running it re-checks the plan with that output instead of waiting silently. The cap runs from start to just before the upload; time spent waiting for approval does not count. If you expect to exceed it, say why when you start.
- **Put it in the program, not only in the rules** (long-lived products, §8). The release entry point takes the mode as a required argument, reports at the cap, and refuses full unless the lead's approval is recorded for it; any direct entry point to the full suite carries the same guard. Solo work and prototypes: the rule alone is enough.
- **ETA comes from the last real run** of the same mode, not a round number.
- **Run acceptance on an isolated copy of a fixed sha.** While it runs, do not merge, check out, regenerate bundles, or edit docs in that tree; if something must be merged, stop and restart on the new sha (never count a mixed result as a pass). Run the full acceptance once per integration commit: implementation branches run unit tests and their own probes only, and a reviewer does not run the full suite at the same time (parallel runs slow each other ~3×). If the release script would rerun acceptance on a source that just passed, skip it and write "acceptance passed on the same source at HH:MM" in the hand-off.
- **A blocking gate that FAILs is read in the raw log.** Grep every failure marker in the whole log (a summary groups results and hides single failures). A real FAIL is not shipped by manual release: fix it, or ask the lead first; if it makes you late, say that first. When an app check fails only under load, rerun just the failed group beside the previous release inside the machine lock, not the whole release. If the same violation keeps recurring, block it with a hook, not another rule.

적용 사례: one app's release entry point takes the mode as a required argument and refuses full unless the lead's approval value is set.

## 2. Five ratchets — verification that only gets stronger

Each moves in one direction only.

| Ratchet | Rule |
|---|---|
| ① One bug = one test | A bug fix ships with a repro test **and** a mutant (the fix reverted) on which that test fails. The same bug cannot come back silently. |
| ② Twice = a check | A review comment or feedback that repeats twice becomes an executable check (test, lint, CI rule, script guard) — not a line in a doc. Same rule as ai-code-safety's enforcement layers (a comment made twice moves one layer up). |
| ③ Baselines only tighten | Improve → re-pin. Regress → block. Never loosen silently. A baseline change records the value and the condition (load, build type). Display values the lead tuned by hand are baselines too: pin them as a pixel/geometry baseline from the last release, never from the current test's expectation. |
| ④ Wrong checks accumulate | Every check that was itself wrong becomes a triage rule (symptom → cause → action) or a known-flaky entry, so the runner classifies it next time. A known failure that repeats is fixed right after the release or registered as a data exception (known + a ceiling at the previous value) — never hidden as SKIP; ask the lead only about new failures. A gate row that fails only because of one bug the lead parked is not `block`: register it `known:<ceiling>` (ceiling = last release's measurement) so a regression is blocked and the release is not; keep the real target in the row's rationale with a pointer to the TODO line, and dry-run the app side before the release window so such rows show up early. |
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
| Feel | Key → paint on the 3 most-used actions (e.g. switch note, move cursor, type); burst of keys; composition | Judge outliers, not the mean (p90 / p99 / max), 0 dropped. Thresholds come from the project's table (metric · status · margin · per-condition rows); probes read it. | Every release (required gate) |
| Safety | Fault injection on open / edit / save | 0 duplicates, 0 lost input, user files untouched | When that code changes |
| Coverage | Gap count in the feature table | Only goes down | Every build |

Hard-to-measure items get a **written criterion** in the same row, never an empty cell.

Feel table `status`: `block` = over the line stops the release. `known:<ceiling>` = over the line because of a parked known defect; at or under the ceiling passes, worse than it blocks. `report` = written in the report, does not block. At 60 Hz one frame is 16.7 ms and two frames 33 ms. 적용 사례: one app judges a burst of keys at p90 33 ms / max 50 ms, and its release policy adds a 25% margin.

Investigate a speed number only when it is 30–50% or more worse than its target, or keeps worsening release after release. Below that (an unfelt 1–3 ms) write the number in the TODO and move on; when a gate blocks on a small gap, one control run decides regression or not — no large investigation. Before chasing a small gap, measure the same build 3 times to see the noise width; if the noise is as large as the gap, clean the environment first and hand over the number with its noise. A measurement that differs per launch (bimodal) is not proven by "3 passes" (a 50/50 case lands on one side 1 time in 8): measure a fixed-work control in the same run, get both a slow and a fast run, and catch at least one slow run before concluding.

## 4. Proving the checks — mutants

- Every row names a mutant. Back up → patch → build → run that row's check → expect FAIL → restore and rebuild (one action) → `git diff` must be empty. A "caught" counts only if the same check PASSes on the unmutated tree first; when a guard sits in two places, merge them into one before mutating.
- Add a **control mutant** (the strongest version of the defect, e.g. "never notify at all"). If even the control passes, the check sits where that defect cannot be seen.
- Some defects are **invisible at the app level** (another path redraws the view anyway). Those belong to headless tests; the app check guards what the user sees.
- When moving checks from the app to headless, prove them with **the same mutants** the app check caught.
- A mutant script anchored on source text goes stale silently when lines change: run the anchor check in the same command right after every merge, and register a new mutant script in the same commit as the mutant.

## 5. When the check is wrong — triage

Tests are often wrong. On FAIL, first decide: **test, environment, or product?** Compare the test's expected answer with the feature's spec doc first — an old rule may be the answer. When the test is older than a settled principle or the canonical doc, fix it without asking and report one line (what changed, by which principle); ask only when no principle exists or principles conflict, and never cover a product regression by editing the test. Take a spec from its original (a teammate's summary or your own expectation is not the spec); before calling a number a defect, give the basis for what it should be — if you cannot, it is an observation, and an open question stays open. Until the cause is confirmed, report "cause under check (check / environment / product undecided)" and report the observed user impact separately — real impact such as data loss is escalated at once, whatever the cause turns out to be (at once = do not wait for the cause; send the lead's channel one line: "cause under check, impact: …"). Every FAIL line gets a category and the evidence line, and the first split is whether another check was running at that time; a runner applies these rules automatically and reruns once where the rule says so. Labels: Test (the test is wrong) · Environment · Product · Process.

| Symptom | Typical cause | Verdict · action |
|---|---|---|
| Timing inflated (~2×) | Test settings accumulated state (e.g. thousands of entries from temporary libraries) that the product scans per action | Environment · reset once per run; and in product code avoid O(table) work per action |
| Fix not visible in the app | Source changed but the bundled build output was not rebuilt | Test/process · a content-hash stamp; release scripts refuse a stale bundle |
| "Looks like X" from reading source | Unconfirmed diagnosis | Test · candidate only; confirm with a repro or an anchor/log trace |
| Timing slightly over the line under load | First-sample outlier + high load | Timing · record load, rerun once; twice over = product |
| Incremental state keeps a deleted structure | Real defect | Product · repro test + mutant (ratchet ①) |
| The implementer says a failure "was already there" | Unverified claim | Test · run the same real-key pages on the previous release tag side by side; passed then, fails now = regression |

- **A source-read cause is a candidate.** Write it as a candidate (also a new check's first FAIL); call it confirmed only after a repro (break that spot and the symptom appears; fix it and it goes). Hand it on with "measure this number before fixing". If two symptoms sit near one spot, suspect one cause first. Do not cancel a teammate's repro request by reading code; if the owner overturns your diagnosis, say you were wrong in the merge message. 적용 사례: two causes "confirmed" by reading source were both wrong when measured; only the agent that measured first found the real one (a height-map error).
- **Name the exact UI element before fixing** from the live DOM or source (do not assume the visible element is the culprit); with two candidates, name both and narrow by the symptom keywords. If no device check is possible, report that the changed class/CSS reached that element in the build output; ask for a screenshot early when unclear.
- **A hand-made repro answers only "what happens in that state".** Whether the state occurs is checked separately through the real path (audit log, DB record), or reported as unverified. Hand-built request/event objects first need proof that such a shape occurs (especially where the verdict is "which field of the request is read": auth, routing) — run a real server and send a real request, then confirm with a mutant. Before using two fields as independent signals, check that one is not derived from the other. 적용 사례: every trash-restore test passed, but the double never used the real trash, so the restore had never once worked on the default install path (a synced folder).
- **A test double hides what lies beyond it.** For resources behind an OS permission (files, trash, keychain, network), run one real-path probe on the real user path. Where someone else's code (a framework) is involved, say "it is not set" from the rendered result, not from a grep of your own source. Before saying "none / 0 results", check the instrument can see a positive (run it once on a state that has one, or use the official query) and look two ways (keyword search + a full listing/schema dump); a "no change / 0" needs: can the effect appear here, does the same measure give ≥1 where it should, and where/along which axis (time, sender) did the 0 begin. Assert before judging that the measured value is the intended one; a check that cannot read its value fails, it does not pass. Follow a new function's return value to where it is read and measure there once.
- **A contract on one axis leaves the others safe by accident**: measure each axis ("A is 0 so B needs no look" means B was not measured); if two points judge one rule, make them call the same function; comments lag code, so verify by query or run and fix the comment too; when flipping an expectation, leave the reason in a test comment; an assertion without an optional argument passes any input.
- **Reviewing a monitor, guard or gate:** first check it can observe the signal it demands (run it so the signal reaches the verdict), above all when the reason for the check is also its trigger (a backup check that goes silent only on damage). A health check behind an auth gate (SSO) always passes on the login page's 200 — look at the final URL; do not monitor what the app cannot fix. After fixing one place, sweep the whole class; open an allow-list by class, not by item. DB time columns are UTC: compare with a reference row's `created_at`, not a local date literal.
- **A "before"/baseline file is not a control** until you open it and see no trace of the fixed feature. A real control is measured at the commit where the feature did not exist (a test using a new API will not run on the old commit — build a minimal probe that runs on both).
- **Confirm the measured binary is current before reading a result:** show both the success and error lines of the build output (not only the last line), grep the new identifier in the artifact, and treat restore + rebuild after a mutant as one action. Per-commit measurement (bisect) uses the bundle built from that commit — a fixed-path app measures the same latest app every time; if all commits give the same result, check that the target really changed (app mtime, front window name). To find a cause, interval instrumentation or process sampling is faster than bisect. A probe's env variable that changes the branch under measurement makes that item unmeasurable: grep it first, split measured / unmeasured in the report, and ask for a separate switch for forced states.
- **A yield inserted into a long test breaks accidental isolation**: reducing starvation by yielding makes parallel full runs fail by interleaving; run the starver separately (serial) instead of splitting it, and check whether random-order/invariant tests rely on no interleaving. After a revert or merge, run `git log -1` and `git diff <base> HEAD` before saying "reverted".
- **Test state is wiped as a whole**, not by key lists: clear the domain/folder and name the keep list, at start and end (aborts included); never touch the user's domain. When a test is oddly slow or shaky, suspect leftover state first. Big test files: keep a fixed original (sha-checked), copy per run, delete the copy. A new project skeleton gets the same guard.

**Settle a suspicious number in one run:** the first diagnostic run records the waiting conditions and their values, what still blocks (animating layer or a thread sample), and an unmodified control. A chained FAIL with no crash report means something outside killed the app. If the cause took an hour or more, add a row to this table. A rare case needing several conditions together goes to the TODO (data-loss possibility excepted).

## 6. Shared-resource rules (one app window)

- **One app at a time.** Before an app check, the running-instance count must be 0 (find the runner by its execution path — `pgrep`=0 only means "none right now"). If another instance appears mid-run, stop and report its pid. On a machine with a key window, app checks run serially: parallel runs steal each other's window and give false FAILs. While one runs, tell the others "no new app checks, read logs only".
- **No auto-start loops.** A "relaunch when it quits" wait loop cuts into someone else's turn. Checks run once and end; a rerun is decided by the triage rule, once.
- **Turns are explicit.** The window turn starts only with an explicit hand-over message; passing the automatic guard (0 instances) is not a turn. Get the current holder's stop reply before sending GO to the next agent; the one who finishes sends GO to the next directly (no relay) and writes a one-line stop message (e.g. "검사 끝"). The PM sets the order once; if two turn messages conflict, confirm in one line before running. If you promise a turn ("GO as soon as it is returned"), set `expect-report.sh --thread <thread> --in <expected return +5m>` in that turn, and when the lock frees, go through the waiting promises first — the teammate will not start without GO, so your omission is their stall.
- **Kill only the pids you started** (save `$!`; clean up by handle, never a list gathered by name). `pkill -f <name>` also kills others' runs on a shared machine — use it only inside the lock. When someone holds an exclusive slot, pass "no app launches" to your sub-agents too. Restore global state after cleanup ends.
- **Probe bundle id only.** Launch under a dedicated probe bundle id; the user's app id would overwrite user settings (scroll positions, last note, theme). To measure a given build, wrap its binary/resources under the probe id and ad-hoc re-sign. An unregistered probe bundle opened with `open -a` can launch another worktree's build registered under the same bundle id: run `lsregister -f <bundle>` before, and after launch check that the pid's executable path is inside the requested bundle (if not, kill only that pid and FAIL); app numbers start with "which binary produced this".
- **Never touch user folders.** Test data lives in temp folders only; a source-scanning test enforces it.
- **Reset accumulated probe settings once per run** (not per launch — some probes relaunch within a run on purpose).

### App-check triage (products with a running app)

| Every "is on screen" check fails; no anchors at all | The probe's env key is not in the anchor gate (or a mode-valued key only passes when it equals "1") | Test · add the key; a test compares keys used by scripts with the gate |
| Synthetic events all rejected as "another window's" | Events created without a window have window number 0 and screen coordinates | Test · resolve windowless events by global location |
| Animation "jumps / stalls" only in a chained run | Many phases in one long-lived app disturb frame timing | Test · run animation and photo checks standalone; rerun standalone once |
| Photo file missing | The app quit before the last chained segment wrote it | Test · photo checks run standalone |
| Pixel count below threshold after a style change | A fixed colour counted; overlapping layers / display colour space shift it | Test · measure relative to the same photo's background |
| All gates pass, but the shipped app hangs at launch on a user machine | Gates launch a re-signed probe bundle and skip the real signed launch path (keychain, permissions, iCloud) | Process · when a release touches the launch path, launch the notarized original once before upload; keep a rollback ready |
| A timing is sometimes ~1 s too long | The check waited on every animation in the window; an unrelated always-running one (an editor caret blink) was still going | Test · judge only the target pane; see the one-run rule below |
| A chained family fails many phases at once, logs cut off, no crash report | Something outside killed the app (another test's cleanup) | Environment · teardown kills only its own processes; record fixed causes in a data table so the repeat-flake warning skips runs before the fix |
| A file-watcher test misses a notice only in full runs | The OS event service lags under a flood of file changes | Environment · on a missed notice, probe the service: alive = real FAIL, silent = visible SKIPPED (never PASS) |

## 7. The runner contract

One command, cheapest first, one app family at a time:

```
headless fast layer → unit suite → equivalence layer → bundle stamp → app families (one at a time) → summary
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

## 9. 적용 사례

Cases are adapted to the situation, not copied.

1. **Ratchet ①** — a whole-table delete left a stale block. Fix + randomized test (1,500 deletes); reverting the fix → 6 fail.
2. **Environment** — a note switch took 50 ms against a 33 ms target; about half was 3,400 accumulated probe-settings entries. Reset once per run + write only on change → 31 ms.
3. **New feature** — a notice delay of 1 s: one row, a test (none at 0.5 s, shown at 1.5 s), a mutant (5 s → test fails). **By size** — a solo script: case 1 only; a long-lived app: §1–7.

## Sources

§1a adapts pstack (cursor/plugins `pstack`, MIT, by Lauren Tan): "state the finish condition up front" and `create-verification-skill` (guide 06), `blast-radius` (levels of proof), principle `attack-the-premise`. Adopted 2026-10-17; rewritten, not copied.
