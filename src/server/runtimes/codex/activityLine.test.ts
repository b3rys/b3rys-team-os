import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../db/migrate";
import { setActivityLine } from "../../db/queries";
import { activityLineOf, statusLineOf } from "./appServerClient";

describe("localized runtime activity keeps sanitized targets",()=>{
 for (const [item,label] of [
  [{type:"commandExecution",command:"npm test"},"테스트 · npm test"],
  [{type:"commandExecution",command:["git","status"]},"실행 · git status"],
  [{type:"commandExecution",command:'curl -H "X-Fixture: fake_secret" https://user:fake@example.com/private?token=fake'},"실행 · curl"],
  [{type:"fileChange",fileChanges:{"src/a.ts":{}}},"수정 · a.ts"],
  [{type:"fileChange",changes:[{path:"/tmp/ws/note.txt",kind:{type:"add"}}]},"새로 쓰기 · note.txt"],
  [{type:"fileChange",changes:[{path:"/tmp/a"},{path:"/tmp/b"},{path:"/tmp/c"}]},"수정 · 파일 3개"],
  [{type:"webSearch",action:{queries:["codex config"]}},"검색 · codex config"],
  [{type:"webSearch",action:{type:"openPage",url:"https://user:fake@example.com/private?token=fake"}},"페이지 열기 · example.com"],
  [{type:"webSearch",action:{pattern:"강수확률"}},"검색 · 강수확률"],
  [{type:"webSearch",query:"",action:null},"검색"],
  [{type:"webSearch",action:{type:"search",query:null,queries:["판교 날씨","성남 날씨"]}},"검색 · 판교 날씨 · 성남 날씨"],
  [{type:"webSearch",action:{type:"search",query:"판교 날씨",queries:null}},"검색 · 판교 날씨"],
  [{type:"mcpToolCall",name:"team_status"},"실행"],
  [{type:"somethingNew"},"도구"],
  [{type:"fileChange",changes:[]},"수정"],
 ] as const) {
  test(JSON.stringify(item),()=>expect(activityLineOf(item)).toBe(label));
 }
 test("noise and repeated statuses never become activity entries",()=>{
  for(const type of ["reasoning","agentMessage","userMessage","user_message","userMessageDelta"])expect(activityLineOf({type})).toBeNull();
  expect(activityLineOf(null)).toBeNull();
 });
 test("model summaries stay data and actual tools are not headers",()=>{
  expect(statusLineOf({type:"reasoning"})).toBe("🧠 생각하는 중…");
  expect(statusLineOf({type:"reasoning",summary:"판교 날씨를 찾는다\n둘째 줄"})).toBe("🧠 판교 날씨를 찾는다");
  expect(statusLineOf({type:"agentMessage"})).toBe("✍️ 대답하는 중…");
  expect(statusLineOf({type:"commandExecution",command:"ls"})).toBeNull();
 });
 test("database activity persists a safe display line and can be cleared",()=>{
  const db=new Database(":memory:");migrate(db);
  try {
   db.prepare("INSERT INTO agent (id,display_name,role,runtime,status_provider,workspace_path,persona_file) VALUES ('dex','Dex','eng','codex','codex_cli','/w','AGENTS.md')").run();
   const line=activityLineOf({type:"commandExecution",command:'curl --header "X-Fixture: fake_secret" https://example.com'});
   setActivityLine(db,"dex",line);const row=db.prepare("SELECT activity_line FROM agent_status WHERE agent_id='dex'").get() as {activity_line:string};
   expect(row.activity_line).toBe("실행 · curl");setActivityLine(db,"dex",null);
   expect((db.prepare("SELECT activity_line FROM agent_status WHERE agent_id='dex'").get() as any).activity_line).toBeNull();
  }finally{db.close();}
 });
});


test("reasoning protocol arrays use the first nonempty line, retaining legacy string and text support", () => {
  expect(statusLineOf({ type: "reasoning", summary: ["", "  \n 첫 요약 \n둘째 줄", "다음 원소"], content: [] })).toBe("🧠 첫 요약");
  for (const summary of [[], ["", "  ", "\n"]]) {
    expect(statusLineOf({ type: "reasoning", summary, content: [] })).toBe("🧠 생각하는 중…");
  }
  expect(statusLineOf({ type: "reasoning", summary: "첫 요약\n둘째 줄" })).toBe("🧠 첫 요약");
  expect(statusLineOf({ type: "reasoning", text: "첫 요약\n둘째 줄" })).toBe("🧠 첫 요약");
});
