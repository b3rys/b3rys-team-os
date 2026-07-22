// claude 런타임 OWNER 1:1 DM 파서 — 세션 .jsonl에서 OWNER와의 1:1만 엄격 추출해 dm_message로 sync.
// ★엄격필터★(POC 검증): <channel source="plugin:telegram" chat_id=OWNER>(inbound) + reply tool_use(outbound)만.
//   <external_message>(팀/버스)·bash·thinking·그룹은 제외 — 안 하면 버스 메시지가 섞임(POC 567→498).
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { DmMessageInput } from "../../db/dmCapture";


// 세션 jsonl은 append-only(새 이벤트가 파일 끝에 추가)라, 끝 일부만 읽어도 최신 DM을 다 잡는다.
// 통째 읽기 대신 tail만 읽어 세션이 MB로 커져도 읽기 비용을 상한(기본 1MB)으로 고정(OWNER 2026-07-09).
// 10초 폴링이라 새 DM은 append된 그 tick에 파일 끝(=tail 안)에 있으므로 놓치지 않는다.
const TAIL_BYTES = Math.max(64 * 1024, Number(process.env.B3OS_DM_TAIL_BYTES) || 1024 * 1024);

/** 파일 끝 TAIL_BYTES만 읽어 텍스트로. 중간부터 시작하면 첫 줄이 잘렸을 수 있어 첫 개행 전까지 버린다. */
export function readTail(fp: string, tailBytes: number = TAIL_BYTES): string {
  const fd = openSync(fp, "r");
  try {
    const size = fstatSync(fd).size;
    const start = size > tailBytes ? size - tailBytes : 0;
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, start);
    let text = buf.toString("utf-8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : ""; // 잘린 첫 줄 폐기
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

function sessionDirFor(workspacePath: string): string {
  // Claude Code 세션 저장 경로: ~/.claude/projects/<workspace의 / 를 - 로 치환>/
  const encoded = workspacePath.replace(/\//g, "-");
  return `${homedir()}/.claude/projects/${encoded}`;
}

// 최근 세션 jsonl (mtime 최신 N개). fresh 재시작으로 세션이 갈리므로 여러 개 스캔.
function recentSessionFiles(dir: string, limit: number): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => `${dir}/${f}`)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: string; text: string } => !!c && typeof c === "object" && (c as { type?: string }).type === "text")
      .map((c) => c.text)
      .join("");
  }
  return "";
}

/**
 * claude 멤버의 최근 세션 jsonl에서 OWNER 1:1 DM(inbound+outbound)을 추출.
 * dedupe_key: inbound=telegram:OWNER:<msg_id>, outbound=telegram:OWNER:out:<ts+본문 해시>
 *   (reply 도구는 호출 시점에 sent id를 모르므로 outbound는 ts+본문 해시로 안정 dedupe).
 * created_at: 이벤트 timestamp(UTC). KST는 렌더 시 +9h.
 */
/** 채널 태그 원문에서 팀장 1:1 inbound 를 뽑는다(엄격필터). 아니면 null.
 *  ★두 경로가 이 한 함수를 공유한다★ — 일반 턴(user 이벤트)과 인터럽트(queue-operation)가
 *  같은 필터를 쓰게 해서, 한쪽만 고치는 회귀를 원천 차단한다.
 *
 *  ★버스/팀 메시지 배제는 '앵커'로 한다(적대 리뷰 2026-07-14).★ 예전엔 본문 어디든 "<external_message"
 *  가 있으면 버렸다 — 그래서 ★팀장이 룰 스니펫을 붙여넣기만 해도 그 DM 이 통째로 유실됐다.★
 *  ("이 <external_message> 태그 파싱 어떻게 해?" → 기록 안 됨). 실제로 팀장은 룰·포맷을 자주 붙여넣는다.
 *  진짜 버스 메시지는 ★<external_message 로 시작★ 하므로, 시작 위치로만 판정한다. */
function inboundFromChannelText(text: string, gdChat: string): { mid: string; body: string } | null {
  const head = text.trimStart();
  if (!head.startsWith("<channel")) return null; // 버스 주입·팀 메시지는 <channel 로 시작하지 않는다
  if (!head.includes(`chat_id="${gdChat}"`)) return null;
  if (!head.includes('source="plugin:telegram')) return null;
  const mid = head.match(/message_id="(\d+)"/)?.[1];
  const body = (head.match(/>\s*([\s\S]*?)\s*<\/channel>/)?.[1] ?? "").trim();
  return mid && body ? { mid, body } : null;
}

