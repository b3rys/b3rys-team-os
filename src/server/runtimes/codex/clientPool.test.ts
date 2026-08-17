// ★팀원별 app-server 를 턴보다 오래 살린다★
//
// 왜 — codex 0.147 의 spawn_agent 는 ★비동기★ 다. 띄우면 id 만 즉시 오고 결과는 나중에 회수한다.
// 턴 끝에 프로세스를 닫으면 그 안에서 돌던 서브가 같이 죽는다.
// 실측: 서브 4개 중 3개가 완료 기록 없이 잘렸고, 메인 마지막 말이 "서브 결과를 회수합니다" 였다.
import { test, expect, beforeEach } from "bun:test";
import { acquireClient, dropClient, dropAllClients, pooledAgents } from "./clientPool";

class Fake {
  closed = false;
  get isClosed() { return this.closed; }
  close() { this.closed = true; }
}

beforeEach(() => dropAllClients());

test("★같은 팀원은 같은 프로세스를 다시 쓴다★ — 매번 새로 띄우면 서브가 남을 곳이 없다", () => {
  let made = 0;
  const a = acquireClient("dex", () => { made++; return new Fake(); });
  const b = acquireClient("dex", () => { made++; return new Fake(); });
  expect(made).toBe(1);
  expect(b.reused).toBe(true);
  expect(b.client).toBe(a.client);
});

test("★죽은 프로세스는 돌려주지 않는다★ — 그대로 주면 그 턴이 통째로 실패한다", () => {
  const a = acquireClient("dex", () => new Fake());
  (a.client as Fake).close(); // 크래시·재시작으로 죽은 상황
  const b = acquireClient("dex", () => new Fake());
  expect(b.reused).toBe(false);
  expect(b.client).not.toBe(a.client);
});

test("팀원끼리 섞이지 않는다", () => {
  const a = acquireClient("dex", () => new Fake());
  const b = acquireClient("cody", () => new Fake());
  expect(a.client).not.toBe(b.client);
  expect(pooledAgents().sort()).toEqual(["cody", "dex"]);
});

test("drop 하면 닫히고 목록에서 빠진다(턴 실패 정리)", () => {
  const a = acquireClient("dex", () => new Fake());
  dropClient("dex");
  expect((a.client as Fake).isClosed).toBe(true);
  expect(pooledAgents()).toEqual([]);
});

test("★전부 정리★ — 안 하면 좀비 프로세스가 쌓인다", () => {
  const a = acquireClient("dex", () => new Fake());
  const b = acquireClient("cody", () => new Fake());
  dropAllClients();
  expect((a.client as Fake).isClosed).toBe(true);
  expect((b.client as Fake).isClosed).toBe(true);
  expect(pooledAgents()).toEqual([]);
});

test("없는 팀원을 drop 해도 터지지 않는다", () => {
  expect(() => dropClient("nobody")).not.toThrow();
});

// ★비정상 종료 턴은 프로세스를 버린다★ (2026-08-12 실측)
//
// 상주로 바꾼 직후 `appserver_interrupted` 가 났다 — 앞 턴의 서브에이전트가 아직 도는
// 프로세스에 새 턴이 들어가면 서로 간섭한다. 재사용 이득보다 ★턴을 통째로 잃는★ 손해가 크다.
// 그래서 ★완료된 턴만★ 프로세스를 남긴다.

test("★버린 프로세스는 다음에 재사용되지 않는다★", () => {
  const first = acquireClient("dex", () => new Fake());
  dropClient("dex"); // 비정상 종료로 폐기했다고 가정
  const second = acquireClient("dex", () => new Fake());
  expect(second.reused).toBe(false);
  expect(second.client).not.toBe(first.client);
  expect((first.client as Fake).isClosed).toBe(true); // 실제로 닫혔다(좀비 방지)
});
