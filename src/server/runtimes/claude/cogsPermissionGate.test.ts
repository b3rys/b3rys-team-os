import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateClaudePermission } from "./cogsPermissionGate";
import { startPermissionHost } from "./cogsPermissionMcp";
import { connect } from "node:net";

test("protected -> checker -> card order, failures never create a card, one correlated audit", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(),"gate-test-"))), workspace = join(root,"work"), control = join(root,"control");
  mkdirSync(workspace); mkdirSync(control);
  try {
    for (const mode of ["protected", "deny", "error", "allow", "card-deny"] as const) {
      const calls: string[] = [], rows: Record<string,unknown>[] = [];
      const candidate = {tool_name:"Write",input:{file_path:join(mode === "protected" ? control : root,"note.txt"),content:"PRIVATE_FIXTURE_PAYLOAD"}};
      const result = await gateClaudePermission(candidate, {
        paths:{workspace,protectedPaths:[control]},
        checker: async () => { calls.push("checker"); if (mode === "error") throw new Error(); return JSON.stringify({verdict:mode === "deny" ? "deny" : "allow",reason:"fixture judgment"}); },
        card: async (request,id,path) => {calls.push("card");expect(request.input).toEqual(candidate.input);expect(id).toBeTruthy();expect(path).toBe(candidate.input.file_path);return mode !== "card-deny";},
        audit: row => rows.push(row),
      });
      expect(calls).toEqual(mode === "protected" ? [] : ["deny","error"].includes(mode) ? ["checker"] : ["checker","card"]);
      expect(result.behavior).toBe(mode === "allow" ? "allow" : "deny");
      expect(rows).toHaveLength(1);expect(rows[0]!.executionId).toBeTruthy();
      expect(JSON.stringify(rows)).not.toContain("PRIVATE_FIXTURE_PAYLOAD");
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("private IPC forwards once and closes malformed input to deny", async () => {
  let calls = 0;
  const host = await startPermissionHost(async input => {calls++; if (input.tool_name !== "Write") throw new Error(); return {behavior:"deny",message:"fixture-deny"};});
  const request = (text:string) => new Promise<string>((resolve,reject) => {
    let data="";const socket=connect(host.path,()=>socket.write(text+"\n"));
    socket.on("data",chunk=>data+=chunk);socket.on("end",()=>resolve(data));socket.on("error",reject);
  });
  try {
    expect(JSON.parse(await request('{"tool_name":"Write","input":{}}')).message).toBe("fixture-deny");
    expect(JSON.parse(await request('not json')).behavior).toBe("deny"); expect(calls).toBe(1);
  } finally {host.close();}
});
