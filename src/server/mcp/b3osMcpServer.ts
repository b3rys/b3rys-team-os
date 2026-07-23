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

export const MCP_NAME = "b3os-mcp";
export const MCP_VERSION = "0.0.3-m2";

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
 * ★신원 단일 choke-point(Codex/Bill MUST-FIX B1)★: 연결 선언값(env B3OS_AGENT_ID)을
 *  [non-empty + listAgents 레지스트리 등록 + (선택)MCP allowlist] 로 검증. 실패=null(fail-closed).
 *  startup에 1회 해석해 closure에 고정 → per-call env 재읽기·위조 차단. 쓰기(send·kanban)·개인scope
 *  읽기(inbox·recall_dms)가 전부 이 한 값으로 게이트되어 칸반 경로 무검증 구멍이 막힌다.
 */
function resolveActor(db: Database): string | null {
  const declared = process.env.B3OS_AGENT_ID?.trim();
  if (!declared) return null; // non-empty
  if (!listAgents(db).some((a) => a.id === declared)) return null; // 레지스트리 등록 agent
  const allow = process.env.B3OS_MCP_ALLOWED_AGENTS?.trim(); // 선택 게이트: 설정 시에만 추가 제한
  if (allow && !allow.split(",").map((s) => s.trim()).includes(declared)) return null;
  return declared;
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

/** DB 핸들을 받아 team_status 도구를 등록한 McpServer 반환(테스트는 격리 DB 주입). */
export function buildMcpServer(db: Database): McpServer {
  const server = new McpServer({ name: MCP_NAME, version: MCP_VERSION });
  // ★신원 startup 고정(B1)★: 이후 모든 쓰기·개인scope 읽기는 이 검증된 actor로만. null=무검증 → 거부.
  const actor = resolveActor(db);

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
  const reg = (server as { registerTool: (...a: unknown[]) => unknown }).registerTool.bind(server);
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
      const all = listTasks(db);
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
      const proc = Bun.spawnSync(["bash", sendShPath(), ...argv]);
      const stdout = proc.stdout ? new TextDecoder().decode(proc.stdout).trim() : "";
      const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr).trim() : "";
      const ok = proc.exitCode === 0;
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
  const server = buildMcpServer(db);
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("[b3os-mcp] fatal:", e);
    process.exit(1);
  });
}
