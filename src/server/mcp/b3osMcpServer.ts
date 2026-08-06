// b3os MCP 서버 — b3os 기능을 표준 MCP 도구로 노출해 어떤 Claude 클라이언트든(Desktop/Code) 붙여 쓰게 한다.
// ★v1 = 읽기(M1) + 안전한 쓰기(M2)★. 위험 기능(restart/deploy 등)은 스코프 아웃(v2, 승인 게이트).
// ★로컬 전용★(서버·클라 같은 머신, stdio). 쓰기는 신원(연결바인딩=env B3OS_AGENT_ID) 필수 + 매 호출 audit
//  → M3 게이트(Bill·Codex)가 신원 기준 allowlist/deny만 얹으면 되게 게이트-레디.
//
// 새 probe/데이터소스 0 — 전부 기존 query·스크립트 재사용:
//  읽기 = team.db 직접(classifyAll·inboxFor·listTasks·recallDmMessages)
//  쓰기 = send_message는 send.sh 래핑(버스 dispatch·audit는 서버가), kanban은 createTask/updateTask + appendAudit.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { listAgents, listStatuses, appendAudit } from "../db/queries";
import { inboxFor } from "../db/inboxQueries";
import { listTasks, createTask, updateTask } from "../db/taskQueries";
import { recallDmMessages } from "../db/dmCapture";
import { classifyAll } from "../lib/health";
import { leadActorId } from "../lib/opAuth"; // ★이름만 재사용★ — 신뢰 규칙(루프백=리드)은 쓰지 않는다
import { askTeammate, fetchAnswer } from "./mcpAsk";

export const MCP_NAME = "b3os-mcp";
export const MCP_VERSION = "0.0.3-m2";

/** 이 연결이 쓸 수 있는 범위. stdio 는 종전대로 write, HTTP 는 신원 매핑이 정한다. */
export type McpScope = "read" | "write";

/** 쓰기 도구 이름 — 권한 분리의 기준. 여기 없으면 읽기로 본다. */
export const WRITE_TOOL_NAMES = new Set([
  "b3os_send_message",
  "b3os_kanban_add",
  "b3os_kanban_update",
  "b3os_ask_teammate", // 팀원에게 질문을 남긴다 = 쓰기다
]);

/** 한 호출이 기다릴 수 있는 상한. ★Cloudflare 가 125초에서 끊는다★ — 그 아래에서 우리가 먼저 접수로 끝낸다. */
export const ASK_WAIT_DEFAULT_SEC = 90;
export const ASK_WAIT_MAX_SEC = 110;

/** 버스 입구 — send.sh 가 POST 하는 그 주소 그대로(기본 http://127.0.0.1:7878/team). */
function busBaseUrl(): string {
  return process.env.TEAM_BASE ?? `http://127.0.0.1:${process.env.TEAM_HTTP_PORT ?? 7878}/team`;
}

/** send_message 입력. */
export interface SendMessageInput {
  to: string;
  body: string;
  thread?: string;
  in_reply_to?: string;
  type?: "dm" | "reply";
  priority?: "low" | "normal" | "high";
  hop?: number;
  direct_to_gd?: boolean;
}

/**
 * send.sh argv 조립(순수함수 — 테스트 대상). ★direct_to_gd는 명시 true일 때만 --direct-to-gd 붙인다★:
 * 본문 기반 자동승격 영구 금지(GD 2026-07-09 — 위임 본문 오발화로 direct_to_gd 폭주했던 회귀 방지).
 */
export function buildSendArgs(input: SendMessageInput, actor: string): string[] {
  const a = ["--from", actor, "--to", input.to, "--body", input.body];
  if (input.thread) a.push("--thread", input.thread);
  if (input.in_reply_to) a.push("--in-reply-to", input.in_reply_to);
  if (input.type) a.push("--type", input.type);
  if (input.priority) a.push("--priority", input.priority);
  if (typeof input.hop === "number") a.push("--hop", String(input.hop));
  if (input.direct_to_gd === true) a.push("--direct-to-gd");
  return a;
}

/**
 * ★신원 단일 choke-point(Codex/Bill MUST-FIX B1)★: 연결 선언값을
 *  [non-empty + listAgents 레지스트리 등록 + (선택)MCP allowlist] 로 검증. 실패=null(fail-closed).
 *  stdio는 env B3OS_AGENT_ID, HTTP는 요청별 검증신원(declared 인자)을 넣는다.
 *  어느 경로든 이 함수 하나를 통과해야 actor 가 되므로 검증 규칙이 갈리지 않는다.
 */
