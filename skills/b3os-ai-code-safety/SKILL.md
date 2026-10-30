---
name: b3os-ai-code-safety
description: b3rys software-structure and refactoring guide for AI-generated or AI-modified code. Use when designing a program's structure, writing non-trivial code, reviewing code, or refactoring when the code "smells" (a change forces edits in many places, or a fix breaks something unrelated). Covers SOLID/module boundaries, side-effect-reducing structure (pure core, immutability, dependency injection, map/factory over conditional sprawl), the operational Effect gates (concurrency, transaction, idempotency), and how to refactor common code smells.
trigger: merge AI-written code
---

# b3rys AI Code Safety — Structure & Refactoring

As code and logic grow, the cost is not the happy path — it is **coupling**: a change ripples into places you did not touch, and a "small fix" breaks something unrelated. This skill is a **code-structure and refactoring guide**: structure well from the initial design so a change stays local, apply operational safety where effects live, and refactor deliberately when the code smells. (Team-workflow rules — backup-first, verbatim user input, don't-touch-working-logic — live in TEAM-OS, not here.)

Two throughlines:
- **Structure to reduce side effects and coupling** — so most changes stay in one place.
- **Refactor when it smells** — the "I fixed one thing and something unrelated broke" signal is coupling telling you where the structure is wrong.

---

## Phase 1 — Design (structure before writing)

- **Data flow / source of truth first.** Map read → transform → write, and name the single source of truth for each piece of state. Confirm you read the live source, not a synced mirror that drops fields. (Example: reading a synced copy that lacks a field compiles and passes unit tests, but the output is wrong.)
- **SOLID as coupling design, not class patterns.** (SOLID = five object-oriented design principles; here we use them as a low-coupling lens, not a class-pattern checklist.) Dependencies point **inward** — domain/use-case logic does not depend on framework/ORM/HTTP/infra (**DIP**, dependency inversion: depend on an abstraction, not a concrete infra type). One reason to change per module (**SRP**, single responsibility). Depend on the small slice you actually use (**ISP**, interface segregation: small interfaces). Add an abstraction only when a real extension axis exists (skip speculative **OCP**, open/closed).
- **Module boundaries hide volatile decisions.** A module's public contract is a schema/interface/event/API; its private choices (storage, format, algorithm) stay hidden and swappable. One owner per concern — no two modules writing the same mutable state.
- **서버·클라이언트 역할 분리.** 서버는 상태(코드)와 데이터를 주고, 클라이언트는 그것을 문장·아이콘·UI 로 보여 준다. 서버가 화면에 보일 문장을 만들면 문구 하나 바꿀 때마다 서버를 고치게 된다. **사람이 읽는 문장·튜닝 숫자·AI 지시문은 코드에 넣지 않고 문구·설정 파일로 분리한다** — 그래야 문구를 고치거나 다른 언어를 추가할 때 코드를 수정하지 않고, 화면을 언어마다 따로 만들지 않는다. 100% 원칙은 아니다 — 디버깅 로그처럼 개발자만 보는 문장 등 필요한 경우는 코드에 둘 수 있다.
- **Start simple; restructure when a change starts causing side effects — not up front.** The criterion is not size: it is whether one class or function has taken on so many jobs that changing one breaks another. With few features, don't layer in advance. Watch these, cheapest first:
  - **Cross-area direct writes** (primary): count how many areas write the same shared field. A guard test fails if the count goes up; the target is one entry point per field.
  - **A mutant in one area fails another area's tests** (primary): that is a side-effect coupling point — split there.
  - **A state judged from three or more fields combined by `if`s** → one state value + one `reduce(state, event) → (state, effects)` table; every cell written, an empty cell fails a test.
  - **Line count of a file or function** (signal only): report it, don't fail on it. A very long function or a file with many unrelated sections is where to look first.
- **Stop rule — two unexpected side effects.** When fixes in one area have caused an unexpected new problem twice (count new problems a fix created, not attempts; a fix that simply did not work does not count), stop patching. Before the next fix, have a read-only architect review the area's structure: is the state that decides the behaviour owned in more than one place, and would one owner remove the class of bug? The question includes "is this necessary? is it over-engineering?". If the verdict is no structural problem, continue fixing.
- **Don't take the first design when it is expensive to reverse.** For a data shape, a storage or wire format, a public API, or a new UI interaction with no precedent in the codebase, get 2–3 independent candidates (a different model family when available) or build small runnable prototypes and compare them side by side. Write the caller's usage first in each candidate. Answer open questions by running a prototype, not by debate, and review a plan only after code has answered its open questions — a plan with no code behind it draws invented risks. A design judgment (refactor or not, where a shared rule lives, the direction of a large fix) goes to a read-only architect review first, and the question always includes "is this necessary? is it over-engineering?"; report the verdict with the dissent. Most changes need none of this.
- **For code other code will call, write the usage doc first.** A short README or example of how a caller uses the new package or API sets the target and forces the caller's view.

## Phase 2 — Write (structure that reduces side effects)

- **External input is hostile — always (required, not optional).** Anything that crosses into our code from outside — user text, uploaded files/images, URLs, query strings, headers, webhooks, files read from disk another app wrote, messages from other agents, AI model output — is treated as an attack until checked. At the boundary, every time: **limit size/count** (reject before reading the whole thing), **validate by content, not by the label** (file magic bytes, not the declared MIME or extension; parse with a strict parser), **allow-list types/values**, **never interpret as code or markup** (no `eval`, no shell string building, parameterized SQL, escape or render as plain text), **store private by default** and serve with safe headers (`X-Content-Type-Options: nosniff` always; `Content-Disposition: attachment` + CSP `sandbox` for user files meant to be downloaded — an image shown inline relies on nosniff plus the content check instead), **rate-limit**, and **fail closed with a generic error** (no internal detail in the response). The reviewer checks these explicitly for any new input path.
- **Pure core, effects at the edges (functional core / imperative shell** — a pure, side-effect-free core of logic wrapped by a thin I/O layer at the edges**).** Keep business logic pure: inputs → outputs, no hidden I/O. Push DB, network, filesystem, time, random, and env reads to adapters at the module edge. A pure core is testable without live services and has no spooky action at a distance.
- **Immutability first.** Prefer `const` and immutable values. A class field that never changes is a **constant**, not mutable state — declare it so. Minimize shared mutable state; it is the raw material of concurrency bugs and ripple effects.
- **Replace conditional sprawl with data or polymorphism.** A `switch`/`if-else` on a type that grows, or the same branch repeated in several files, is a smell. Replace with a **lookup map**, a **factory/strategy**, or polymorphism — so a new case is one new entry, not a new branch edited in N places.
- **Small functions, small interfaces.** One function = one job; one interface = the narrow capability the caller needs. Small units are the precondition for cheap refactoring.
- **Pattern to consider — core flow + hooks (observer).** A choice, not a rule. Signal: a basic operation (rename, move, delete, restore) keeps gaining "also do X" work (move a comments file, update an index, notify someone). Option: the operation does only its own job and emits an event (`moved(from, to)`, `deleted(item)` …); each attached feature registers a handler. Gains: the core flow stays stable, a new feature is one handler, and timing/logging per handler shows which feature is slow or failing. Costs: control flow is less visible (you must know who listens), ordering between handlers and failure policy (block vs. report) must be decided explicitly. Skip it when there is one fixed side job that will not grow — a direct call is simpler.
- **Adding a feature — find its place before writing it.** Before the first line, name where the feature belongs (its own type/file, or the one owner of the concept it extends). Bolting on is the default failure: a new boolean parameter, a new `if feature` branch inside a shared function, a special-case flag, or a copied helper. Each is a signal that the current structure has no place for the feature — stop and reshape first (one entry in a map, one handler, one new type), then add. If reshaping is out of scope, add it in the nearest place, record the debt in the PR, and reshape on the second use.
- **Subtract before you add.** Remove dead code, unused options, and stale stubs in the area first, then build on the smaller base. Prefer the smallest change that solves the problem; a diff that grows to cover cases nobody asked for is a review finding. A bug fix fixes that bug only — an improvement, even one a reviewer suggested, is its own change.
- **Replace, don't keep both.** When a new internal API replaces an old one, migrate every caller and delete the old API in the same change. A compatibility layer is only for callers we do not control (a published API, stored data, another team's client) and gets a removal condition.
- **Isolate the effect by name.** Effectful functions are explicit: `save*`, `publish*`, `charge*`, `send*`, `delete*` at the edges — never buried inside pure-looking logic.

