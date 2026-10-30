# Worked examples (before → after)

## DIP: 도메인이 인프라가 아닌 추상에 의존

Before: 도메인 서비스가 PG 드라이버를 직접 import 해서 DB 교체·테스트가 막힌다.
```ts
import { pgPool } from "../infra/pg";
export class OrderService {
  async place(userId: string, amount: number) {
    await pgPool.query("INSERT INTO orders(user_id, amount) VALUES($1, $2)", [userId, amount]);
  }
}
```
After: 도메인이 소유한 포트에만 의존하고 구현체는 생성자로 주입한다. 테스트는 인메모리 fake 로 DB 없이 돈다.
```ts
export interface OrderRepository { save(order: { userId: string; amount: number }): Promise<void>; }
export class OrderService {
  constructor(private readonly repo: OrderRepository) {}
  async place(userId: string, amount: number) {
    if (amount <= 0) throw new Error("amount must be positive");
    await this.repo.save({ userId, amount });
  }
}
// infra/pg-order.repository.ts: class PgOrderRepository implements OrderRepository
```

## 사이드이펙트 격리: functional core / imperative shell

Before: 할인 계산과 DB·로그가 한 함수에 섞여 라이브 DB 없이 할인 로직을 테스트할 수 없다.
After: 계산은 순수 함수로 뽑고 I/O 는 얇은 shell 에만 남긴다.
```ts
export function computeTotal(u: { cartTotal: number; isVip: boolean }): number {
  let total = u.cartTotal;
  if (u.isVip) total *= 0.9;
  if (total > 100) total -= 10;
  return total;
}
export async function applyDiscount(userId: string) {
  const user = await db.users.find(userId);
  const total = computeTotal(user);
  logger.info(`charging ${total}`);
  await db.users.update(userId, { finalTotal: total });
}
```

## 공유 가변 상태 → 읽기 전용 계약 (ripple 끊기)

Before: 모듈 전역 `config` 를 auth·billing 이 서로 덮어써서 billing 실행 뒤 `login()` 이 엉뚱한 URL 로 깨진다. 같은 패턴으로 `static defaults` 객체를 요청마다 변이하면 한 요청의 override 가 다음 요청으로 샌다.
After: readonly 인터페이스를 주입받아 읽기만 하고, 호출마다 새 객체를 합성한다.
```ts
export interface ApiConfig { readonly apiUrl: string; readonly token: string; }
export function login(cfg: ApiConfig, path: string) {
  return fetch(`${cfg.apiUrl}${path}`, { headers: { token: cfg.token } });
}
// 기본값 병합: return { ...RateLimiter.defaults, ...userOpts };  (defaults 는 static readonly ... as const)
```

## 조건 분기 폭발 → lookup map

새 케이스 = 항목 하나. `Record<Channel, ...>` 이 누락을 컴파일 타임에 잡는다.
```ts
type Channel = "email" | "sms" | "push";
const senders: Record<Channel, (to: string) => string> = {
  email: (to) => `Emailing ${to}`, sms: (to) => `SMS to ${to}`, push: (to) => `Push to ${to}`,
};
const send = (n: { type: Channel; to: string }) => senders[n.type](n.to);
```

## 흩어진 개념 → 한 모듈 (shotgun surgery 제거)

`cart.ts`·`checkout.ts`·`banner.ts` 에 무료배송 임계값 `50_000` 이 흩어져 있으면 규칙 하나를 바꿀 때 세 파일을 고치고 하나를 놓친다. `shipping.ts` 에 `FREE_SHIP_THRESHOLD`, `isFreeShipping`, `shippingFee`, `remainingForFreeShip` 을 모으고 세 파일은 이것만 import 한다.

## 상태 × 입력이 많으면 상태표로

lookup map 이 "타입 → 할 일"이면 상태표는 "상태 × 입력 → 할 일"이다. 편집기 키 처리, 화면 모드, 동기화 상태처럼 조합이 많은 곳에 쓴다. Before 는 같은 판단("이 줄이 몇 단계인가")을 `list-editing.js`, `inline-render.js`, `vim-list-shift.js`, `markdown-keys.js` 네 곳이 따로 하던 구조다.
```js
// ① 판정 — 상태는 한 함수만 정한다 (화면·키·vim 이 모두 이것을 부른다)
function quoteState(lines, row, col) { /* 'emptyQuote' | 'quoteEnd' | ... | null */ }
// ② 표 — 보통 편집과 다른 칸만
const QUOTE_TABLE = {
  emptyQuote: { Enter: 'endQuote', Backspace: 'joinUp' },
  quoteEnd:   { Enter: 'newQuoteLine', o: 'newQuoteLine' },
};
// ③ 실행 — 할 일마다 작은 함수, 표에 없으면 기본 동작
const action = QUOTE_TABLE[quoteState(lines, row, col)]?.[key];
if (!action) return null;
return ACTIONS[action](lines, row, col);
```
표만으로는 좋아지지 않는다. 함께 지킬 것:
1. 판정 함수는 하나. 판정이 여러 곳이면 표가 맞아도 엉뚱한 칸을 찾는다.
2. 빈칸의 뜻을 정한다. 경우가 닫혀 있고 틀리면 데이터가 상하는 표(저장·동기화)는 모든 칸을 채우고 빈칸 = 시험 실패. 기본 동작 위에 특별한 경우만 얹는 표(편집기 키)는 특별한 칸만 적고 `if (!action) return null` 로 나머지를 기본 동작에 맡긴다. 어느 쪽인지 표 위 주석에 적는다.
3. 표 밖 if 를 두지 않는다. 새 경우는 상태나 칸을 더하고, 리뷰는 표 앞·뒤의 if 부터 본다.
4. "어떻게"는 보통 함수로. 복잡한 동작(번호 다시 매기기)은 실행 함수 안에서 잘 쓰고 그 함수만 따로 시험한다.
5. 칸마다 시험 한 줄 + 실제 사용 순서(녹화 그대로) 시험 하나로 칸 사이 이음새를 지킨다.
6. 갈래가 둘뿐이고 늘 일이 없으면 if 가 더 읽기 쉽다. 표로 옮길 신호: 같은 판단이 두 곳 이상 · 고쳤더니 다른 곳이 깨짐 · 상태 조합을 사람이 머리로 기억하고 있음.
