import {test, expect} from "bun:test";
import {Database} from "bun:sqlite";
import {migrate, migrateCogsPermissions} from "../../db/migrate";
import {getPermissionRequest} from "../permissionGate";
import {createCogsApproval, getBinding, pressCogsApproval, handOffCogsApproval, hasCogsSessionGrant} from "./approvals";
import {createApprovalWithCogsOwner, handOffWithCogsOwner} from "./ownerHandoff";
const owner = {instance:"http://cogs",botId:12,userId:7,generation:1};
const op = {runtime:"claude",agent_id:"fixture",action:"Write",path:"/synthetic/outside.txt",text:'{"content":"fixture"}'};
function setup() {
  const db = new Database(":memory:"); migrate(db);
  const input = {op,owner,roomId:"42",policyStamp:"stamp",sessionId:"s",processGen:"g",ttlMs:1000,nowMs:100};
  const {request} = createCogsApproval(db,input);
  const press = {requestId:request.id,action:"pg1" as const,actorUserId:7,ownerUserId:7,currentOwner:owner,
    callbackOwnerGeneration:1,roomId:42,bridgeAgentId:"fixture",currentStamp:"stamp",nowMs:200};
  const handoff = {requestId:request.id,agentId:"fixture",sessionId:"s",processGen:"g",currentStamp:"stamp",nowMs:300,
    currentOwner:owner,currentOwnerUserId:7,executionOperation:op};
  return {db,input,id:request.id,press,handoff};
}
test("issuance requires an owner; migration never fills legacy owner from the current generation", () => {
  const s=setup(); try {
    expect(() => createCogsApproval(s.db,{...s.input,owner:undefined})).toThrow("cogs_owner_required");
    s.db.run("ALTER TABLE cogs_permission_binding DROP COLUMN owner_binding_json");
    migrateCogsPermissions(s.db);
    expect(getBinding(s.db,s.id)!.owner_binding_json).toBeNull();
    expect(pressCogsApproval(s.db,s.press).kind).toBe("expired");
  } finally {s.db.close();}
});
test("callback generation cannot overwrite issuance, even for the same owner", () => {
  const s=setup(); try {
    expect(pressCogsApproval(s.db,{...s.press,callbackOwnerGeneration:3}).kind).toBe("forbidden");
    expect(JSON.parse(getBinding(s.db,s.id)!.owner_binding_json!).generation).toBe(1);
    expect(pressCogsApproval(s.db,{...s.press,callbackOwnerGeneration:undefined}).kind).toBe("forbidden");
    expect(pressCogsApproval(s.db,s.press).kind).toBe("decided");
  } finally {s.db.close();}
});
test("A to B to A, foreign bot/instance and absent owner invalidate approval and session grant", () => {
  for (const currentOwner of [null,{...owner,generation:3},{...owner,userId:8,generation:2},
    {...owner,botId:13},{...owner,instance:"http://other"}]) {
    const s=setup(); try {
      expect(pressCogsApproval(s.db,{...s.press,action:"pgs"}).kind).toBe("decided");
      expect(hasCogsSessionGrant(s.db,{...s.handoff,op,currentOwner:owner})).toBe(true);
      expect(handOffCogsApproval(s.db,{...s.handoff,currentOwner})).toBe(false);
      expect(getPermissionRequest(s.db,s.id)!.status).toBe("expired");
      expect(s.db.query("SELECT count(*) n FROM cogs_permission_session_grant").get()).toEqual({n:0});
      expect(handOffCogsApproval(s.db,s.handoff)).toBe(false);
    } finally {s.db.close();}
  }
});
test("session grant lookup checks generation rather than only owner id", () => {
  const s=setup(); try {
    pressCogsApproval(s.db,{...s.press,action:"pgs"});
    expect(hasCogsSessionGrant(s.db,{...s.handoff,op,currentOwner:{...owner,generation:3}})).toBe(false);
    expect(hasCogsSessionGrant(s.db,{...s.handoff,op})).toBe(false);
  } finally {s.db.close();}
});
test("execution boundary reads expected generation again and claims once; unavailable owner denies", async () => {
  for (const status of [200,409,401,500]) {
    const s=setup(); const calls: unknown[]=[];
    try {
      pressCogsApproval(s.db,s.press);
      const fetchFn = (async (_url: unknown, init: RequestInit) => {
        calls.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ok:true,result:{id:12,owner_user_id:7,owner_generation:1}}),{status});
      }) as unknown as typeof fetch;
      const transport = {apiBase:"http://cogs",token:"fixture",fetchFn,now:()=>300,currentStamp:()=>"stamp"};
      expect(await handOffWithCogsOwner(s.db,s.handoff,transport)).toBe(status===200);
      expect(calls).toEqual([{expected_owner_generation:1}]);
      expect(await handOffWithCogsOwner(s.db,s.handoff,transport)).toBe(false);
    } finally {s.db.close();}
  }
});