function validateActor(db: Database, declared: string | undefined | null): string | null {
  const id = declared?.trim();
  if (!id) return null; // non-empty
  // ★팀 리드는 팀원 명부(agent 테이블)에 없지만 기록 주체로는 이미 쓰인다★ —
  // 대시보드가 그렇게 하고 있고 audit_event 에 actor='gd' 행이 실재한다(2026-08-06 실측 42건).
  // 리드 id 의 단일 출처는 leadActorId(DB setting → env LEAD_ACTOR_ID → 기본 'gd') 이므로 그것만 재사용한다.
  // → 리드를 agent 로 등록하지 않는다. 등록하면 깨우기·헬스·브로드캐스트 대상이 되어 사람이 팀원처럼 다뤄진다.
  //
  // ※ ★재사용하는 것은 '이름' 뿐이다.★ opAuth 의 신뢰 규칙("루프백이면 리드")은 쓰지 않는다 —
  //   그건 같은 머신 전제라, 밖에서 오는 MCP 경로에 쓰면 서버에 닿은 모든 요청이 리드가 된다.
  //   여기 도달했다는 건 이미 Cloudflare Access JWT 서명 검증 + 주체→신원 매핑을 통과했다는 뜻이다.
  const isLeadId = id === leadActorId(db);
  if (!isLeadId && !listAgents(db).some((a) => a.id === id)) return null; // 리드 또는 등록 agent
  const allow = process.env.B3OS_MCP_ALLOWED_AGENTS?.trim(); // 선택 게이트: 설정 시에만 추가 제한
  if (allow && !allow.split(",").map((s) => s.trim()).includes(id)) return null;
  return id;
}

/** stdio 전용 — 연결 선언값을 env 에서 읽는다(종전 동작). */
export function resolveActor(db: Database): string | null {
  return validateActor(db, process.env.B3OS_AGENT_ID);
}

/**
 * ★HTTP 전용 — env 폴백이 없다★ (리뷰 P2, bill).
 * 밖에서 들어오는 경로에서 신원이 비면 ★거부★ 여야지, 서버 자기 신원(대개 권한이 큰 쪽)으로
 * 떨어지면 안 된다. 폴백이 있으면 타입이 한 번 느슨해지거나 호출부가 바뀔 때 조용히 열린다.
 * → 이 함수는 인자로 받은 값만 본다. 빈 값이면 null.
 */
export function resolveActorStrict(db: Database, declared: string): string | null {
  return validateActor(db, declared);
}
/** lead 예외(타 멤버 개인scope 읽기 허용) allowlist — 별도 env, 미설정 시 없음. */
function isLead(id: string): boolean {
  const leads = process.env.B3OS_MCP_LEAD_AGENTS?.trim();
  return !!leads && leads.split(",").map((s) => s.trim()).includes(id);
}
/** 유효 신원 없음 → 거부(fail-closed). */
function denyIdentity(action: string) {
  return {
    content: [{ type: "text", text: `${action} 거부: 유효 연결신원 필요 — B3OS_AGENT_ID가 등록 agent여야 함(fail-closed).` }],
    isError: true,
    structuredContent: { error: "identity_required" },
  };
}
/** 타 멤버 개인scope 접근 → 거부. */
function denyCrossMember(self: string, target: string) {
  return {
    content: [{ type: "text", text: `거부: 타 멤버(${target}) 데이터 접근 불가 — 연결 신원=${self} 본인만(lead 예외는 별도 allowlist).` }],
    isError: true,
    structuredContent: { error: "cross_member_denied", self, target },
  };
}

/**
 * DB 핸들을 받아 도구를 등록한 McpServer 반환(테스트는 격리 DB 주입).
 *
 * ★신원 고정 시점★: stdio 는 프로세스당 1회(env), HTTP 는 ★요청/세션당 1회★(검증된 신원 주입).
 * 어느 쪽이든 서버 인스턴스 하나에 actor 하나가 고정되므로, 한 인스턴스가 도중에 다른 사람이 되는 일은 없다.
 * → HTTP 경로는 반드시 ★요청마다 새 인스턴스★를 만들어야 한다(재사용 금지).
 */
