import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { cogsRegistryPath } from "./cogsToolPolicy";
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

test("audit never stores checker-quoted content or raw paths", async () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "gate-audit-")));
  const path = join(workspace, "private-note.txt"), content = "PRIVATE_FIXTURE_PAYLOAD";
  const rows: Record<string, unknown>[] = [];
  let cards = 0;
  try {
    const result = await gateClaudePermission({tool_name:"Write",input:{file_path:path,content}}, {
      paths:{workspace,protectedPaths:[]},
      checker:async()=>JSON.stringify({verdict:"deny",reason:`Refuse ${content} at ${path}`}),
      card:async()=>{cards++;return true;}, audit:row=>rows.push(row),
    });
    expect(result).toEqual({behavior:"deny",message:"checker_denied: 보안 검사에서 거절됐어요"});
    expect(JSON.stringify(result)).not.toContain(content);
    expect(JSON.stringify(result)).not.toContain(path);
    expect(result.behavior).toBe("deny");expect(cards).toBe(0);expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(content);
    expect(JSON.stringify(rows)).not.toContain(path);
    expect(rows[0]!.reason).toBe("checker_denied");
    expect(rows[0]!.checkerVerdict).toBe("deny");
    expect(rows[0]!.model).toBe("sonnet");
    expect(rows[0]!.promptVersion).toBe("cogs-write-check-v1");
  } finally {rmSync(workspace,{recursive:true,force:true});}
});

test("relative registry env preserves protected targets and ordinary outside approval", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gate-relative-registry-")));
  const workspace = join(root, "work"), registry = join(root, "agents.json");
  mkdirSync(workspace);
  const prior = process.env.TEAM_AGENT_REGISTRY;
  process.env.TEAM_AGENT_REGISTRY = relative(process.cwd(), registry);
  const protectedTargets = [".claude.json", ".claude", ".codex", ".openclaw"].map(p => join(root, p));
  let checks = 0, cards = 0;
  try {
    const deps = {
      paths: { workspace, protectedPaths: [cogsRegistryPath(), ...protectedTargets] },
      checker: async () => { checks++; return '{"verdict":"allow","reason":"ordinary note"}'; },
      card: async () => { cards++; return true; }, audit: () => {},
    };
    for (const path of [...protectedTargets, registry]) {
      expect(await gateClaudePermission({tool_name:"Write",input:{file_path:path,content:"fixture"}}, deps))
        .toEqual({behavior:"deny",message:"protected_path: 보호된 경로에는 쓸 수 없어요"});
    }
    expect(checks).toBe(0); expect(cards).toBe(0);
    const input = {file_path:join(root,"ordinary.txt"),content:"ordinary note"};
    expect(await gateClaudePermission({tool_name:"Write",input}, deps)).toEqual({behavior:"allow",updatedInput:input});
    expect(checks).toBe(1); expect(cards).toBe(1);
  } finally {
    if (prior === undefined) delete process.env.TEAM_AGENT_REGISTRY; else process.env.TEAM_AGENT_REGISTRY = prior;
    rmSync(root,{recursive:true,force:true});
  }
});
