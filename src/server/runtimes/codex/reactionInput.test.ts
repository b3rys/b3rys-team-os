import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { createReactionInbox, reactionInputs, REACTION_INSTRUCTIONS, type ReactionUpdate } from '../../lib/reactionInput';
import { routeReactionUpdate, bridgeUpdatesUrl, handleMessage, type BridgeDeps } from './bridge';
import { parseMemberChannel, DEFAULT_CHANNEL } from '../../lib/memberChannel';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const channel = parseMemberChannel({kind:'b3chat',api_base:'http://127.0.0.1:1',owner_chat:'2'});
function reaction(emoji='👌', overrides: Partial<ReactionUpdate>={}): ReactionUpdate {
 return {chat:{id:2},message_id:123,user:{id:1,is_bot:false,first_name:'GD'},old_reaction:[],new_reaction:[{type:'emoji',emoji}],cogs_message_sender_id:7,cogs_message_text:'제안입니다',cogs_reactor_is_master:true,cogs_hop:0,cogs_chain_id:88,...overrides};
}
function harness(running=false, ownBotId=7) {
 const queued: Array<()=>Promise<void>>=[]; const steered:string[]=[]; const turns:string[]=[]; let receipts=0;
 const inbox=createReactionInbox();
 const deps={channel,allowFrom:new Set([2]),ownBotId,inbox,
  route:{isRunning:()=>running,steer:async (text:string)=>{steered.push(text);return true},enqueue:(run:()=>Promise<void>)=>queued.push(run),receive:async()=>{receipts++;return 1}},
  runTurn:async(text:string)=>{turns.push(inbox.prepend(2,text))},
 };
 return {deps,inbox,queued,steered,turns,receipts:()=>receipts};
}

