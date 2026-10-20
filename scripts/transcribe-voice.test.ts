import {test, expect} from "bun:test";
import {mkdtemp, mkdir, readdir, rm, writeFile, chmod, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {transcribeVoiceFile} from "./transcribe-voice";
import {transcribeLocalVoice, type VoiceDiagnostic} from "../src/server/lib/telegramVoice";

test("private basename and fresh directory on success, empty result and failure; old outputs are not read", async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),"voice-cli-test-")));
 try {
  const input=join(root,"different-name.ogg");await writeFile(input,"fixture");await writeFile(join(root,"voice.txt"),"OLD");
  const dirs:string[]=[];
  for(const mode of ["success","empty","error"]) {
   const job=transcribeVoiceFile(input,{tempRoot:root,transcribe:async(path,dir)=>{
    dirs.push(dir);expect(path).toBe(join(dir,"voice.ogg"));await writeFile(join(dir,"voice.txt"),"temp");
    if(mode==="error")throw new Error("PRIVATE");return mode==="empty"?" ":" 빌 확인 ";
   }});
   if(mode==="success")expect(await job).toBe("빌 확인");else await expect(job).rejects.toThrow();
   expect((await readdir(root)).filter(x=>x.startsWith("b3os-voice-cli-"))).toEqual([]);
  }
  expect(new Set(dirs).size).toBe(3);
 } finally {await rm(root,{recursive:true,force:true});}
});

test("CLI exits with only transcript or fixed failure for success, missing, empty and engine failure", async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),"voice-cli-spawn-")));
 try {
  const audio=join(root,"not-voice.wav"), tmp=join(root,"tmp"), home=join(root,"home"), engine=join(root,"engine");
  await mkdir(tmp);await mkdir(home);await mkdir(join(engine,".venv/bin"),{recursive:true});
  const ff=Bun.spawn(["/opt/homebrew/bin/ffmpeg","-v","error","-f","lavfi","-i","sine=frequency=440:duration=0.2",audio],{stdout:"ignore",stderr:"ignore"});expect(await ff.exited).toBe(0);
  const fake=join(engine,".venv/bin/python");
  await writeFile(fake,'#!/bin/sh\ncase "$VOICE_FIXTURE_MODE" in success) printf "빌 확인" > "$4";; empty) : > "$4";; *) exit 1;; esac\n');await chmod(fake,0o700);
  for(const mode of ["success","missing","empty","failure"]) {
   const child=Bun.spawn([process.execPath,resolve("scripts/transcribe-voice.ts"),mode==="missing"?join(root,"missing"):audio],{env:{...process.env,HOME:home,TMPDIR:tmp,B3OS_STT_HOME:engine,VOICE_FIXTURE_MODE:mode},stdout:"pipe",stderr:"pipe"});
   const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
   expect([code,out,err]).toEqual(mode==="success"?[0,"빌 확인\n",""]:[1,"","TRANSCRIBE_FAILED\n"]);
   expect(await readdir(tmp)).toEqual([]);
  }
 } finally {await rm(root,{recursive:true,force:true});}
});

test("one safe diagnostic reports final engine, timing and stage on success and silence",async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),"voice-diagnostic-")));
 try {
  for(const silent of [false,true]){
   const events:VoiceDiagnostic[]=[];
   const job=transcribeLocalVoice(join(root,"voice.ogg"),root,"PRIVATE",{onDiagnostic:e=>events.push(e),checkAudio:async()=>{if(silent)throw new Error("PRIVATE");},run:async()=>{await writeFile(join(root,"voice-mlx.txt"),"PRIVATE");}});
   if(silent)await expect(job).rejects.toThrow();else expect(await job).toBe("PRIVATE");
   expect(events).toHaveLength(1);expect(events[0]).toMatchObject({engine:"mlx",stage:silent?"audio":"success",ok:!silent});
   expect(events[0]!.elapsedMs).toBeGreaterThanOrEqual(0);expect(JSON.stringify(events)).not.toContain("PRIVATE");
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test("CPU fallback reports one final diagnostic without paths, transcript or raw errors",async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),"voice-cpu-log-"))),previous=process.env.HOME;
 try {
  process.env.HOME=root;await mkdir(join(root,".cache/whisper"),{recursive:true});await writeFile(join(root,".cache/whisper/large-v3-turbo.pt"),"fixture");
  for(const fail of [false,true]){
   const events:VoiceDiagnostic[]=[];let calls=0;
   const job=transcribeLocalVoice(join(root,"voice.ogg"),root,"PRIVATE",{onDiagnostic:e=>events.push(e),warn:()=>{},checkAudio:async()=>{},run:async()=>{
    calls++;if(calls===1||fail)throw new Error("PRIVATE");await writeFile(join(root,"voice.txt"),"PRIVATE");
   }});
   if(fail)await expect(job).rejects.toThrow();else expect(await job).toBe("PRIVATE");
   expect(events).toHaveLength(1);expect(events[0]).toMatchObject({engine:"cpu",stage:fail?"process":"success",ok:!fail});
   expect(JSON.stringify(events)).not.toContain("PRIVATE");expect(JSON.stringify(events)).not.toContain(root);
  }
 }finally{if(previous===undefined)delete process.env.HOME;else process.env.HOME=previous;await rm(root,{recursive:true,force:true});}
});