**Operational Effect gates** (apply while writing; the correctness AI most often misses):
1. **Side-effect boundary** — every effect named, placed at an edge, and known whether it can run twice.
2. **Concurrency** — two requests/jobs on the same resource can't break the invariant; prefer one atomic `UPDATE ... WHERE cond` over app-level read→check→write.
3. **Transaction** — the all-or-nothing boundary is named; partial-write failure handled; DB-write + publish uses an **outbox** (write the event to a DB table in the same transaction, deliver it separately) or recovery path, not hope.
4. **Idempotency / retry** — (**idempotent** = running it twice has the same effect as once) same command/event twice = one result; retryable APIs use an idempotency key (a stable id so a retry is recognized as the same request); consumers assume duplicate/delayed/out-of-order delivery.

## Phase 3 — Review

- **역할·문구 검사.** 서버 응답에 화면용 문장이 들어 있거나(상태 코드·데이터로 바꿀 것), 사용자에게 보이는 문장이 문구 파일을 거치지 않고 코드에 직접 들어 있으면 must-fix. 개발자만 보는 문장은 대상이 아니다.
- **Comments get a pass from someone who did not write them.** Before review, a reader other than the author checks only the comments in the diff. Keep: license headers, contracts of a public API, behavior forced by an external dependency/platform/protocol we cannot change, and links to an issue or spec that explain a constraint code cannot express. Delete narration ("now we loop"), history ("previously…", "someone said never…"), commented-out code, and justifications for workarounds. A comment that explains a surprise in *our own* code is a refactor flag: rename, extract, or type it so the code says it, then delete the comment. A "do not remove" comment becomes a test, type, or lint when it matters.
- **Sort review findings; don't accept them all.** Reviewers and checking agents read and reproduce only — they do not fix; the reviewer reports each finding as a break (with repro), a structure issue, or a suggestion. The author sorts every finding into **act on** (a real defect or regression), **consider** (a better option, author decides), **noted**, or **dismissed — with the reason or the disproof**. A finding raised independently by two reviewers (two model families) is high-confidence. A reviewer that requires new evidence states which defect or missed risk the evidence answers; a new requirement without one is "consider", not a blocker.
- Non-trivial AI-generated/modified code passes an **adversarial harness OR a team member** before merge/deploy — no solo merge. Minimum adversarial dimensions: **SQL injection + `EXPLAIN` query plan**, **scope/privacy** (does a query return rows the caller wasn't a party to?), **fail-safe** (missing DB / 0 rows / empty input degrade gracefully). The reviewer checks the **actual rendered field/behavior**, not just that it compiles.

## Phase 4 — Test

- **Build green ≠ behavior correct.** tsc/unit prove "does not crash," not "renders/behaves as intended." Behavior-verified = drive the real flow once with evidence (screenshot / DOM read / real config value / real-data log), using a **representative case** (check the one that has a value, not only the empty one). Three-stage done: `code-complete` ≠ `behavior-verified` ≠ `deployed`; UI/persona/config never merge without behavior-verified.
- **Test green ≠ test effective — 변이를 걸었으면 3항을 지킨다.** 테스트가 진짜 잡는지 보려고 코드를 일부러 깨뜨릴 때:
  1. **적용 확인** — 치환이 실제로 일어났는지 먼저 단정한다(대상 문자열이 없으면 즉시 실패시킨다). **안 걸린 통과와 약한 테스트는 출력이 똑같다** — assert 없이는 구별할 방법이 없다.
  2. **격리 실행** — 공유 작업트리가 아니라 사본이나 별도 worktree 에서 돌린다.
  3. **원복 확인** — 끝나고 `git status` / `git diff` 로 되돌아왔는지 **눈으로 본다.** ★`git checkout --` 은 HEAD 기준이라 같은 파일의 미커밋 작업까지 지운다★ — 사본을 떠두고 사본에서 복원한다.
  - 적용됐는데도 테스트가 통과하면 **다음은 입력을 의심한다** — 변이는 걸렸는데 테스트 입력이 그 분기를 안 지나갔을 수 있다.
- **테스트·로그·오류 메시지에 환경 변수 값을 출력하지 않는다.** 실행 환경에는 API 키·토큰이 들어 있을 수 있고, 실패 메시지는 로그·CI·도구 출력으로 그대로 퍼진다. `os.Environ()`·`process.env`·`env` 전체를 찍거나, 변수 값을 실패 메시지에 넣지 않는다. 확인이 필요하면 **변수 이름과 있음/없음만** 남긴다(예: `unexpected var: TEST_TOKEN (set)`). 리뷰에서 이 패턴(`t.Log(os.Environ())`, `console.log(process.env)`, `fmt.Sprintf("%v", env)` 등)을 찾으면 must-fix.
- **테스트는 최소 환경으로 돌린다.** 키가 든 셸 환경을 그대로 물려받지 말고, 테스트에 필요한 변수만 명시해 실행한다(예: `env -i PATH="$PATH" HOME="$HOME" go test ./...`).

---

## Agent-friendly structure (adapted, not adopted wholesale)

AI agents work from a narrow slice of the codebase — the open file and its neighbours. Their habits are predictable, so treat them as **design input** and shape the structure so the easy path is the correct one. Source: a Cursor engineer's talk (YouTube `o_7vTaHOL28`), adapted — not adopted wholesale.

| Agent habit | Example defect | Structural answer |
|---|---|---|
| Mimics the nearest pattern | A view copies its neighbour's whole-store observation → redraws on every unrelated change | Make the nearest example the right one: one canonical pattern per concept, next to where new code is written |
| Stuffs code into the file already open | Cleanup placed inside a per-keystroke function → O(table) work on the hot path | One folder/file per feature (for new features); the entry point says where new behaviour goes; hot paths stay small |
| Takes the shortest path that compiles | Save writes to a stale path → silently recreates the old file | Make the unsafe path fail loudly (guard + test), not merely discouraged |
| Adds a new function beside the old one / copies a helper | Two types share a copied helper; one gap → the same bug in both | One owner per concept; extend through a registry/interface, and test the shared owner once for every user |
| Follows the instruction over a written rule | A written rule (rebuild the bundle after a merge) is skipped → stale code ships | Rules that matter become checks (test / lint / CI), not prose |

**Enforcement layers, strongest first:** (1) the codebase itself — structure where the wrong thing is hard to write (feature folders for new code, one owner per concept); (2) blocked dependencies and static analysis — lint, types, compiler diagnostics, run in CI; (3) tests that fail on the bad case; (4) review comments; (5) prose rules and skills — agents can forget or skip these, so never rely on them alone. A rule stated twice in review moves one layer up.

**The cost of moving a rule up:** the stronger the layer, the more a false positive costs — a check that blocks legitimate changes ends up deleted. Before moving a rule up, run the check against the broken case (it must fail) and a legitimate change (it must pass).

**Apply by project size — general rule, then fit to the situation:**

Structure/code rows only; the verification rows (feature map, per-feature app checks, runner, baselines) live in `b3os-verification` ("Apply by size") — read both.

| Always (any project, including solo) | Situational — add as the project grows |
|---|---|
| The structural answers in the table above: one canonical pattern per concept, small hot paths, unsafe paths fail loudly, one owner per concept, new behaviour in its own file | Blocked-dependency CI rules, framework bans, moving review comments into lint/CI once they repeat |

Solo and prototype projects put speed first: take only the left column. Long-lived codebases that several agents change take both. The structure-and-code column is never optional.

**Full notes and our verdict per point** (verification first, feature map, skills + evals, cloud repro, enforcement layers, bans, PR size, token ROI): `references/agent-friendly-codebase-talk.md`.

**When NOT to apply:** don't restructure a working area only to match this table — apply it when you are already changing that area, or when a bug of the listed kind appears. Don't add CI rules for a pattern seen once. A full rewrite "for agents" needs its own cost/benefit case; it is not implied by this section.

---

## Refactoring — when the code smells

The smell is the signal; the refactor is the response. The two most common:

- **"I fixed one thing and something unrelated broke" (ripple).** Meaning: **tight coupling / a hidden dependency** — the two places share mutable state or one reaches into the other's internals. Fix: make the dependency explicit and route it through a **boundary/interface**; give the shared concern a **single owner** so callers depend on the contract, not the internals.
- **"One change forces edits in many files" (shotgun surgery).** Meaning: **the concept isn't localized** — one responsibility is smeared across many modules. Fix: **gather** the scattered logic into one module so that concept has a single place to change.
- **One type does everything (god object — one file thousands of lines long, many unrelated sections).** Meaning: every new feature was attached to the nearest store. Fix: pin behavior first (tests + mutants per area), then split **by responsibility behind the same outward API** — the most-called area (usually the state everything depends on) first as a state machine, then the independent areas in parallel, one area per PR, existing tests unchanged, and the design doc updated with each piece.

Two worked examples:
- **Conditional sprawl → lookup.** `if (t==='a') doA(); else if (t==='b') doB(); …` (a new type = a new branch edited in every place that switches on `t`) → `const handlers = { a: doA, b: doB }; handlers[t]?.(args)` (a new type = one map entry).
- **Scattered concept → gathered module.** Price rules computed inline in `cart.ts`, `checkout.ts`, `invoice.ts` (a rule change = edit 3 files, and one is easy to miss) → one `pricing.ts` with `compute(...)`; the three call it (a rule change = one file).

Other common smells → refactor:
- **Duplicated code** → extract a function/module (one place to change).
- **Long function / large class doing several jobs** (SRP violation) → extract, split by reason-to-change.
- **Conditional sprawl** (type switch repeated) → polymorphism / lookup map / strategy.
- **State × input sprawl** (`if (stateA && key===X) … else if (stateB && …)`, the same state judged in several files) → one state-judging function + a state table + small action functions. See "상태 × 입력이 많으면 상태표로" below. Signal: a fix that breaks something elsewhere.
- **Code that relies on luck (timing instead of state)** — "retry up to N times", "try every 100 ms until it works", a fixed `sleep`/delay before acting, "re-read if the result looks wrong". It passes when timing is kind and fails when it isn't, and the retries keep running while the user does something else (stealing focus, overwriting a list). Suspect it hardest when **the same area keeps breaking and getting re-fixed**: each fix tunes a count or delay instead of naming what is not ready. Refactor → model the missing state explicitly: the producer signals "ready/settled" once and the consumer acts once on that signal; an in-between condition ("restored, not yet visible on disk") becomes a named state that rules follow, not a retry loop. If a proposed fix contains a retry count or a delay, stop and ask what signal is missing.
- **Feature envy** (a function leaning on another module's data) → move it to where the data lives.
- **Primitive/loose params threaded everywhere** → introduce a small type/object as the contract.

**Refactor safely (behavior-preserving):**
1. **Pin behavior with a test first** — capture current output so you can prove it's unchanged. Display values someone tuned by hand (spacing, indents, alignment) are behavior: pin them with a pixel/geometry baseline from the last release, and say "do not change display values" when handing out the refactor. A test rewritten to expect the new value proves nothing.
2. **Small steps** — one structural move at a time; run the test after each.
3. **Do not mix** a refactor with a feature/behavior change in the same commit — you can't tell which caused a regression.
4. **Verify behavior unchanged** (same tests + real run), then commit.

---

## Risk Tier & Review Output

Full gates when any is yes: money/permission/deletion/irreversible state · external effect (send/publish/pay) · webhook/queue/cron/retry · multiple writes that must stay consistent · concurrent access to one resource · wrong data source would silently produce wrong output · AI wrote it and no one has reasoned through failure paths. Otherwise short gate: data source, side effects, module boundary, one meaningful test (+ one behavior check if there's visible output).

Report includes:
```text
AI code safety:
- data source / source-of-truth:
- structure (coupling/cohesion, side-effect isolation):
- concurrency / transaction / idempotency decision:
- refactor applied (smell → move), if any:
- tests + behavior evidence (real run, not just tsc/unit):
- reviewer (harness or member) + what they verified:
- unverified scope · rollback path:
```

## Worked Examples (before → after)

> Each example was checked by an independent reviewer for correctness, fit to the principles, and not over-applying them.

### 의존성 역전(DIP): 도메인이 인프라가 아닌 추상에 의존

Before:
```ts
// order.service.ts — 도메인 로직이 인프라(PG 드라이버)를 직접 import
import { pgPool } from "../infra/pg";

export class OrderService {
  async place(userId: string, amount: number) {
    // 도메인 규칙이 SQL/커넥션에 직접 묶임 → DB 교체·테스트 불가
    await pgPool.query(
      "INSERT INTO orders(user_id, amount) VALUES($1, $2)",
      [userId, amount],
    );
  }
}
```
After:
```ts
// order.service.ts — 도메인이 소유한 포트(인터페이스)에만 의존
export interface OrderRepository {
  save(order: { userId: string; amount: number }): Promise<void>;
}

export class OrderService {
  constructor(private readonly repo: OrderRepository) {} // 주입

  async place(userId: string, amount: number) {
    if (amount <= 0) throw new Error("amount must be positive"); // 도메인 규칙 (인프라와 무관)
    await this.repo.save({ userId, amount });
  }
}

// infra/pg-order.repository.ts (바깥 계층이 포트를 구현 → 의존 방향 inward)
// export class PgOrderRepository implements OrderRepository { ... }

// test — 인메모리 fake만 주입하면 DB 없이 도메인 검증
// const fake: OrderRepository = { save: async () => {} };
// await new OrderService(fake).place("u1", 100);
```
**Why:** 도메인이 자신이 소유한 OrderRepository 포트에만 의존하고 PG 구현체를 생성자로 주입받으므로, 의존 방향이 인프라→도메인(inward)으로 뒤집힌다. DB를 바꾸거나 테스트에서 인메모리 fake를 넣어도 도메인 코드는 그대로다.

### 사이드이펙트 격리 — functional core / imperative shell

Before:
```ts
// 순수 계산과 I/O(DB·로그)가 한 함수에 뒤섞임 → 라이브 DB 없이는 할인 로직을 테스트할 수 없다
async function applyDiscount(userId: string): Promise<void> {
  const user = await db.users.find(userId);
  let total = user.cartTotal;
  if (user.isVip) total *= 0.9;
  if (total > 100) total -= 10;
  logger.info(`charging ${total}`);
  await db.users.update(userId, { finalTotal: total });
}
```
After:
```ts
// functional core: 순수·결정적 → DB/로그 없이 단위테스트 가능
export function computeTotal(u: { cartTotal: number; isVip: boolean }): number {
  let total = u.cartTotal;
  if (u.isVip) total *= 0.9;
  if (total > 100) total -= 10;
  return total;
}
// imperative shell: I/O는 edge에만
export async function applyDiscount(userId: string): Promise<void> {
  const user = await db.users.find(userId);
  const total = computeTotal(user);
  logger.info(`charging ${total}`);
  await db.users.update(userId, { finalTotal: total });
}
```
**Why:** 할인 규칙(핵심 비즈니스 로직)을 순수함수 computeTotal로 뽑아내 DB·로그 목킹 없이 입력→출력만으로 검증할 수 있고, I/O는 얇은 shell(applyDiscount)에만 남아 사이드이펙트 경계가 명확해진다.

### 공유 가변 상태 대신 매 호출 새 객체 (const·readonly)

Before:
```ts
class RateLimiter {
  // 모두가 참조하는 단 하나의 가변 객체
  static defaults = { windowMs: 60_000, max: 100 };

  resolve(userOpts: { windowMs?: number; max?: number }) {
    const opts = RateLimiter.defaults;            // 공유 참조를 그대로 집어옴
    if (userOpts.windowMs) opts.windowMs = userOpts.windowMs; // 공유 default를 변이!
    if (userOpts.max) opts.max = userOpts.max;
    return opts; // 이 요청의 override가 이후 모든 요청으로 새어나감 (ripple)
  }
}
```
After:
```ts
class RateLimiter {
  // 안 변하는 필드는 상수로 고정
  static readonly defaults = { windowMs: 60_000, max: 100 } as const;

  resolve(userOpts: { windowMs?: number; max?: number }) {
    // 공유 상태를 건드리지 않고 매 호출 새 객체를 합성
    return { ...RateLimiter.defaults, ...userOpts };
  }
}
```
**Why:** after는 공유 default를 readonly 상수로 고정하고 호출마다 새 객체를 만들어 반환하므로, 한 요청의 override가 다른 요청으로 새어나가는 동시성·ripple 버그가 원천적으로 사라진다. 상태를 변이하지 않으니 추적·롤백도 쉽다.

### 조건분기 폭발 → lookup map으로 (새 케이스 = 한 엔트리)

Before:
```ts
type Channel = "email" | "sms" | "push";
type Notification = { type: Channel; to: string };

function send(n: Notification): string {
  if (n.type === "email") return `Emailing ${n.to}`;
  else if (n.type === "sms") return `SMS to ${n.to}`;
  else if (n.type === "push") return `Push to ${n.to}`;
  // 채널 추가할 때마다 이 분기 사슬을 계속 수정해야 함
  throw new Error(`unknown channel: ${n.type}`);
}
```
After:
```ts
type Channel = "email" | "sms" | "push";
type Notification = { type: Channel; to: string };

// 채널 → 핸들러 lookup. 새 채널 = 여기 한 엔트리만 추가
const senders: Record<Channel, (to: string) => string> = {
  email: (to) => `Emailing ${to}`,
  sms: (to) => `SMS to ${to}`,
  push: (to) => `Push to ${to}`,
};

const send = (n: Notification): string => senders[n.type](n.to);
```
**Why:** 분기 사슬 대신 타입→핸들러 lookup map으로 바꿔 새 케이스 추가가 한 줄로 끝나고, Record<Channel, ...>가 누락된 케이스를 컴파일 타임에 강제하므로 런타임 unknown 예외가 원천 차단된다.

### 상태 × 입력이 많으면 상태표로 — 판정 하나 + 표 + 작은 실행 함수

lookup map(위 예)이 "타입 하나 → 할 일"이라면, 상태표는 "상태 × 입력 → 할 일"이다. 편집기 키 처리(목록·인용·표), 화면 모드, 동기화 상태처럼 조합이 많은 곳에 쓴다.

Before (편집기 목록 처리 — 같은 판단이 네 곳에 흩어짐):
```js
// 같은 판단("이 줄이 몇 단계인가")을 네 곳이 따로 한다
// list-editing.js   : 원문 공백 수로 단계 계산 → Enter/Backspace
// inline-render.js  : 기호 폭·padding 으로 단계 위치 계산 → 화면
// vim-list-shift.js : >> / << 가 자기 규칙으로 들여쓰기
// markdown-keys.js  : 우리 Enter 가 false 면 CodeMirror 기본 목록 이어쓰기로
if (isEmptyItem(line)) { ... } else if (afterExit && typed === '-') { ... } else if (...) { ... }
```
After (인용 규칙):
```js
// ① 판정 — 상태는 한 함수만 정한다 (화면·키·vim 이 모두 이것을 부른다)
function quoteState(lines, row, col) { /* 'emptyQuote' | 'quoteEnd' | 'quoteStartBelowQuote' | 'quoteStartFirst' | null */ }
// ② 표 — 보통 편집과 다른 칸만
const QUOTE_TABLE = {
  emptyQuote:           { Enter: 'endQuote',     Backspace: 'joinUp' },
  quoteEnd:             { Enter: 'newQuoteLine', o: 'newQuoteLine' },
  quoteStartBelowQuote: { Backspace: 'joinUp' },
  quoteStartFirst:      { Backspace: 'dropMarker' },
};
// ③ 실행 — 할 일마다 작은 함수, 표에 없으면 기본 동작
const action = QUOTE_TABLE[quoteState(lines, row, col)]?.[key];
if (!action) return null;
return ACTIONS[action](lines, row, col);
```
**Why:** 상태 × 입력 조합이 표 한 곳에 보여 빠진 칸이 드러나고, 새 입력은 표에 한 칸 더하는 것으로 끝난다.

> ⚠️ **상태표는 만능이 아니다.** 판정이 여러 곳이면 표가 맞아도 결과가 틀리고, 표 밖에 if 하나가 붙으면 흩어진 코드로 돌아간다. 표는 아래 6가지와 **함께** 쓸 때만 효과가 난다.

**표만으로는 좋아지지 않는다 — 함께 지킬 것:**
1. **판정 함수는 하나.** 판정이 여러 곳이면 표가 맞아도 엉뚱한 칸을 찾는다(위 Before 의 진짜 원인).
2. **빈칸의 뜻을 정한다.** 경우가 닫혀 있고 틀리면 데이터가 상하는 표(저장·동기화)는 모든 칸을 채우고 빈칸 = 시험 실패. 기본 동작 위에 특별한 경우만 얹는 표(편집기 키)는 특별한 칸만 적고 `if (!action) return null` 로 나머지를 기본 동작에 맡긴다 — 다 적으면 특별한 칸이 묻힌다. 어느 쪽인지 표 위 주석에 적는다.
3. **표 밖 if 금지.** 새 경우는 상태나 칸을 하나 더 만든다. 리뷰는 "표 앞·뒤의 if" 부터 본다.
4. **"어떻게"는 보통 함수로.** 번호 다시 매기기처럼 복잡한 동작은 실행 함수 안에서 잘 쓰고 그 함수만 따로 시험한다. 표는 "언제 무엇을"만.
5. **칸마다 시험 한 줄 + 실제 사용 순서 하나.** 칸 시험은 표를, 사람이 실제로 친 키 순서(녹화 그대로) 시험은 칸 사이 이음새를 지킨다.
6. **갈래가 둘뿐이고 늘 일이 없으면 if 가 더 읽기 쉽다.** 표로 옮길 신호: 같은 판단이 두 곳 이상 · 고쳤더니 다른 곳이 깨짐 · 상태 조합을 사람이 머리로 기억하고 있음.

### 공유 가변 상태를 인터페이스 경계로 분리해 ripple 끊기

Before:
```ts
// config.ts — 모듈 전역 가변 싱글턴
export const config = { apiUrl: "", token: "" };

// auth.ts
import { config } from "./config";
export function login() {
  config.apiUrl = "https://api/auth";   // 공유 상태를 직접 변경
  return fetch(config.apiUrl, { headers: { token: config.token } });
}

// billing.ts 도 config.apiUrl 을 덮어씀
// → billing 실행 뒤 login() 이 엉뚱한 URL 로 깨진다 (무관한 곳 ripple)
```
After:
```ts
// config.ts — 읽기 전용 경계 계약
export interface ApiConfig { readonly apiUrl: string; readonly token: string; }

// auth.ts — 의존을 주입받고 읽기만, path 는 호출자 소유
export function login(cfg: ApiConfig, path: string) {
  // cfg.apiUrl = "..."  // ← 컴파일 에러: readonly, 변이 자체가 경계에서 막힘
  return fetch(`${cfg.apiUrl}${path}`, { headers: { token: cfg.token } });
}

// billing.ts 는 자기 path 만 넘김 → auth 상태를 건드릴 방법이 없다
login(cfg, "/auth");
login(cfg, "/billing");
// 공유 가변 상태가 사라져 한 호출이 다른 호출을 깨지 못하고(런타임 ripple 제거),
// readonly 라 변이 시도는 컴파일타임에 차단된다(경계에서 방어).
```
**Why:** after는 공유 가변 상태를 없애고 config를 readonly 인터페이스로 주입받아 읽기만 하므로, 한 모듈의 변경이 다른 모듈로 새는 숨은 의존이 사라진다. 각 호출자가 자기 입력을 단독 소유하고 계약 변경은 타입 경계에서 잡혀 ripple이 끊긴다.

### 흩어진 '무료배송' 규칙을 한 모듈로 모으기 (Shotgun Surgery 제거)

Before:
```ts
// cart.ts
function cartSummary(total: number) {
  return { total, freeShipping: total >= 50_000 };
}
// checkout.ts
function shippingFee(total: number) {
  return total >= 50_000 ? 0 : 3_000;
}
// banner.ts — 임계값 50_000 이 3개 파일에 흩어짐
function remainingForFreeShip(total: number) {
  return Math.max(0, 50_000 - total); // 규칙 바뀌면 여러 파일 동시 수정
}
```
After:
```ts
// shipping.ts — '무료배송' 개념의 단일 변경 지점
const FREE_SHIP_THRESHOLD = 50_000;
export const isFreeShipping = (total: number): boolean =>
  total >= FREE_SHIP_THRESHOLD;
export const shippingFee = (total: number): number =>
  isFreeShipping(total) ? 0 : 3_000;
export const remainingForFreeShip = (total: number): number =>
  Math.max(0, FREE_SHIP_THRESHOLD - total);
// cart.ts / checkout.ts / banner.ts 는 이 모듈만 import → 규칙 변경 = 1곳
```
**Why:** 무료배송이라는 한 개념(임계값+판정+요금)이 여러 파일에 복제돼 있으면 규칙 하나 바꿀 때 산탄총처럼 여러 파일을 고쳐야 하고 누락·불일치가 생긴다. 한 모듈로 모으면 변경 지점이 하나가 되어 수정이 안전하고 재사용된다.

## Anti-patterns

- "tsc/unit passed, so it works." (compile ≠ behavior) · "I checked the empty case." (check the one with a value)
- "Let's make interfaces for everything" without a real volatility boundary. · "We used a transaction, so it's safe."
- Refactor + feature change in one commit. · Refactoring without pinning behavior first. · A bug fix that also "improves" the shared input path.
- Adding another branch to a growing switch instead of a map/strategy.
- Fixing a timing bug by raising a retry count or a delay ("try 3 more times", "wait 0.5 s") — luck, not logic; name the missing ready/settled state instead.
- 서버가 화면 문장을 만들어 보내기 — 문구 하나 바꾸려고 서버를 고치고 배포하게 된다. · 언어마다 화면을 한 벌씩 복사하기 — 고칠 때마다 여러 벌을 고친다.

## Source Anchors

- Structure: SOLID (dependency direction, SRP/ISP/DIP as coupling); functional core / imperative shell (side-effect isolation).
- Refactoring: Fowler, *Refactoring* (code smells — shotgun surgery, divergent change, feature envy, duplicated code); Feathers, *Working Effectively with Legacy Code* (pin tests before changing structure).
- Operational gates: race condition, partial write, atomic operation, transaction, idempotency key. Video: Nomad Coders, YouTube `ThYV4Kpf9Bk`.
- Design candidates, adding-a-feature signals, subtract first, replace-don't-keep-both, the comment pass, sorting review findings: adapted from pstack (cursor/plugins `pstack`, MIT, by Lauren Tan) — principles `exhaust-the-design-space`, `subtract-before-you-add`, `laziness-protocol`, `migrate-callers-then-delete-legacy-apis`, skills `architect`, `no-comments`, `interrogate`. Adopted 2026-10-17; rewritten for our workflow, not copied.
- Agent-friendly structure: a video introducing a Cursor engineer's talk, YouTube `o_7vTaHOL28` — agent habits as design input; enforcement by codebase structure and compiler/lint/CI over prose. Adapted, not adopted wholesale.