describe('human reaction delivery',()=>{
 test('OK wakes only the target author, never another bot',async()=>{
  const author=harness(),other=harness(false,8);
  expect(await routeReactionUpdate(1,reaction(),author.deps)).toBe('newTurn');
  expect(await routeReactionUpdate(1,reaction(),other.deps)).toBeNull();
  expect(author.queued).toHaveLength(1);expect(other.queued).toHaveLength(0);
  await author.queued[0]!();expect(author.turns[0]).toContain('<반응:OK');expect(author.turns[0]).toContain('승인=예');expect(author.turns[0]).toContain('이모지="👌"');
 });
 test('heart does not wake; prepends only to next input in the same conversation',async()=>{
  const h=harness();expect(await routeReactionUpdate(1,reaction('❤️'),h.deps)).toBeNull();
  expect(h.queued).toHaveLength(0);expect(h.steered).toHaveLength(0);
  expect(h.inbox.prepend(3,'other')).toBe('other');
  expect(h.inbox.prepend(2,'next')).toContain('<반응:고마워요');expect(h.inbox.prepend(2,'again')).toBe('again');
 });
 test('OK removal wakes with cancellation and no approval',async()=>{
  const h=harness();const r=reaction('👌',{old_reaction:[{type:'emoji',emoji:'👌'}],new_reaction:[]});
  await routeReactionUpdate(1,r,h.deps);await h.queued[0]!();
  expect(h.turns[0]).toContain('<반응취소:OK');expect(h.turns[0]).toContain('승인=아니오');
 });
 test('bot, hop, missing contract, wrong author, Telegram and disallowed room are discarded',async()=>{
  for(const r of [reaction('👌',{user:{id:3,is_bot:true}}),reaction('👌',{cogs_hop:1}),reaction('👌',{cogs_message_sender_id:undefined}),reaction('👌',{cogs_reactor_is_master:undefined}),reaction('👌',{cogs_message_text:undefined}),reaction('👌',{chat:{id:3}})]){
   const h=harness();expect(await routeReactionUpdate(1,r,h.deps)).toBeNull();expect(h.queued).toHaveLength(0);
  }
  const h=harness();expect(await routeReactionUpdate(1,reaction(),{...h.deps,channel:DEFAULT_CHANNEL})).toBeNull();
 });
 test('same update is delivered once; unchanged reaction produces no input',async()=>{
  const h=harness();await routeReactionUpdate(8,reaction(),h.deps);await routeReactionUpdate(8,reaction(),h.deps);await routeReactionUpdate(7,reaction(),h.deps);
  expect(h.queued).toHaveLength(1);
  expect(reactionInputs(reaction('👌',{old_reaction:[{type:'emoji',emoji:'👌'}]}),'target',true)).toEqual([]);
 });
 test('master approval differs from ordinary human agreement',()=>{
  const r=reaction();expect(reactionInputs(r,'target',true)[0]!.text).toContain('보낸이="팀장님"');
  expect(reactionInputs(r,'target',false)[0]!.text).toContain('승인=아니오');
  expect(REACTION_INSTRUCTIONS).toContain('어느 것을 진행할까요?');expect(REACTION_INSTRUCTIONS).toContain('어느 부분이 걸리세요?');
 });
 test('active turn OK/uncertainty steers without receipt or new bubble',async()=>{
  const h=harness(true);await routeReactionUpdate(1,reaction(),h.deps);await routeReactionUpdate(2,reaction('🤔'),h.deps);
  expect(h.steered).toHaveLength(2);expect(h.queued).toHaveLength(0);expect(h.receipts()).toBe(0);
  expect(h.steered[0]).toContain('<반응:OK');
  expect(h.steered[0]).not.toContain('이 메시지에도 답해라');expect(h.steered[1]).toContain('<반응:의문');
 });
 test('failed steer falls back to serial turn and preserves quiet reactions',async()=>{
  const h=harness(true);await routeReactionUpdate(1,reaction('❤️'),h.deps);
  h.deps.route.steer=async()=>false;
  expect(await routeReactionUpdate(2,reaction(),h.deps)).toBe('newTurn');await h.queued[0]!();
  expect(h.turns[0]).toContain('<반응:고마워요');expect(h.turns[0]).toContain('<반응:OK');
 });
 test('new quiet reaction arriving during steer survives for next input',async()=>{
  const h=harness();h.inbox.accept(1,reaction('❤️'),7);
  await h.inbox.steer(2,'hello',async()=>{h.inbox.accept(2,reaction('👍'),7);return true});
  const next=h.inbox.prepend(2,'next');expect(next).toContain('<반응:좋아요');expect(next).not.toContain('<반응:고마워요');
 });
 test('concurrent steer inputs consume the quiet prefix exactly once',async()=>{
  const h=harness();h.inbox.accept(1,reaction('❤️'),7);const sent:string[]=[];
  const send=async(text:string)=>{sent.push(text);await Promise.resolve();return true};
  await Promise.all([h.inbox.steer(2,'one',send),h.inbox.steer(2,'two',send)]);
  expect(sent).toHaveLength(2);expect(sent[0]).toContain('<반응:고마워요');expect(sent[1]).toBe('two');
 });
 test('Unicode preview is 60 code points and quoted fields preserve raw emoji',()=>{
  const row=reactionInputs(reaction('👌',{user:{id:2,is_bot:false,first_name:'A"\nB'}}),'😀'.repeat(61),false)[0]!.text;
  expect(row).toContain('😀'.repeat(60));expect(row).not.toContain('😀'.repeat(61));expect(row).toContain('A\\"\\nB');
 });
 test('poll request includes reaction and forwards offset',()=>{
  const url=new URL(bridgeUpdatesUrl('http://127.0.0.1:1','T',99));
  expect(JSON.parse(url.searchParams.get('allowed_updates')!)).toContain('message_reaction');expect(url.searchParams.get('offset')).toBe('99');
 });
});

let prev:string|undefined;
beforeEach(()=>{prev=process.env.B3OS_FIRST_CONTACT_DIR;process.env.B3OS_FIRST_CONTACT_DIR=mkdtempSync(join(tmpdir(),'dex-react-'))});
afterEach(()=>{if(prev===undefined)delete process.env.B3OS_FIRST_CONTACT_DIR;else process.env.B3OS_FIRST_CONTACT_DIR=prev});
test('cogs normal input consumes quiet reactions and does not add automatic eyes',async()=>{
 const inbox=createReactionInbox();inbox.accept(1,reaction('❤️'),7);
 const reacts:string[]=[];let prompt='';
 const deps:BridgeDeps={channel,reactionInbox:inbox,sandbox:'read-only',reactMessage:async(_c,_m,e)=>{reacts.push(e);return true},sendMessage:async()=>1,editMessage:async()=>true,runTurn:async o=>{prompt=o.prompt;return{ok:true,reply:'done',detail:'ok',elapsedMs:1}}};
 await handleMessage(2,'next',22,deps);
 expect(reacts).toEqual([]);expect(prompt).toContain('<반응:고마워요');expect(prompt).toContain('next');
});
