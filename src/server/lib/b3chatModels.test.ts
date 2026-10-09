import {test,expect} from "bun:test";
import {mkdtempSync,writeFileSync,readFileSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readModel,saveModel,setModelLine} from "./b3chatModels";

test("model selection changes only the root setting",()=>{
 const dir=mkdtempSync(join(tmpdir(),"cogs-model-"));const path=join(dir,"config.toml");
 const raw='model = "gpt-6.1-sol"\nmodel_reasoning_effort = "low"\n[other]\nmodel = "other"\n';writeFileSync(path,raw);
 saveModel(path,"codex","gpt-6-luna");
 expect(readFileSync(path,"utf-8")).toBe(raw.replace('"gpt-6.1-sol"','"gpt-6-luna"'));
 expect(readModel(path)).toBe("gpt-6-luna");
 expect(()=>saveModel(path,"codex","sonnet")).toThrow();
 expect(readModel(path)).toBe("gpt-6-luna");
 expect(()=>saveModel(path,"claude","gpt-6-luna")).toThrow();
});
test("section setting is never mistaken for root setting; symlinks are rejected",()=>{
 expect(setModelLine('[section]\nmodel = "keep"\n',"gpt-6-luna")).toBe('model = "gpt-6-luna"\n[section]\nmodel = "keep"\n');
 const dir=mkdtempSync(join(tmpdir(),"cogs-model-"));const path=join(dir,"original");writeFileSync(path,'model = "gpt-6-luna"\n');
 const link=join(dir,"config.toml");symlinkSync(path,link);
 expect(()=>saveModel(link,"codex","gpt-6.1-sol")).toThrow();
 expect(readFileSync(path,"utf-8")).toBe('model = "gpt-6-luna"\n');
});
