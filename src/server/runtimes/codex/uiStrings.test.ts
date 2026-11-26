import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uiText } from "./uiStrings";
import { buildOperationFromApproval } from "./appServerPopup";
import { grantKey } from "../../lib/permissionGate";
import type { ApprovalRequest } from "./appServerClient";

const previousLocale=process.env.B3OS_UI_LOCALE;
const previousDir=process.env.B3OS_UI_LOCALES_DIR;
afterEach(()=>{
 if(previousLocale===undefined)delete process.env.B3OS_UI_LOCALE;else process.env.B3OS_UI_LOCALE=previousLocale;
 if(previousDir===undefined)delete process.env.B3OS_UI_LOCALES_DIR;else process.env.B3OS_UI_LOCALES_DIR=previousDir;
});
test("locale keys match and external wording changes require no source edit",()=>{
 const ko=JSON.parse(readFileSync(new URL("./locales/ko.json",import.meta.url),"utf8"));
 const en=JSON.parse(readFileSync(new URL("./locales/en.json",import.meta.url),"utf8"));
 expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
 for(const value of Object.values(en))expect(typeof value==="string" && value.length>0).toBe(true);
 const dir=mkdtempSync(join(tmpdir(),"codex-ui-locale-"));
 writeFileSync(join(dir,"ko.json"),JSON.stringify({working:"fixture ko",approval_files:"files {count}"}));
 writeFileSync(join(dir,"en.json"),JSON.stringify({working:"fixture en"}));
 process.env.B3OS_UI_LOCALES_DIR=dir;process.env.B3OS_UI_LOCALE="en";
 expect(uiText("working")).toBe("fixture en");expect(uiText("approval_files",{count:3})).toBe("Edit 3 files?");
 writeFileSync(join(dir,"en.json"),JSON.stringify({working:"replaced"}));expect(uiText("working")).toBe("replaced");
 process.env.B3OS_UI_LOCALE="unsupported";expect(uiText("working")).toBe("fixture ko");
});
test("permission identity is independent of UI language",()=>{
 const req={method:"applyPatchApproval",params:{fileChanges:{"/tmp/fixture.ts":{type:"update",diff:"fixture"}},grantRoot:"/tmp/work"}} as ApprovalRequest;
 process.env.B3OS_UI_LOCALE="ko";const ko=buildOperationFromApproval(req,"fixture","/tmp/work");
 process.env.B3OS_UI_LOCALE="en";const en=buildOperationFromApproval(req,"fixture","/tmp/work");
 expect(grantKey(ko.requested_by??"fixture",ko.path??ko.text??"")).toBe(grantKey(en.requested_by??"fixture",en.path??en.text??""));
 expect(en).toEqual(ko);
});
