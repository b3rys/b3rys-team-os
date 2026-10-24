import { test, expect, afterAll } from "bun:test";
import { mkdtempSync,writeFileSync,mkdirSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {join} from "node:path";
import {Database} from "bun:sqlite";
import {controlCogsTmux,cogsTmuxCommand} from "./cogsTmux";
import {ownsCogsMessage} from "./cogsTmuxReply";
import {createCogsTmuxSupervisor} from "../../workers/cogsTmuxSupervisor";
import type {AgentRecord} from "../../types";
const dir=mkdtempSync(join(tmpdir(),"cogs-tmux-test-"));
const prior=process.env.TEAMOS_AGENT_OFF_FILE;
process.env.TEAMOS_AGENT_OFF_FILE=join(dir,"off");
const agent={id:"testmate",runtime:"claude_channel",workspace_path:dir,tmux_session:"claude-testmate",team_official_member:false,
 cogs_inbox:{transport:"tmux",api_base:"http://127.0.0.1:1",token_file:join(dir,"token"),allow_from:[14]}} as AgentRecord;
afterAll(()=>{if(prior===undefined)delete process.env.TEAMOS_AGENT_OFF_FILE;else process.env.TEAMOS_AGENT_OFF_FILE=prior;rmSync(dir,{recursive:true,force:true});});
async function gates(fn:()=>Promise<void>){const old=[process.env.APPROVAL_EXECUTION_ENABLED,process.env.HEALTH_AUTOFIX_ENABLED];process.env.APPROVAL_EXECUTION_ENABLED="1";process.env.HEALTH_AUTOFIX_ENABLED="1";try{await fn();}finally{for(const [i,k] of ["APPROVAL_EXECUTION_ENABLED","HEALTH_AUTOFIX_ENABLED"].entries()){if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];}}}
test("nonofficial app member starts after old bridge is retired",async()=>gates(async()=>{
 let alive=false;const commands:string[][]=[];
 const r=await controlCogsTmux(agent,true,false,{alive:()=>alive,run:(cmd,args)=>{commands.push([cmd,...args]);if(args[0]==="new-session")alive=true;return {status:0};}});
 expect(r.ok).toBe(true);expect(commands[0]?.[0]).toBe("launchctl");expect(commands[1]?.slice(0,5)).toEqual(["tmux","new-session","-d","-s",agent.tmux_session!]);
}));
test("failed bridge retirement prevents second poller and session startup",async()=>gates(async()=>{
 const cmds:string[]=[];const r=await controlCogsTmux(agent,true,false,{alive:()=>false,run:(cmd)=>{cmds.push(cmd);return {status:1};}});
 expect(r.ok).toBe(false);expect(cmds).toEqual(["launchctl","launchctl"]);
}));
test("execution gate prevents all process mutations",async()=>{const old=process.env.APPROVAL_EXECUTION_ENABLED;delete process.env.APPROVAL_EXECUTION_ENABLED;try{const r=await controlCogsTmux(agent,true,false,{run:()=>{throw Error("must not execute");}});expect(r.ok).toBe(false);}finally{if(old!==undefined)process.env.APPROVAL_EXECUTION_ENABLED=old;}});
test("supervisor recovers a dead nonofficial member; retries are bounded; off stays off",async()=>gates(async()=>{
 let now=0,count=0,alive=false;
 const ensure=createCogsTmuxSupervisor({alive:()=>alive,now:()=>now,control:async()=>{count++;return {ok:alive,detail:"test"};}});
 expect(await ensure(agent)).toBe(false);expect(count).toBe(1);
 await ensure(agent);expect(count).toBe(1);
 now=30001;alive=true;expect(await ensure(agent)).toBe(true);expect(count).toBe(2);
 await ensure(agent);expect(count).toBe(2);
 writeFileSync(join(dir,"off"),"testmate\n");expect(await ensure(agent)).toBe(false);expect(count).toBe(2);writeFileSync(join(dir,"off"),"");
 expect(await ensure({...agent,enabled:false})).toBe(false);
}));
test("auto recovery remains gated even when execution is enabled",async()=>gates(async()=>{delete process.env.HEALTH_AUTOFIX_ENABLED;let count=0;const ensure=createCogsTmuxSupervisor({alive:()=>false,control:async()=>{count++;return {ok:true,detail:"test"};}});expect(await ensure(agent)).toBe(false);expect(count).toBe(0);}));
test("interactive CLI preserves folder restrictions and permits only reply MCP",()=>{
 const command=cogsTmuxCommand(agent);
 expect(command).toContain("--restricted");expect(command).toContain("dontAsk");expect(command).toContain("mcp__cogs_reply__reply");expect(command).not.toContain("skip-permissions");expect(command).not.toContain("-p'");
});
test("reply tool cannot choose another teammate's message or thread",()=>{
 const db=new Database(":memory:");db.run("CREATE TABLE message(id TEXT,thread_id TEXT,meta_json TEXT)");db.run("INSERT INTO message VALUES ('m','t',?)",[JSON.stringify({cogs:{agent_id:"testmate"}})]);
 expect(ownsCogsMessage(db,"testmate","t","m")).toBe(true);
 expect(ownsCogsMessage(db,"other","t","m")).toBe(false);expect(ownsCogsMessage(db,"testmate","other","m")).toBe(false);db.close();
});

test("off while bridge retirement awaits cancels recovery before launch",async()=>gates(async()=>{
 let release!:()=>void;const gate=new Promise<boolean>(r=>release=()=>r(true));let launches=0;
 const pending=controlCogsTmux(agent,true,true,{bridgePids:()=>[123],waitBridgeExit:()=>gate,alive:()=>false,run:(_cmd,args)=>{if(args[0]==="new-session")launches++;return {status:0};}});
 writeFileSync(process.env.TEAMOS_AGENT_OFF_FILE!,`${agent.id}\n`);
 release();expect((await pending).ok).toBe(false);expect(launches).toBe(0);
 writeFileSync(process.env.TEAMOS_AGENT_OFF_FILE!,"");
}));
test("later stop cancels an earlier start waiting for bridge exit",async()=>gates(async()=>{
 let release!:()=>void;const gate=new Promise<boolean>(r=>release=()=>r(true));let launches=0;
 const run=(_cmd:string,args:string[])=>{if(args[0]==="new-session")launches++;return {status:0};};
 const pending=controlCogsTmux(agent,true,true,{bridgePids:()=>[123],waitBridgeExit:()=>gate,alive:()=>false,run});
 expect((await controlCogsTmux(agent,false,false,{bridgePids:()=>[],alive:()=>false,run})).ok).toBe(true);
 release();expect((await pending).ok).toBe(false);expect(launches).toBe(0);
}));
