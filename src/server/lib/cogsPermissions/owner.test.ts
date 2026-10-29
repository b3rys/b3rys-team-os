import {test, expect} from "bun:test";
import {fetchCogsOwner, type CogsOwner} from "./owner";
const owner: CogsOwner = {instance:"http://cogs", botId:12, userId:7, generation:3};
const reply = (result: unknown, status = 200, ok = true) => (async () =>
  new Response(JSON.stringify({ok, result}), {status})) as unknown as typeof fetch;

test("getMe binds the instance and bot as well as owner generation", async () => {
  const calls: unknown[] = [];
  const f = (async (_url: unknown, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ok:true,result:{id:12,owner_user_id:7,owner_generation:3}}));
  }) as unknown as typeof fetch;
  expect(await fetchCogsOwner("http://cogs/", "fixture", undefined, f)).toEqual(owner);
  expect(await fetchCogsOwner("http://cogs", "fixture", owner, f)).toEqual(owner);
  expect(calls).toEqual([{}, {expected_owner_generation:3}]);
  expect(await fetchCogsOwner("http://other", "fixture", owner, f)).toBeNull();
  expect(calls).toHaveLength(2);
});

test("missing, stale, foreign and malformed ownership never yields an execution owner", async () => {
  for (const result of [null, {}, {id:12,owner_user_id:null,owner_generation:3},
    {id:12,owner_user_id:7}, {id:12,owner_user_id:7,owner_generation:"3"},
    {id:12,owner_user_id:7,owner_generation:0}, {id:12,owner_user_id:7,owner_generation:5},
    {id:13,owner_user_id:7,owner_generation:3}, {id:12,owner_user_id:8,owner_generation:3}]) {
    expect(await fetchCogsOwner("http://cogs", "fixture", owner, reply(result))).toBeNull();
  }
  for (const status of [400,401,409,500]) {
    expect(await fetchCogsOwner("http://cogs", "fixture", owner,
      reply({id:12,owner_user_id:7,owner_generation:3},status))).toBeNull();
  }
  expect(await fetchCogsOwner("http://cogs", "fixture", owner, (async () => {throw new Error("offline");}) as unknown as typeof fetch)).toBeNull();
  expect(await fetchCogsOwner("http://cogs", "fixture", null, reply({}))).toBeNull();
});