export function buildMcpServer(db: Database, actor: string | null, scope: McpScope): McpServer {
  const server = new McpServer({ name: MCP_NAME, version: MCP_VERSION });
  // ★신원은 호출부가 이미 검증해서 넘긴다★ — stdio 는 resolveActor, HTTP 는 resolveActorStrict.
  // ★scope 는 기본값을 두지 않는다★ (리뷰 P3, bill): 권한 인자의 기본값이 열린 쪽이면
  // 새 호출부가 빠뜨렸을 때 조용히 열린다. 필수로 두면 빠뜨리는 순간 컴파일이 막는다.

  server.registerTool(
    "team_status",
    {
      title: "b3os 팀 상태",
      description:
        "b3rys 팀 각 멤버의 헬스 상태(ok/warn/danger)와 요약을 반환한다. 읽기 전용 — 대시보드와 동일 소스.",
    },
    async () => {
      const verdicts = classifyAll(listStatuses(db), listAgents(db));
      const summary = {
        danger: verdicts.filter((v) => v.level === "danger").map((v) => v.agentId),
        warn: verdicts.filter((v) => v.level === "warn").map((v) => v.agentId),
        capacity: verdicts.filter((v) => v.capacityLevel === "danger").map((v) => v.agentId),
        ok: verdicts.filter((v) => v.level === "ok").length,
      };
      const lines = verdicts.map(
        (v) => `- ${v.agentId}: ${v.level}${v.capacityLevel === "danger" ? " ⚠capacity" : ""}`,
      );
      const text =
        `b3os 팀 상태 (총 ${verdicts.length}명)\n` +
        `ok=${summary.ok} · warn=[${summary.warn.join(", ")}] · danger=[${summary.danger.join(", ")}]\n` +
        lines.join("\n");
      return {
        content: [{ type: "text", text }],
        structuredContent: { summary, agents: verdicts as unknown as Record<string, unknown>[] },
      };
    },
  );

  // ── M1 읽기 도구 (전부 읽기전용·team.db 직접·기존 query 재사용·새 probe 0) ──

  // inbox — 특정 에이전트의 안읽은 메시지 (inboxFor 재사용, 라우트 GET /api/inbox/:id 와 동일 소스).
  // ★(server as any).registerTool: inputSchema 있는 registerTool 제네릭이 이 SDK(1.29)/TS 조합에서
  //  ToolCallback<InputArgs> 인스턴스화 중 TS2589(excessively deep)를 내는 알려진 타입 버그를 우회.
  //  런타임엔 실제 zod shape가 그대로 전달돼 입력검증·JSON스키마 노출 정상. 본문 인자는 명시 캐스트로 좁힌다.
  //  (team_status는 inputSchema 없어 무영향 — 타입 그대로 유지.)★
  const rawReg = (server as { registerTool: (...a: unknown[]) => unknown }).registerTool.bind(server);
  /**
   * ★권한 단일 관문★: scope="read" 신원에게는 쓰기 도구를 ★아예 등록하지 않는다★.
   * 호출 시점에 거절하는 대신 목록에서 빼는 이유 — 클라이언트가 있는 줄 알고 부르면 실패가 대화에 섞인다.
   * 없으면 애초에 후보에 안 오른다. (신원 검증은 resolveActor, 권한 분리는 여기 — 둘 다 한 곳씩.)
   */
  const reg = (name: string, ...rest: unknown[]) => {
    if (scope === "read" && WRITE_TOOL_NAMES.has(name)) return undefined;
    return rawReg(name, ...rest);
  };
  reg(
    "b3os_inbox",
    {
      title: "b3os 인박스",
      description: "연결 신원 본인의 안읽은 메시지를 반환한다(기본 20건, limit로 조정). 읽기 전용. agent_id 생략=본인, 타 멤버 지정은 거부(lead 예외).",
      inputSchema: {
        agent_id: z.string().min(1).optional().describe("조회 대상(생략=연결 신원 본인). 본인만 허용(lead 예외 별도)"),
        limit: z.number().int().min(1).max(200).optional().describe("최대 건수(기본 20)"),
      },
    },
    async (args: unknown) => {
      if (!actor) return denyIdentity("인박스 조회");
      const { agent_id, limit } = args as { agent_id?: string; limit?: number };
      const target = agent_id ?? actor;
      if (target !== actor && !isLead(actor)) return denyCrossMember(actor, target);
      const msgs = inboxFor(db, target, limit ?? 20);
      const clip = (s: string) => (s.length > 80 ? s.slice(0, 80) + "…" : s);
      const lines = msgs.map(
        (m) => `- [${m.priority}] ${m.from_agent_id} → ${clip(m.body)} (thread ${m.thread_id})`,
      );
      const text = `${target} 안읽은 메시지 ${msgs.length}건\n` + lines.join("\n");
      return {
        content: [{ type: "text", text }],
        structuredContent: { count: msgs.length, messages: msgs as unknown as Record<string, unknown>[] },
      };
    },
  );

  // kanban_list — 칸반 카드 목록 (listTasks 재사용, lane 필터).
  reg(
    "b3os_kanban_list",
    {
      title: "b3os 칸반",
      description: "칸반 카드 목록을 반환한다. lane(plan/doing/done) 필터 가능. 읽기 전용.",
      inputSchema: {
        lane: z.enum(["plan", "doing", "done"]).optional().describe("레인 필터(생략=전체)"),
      },
    },
    async (args: unknown) => {
      const { lane } = args as { lane?: "plan" | "doing" | "done" };
      const all = listTasks(db).filter((t) => !t.held_at);
      const tasks = lane ? all.filter((t) => t.column === lane) : all;
      const lines = tasks.map((t) => `- [${t.column}] ${t.title}${t.owner ? ` (${t.owner})` : ""}`);
      const text = `칸반 카드 ${tasks.length}건${lane ? ` (lane=${lane})` : ""}\n` + lines.join("\n");
      return {
        content: [{ type: "text", text }],
        structuredContent: { count: tasks.length, tasks: tasks as unknown as Record<string, unknown>[] },
      };
    },
  );

  // recall_dms — 특정 멤버의 GD 1:1 최근 DM (recallDmMessages 재사용, 멤버별 격리).
  reg(
    "b3os_recall_dms",
    {
      title: "b3os DM recall",
      description: "연결 신원 본인의 GD 1:1 최근 DM(최신순, 기본 10건·limit로 조정)을 반환한다. ★멤버별 격리★ — 본인만, 타 멤버 지정은 거부(lead 예외).",
      inputSchema: {
        agent_id: z.string().min(1).optional().describe("조회 대상(생략=연결 신원 본인). 본인만 허용(lead 예외 별도)"),
        limit: z.number().int().min(1).max(50).optional().describe("최대 건수(기본 10)"),
      },
    },
    async (args: unknown) => {
      if (!actor) return denyIdentity("DM recall");
      const { agent_id, limit } = args as { agent_id?: string; limit?: number };
      const target = agent_id ?? actor;
      if (target !== actor && !isLead(actor)) return denyCrossMember(actor, target);
      const dms = recallDmMessages(db, target, limit ?? 10);
      const clip = (s: string) => (s.length > 100 ? s.slice(0, 100) + "…" : s);
      const lines = dms.map((d) => `- (${d.direction}) ${clip(d.body)} · ${d.created_at}`);
      const text = `${target} 최근 DM ${dms.length}건 (최신순)\n` + lines.join("\n");
      return {
        content: [{ type: "text", text }],
        structuredContent: { count: dms.length, dms: dms as unknown as Record<string, unknown>[] },
      };
    },
  );

  // ── M2 안전 쓰기 도구 (신원 fail-closed + 매 호출 audit → M3 게이트-레디) ──

  // send_message — 팀 버스 발신(로컬). send.sh 래핑(버스 dispatch·서버 audit 경유). direct_to_gd 명시 전용.
  reg(
    "b3os_send_message",
    {
      title: "b3os 메시지 발신",
      description:
        "팀 버스로 메시지를 발신한다(로컬). send.sh 래핑. direct_to_gd는 명시 플래그일 때만 팀장 1:1 릴레이(본문 자동승격 금지). 신원 필수·발신마다 audit.",
      inputSchema: {
        to: z.string().min(1).describe("수신 에이전트 id"),
        body: z.string().min(1).describe("본문"),
        thread: z.string().optional().describe("스레드 id(선택)"),
        in_reply_to: z.string().optional().describe("답장 대상 message id(선택)"),
        type: z.enum(["dm", "reply"]).optional(),
        priority: z.enum(["low", "normal", "high"]).optional(),
        hop: z.number().int().min(0).max(20).optional(),
        direct_to_gd: z.boolean().optional().describe("true일 때만 팀장 1:1 DM 릴레이(기본 false)"),
      },
    },
    async (args: unknown) => {
      if (!actor) return denyIdentity("발신");
      const input = args as SendMessageInput;
      const argv = buildSendArgs(input, actor);
      // ★테스트 seam: DRYRUN이면 실제 발신 없이 argv 반환(direct_to_gd 게이팅 검증용).★
      if (process.env.B3OS_MCP_SEND_DRYRUN) {
        return {
          content: [{ type: "text", text: `[dry-run] send.sh ${argv.join(" ")}` }],
          structuredContent: { dryRun: true, argv, direct_to_gd: input.direct_to_gd === true },
        };
      }
      // ★동기 spawn 금지★ (팀 리드 원칙 2026-08-05: "외부확장 요청이 본 쓰레드를 멈추면 안 되지").
      // b3os 서버는 프로세스 1개·주 스레드 1개다. spawnSync 는 자식이 끝날 때까지 그 스레드를 붙들어
      // ★그동안 대시보드를 포함한 모든 요청이 멈춘다.★ stdio 시절엔 별도 프로세스라 자기만 멈췄는데,
      // HTTP 창구가 같은 프로세스에 들어온 뒤로는 남을 멈춘다.
      // 실측(2026-08-06): send.sh 는 인자 오류로 즉시 끝나는 경로에서도 25~32ms — 네트워크 호출 전이다.
      // 실제 발신은 HTTP POST 가 붙어 더 길다. 대시보드 평소 응답이 0.6~1.2ms 이므로 한 번 보낼 때마다
      // 그 수십 배를 서버 전체가 멈추고 있었다.
      // → await 로 바꾼다. ★기다리는 것 자체는 무해하다★ — 기다리는 동안 다른 요청이 처리된다.
      //   문제는 붙들고 안 놓는 것이었다. (둘은 비슷해 보이지만 다르다.)
      const proc = Bun.spawn(["bash", sendShPath(), ...argv], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text().then((t) => t.trim()),
        new Response(proc.stderr).text().then((t) => t.trim()),
        proc.exited,
      ]);
      const ok = exitCode === 0;
      // minor(추적성): send.sh 출력에서 message_id·thread 파싱해 audit detail에 실어 direct_to_gd 릴레이 추적.
      const sentId = stdout.match(/sent\s+(\S+)/)?.[1] ?? null;
      const threadId = stdout.match(/thread=(\S+)/)?.[1] ?? input.thread ?? null;
      appendAudit(db, actor, "mcp.send_message", input.to, {
        direct_to_gd: input.direct_to_gd === true, ok, message_id: sentId, thread_id: threadId,
      });
      return {
        content: [{ type: "text", text: ok ? stdout : `발신 실패: ${stderr || stdout}` }],
        isError: !ok,
        structuredContent: { sent: ok, output: stdout, message_id: sentId, thread_id: threadId },
      };
    },
  );

  // kanban_add — 카드 생성 (createTask + audit).
  reg(
    "b3os_kanban_add",
    {
      title: "b3os 칸반 카드 생성",
      description: "칸반 카드를 생성한다. 신원 필수·audit 기록.",
      inputSchema: {
        title: z.string().min(1).describe("카드 제목"),
        lane: z.enum(["plan", "doing", "done"]).optional().describe("레인(기본 plan)"),
        owner: z.string().optional().describe("담당자 id"),
        description: z.string().optional().describe("설명"),
      },
    },
    async (args: unknown) => {
      if (!actor) return denyIdentity("카드 생성");
      const { title, lane, owner, description } = args as {
        title: string; lane?: "plan" | "doing" | "done"; owner?: string; description?: string;
      };
      const task = createTask(db, { title, column: lane, owner, description });
      appendAudit(db, actor, "mcp.kanban_add", task.id, { title, lane: task.column, owner });
      return {
        content: [{ type: "text", text: `카드 생성: ${task.id} [${task.column}] ${task.title}` }],
        structuredContent: { task: task as unknown as Record<string, unknown> },
      };
    },
  );

  // kanban_update — 카드 수정/이동 (updateTask + audit; lane 이동 시 순서 자동정렬은 updateTask가 처리).
  reg(
    "b3os_kanban_update",
    {
      title: "b3os 칸반 카드 수정",
      description: "칸반 카드를 수정/이동한다(lane 이동 시 순서 자동정렬). 신원 필수·audit.",
      inputSchema: {
        id: z.string().min(1).describe("카드 id"),
        title: z.string().optional(),
        lane: z.enum(["plan", "doing", "done"]).optional(),
        owner: z.string().optional(),
        description: z.string().optional(),
      },
    },
    async (args: unknown) => {
      if (!actor) return denyIdentity("카드 수정");
      const { id, title, lane, owner, description } = args as {
        id: string; title?: string; lane?: "plan" | "doing" | "done"; owner?: string; description?: string;
      };
      const task = updateTask(db, id, { title, column: lane, owner, description });
      if (!task) {
        return { content: [{ type: "text", text: `카드 없음: ${id}` }], isError: true, structuredContent: { error: "not_found", id } };
      }
      appendAudit(db, actor, "mcp.kanban_update", id, { title, lane, owner });
      return {
        content: [{ type: "text", text: `카드 수정: ${task.id} [${task.column}] ${task.title}` }],
        structuredContent: { task: task as unknown as Record<string, unknown> },
      };
    },
  );

  // ── 팀원과 대화하기 (고정 1:1 방 + 질문 번호) ──
  //
  // ★설계 확정 근거는 mcpAsk.ts 머리말에 있다.★ 여기서는 도구 표면만 정의한다.
  // send_message 와 다른 점: 저쪽은 "보내고 끝", 이쪽은 ★보내고 그 질문의 답까지 짝지어 돌려준다.★

  /** 이 연결이 어느 클라이언트인지(커서·클로드 코드 등). ★기록용★ — 동작은 이 값에 좌우되지 않는다. */
  const clientName = (): string | undefined => {
    try {
      const impl = (server as unknown as { server?: { getClientVersion?: () => { name?: string } | undefined } })
        .server?.getClientVersion?.();
      return impl?.name;
    } catch {
      return undefined;
    }
  };

  reg(
    "b3os_ask_teammate",
    {
      title: "b3os 팀원에게 묻기",
      description:
        "팀원에게 질문하고 그 답을 기다린다. 상대마다 고정된 1:1 방을 쓰므로 이어서 물으면 팀원이 앞 대화를 안다. " +
        "답이 제때 오면 답을, 늦으면 요청 번호와 함께 접수 상태를 돌려준다(요청은 살아 있다 — b3os_fetch_answer 로 회수).",
      inputSchema: {
        to: z.string().min(1).describe("질문할 팀원 id (예: bill, codex)"),
        question: z.string().min(1).describe("질문 본문"),
        wait_seconds: z
          .number()
          .int()
          .min(1)
          .max(ASK_WAIT_MAX_SEC)
          .optional()
          .describe(`답을 기다릴 최대 시간(기본 ${ASK_WAIT_DEFAULT_SEC}초, 최대 ${ASK_WAIT_MAX_SEC}초)`),
      },
    },
    async (args: unknown) => {
      if (!actor) return denyIdentity("팀원에게 질문");
      const { to, question, wait_seconds } = args as { to: string; question: string; wait_seconds?: number };
      if (to === actor) {
        return {
          content: [{ type: "text", text: `거부: 자기 자신(${actor})에게는 물을 수 없다.` }],
          isError: true,
          structuredContent: { error: "self_ask" },
        };
      }
      if (!listAgents(db).some((a) => a.id === to)) {
        return {
          content: [{ type: "text", text: `거부: '${to}' 는 등록된 팀원이 아니다.` }],
          isError: true,
          structuredContent: { error: "unknown_teammate", to },
        };
      }
      const waitMs = (wait_seconds ?? ASK_WAIT_DEFAULT_SEC) * 1000;
      const r = await askTeammate(
        db,
        { baseUrl: busBaseUrl() },
        { from: actor, to, body: question, client: clientName() },
        { waitMs, pollMs: 1500 }, // 디스패처 폴링과 같은 간격 — 더 자주 봐도 새 사실이 생기지 않는다
      );
      appendAudit(db, actor, "mcp.ask_teammate", to, {
        request_id: r.requestId, thread_id: r.roomId, status: r.status, waited_ms: r.waitedMs,
      });
      if (r.status === "answered" && r.answer) {
        return {
          content: [{ type: "text", text: `${to}:\n${r.answer.body}` }],
          structuredContent: {
            status: "answered", request_id: r.requestId, thread_id: r.roomId,
            answer: r.answer as unknown as Record<string, unknown>,
          },
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `${to} 가 아직 답하지 않았습니다 (${Math.round((r.waitedMs ?? 0) / 1000)}초 기다림).\n` +
              `요청 번호 ${r.requestId} — 질문은 살아 있습니다. 나중에 b3os_fetch_answer 로 받거나, ` +
              `늦게 오면 팀 리드의 평소 채널로 전달됩니다.`,
          },
        ],
        structuredContent: { status: "pending", request_id: r.requestId, thread_id: r.roomId },
      };
    },
  );

  reg(
    "b3os_fetch_answer",
    {
      title: "b3os 답 회수",
      description:
        "b3os_ask_teammate 가 접수로 끝냈을 때, 요청 번호로 그 질문의 답을 회수한다. " +
        "★번호가 맞는 답만 돌려준다★ — 번호 없이 온 발언은 답으로 붙이지 않고 따로 알려준다.",
      inputSchema: { request_id: z.string().min(1).describe("b3os_ask_teammate 가 돌려준 요청 번호") },
    },
    async (args: unknown) => {
      // ★읽기 도구도 누가 읽는지는 본다★ (리뷰 P1, bill) — 읽기 ≠ 신원 없음.
      if (!actor) return denyIdentity("답 회수");
      const { request_id } = args as { request_id: string };
      const got = fetchAnswer(db, request_id, actor);
      if (!got.found && got.denied) {
        // ★있다/없다를 구분해 알려주지 않는다★ — 그러면 번호를 넣어보며 남의 요청 존재를 알아낼 수 있다.
        return {
          content: [{ type: "text", text: `그런 요청 번호가 없습니다: ${request_id}` }],
          isError: true,
          structuredContent: { error: "unknown_request", request_id },
        };
      }
      if (got.found) {
        return {
          content: [{ type: "text", text: `${got.answer.from}:\n${got.answer.body}` }],
          structuredContent: {
            status: "answered", request_id, thread_id: got.roomId,
            answer: got.answer as unknown as Record<string, unknown>,
          },
        };
      }
      if (!got.roomId) {
        return {
          content: [{ type: "text", text: `그런 요청 번호가 없습니다: ${request_id}` }],
          isError: true,
          structuredContent: { error: "unknown_request", request_id },
        };
      }
      const note = got.unlabeled.length
        ? `\n※ 번호 없이 온 발언 ${got.unlabeled.length}건이 있습니다(답으로 붙이지 않았습니다): ` +
          got.unlabeled.map((u) => `"${u.body.slice(0, 40)}"`).join(", ")
        : "";
      return {
        content: [{ type: "text", text: `${got.to} 의 답이 아직 없습니다. 요청은 살아 있습니다.${note}` }],
        structuredContent: {
          status: "pending", request_id, thread_id: got.roomId,
          unlabeled: got.unlabeled as unknown as Record<string, unknown>[],
        },
      };
    },
  );

  return server;
}