test("issuance captures getMe rather than accepting caller supplied owner; failed lookup creates no request", async () => {
  for (const status of [200,401]) {
    const s=setup(); try {
      const before=(s.db.query("SELECT count(*) n FROM permission_request").get() as {n:number}).n;
      const fetchFn=(async () => new Response(JSON.stringify({ok:true,result:{id:12,owner_user_id:7,owner_generation:4}}),{status})) as unknown as typeof fetch;
      const created=await createApprovalWithCogsOwner(s.db,s.input,{apiBase:"http://cogs",token:"fixture",fetchFn,now:()=>400,currentStamp:()=>"stamp"});
      expect((s.db.query("SELECT count(*) n FROM permission_request").get() as {n:number}).n).toBe(before+(status===200?1:0));
      if(status===200) expect(JSON.parse(created!.binding.owner_binding_json!).generation).toBe(4);
      else expect(created).toBeNull();
    } finally {s.db.close();}
  }
});


test("old owner failures preserve newer approvals, session grants and Codex requests", () => {
  for (const boundary of ["press", "handoff", "grant"] as const) {
    for (const currentOwner of [null, {...owner,generation:3}]) {
      const s=setup(); try {
        const newerOwner={...owner,generation:3};
        const newer=createCogsApproval(s.db,{...s.input,owner:newerOwner,sessionId:"new-session"}).request;
        const pending=createCogsApproval(s.db,{...s.input,owner:newerOwner,sessionId:"new-pending"}).request;
        const codex=createCogsApproval(s.db,{...s.input,owner:undefined,op:{...op,runtime:"codex"}}).request;
        expect(pressCogsApproval(s.db,{...s.press,requestId:newer.id,action:"pgs",currentOwner:newerOwner,callbackOwnerGeneration:3}).kind).toBe("decided");
        if(boundary !== "press") pressCogsApproval(s.db,{...s.press,action:"pgs"});
        const fail = () => {
          if(boundary === "press") return pressCogsApproval(s.db,{...s.press,currentOwner});
          if(boundary === "handoff") return handOffCogsApproval(s.db,{...s.handoff,currentOwner});
          return hasCogsSessionGrant(s.db,{...s.handoff,op,currentOwner});
        };
        fail(); fail();
        expect(getPermissionRequest(s.db,s.id)!.status).toBe("expired");
        expect(getPermissionRequest(s.db,newer.id)!.status).toBe("allowed_once");
        expect(getPermissionRequest(s.db,pending.id)!.status).toBe("pending");
        expect(getPermissionRequest(s.db,codex.id)!.status).toBe("pending");
        expect(hasCogsSessionGrant(s.db,{...s.handoff,sessionId:"new-session",op,currentOwner:newerOwner})).toBe(true);
        expect(s.db.query("SELECT request_id FROM cogs_permission_session_grant").all()).toEqual([{request_id:newer.id}]);
      } finally {s.db.close();}
    }
  }
});
