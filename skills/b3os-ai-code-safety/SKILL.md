---
name: b3os-ai-code-safety
description: b3rys software-structure and refactoring guide for AI-generated or AI-modified code. Use when designing a program's structure, writing non-trivial code, reviewing code, or refactoring when the code "smells" (a change forces edits in many places, or a fix breaks something unrelated). Covers SOLID/module boundaries, side-effect-reducing structure (pure core, immutability, dependency injection, map/factory over conditional sprawl), the operational Effect gates (concurrency, transaction, idempotency), and how to refactor common code smells.
---

# b3rys AI Code Safety — Structure & Refactoring

As code and logic grow, the cost is not the happy path — it is **coupling**: a change ripples into places you did not touch, and a "small fix" breaks something unrelated. This skill is a **code-structure and refactoring guide**: structure well from the initial design so a change stays local, apply operational safety where effects live, and refactor deliberately when the code smells. (Team-workflow rules — backup-first, verbatim user input, don't-touch-working-logic — live in TEAM-OS, not here.)

Two throughlines:
- **Structure to reduce side effects and coupling** — so most changes stay in one place.
- **Refactor when it smells** — the "I fixed one thing and something unrelated broke" signal is coupling telling you where the structure is wrong.

---

## Phase 1 — Design (structure before writing)

- **Data flow / source of truth first.** Map read → transform → write, and name the single source of truth for each piece of state. Confirm you read the live source, not a synced mirror that drops fields. (Root of the 2026-07-06 dashboard bug: a read hit the DB-synced registry, which lacked the `purpose` field, instead of `agents.json` where it lives — the code compiled and passed units, the output was wrong.)
- **SOLID as coupling design, not class patterns.** (SOLID = five object-oriented design principles; here we use them as a low-coupling lens, not a class-pattern checklist.) Dependencies point **inward** — domain/use-case logic does not depend on framework/ORM/HTTP/infra (**DIP**, dependency inversion: depend on an abstraction, not a concrete infra type). One reason to change per module (**SRP**, single responsibility). Depend on the small slice you actually use (**ISP**, interface segregation: small interfaces). Add an abstraction only when a real extension axis exists (skip speculative **OCP**, open/closed).
- **Module boundaries hide volatile decisions.** A module's public contract is a schema/interface/event/API; its private choices (storage, format, algorithm) stay hidden and swappable. One owner per concern — no two modules writing the same mutable state.

## Phase 2 — Write (structure that reduces side effects)

- **Pure core, effects at the edges (functional core / imperative shell** — a pure, side-effect-free core of logic wrapped by a thin I/O layer at the edges**).** Keep business logic pure: inputs → outputs, no hidden I/O. Push DB, network, filesystem, time, random, and env reads to adapters at the module edge. A pure core is testable without live services and has no spooky action at a distance.
- **Immutability first.** Prefer `const` and immutable values. A class field that never changes is a **constant**, not mutable state — declare it so. Minimize shared mutable state; it is the raw material of concurrency bugs and ripple effects.
- **Replace conditional sprawl with data or polymorphism.** A `switch`/`if-else` on a type that grows, or the same branch repeated in several files, is a smell. Replace with a **lookup map**, a **factory/strategy**, or polymorphism — so a new case is one new entry, not a new branch edited in N places.
- **Small functions, small interfaces.** One function = one job; one interface = the narrow capability the caller needs. Small units are the precondition for cheap refactoring.
- **Isolate the effect by name.** Effectful functions are explicit: `save*`, `publish*`, `charge*`, `send*`, `delete*` at the edges — never buried inside pure-looking logic.

**Operational Effect gates** (apply while writing; the correctness AI most often misses):
1. **Side-effect boundary** — every effect named, placed at an edge, and known whether it can run twice.
2. **Concurrency** — two requests/jobs on the same resource can't break the invariant; prefer one atomic `UPDATE ... WHERE cond` over app-level read→check→write.
3. **Transaction** — the all-or-nothing boundary is named; partial-write failure handled; DB-write + publish uses an **outbox** (write the event to a DB table in the same transaction, deliver it separately) or recovery path, not hope.
4. **Idempotency / retry** — (**idempotent** = running it twice has the same effect as once) same command/event twice = one result; retryable APIs use an idempotency key (a stable id so a retry is recognized as the same request); consumers assume duplicate/delayed/out-of-order delivery.

## Phase 3 — Review

- Non-trivial AI-generated/modified code passes an **adversarial harness OR a team member** before merge/deploy — no solo merge. Minimum adversarial dimensions: **SQL injection + `EXPLAIN` query plan**, **scope/privacy** (does a query return rows the caller wasn't a party to?), **fail-safe** (missing DB / 0 rows / empty input degrade gracefully). The reviewer checks the **actual rendered field/behavior**, not just that it compiles.

## Phase 4 — Test

- **Build green ≠ behavior correct.** tsc/unit prove "does not crash," not "renders/behaves as intended." Behavior-verified = drive the real flow once with evidence (screenshot / DOM read / real config value / real-data log), using a **representative case** (check the one that has a value, not only the empty one). Three-stage done: `code-complete` ≠ `behavior-verified` ≠ `deployed`; UI/persona/config never merge without behavior-verified.

---

## Refactoring — when the code smells

The smell is the signal; the refactor is the response. The two GD called out first:

- **"I fixed one thing and something unrelated broke" (ripple).** Meaning: **tight coupling / a hidden dependency** — the two places share mutable state or one reaches into the other's internals. Fix: make the dependency explicit and route it through a **boundary/interface**; give the shared concern a **single owner** so callers depend on the contract, not the internals.
- **"One change forces edits in many files" (shotgun surgery).** Meaning: **the concept isn't localized** — one responsibility is smeared across many modules. Fix: **gather** the scattered logic into one module so that concept has a single place to change.

Two worked examples:
- **Conditional sprawl → lookup.** `if (t==='a') doA(); else if (t==='b') doB(); …` (a new type = a new branch edited in every place that switches on `t`) → `const handlers = { a: doA, b: doB }; handlers[t]?.(args)` (a new type = one map entry).
- **Scattered concept → gathered module.** Price rules computed inline in `cart.ts`, `checkout.ts`, `invoice.ts` (a rule change = edit 3 files, and one is easy to miss) → one `pricing.ts` with `compute(...)`; the three call it (a rule change = one file).

Other common smells → refactor:
- **Duplicated code** → extract a function/module (one place to change).
- **Long function / large class doing several jobs** (SRP violation) → extract, split by reason-to-change.
- **Conditional sprawl** (type switch repeated) → polymorphism / lookup map / strategy.
- **Feature envy** (a function leaning on another module's data) → move it to where the data lives.
- **Primitive/loose params threaded everywhere** → introduce a small type/object as the contract.

**Refactor safely (behavior-preserving):**
1. **Pin behavior with a test first** — capture current output so you can prove it's unchanged.
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

> 팀 하네스 조사 + 적대 교차검증 통과(2026-07-06): 각 예제는 정확성·원칙 부합·과적용 아님을 독립 리뷰어가 검증했다.

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
- Refactor + feature change in one commit. · Refactoring without pinning behavior first.
- Adding another branch to a growing switch instead of a map/strategy.

## Source Anchors

- Structure: SOLID (dependency direction, SRP/ISP/DIP as coupling); functional core / imperative shell (side-effect isolation).
- Refactoring: Fowler, *Refactoring* (code smells — shotgun surgery, divergent change, feature envy, duplicated code); Feathers, *Working Effectively with Legacy Code* (pin tests before changing structure).
- Operational gates: race condition, partial write, atomic operation, transaction, idempotency key. Video: Nomad Coders, YouTube `ThYV4Kpf9Bk`.
- b3rys lessons: data-source bug + behavior-verify (`feedback_verify_actual_behavior_not_tsc`, 2026-07-06); lifecycle + refactoring framing (GD 2026-07-06).
