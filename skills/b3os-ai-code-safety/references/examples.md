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

lookup map(위 Refactoring 절의 "조건분기 → lookup")이 "타입 하나 → 할 일"이라면, 상태표는 "상태 × 입력 → 할 일"이다. 편집기 키 처리(목록·인용·표), 화면 모드, 동기화 상태처럼 조합이 많은 곳에 쓴다.

- ① 판정: 상태는 함수 하나가 정한다(화면·키·단축키가 모두 이것을 부른다).
- ② 표: 보통 동작과 다른 칸만 적는다.
- ③ 실행: 할 일마다 작은 함수를 두고, 표에 없으면 기본 동작을 한다.

Cases are adapted to the situation, not copied. 적용 사례: 편집기의 목록·인용·표 키 처리에서 "이 줄이 몇 단계인가"를 네 모듈(입력·렌더·단축키·기본 편집)이 따로 판단했다. 판정 함수 하나와 표 하나로 모았고, 새 입력은 표에 칸 하나를 더하는 것으로 끝났다.

> ⚠️ **상태표는 만능이 아니다.** 판정이 여러 곳이면 표가 맞아도 결과가 틀리고, 표 밖에 if 하나가 붙으면 흩어진 코드로 돌아간다. 표는 아래 6가지와 **함께** 쓸 때만 효과가 난다.

**표만으로는 좋아지지 않는다 — 함께 지킬 것:**
1. **판정 함수는 하나.** 판정이 여러 곳이면 표가 맞아도 엉뚱한 칸을 찾는다.
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