export function parseClaudeGdDms(memberId: string, workspacePath: string, ownerChatId: string, opts: { sessionLimit?: number } = {}): DmMessageInput[] {
  if (!ownerChatId) return []; // owner_chat_id 미설정 → 캡처 없음(무동작이 오동작보다 낫다)
  const GD_CHAT = ownerChatId;
  const files = recentSessionFiles(sessionDirFor(workspacePath), opts.sessionLimit ?? 3);
  const out: DmMessageInput[] = [];
  for (const fp of files) {
    let raw: string;
    try {
      raw = readTail(fp); // 통째 아님 — 파일 끝 tail만(최신 DM은 끝에 있음). 재읽기 겹쳐도 dedup가 흡수.
    } catch {
      continue;
    }
    const src = fp.split("/").pop() ?? "?";
    for (const ln of raw.split("\n")) {
      if (!ln.trim()) continue;
      let ev: { timestamp?: string; type?: string; operation?: string; content?: unknown; message?: { role?: string; content?: unknown } };
      try {
        ev = JSON.parse(ln);
      } catch {
        continue;
      }
      const ts = ev.timestamp;
      if (!ts) continue;
      const msg = ev.message ?? {};
      const role = msg.role ?? ev.type;

      // ★INBOUND ②: 팀원이 ★일하는 중에★ 팀장이 보낸 메시지(인터럽트) — OWNER 2026-07-14 발견.★
      //   클로드 런타임은 이걸 user 이벤트가 아니라 {type:"queue-operation", operation:"enqueue",
      //   content:"<channel …>"} 로 적는다. role==="user" 만 보던 옛 코드는 ★통째로 놓쳤다.★
      //   실측(이 세션): "잠시만"·"오케이 고 하고 풀테스트" 가 dm_message 에 하나도 안 남았다.
      //   하필 인터럽트가 ★"member 응답??" 같은 재촉★ 이라, 제일 중요한 메시지가 기록에서 빠지고 있었다.
      if (ev.type === "queue-operation" && ev.operation === "enqueue" && typeof ev.content === "string") {
        const hit = inboundFromChannelText(ev.content, GD_CHAT);
        if (hit) {
          out.push({
            memberId,
            runtime: "claude_channel",
            direction: "in",
            body: hit.body,
            createdAt: new Date(ts),
            dedupeKey: `telegram:${GD_CHAT}:${hit.mid}`, // 일반 턴과 같은 키 → 양쪽에 잡혀도 1건
            sourceRef: `claude:${src}`,
          });
        }
        continue;
      }

      // INBOUND ①: 일반 턴의 OWNER 1:1 채널 메시지(엄격필터). external_message(팀/버스)는 배제.
      if (role === "user") {
        const text = textOf(msg.content);
        const hit = inboundFromChannelText(text, GD_CHAT);
        if (hit) {
          const mid = hit.mid;
          const body = hit.body;
          if (mid && body) {
            out.push({
              memberId,
              runtime: "claude_channel",
              direction: "in",
              body,
              createdAt: new Date(ts),
              dedupeKey: `telegram:${GD_CHAT}:${mid}`,
              sourceRef: `claude:${src}`,
            });
          }
        }
      }

      // OUTBOUND: reply 도구로 OWNER에게 보낸 답.
      if (role === "assistant" && Array.isArray(msg.content)) {
        for (const c of msg.content as Array<{ type?: string; name?: string; input?: { chat_id?: unknown; text?: unknown } }>) {
          if (c?.type === "tool_use" && typeof c.name === "string" && c.name.endsWith("__reply")) {
            const inp = c.input ?? {};
            const body = typeof inp.text === "string" ? inp.text : "";
            if (String(inp.chat_id ?? "") === GD_CHAT && body.trim()) {
              const h = createHash("sha1").update(`${ts}\n${body}`).digest("hex").slice(0, 12);
              out.push({
                memberId,
                runtime: "claude_channel",
                direction: "out",
                body,
                createdAt: new Date(ts),
                dedupeKey: `telegram:${GD_CHAT}:out:${h}`,
                sourceRef: `claude:${src}`,
              });
            }
          }
        }
      }
    }
  }
  return out;
}