/** 실제 실행 시 team.db 경로(env B3OS_MCP_DB 우선, 기본=레포 team.db). */
function dbPath(): string {
  return process.env.B3OS_MCP_DB ?? `${process.env.HOME}/Development/b3rys-team-os/team.db`;
}
/** 레포 루트 = team.db가 있는 디렉터리. */
function repoRoot(): string {
  return dbPath().replace(/\/[^/]*$/, "");
}
/** send.sh 경로(env B3OS_SEND_SH 우선). */
function sendShPath(): string {
  return process.env.B3OS_SEND_SH ?? `${repoRoot()}/skills/b3os-team-inbox/scripts/send.sh`;
}

/**
 * stdio 서버로 기동. ★M2부터 쓰기 오픈★(읽기전용 아님) — 단 쓰기는 도구 레벨에서 신원(B3OS_AGENT_ID)
 * 필수 + 매 호출 audit로 게이트. 읽기 도구는 읽기 전용 query만 사용. (M3에서 신원 allowlist/deny 추가.)
 */
export async function main(): Promise<void> {
  const db = new Database(dbPath());
  // stdio 는 종전대로 env 신원 + 쓰기 허용. ★둘 다 명시★ — 기본값에 기대지 않는다.
  const server = buildMcpServer(db, resolveActor(db), "write");
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("[b3os-mcp] fatal:", e);
    process.exit(1);
  });
}
