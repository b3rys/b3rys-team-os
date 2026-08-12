import type { Database } from "bun:sqlite";
import type { PendingDispatchRow } from "../../bus/types";
import { recentThreadMessages } from "../../db/inboxQueries";
import type { AgentRecord } from "../../types";
import { buildCodexMemoryRefs, type CodexMemoryRef } from "./memory";

export interface CodexTurnEnvelope {
  runtime: "codex_cli";
  agentId: string;
  threadId: string;
  messageId: string;
  surface: "team_bus" | "telegram" | string;
  goal: string;
  taskState?: {
    taskId: string;
    title: string;
    lane: string;
    owner: string | null;
    description: string | null;
  };
  /** 이 턴의 답을 실제로 보내는 명령(스레드·in-reply-to 포함). 안 보내면 아무도 못 본다. */
  howToReply: string;
}

export class CodexTurnEnvelopeBuilder {
  constructor(private readonly db: Database) {}

  buildForBus(input: {
    agent: AgentRecord;
    row: PendingDispatchRow;
    teamContext: string;
    sandbox?: string;
    networkAccess?: boolean;
  }): CodexTurnEnvelope {
    const recent = recentThreadMessages(this.db, input.row.thread_id, 12, 6);
    const conversation = recent
      .filter((m) => m.id !== input.row.message_id)
      .map((m) => ({
        from: m.from_agent_id,
        role: m.from_agent_id === input.agent.id ? ("self" as const) : ("external" as const),
        body: m.body,
      }));
    conversation.push({ from: input.row.from_agent_id, role: "external", body: input.row.body });

    return {
      runtime: "codex_cli",
      agentId: input.agent.id,
      threadId: input.row.thread_id,
      messageId: input.row.message_id,
      surface: "team_bus",
      goal: input.row.body,
      taskState: this.findTaskState(input.row),
      // ★답을 실제로 보내는 명령.★ 서버는 턴 결과를 대신 게시하지 않는다
      //   (turn_completed_no_autopost — 모든 런타임 공통). 보내야 말한 것이다.
      //   실측 2026-08-12: 이게 없어서 dex 가 일을 다 하고도 답을 안 보냈다.
      howToReply: this.replyCommand(input.row),
    };
  }

  toPrompt(envelope: CodexTurnEnvelope): string {
    // ★같은 명령을 두 번 쓰지 않는다.★ (팀 리드 2026-08-12) 지시문 쪽만 남긴다 —
    //   JSON 은 자료고 지시문은 명령이라, 모델이 실제로 따르는 쪽에 둔다.
    const { howToReply, ...data } = envelope;
    return [
      "[CodexTurnEnvelope]",
      JSON.stringify(data, null, 2),
      "",
      "[Instruction]",
      "Answer the current turn using the envelope above.",
      `To actually reply you MUST run: ${howToReply}`,
    ].join("\n");
  }

  /** ★이 턴의 답을 실제로 보내는 명령.★ 스레드·in-reply-to 를 박아 준다(사람이 조립하다 틀리지 않게). */
  private replyCommand(row: PendingDispatchRow): string {
    const repo = process.env.B3OS_REPO_ROOT ?? `${process.env.HOME ?? "~"}/Development/b3rys-team-os`;
    const to = row.from_agent_id ? `--to ${row.from_agent_id}` : "--direct-to-gd";
    return `${repo}/skills/b3os-team-inbox/scripts/send.sh ${to} --thread ${row.thread_id} --in-reply-to ${row.message_id} --body '<your answer>'`;
  }

  private findTaskState(row: PendingDispatchRow): CodexTurnEnvelope["taskState"] {
    const taskId = this.taskIdFromRow(row);
    if (!taskId) return undefined;
    const task = this.db
      .prepare(`SELECT id, title, lane, owner, description FROM task WHERE id = ?`)
      .get(taskId) as
      | { id: string; title: string; lane: string; owner: string | null; description: string | null }
      | undefined;
    if (!task) return undefined;
    return {
      taskId: task.id,
      title: task.title,
      lane: task.lane,
      owner: task.owner,
      description: task.description,
    };
  }

  private taskIdFromRow(row: PendingDispatchRow): string | undefined {
    try {
      const meta = row.meta_json ? (JSON.parse(row.meta_json) as Record<string, unknown>) : {};
      const value = meta.task_id ?? meta.taskId;
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch {
      // Ignore malformed metadata; the envelope still carries conversation context.
    }
    const linked = this.db
      .prepare(`SELECT task_link_id FROM message WHERE id = ?`)
      .get(row.message_id) as { task_link_id: string | null } | undefined;
    return linked?.task_link_id ?? undefined;
  }
}
