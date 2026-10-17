import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { reviewDecision, activeReviewOwners } from "./task-review-ping";
const DAY = 24 * 3600_000;
const now = Date.parse("2026-10-17T00:00:00Z");
const cards = [{ id: "a", title: "task", owner: "test", column: "doing" as const, description: null, updated_at: "2026-10-10 00:00:00" }];
test("첫 리뷰와 첫 무변경 리뷰는 보내며 두 번째 연속 무변경부터 억제한다", () => {
 const first = reviewDecision(cards, undefined, now);
 expect(first.send).toBe(true);
 const second = reviewDecision(cards, { ...first.next, lastSentAt: now }, now + DAY);
 expect(second.send).toBe(true);
 const third = reviewDecision(cards, { ...second.next, lastSentAt: now + DAY }, now + 2 * DAY);
 expect(third.send).toBe(false);
});
test("무변경이어도 마지막 발송 7일째는 보낸다", () => {
 const state = { ...reviewDecision(cards, undefined, now).next, unchanged: true, lastSentAt: now };
 expect(reviewDecision(cards, state, now + 7 * DAY - 1).send).toBe(false);
 expect(reviewDecision(cards, state, now + 7 * DAY).send).toBe(true);
});
test("카드 갱신·추가·삭제·lane 변경은 보내고 정렬만 바뀌면 억제한다", () => {
 const multi = [...cards, { ...cards[0]!, id: "b" }];
 const state = { ...reviewDecision(multi, undefined, now).next, unchanged: true, lastSentAt: now };
 expect(reviewDecision([...multi].reverse(), state, now + DAY).send).toBe(false);
 for (const changed of [cards, [...multi, { ...cards[0]!, id: "c" }], multi.map(t => ({...t, updated_at: "new"})), multi.map(t => ({...t, column: "plan" as const}))]) {
  expect(reviewDecision(changed, state, now + DAY).send).toBe(true);
 }
});
test("갱신 시각을 모르면 발송하고 보류·완료·미배정은 리뷰 대상에서 제외한다", () => {
 expect(reviewDecision([{ ...cards[0]!, updated_at: undefined }], undefined, now).send).toBe(true);
 expect(activeReviewOwners([{...cards[0]!, held_at: "held"}, {...cards[0]!, column:"done"}, {...cards[0]!, owner:null}], ["test"])).toEqual([]);
});

test("실제 리뷰 스크립트가 무변경 상태를 재실행 사이에 보존하고 7일 뒤 다시 보낸다", async () => {
 const dir=mkdtempSync(join(tmpdir(),"task-review-"));
 const script=join(dir,"scripts/task-review-ping.ts");
 mkdirSync(join(dir,"scripts"));
 copyFileSync(join(import.meta.dir,"task-review-ping.ts"),script);
 const registry=join(dir,"agents.json");
 writeFileSync(registry,JSON.stringify([{id:"test",team_official_member:true}]));
 let sent=0;
 let failSend=false;
 const server=Bun.serve({port:0,fetch(req){
  if(new URL(req.url).pathname==="/tasks")return Response.json({tasks:cards});
  sent++;
  return Response.json({ok:!failSend});
 }});
 const run=async()=>{
  const proc=Bun.spawn([process.execPath,script],{env:{PATH:process.env.PATH!,TEAM_AGENT_REGISTRY:registry,TEAM_TASKS_API:`${server.url}tasks`,TEAM_INBOX_API:`${server.url}inbox`},stdout:"pipe",stderr:"pipe"});
  expect(await proc.exited).toBe(0);
 };
 try {
  await run();await run();await run();
  expect(sent).toBe(2);
  const path=join(dir,"var/task-review-ping-state.json");
  const state=JSON.parse(readFileSync(path,"utf8"));
  state.test.lastSentAt=Date.now()-7*DAY-1000;
  writeFileSync(path,JSON.stringify(state));
  failSend=true;
  await run();
  expect(JSON.parse(readFileSync(path,"utf8")).test.lastSentAt).toBe(state.test.lastSentAt);
  failSend=false;
  await run();
  expect(sent).toBe(4);
  await run();expect(sent).toBe(4);
 }finally {server.stop(true);rmSync(dir,{recursive:true,force:true});}
});
