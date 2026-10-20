// Local task-worktree mutation check; always restores each original source.
import {readFile,writeFile} from "node:fs/promises";
const mutants=[
 ["temporary directory left behind","scripts/transcribe-voice.ts","if (dir) await rm(dir, {recursive: true, force: true});","if (false) await rm(dir!, {recursive: true, force: true});","scripts/transcribe-voice.test.ts"],
 ["empty transcript accepted","scripts/transcribe-voice.ts","if (!text) throw new Error();","if (false) throw new Error();","scripts/transcribe-voice.test.ts"],
 ["exactly seven days deleted","scripts/cleanup-telegram-inbox.ts","info.mtimeMs >= cutoff","info.mtimeMs > cutoff","scripts/cleanup-telegram-inbox.test.ts"],
] as const;
for(const [name,path,before,after,test] of mutants){
 const original=await readFile(path,"utf8");
 if(!original.includes(before))throw new Error("Missing mutation anchor: "+name);
 try {
  await writeFile(path,original.replace(before,after));
  const p=Bun.spawn([process.execPath,"test",test],{stdout:"pipe",stderr:"pipe"});
  const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  if(code===0||!(out+err).includes("(fail)"))throw new Error("UNPROVEN "+name);
  console.log("CAUGHT "+name);
 }finally{await writeFile(path,original);}
}
