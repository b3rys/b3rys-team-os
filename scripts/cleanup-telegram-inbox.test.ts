import {test,expect} from "bun:test";
import {mkdtemp,mkdir,writeFile,utimes,symlink,rm,realpath,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {cleanupTelegramInbox,inboxRoots} from "./cleanup-telegram-inbox";

test("7-day cutoff, dry-run, allowlist, symlink ancestors and children, and empty/root guards",async()=>{
 const home=await realpath(await mkdtemp(join(tmpdir(),"inbox-retention-")));
 const now=Date.now(),day=86400000;
 try {
  const inbox=join(home,".claude/channels/telegram-test/inbox"),openclaw=join(home,".openclaw/media/inbound"),outside=join(home,"outside");
  for(const dir of [inbox,openclaw,outside])await mkdir(dir,{recursive:true});
  for(const [name,age] of [["old",8],["boundary",7],["fresh",6]] as const){const p=join(inbox,name);await writeFile(p,name);await utimes(p,(now-age*day)/1000,(now-age*day)/1000);}
  const keep=join(outside,"keep");await writeFile(keep,"KEEP");await utimes(keep,(now-9*day)/1000,(now-9*day)/1000);
  await symlink(outside,join(inbox,"linked-dir"));await symlink(keep,join(inbox,"linked-file"));
  await symlink(outside,join(home,".claude/channels/telegram-linked"));
  expect(await inboxRoots(home)).toEqual([inbox,openclaw]);
  const result=await cleanupTelegramInbox({home,now});expect(result.mode).toBe("dry-run");expect(result.files).toEqual([{path:join(inbox,"old"),action:"would-delete"}]);
  expect(await readFile(join(inbox,"old"),"utf8")).toBe("old");
  const applied=await cleanupTelegramInbox({home,now,apply:true});expect(applied.files[0]!.action).toBe("deleted");
  expect(await readFile(keep,"utf8")).toBe("KEEP");expect(await readFile(join(inbox,"boundary"),"utf8")).toBe("boundary");
  for(const root of ["","/",outside])await expect(cleanupTelegramInbox({home,root,apply:true})).rejects.toThrow();
  for(const days of [0,-1,NaN,Infinity])await expect(cleanupTelegramInbox({home,days})).rejects.toThrow();
  for(const value of ["","/"])await expect(inboxRoots(value)).rejects.toThrow();
 } finally {await rm(home,{recursive:true,force:true});}
});

test("CLI honors temporary HOME, defaults to dry-run and rejects an empty root without printing private errors",async()=>{
 const home=await realpath(await mkdtemp(join(tmpdir(),"inbox-cli-")));
 try {
  const inbox=join(home,".claude/channels/telegram-test/inbox");await mkdir(inbox,{recursive:true});
  const old=join(inbox,"old");await writeFile(old,"KEEP");await utimes(old,1,1);
  const script=new URL("./cleanup-telegram-inbox.ts",import.meta.url).pathname;
  for(const args of [[],["--root",""]]){
   const p=Bun.spawn([process.execPath,script,...args],{env:{...process.env,HOME:home},stdout:"pipe",stderr:"pipe"});
   const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
   if(args.length)expect([code,out,err]).toEqual([1,"","CLEANUP_FAILED\n"]);
   else {expect(code).toBe(0);expect(err).toBe("");expect(JSON.parse(out)).toMatchObject({mode:"dry-run",roots:[inbox],files:[{path:old,action:"would-delete"}]});}
   expect(await readFile(old,"utf8")).toBe("KEEP");
  }
 }finally{await rm(home,{recursive:true,force:true});}
});
