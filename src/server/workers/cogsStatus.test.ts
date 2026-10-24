import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { cogsRuntimeStatus, createCogsStatusReporter } from "./cogsStatus";
import type { AgentRecord } from "../types";
test("status distinguishes a dead runtime from an alive but stale poller",()=>{
 expect(cogsRuntimeStatus(true,false,1000,2000)).toBe("offline");
 expect(cogsRuntimeStatus(false,true,1000,2000)).toBe("offline");
 expect(cogsRuntimeStatus(true,true,1000,2000)).toBe("ok");
 expect(cogsRuntimeStatus(true,true,1000,92000)).toBe("stalled");
 expect(cogsRuntimeStatus(true,true,0,2000)).toBe("stalled");
});
test("reports nonofficial cogs members, throttles repeats, immediately reports state change",async()=>{
 const db=new Database(":memory:");const a={id:"testmate",runtime:"claude_channel",enabled:true,team_official_member:false,cogs_inbox:{api_base:"http://localhost:1",token_file:"/tmp/no-token",allow_from:[14]}} as AgentRecord;
 let now=2000,alive=true;const sent:string[]=[];
 const report=createCogsStatusReporter({db,agents:()=>[a],off:()=>false,now:()=>now,observe:()=>({alive,pollAt:1000}),report:async(_,status)=>{sent.push(status);}});
 await report();await report();expect(sent).toEqual(["ok"]);
 alive=false;await report();expect(sent).toEqual(["ok","offline"]);
 now+=30001;await report();expect(sent).toEqual(["ok","offline","offline"]);db.close();
});
test("failed report is retried and does not terminate other members",async()=>{
 const db=new Database(":memory:");const a={id:"testmate",runtime:"codex",cogs_inbox:{}} as AgentRecord;let calls=0;
 const report=createCogsStatusReporter({db,agents:()=>[a],off:()=>false,observe:()=>({alive:false,pollAt:0}),report:async()=>{calls++;if(calls===1)throw Error("network");}});
 await report();await report();expect(calls).toBe(2);db.close();
});
