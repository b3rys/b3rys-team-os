/**
 * ★마감 — 답이 안 오면 그때 상황으로 보고하게 깨운다.★ (GD 2026-07-13)
 *
 * ═══ 왜 (팀장 라이브 테스트) ═══
 *   16:22:01  steve → demis/hermes/codex   팬아웃
 *   16:23:13  demis → steve                답
 *   16:24:01  codex → steve                답
 *             hermes                        ★영영 안 옴★ (턴이 타임아웃으로 죽었다)
 *   → steve 대기열 0건. ★아무도 steve 를 다시 안 깨운다 → 영원히 대기.★
 *
 * ★팀원 스스로는 못 한다★ (GD 질문): hermes·openclaw·codex 는 턴이 끝나면 ★프로세스가 죽는다★ —
 *   5분 뒤의 자기가 없다. claude 는 세션이 살아있지만 ★주입을 받아야 움직인다★ (타이머 없음).
 *   턴 안에서 5분을 자면? ★그동안 팀장 메시지에 응답 못 한다 — 더 나쁘다.★
 *   → ★플랫폼이 깨워야 한다.★ 룰은 이미 "침묵하는 사람이 있으면 밝히고 보고하라" 고 시킨다.
 *
 * ═══ ★내가 세 번 틀렸다★ (전부 정답 대조로 잡았다) ═══
 *   ① thread+collector 로 묶음 → ★가짜 수집 200개★ (요청자를 기여자로 셈) → 배포했으면 ★마감 폭탄★
 *   ② 위임 행을 anchor → ★팀장의 단톡방 지시는 message 테이블에 없다★ (캡처로 직접 주입) → 못 잡음
 *   ③ "요청자 = 먼저 말 건 사람" → 장수 그룹방에선 기여자도 예전에 말한 적 있다 → ★0건★
 *   → ★질문은 답보다 먼저 나간다★ 가 유일하게 믿을 수 있는 신호였다.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { findStalledCollections, sweepCollectionDeadlines } from "./collectionDeadline";
import { migrate } from "../db/migrate";

const AGENTS = ["steve", "hermes", "codex", "demis", "bill", "dbak", "devon"].map((id) => ({ id })) as never;

function db0(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE message (
    id TEXT PRIMARY KEY, thread_id TEXT, from_agent_id TEXT, to_agent_id TEXT,
    type TEXT, body TEXT, source TEXT, created_at TEXT, meta_json TEXT)`);
  return db;
}
let n = 0;
/** minsAgo 분 전에 from→to 메시지 (replyMode 지정 시 meta_json.reply_mode 로 실음 — direct_to_gd 개별보고 구별용) */
function msg(db: Database, thread: string, from: string, to: string | null, minsAgo: number, replyMode?: string, individual?: boolean) {
  const meta: Record<string, unknown> = {};
  if (replyMode) meta.reply_mode = replyMode;
  if (individual) meta.individual = true;   // send.sh --individual 이 싣는 칸
  db.run(
    `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, created_at, meta_json)
     VALUES (?, ?, ?, ?, 'dm', 'x', 'agent', datetime('now', '-' || ? || ' minutes'), ?)`,
    [`m${++n}`, thread, from, to, String(minsAgo), Object.keys(meta).length ? JSON.stringify(meta) : null],
  );
}

describe("★막힌 수집을 찾는다 — 정확히 그것만★", () => {
  let db: Database;
  beforeEach(() => { db = db0(); n = 0; });

  it("★팀장 케이스: 3명에게 뿌렸고 1명이 끝내 안 왔다 → 잡는다★", () => {
    msg(db, "tg-1", "steve", "demis", 20);
    msg(db, "tg-1", "steve", "hermes", 20);
    msg(db, "tg-1", "steve", "codex", 20);
    msg(db, "tg-1", "demis", "steve", 19);   // 답
    msg(db, "tg-1", "codex", "steve", 18);   // 답
    // hermes 는 영영 안 옴
    const st = findStalledCollections(db, AGENTS);
    expect(st).toHaveLength(1);
    expect(st[0]!.collector).toBe("steve");
    expect(st[0]!.missing).toEqual(["hermes"]);
    expect(st[0]!.answered.sort()).toEqual(["codex", "demis"]);
  });

  it("★정상 완료된 수집은 안 잡는다★ (다 왔고 보고까지 했다)", () => {
    msg(db, "t2", "bill", "hermes", 20);      // 위임
    msg(db, "t2", "hermes", "steve", 19);     // 팬아웃
    msg(db, "t2", "hermes", "dbak", 19);
    msg(db, "t2", "steve", "hermes", 18);     // 답
    msg(db, "t2", "dbak", "hermes", 18);      // 답
    msg(db, "t2", "hermes", "bill", 17);      // ★종합 보고★
    expect(findStalledCollections(db, AGENTS)).toHaveLength(0);
  });

  it("★요청자에게 낸 종합을 '질문' 으로 오인하지 않는다★ (그러면 요청자가 '미응답' 으로 잡힌다 — 실측 오탐)", () => {
    msg(db, "t3", "bill", "hermes", 20);
    msg(db, "t3", "hermes", "steve", 19);
    msg(db, "t3", "hermes", "dbak", 19);
    msg(db, "t3", "steve", "hermes", 18);
    msg(db, "t3", "hermes", "bill", 17);      // 종합 (dbak 은 아직 안 옴)
    const st = findStalledCollections(db, AGENTS);
    // 보고를 했으므로 재촉하지 않는다. ★bill 이 missing 에 들어가면 안 된다.★
    expect(st.flatMap((s) => s.missing)).not.toContain("bill");
  });

  it("★팬아웃 전 ack 을 질문으로 세지 않는다★ (codex 는 '확인했습니다' 를 먼저 보낸다)", () => {
    msg(db, "t4", "bill", "codex", 20);       // 위임
    msg(db, "t4", "codex", "bill", 19);       // ★ack (질문 아님)★
    msg(db, "t4", "codex", "steve", 19);      // 팬아웃
    msg(db, "t4", "codex", "dbak", 19);
    msg(db, "t4", "steve", "codex", 18);      // 답
    // dbak 안 옴 → 잡혀야 하고, ★bill 은 missing 이 아니어야 한다★
    const st = findStalledCollections(db, AGENTS);
    expect(st).toHaveLength(1);
    expect(st[0]!.missing).toEqual(["dbak"]);
  });

  it("★개별보고 패턴은 막힌 게 아니다★ (기여자가 collector 아니라 ★요청자에게★ 직접 답한다)", () => {
    msg(db, "t5", "bill", "codex", 20);
    msg(db, "t5", "codex", "devon", 19);
    msg(db, "t5", "codex", "dbak", 19);
    msg(db, "t5", "devon", "bill", 18);       // ★요청자에게 직접★
    msg(db, "t5", "dbak", "bill", 18);
    expect(findStalledCollections(db, AGENTS)).toHaveLength(0);
  });

  it("★한 명한테만 물은 건 수집이 아니다★ (그냥 질문일 수 있다 — 과잉 재촉 방지)", () => {
    msg(db, "t6", "bill", "steve", 20);
    msg(db, "t6", "steve", "demis", 19);      // 1명뿐
    expect(findStalledCollections(db, AGENTS)).toHaveLength(0);
  });

  it("★팀장께 직보(to='user')한 것도 '보고했다' 로 센다★ — 안 그러면 불필요한 재촉이 간다(실측 6건)", () => {
    msg(db, "t8", "bill", "codex", 20);
    msg(db, "t8", "codex", "steve", 19);
    msg(db, "t8", "codex", "dbak", 19);
    msg(db, "t8", "steve", "codex", 18);
    // dbak 은 안 왔지만, codex 가 ★팀장(user)께★ 직보했다 → 재촉하지 않는다
    msg(db, "t8", "codex", "user", 17);
    expect(findStalledCollections(db, AGENTS)).toHaveLength(0);
  });

  it("★방(broadcast)에 올린 것도 보고다★", () => {
    msg(db, "t9", "bill", "codex", 20);
    msg(db, "t9", "codex", "steve", 19);
    msg(db, "t9", "codex", "dbak", 19);
    msg(db, "t9", "steve", "codex", 18);
    msg(db, "t9", "codex", "broadcast", 17);
    expect(findStalledCollections(db, AGENTS)).toHaveLength(0);
  });

  it("★마감 전에는 안 깨운다★ (방금 물어봤는데 재촉하면 안 된다)", () => {
    msg(db, "t7", "steve", "demis", 1);
    msg(db, "t7", "steve", "hermes", 1);
    expect(findStalledCollections(db, AGENTS)).toHaveLength(0);
  });
});



/**
 * ★"다 왔는데 종합이 안 나갔다" — 아무도 안 잡고 있었다.★ (2026-07-14 실측, 팀장 라이브)
 *
 * ═══ codex 가 35분째 멈췄다 ═══
 *   09:31:24  codex → steve·hermes   팬아웃
 *   09:31:43  codex → hermes         ★"의견 반영 완료" (ack)★
 *   09:32:32  steve → codex          입력 도착 → ★이 wake 가 codex 의 마지막 기회였다★
 *   09:32:48  codex → steve          ★"입력 반영 완료" (또 ack) — 종합 대신 ack 으로 턴을 끝냈다★
 *   그 뒤로 ★아무도 codex 를 다시 안 깨운다.★ 팀장은 영원히 기다린다.
 *
 * 옛 코드: `if (missing.length === 0) continue;  // 다 왔는데 보고 안 한 건 ★침묵 룰 소관★`
 * ★그런데 룰은 아무도 깨우지 않는다.★ ★한 턴짜리 런타임은 다음 순간의 자기가 없다.★
 * ★팀장 기준: "답이 영영 안 옴" = 의도하지 않은 결과 → 시스템이 잡는다.★
 */
describe("★다 왔는데 종합이 안 나갔다 — 그것도 막힌 것이다★", () => {
  let db: Database;
  beforeEach(() => { db = db0(); n = 0; });

  it("★codex 케이스 재현: 전원 답했는데 보고 없음 → 깨운다★", () => {
    // (분 단위 헬퍼라 답과 ack 을 ★다른 분★ 에 둔다 — 같은 분이면 순서를 못 가른다)
    msg(db, "c1", "bill", "codex", 25);      // 위임
    msg(db, "c1", "codex", "steve", 24);     // 팬아웃
    msg(db, "c1", "codex", "hermes", 24);
    msg(db, "c1", "hermes", "codex", 22);    // 답
    msg(db, "c1", "codex", "hermes", 21);    // ★ack ("의견 반영 완료") — 보고가 아니다★
    msg(db, "c1", "steve", "codex", 20);     // 답
    msg(db, "c1", "codex", "steve", 19);     // ★또 ack — 종합 대신★
    const st = findStalledCollections(db, AGENTS);
    expect(st).toHaveLength(1);
    expect(st[0]!.missing).toEqual([]);                       // ★미응답 없음★
    expect(st[0]!.answered.sort()).toEqual(["hermes", "steve"]);
  });

  it("★기여자에게 보낸 ack 은 '보고' 가 아니다★ — 그게 보고로 세지면 영원히 안 깨운다", () => {
    // 위 케이스의 핵심: codex 가 기여자에게 보낸 ack 들이 ★'보고했다' 로 세지면 안 된다★
    msg(db, "c2", "bill", "codex", 21);
    msg(db, "c2", "codex", "steve", 20);
    msg(db, "c2", "codex", "hermes", 20);
    msg(db, "c2", "steve", "codex", 19);
    msg(db, "c2", "hermes", "codex", 19);
    msg(db, "c2", "codex", "steve", 18);     // ack (기여자에게)
    msg(db, "c2", "codex", "hermes", 18);    // ack (기여자에게)
    expect(findStalledCollections(db, AGENTS)).toHaveLength(1);   // ★여전히 막힌 것★
  });

  it("★진짜 보고했으면 안 깨운다★ (고무도장 아님)", () => {
    msg(db, "c3", "bill", "codex", 21);
    msg(db, "c3", "codex", "steve", 20);
    msg(db, "c3", "codex", "hermes", 20);
    msg(db, "c3", "steve", "codex", 19);
    msg(db, "c3", "hermes", "codex", 19);
    msg(db, "c3", "codex", "bill", 18);      // ★종합 보고 (요청자에게)★
    expect(findStalledCollections(db, AGENTS)).toHaveLength(0);
  });

  it("★개별보고는 여전히 안 깨운다★ — 기여자가 요청자에게 직접 답하면 종합이 필요 없다", () => {
    msg(db, "c4", "bill", "codex", 21);
    msg(db, "c4", "codex", "devon", 20);
    msg(db, "c4", "codex", "dbak", 20);
    msg(db, "c4", "devon", "bill", 19);      // ★요청자에게 직접★
    msg(db, "c4", "dbak", "bill", 19);
    expect(findStalledCollections(db, AGENTS)).toHaveLength(0);   // ★깨우면 멀쩡한 걸 재촉하는 것★
  });

  it("★개별보고 — 기여자가 collector 에게 direct_to_gd 로 답해도 안 깨운다★ (서귀포 오탐 재현)", () => {
    // 기여자가 `--to <collector> --direct-to-gd` 로 답하면 목적지는 GD(개별보고)지 collector 종합용이 아니다.
    // 옛 코드는 'collector 에게 왔다=수집' 으로 오판해 [마감] 독촉을 쐈다(서귀포). direct_to_gd 는 수집 답에서 뺀다.
    msg(db, "c4d", "bill", "codex", 21);                    // 요청자 bill → collector codex
    msg(db, "c4d", "codex", "devon", 20);                   // fan-out
    msg(db, "c4d", "codex", "dbak", 20);
    msg(db, "c4d", "devon", "codex", 19, "direct_to_gd");   // ★collector 에게 보냈지만 direct_to_gd = 개별(GD 행)★
    msg(db, "c4d", "dbak", "codex", 19, "direct_to_gd");
    expect(findStalledCollections(db, AGENTS)).toHaveLength(0);   // 개별보고 → 종합 불필요 → 안 깨움
  });

  it("★개별보고 — 일부만 direct_to_gd 로 답했고 나머지는 아직이어도 안 깨운다★ (① narrowing 완성, dbak 오탐)", () => {
    // 라이브 오탐: 개별보고에서 hermes 는 GD께 direct_to_gd 로 답했는데 steve 가 늦자 → "missing: steve" 독촉이 나갔다.
    // direct_to_gd 답이 하나라도 있으면 = 개별보고 확정 → 미응답이 있어도 backstop 통째 스킵.
    msg(db, "c4e", "bill", "codex", 21);                    // 요청자 → collector
    msg(db, "c4e", "codex", "devon", 20);                   // fan-out
    msg(db, "c4e", "codex", "dbak", 20);
    msg(db, "c4e", "devon", "codex", 19, "direct_to_gd");   // devon 만 direct_to_gd 로 답(GD행) — dbak 은 아직 무응답
    expect(findStalledCollections(db, AGENTS)).toHaveLength(0);   // 개별보고 → dbak 미응답이어도 안 깨움
  });
});

/**
 * ★윈도 경계 오탐 — 이미 끝난 수집에 [마감] 이 갔다.★ (2026-07-13 라이브, ★dbak 이 잡았다★)
 *
 * ═══ 실측 ═══
 *   18:14:54  bill  → dbak   위임 ("demis 한테 물어봐서 종합해서 bill 에게 보고해줘")
 *   18:15:03  dbak  → demis  질문        ┐ 같은 초
 *   18:15:03  dbak  → bill   ack("접수") ┘
 *   18:15:26  demis → dbak   답
 *   18:15:34  dbak  → bill   ★종합 보고 — 수집 끝★
 *   19:44:54  system→ dbak   ★[마감] 미응답: bill★   ← ★90분 뒤에, 이미 끝난 수집에★
 *
 * ★dbak 은 룰을 완벽히 지켰다. 서버가 훼손된 시야로 그를 고발했다.★
 *   'now-90분' 윈도의 시작이 위임(18:14:54)을 막 지나가는 ★40초짜리 틈★ 에서
 *   위임 행만 밖으로 밀려나고 → 요청자를 못 찾고 → ack 이 팬아웃으로 오인되고 →
 *   bill 이 '기여자' 가 되어 → 미응답자로 고발 + ★bill 에게 간 진짜 종합이 '보고' 로 안 세짐.★
 */
describe("★윈도 경계 — 훼손된 시야로 멀쩡한 팀원을 고발하지 않는다★", () => {
  let db: Database;
  beforeEach(() => { db = db0(); n = 0; });

  it("★dbak 케이스 재현: 위임이 윈도 밖으로 밀려나도 ack 을 질문으로 세지 않는다★", () => {
    // 위임이 91분 전(윈도 밖) — 나머지는 안쪽
    msg(db, "w1", "bill", "dbak", 91);     // 위임 (★now-90분 윈도 밖★)
    msg(db, "w1", "dbak", "demis", 89);    // 질문
    msg(db, "w1", "dbak", "bill", 89);     // ★ack — 질문이 아니다★
    msg(db, "w1", "demis", "dbak", 88);    // 답
    msg(db, "w1", "dbak", "bill", 88);     // ★종합 보고★
    expect(findStalledCollections(db, AGENTS)).toHaveLength(0);   // ★깨우면 안 된다★
  });

  it("★너무 늦은 건 깨우지 않는다★ — 5분 마감인데 90분 뒤 재촉은 소음이다", () => {
    msg(db, "w2", "steve", "demis", 89);
    msg(db, "w2", "steve", "hermes", 89);
    // hermes 가 진짜로 안 왔지만 ★89분이 지났다★ → 지금 깨워봐야 도움이 안 된다
    msg(db, "w2", "demis", "steve", 88);
    expect(findStalledCollections(db, AGENTS)).toHaveLength(0);
  });

  it("★진짜 막힌 건 여전히 잡는다★ (마감 지남 · 상한 이내) — 위 두 가드가 고무도장이 아니다", () => {
    msg(db, "t10", "bill", "steve", 21);
    msg(db, "t10", "steve", "demis", 20);
    msg(db, "t10", "steve", "hermes", 20);
    msg(db, "t10", "steve", "codex", 20);
    msg(db, "t10", "demis", "steve", 19);
    // hermes·codex 침묵 · 보고 없음
    const st = findStalledCollections(db, AGENTS);
    expect(st).toHaveLength(1);
    expect(st[0]!.missing.sort()).toEqual(["codex", "hermes"]);
    expect(st[0]!.missing).not.toContain("bill");   // ★요청자는 절대 미응답이 아니다★
  });
});

/**
 * ★하드캡 — 감지가 틀려도 스팸이 되면 안 된다.★
 *
 * 2026-07-13 사고: 마감 체커가 steve 를 ★47번★ 재촉했다.
 *   원인 ① 감지: claude 는 텔레그램에 직접 쏜다 → ★서버가 보고를 못 본다★ → 영원히 '미보고'
 *   원인 ② 중복방지: dedupe_key 를 걸었는데 ★insertMessage 는 dedupe 를 안 한다★ → 매 tick 발사
 *   ★①만 고치면 다음 사각지대에서 또 터진다. ②가 진짜 안전망이다.★
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("★하드캡 — 수집 하나당 최대 1회★", () => {
  const SRC = readFileSync(join(import.meta.dir, "collectionDeadline.ts"), "utf8");

  it("★audit 을 진실의 원천으로 쓴다★ (dedupe_key 는 못 믿는다 — insertMessage 가 안 막는다)", () => {
    expect(SRC).toContain("FROM audit_event");
    expect(SRC).toContain("action = 'collection_deadline_woke'");
    expect(SRC).toContain("if (already > 0) continue;");
  });

  it("★audit 에 key 를 남긴다★ — 안 남기면 위 체크가 영영 0을 반환해 ★무한 발사★ 한다", () => {
    expect(SRC).toContain('appendAudit(db, "bus_dispatcher", "collection_deadline_woke", msg.id, {');
    expect(SRC).toMatch(/collection_deadline_woke", msg\.id, \{[\s\S]{0,40}key,/);
  });

  it("★기능은 기본 OFF★ — 켜는 건 검증 뒤에 (사고 재발 방지)", () => {
    const DISPATCH = readFileSync(join(import.meta.dir, "wakeDispatcher.ts"), "utf8");
    expect(DISPATCH).toContain(`process.env.COLLECTION_DEADLINE_ON !== "0"`);
  });
});

/**
 * ★서버가 못 가르는 걸 알림이 팀원에게 물어본다.★ (GD 2026-07-17)
 *
 * ═══ 왜 ═══
 *   anyToGd 스킵은 ★기여자가 direct_to_gd 로 답해야★ 켜진다. 그런데 아무도 아직 안 답한 5분 시점엔
 *   개별보고와 수집이 ★서버 눈에 똑같이 생겼다★ — 둘 다 '60초 안에 2명 이상에게 뿌림'.
 *   요청 본문의 "각자 GD께 보고하세요" 는 meta 에 없어 서버가 못 읽는다. → ★개별보고에 독촉이 나간다.★
 *   (2026-07-17 demis 라이브: "5분 뒤 독촉 오면 무시하겠다" — 무시가 맞지만, 팀원이 룰을 뒤져
 *    추론해야 했다. ★알림 자체가 말해주면 추론이 필요 없다.★)
 *
 * ═══ 왜 플래그가 아닌가 ═══
 *   ★플래그로 판정하지 않는다★ (collectionDeadline.ts:22 — 기능을 지웠는데 플래그 지시문이 남아
 *   팀원이 오지 않을 번들을 영원히 기다렸다). 서버는 ★사실만★ 말하고 ★판단은 팀원이★ 한다(line 18).
 *   팀원은 자기가 개별보고를 시켰는지 ★안다.★
 */
/**
 * ★--individual — 뿌리는 순간 개별보고임을 알린다.★ (GD 2026-07-17)
 *
 * anyToGd 는 ★기여자의 답이 와야★ 켜진다 → 아무도 아직 안 답한 5분 시점엔 개별보고와 수집이
 * 서버 눈에 똑같다(둘 다 '2명 이상에게 뿌림') → ★개별보고가 독촉을 맞는다.★
 * 이 플래그는 그 창을 닫는다. 본문 해석이 아니라 meta 의 칸 하나다.
 *
 * ★--collect 의 전철을 안 밟는 이유★: 그건 룰이 플래그에 의존해(없으면 무한 대기) 고장났다.
 * 이건 안 붙여도 독촉 1회가 올 뿐이고 본문이 "개별보고면 무시" 라고 알려준다 = 계약이 아니라 최적화.
 */
describe("★--individual 플래그 — 뿌리는 순간 개별보고를 안다★", () => {
  let db: Database;
  beforeEach(() => { db = db0(); n = 0; });

  it("★individual 로 뿌리면 아무도 안 답해도 독촉 안 함★ (플래그 없으면 나가던 바로 그 상황)", () => {
    msg(db, "i1", "demis", "lui", 10, undefined, true);
    msg(db, "i1", "demis", "ames", 10, undefined, true);
    expect(findStalledCollections(db, [...AGENTS, { id: "lui" }, { id: "ames" }] as never)).toHaveLength(0);
  });

  it("★플래그 없으면 그대로 잡힌다★ — 대조군(이게 안 잡히면 위 테스트가 무의미)", () => {
    msg(db, "i2", "demis", "lui", 10);
    msg(db, "i2", "demis", "ames", 10);
    expect(findStalledCollections(db, [...AGENTS, { id: "lui" }, { id: "ames" }] as never)).toHaveLength(1);
  });

  /**
   * ★플래그 오남용 방어 — 사실이 힌트를 반박한다.★ (dbak 리뷰 2026-07-17)
   *
   *   --collect 와의 비교를 '없으면 고장나나' 축으로만 보면 놓친다. 축이 하나 더 있다 — ★잘못 붙이면?★
   *     · --collect 오남용    → 안 올 번들 무한대기
   *     · --individual 오남용 → backstop 사망 → collector 무한대기   ← ★실패 모양이 같다★
   *   오남용의 결말은 ★이 파일이 애초에 만들어진 그 사고★(steve 정지)와 정확히 같고 조용히 죽는다.
   *   → 기여자가 collector 에게 실제로 답하고 있다 = ★개별보고가 아니라는 관측된 사실★ → backstop 부활.
   */
  it("★individual 을 붙였어도 collector 에게 답이 오고 있으면 잡는다★ (오남용 → 무한대기 대신 부분보고 독촉)", () => {
    msg(db, "i4", "demis", "lui", 20, undefined, true);    // 습관적으로 --individual 을 붙였다
    msg(db, "i4", "demis", "ames", 20, undefined, true);
    msg(db, "i4", "lui", "demis", 18);                      // ★그런데 collector 에게 답이 왔다 = 개별보고가 아니다★
    // ames 는 안 옴 → 진짜로는 수집이었고, 플래그를 믿었으면 여기서 조용히 죽었다
    const st = findStalledCollections(db, [...AGENTS, { id: "lui" }, { id: "ames" }] as never);
    expect(st).toHaveLength(1);
    expect(st[0]!.missing).toEqual(["ames"]);
    expect(st[0]!.answered).toEqual(["lui"]);
  });

  it("★진짜 개별보고는 답이 GD·요청자로 가므로 계속 스킵된다★ (위 방어가 정상 케이스를 깨면 안 된다)", () => {
    msg(db, "i5", "demis", "lui", 20, undefined, true);
    msg(db, "i5", "demis", "ames", 20, undefined, true);
    msg(db, "i5", "lui", "demis", 18, "direct_to_gd");     // 개별보고 = GD 행 (collector 함에 안 쌓임)
    expect(findStalledCollections(db, [...AGENTS, { id: "lui" }, { id: "ames" }] as never)).toHaveLength(0);
  });

  it("★한계 명시: 오남용 + 아무도 안 답하면 여전히 조용히 스킵된다★ (완전 방어가 아님을 테스트로 박아둔다)", () => {
    msg(db, "i6", "demis", "lui", 20, undefined, true);
    msg(db, "i6", "demis", "ames", 20, undefined, true);
    // 답이 하나도 없다 → 사실이 반박할 게 없다 → 플래그를 믿는다
    expect(findStalledCollections(db, [...AGENTS, { id: "lui" }, { id: "ames" }] as never)).toHaveLength(0);
  });

  it("★진짜 수집은 플래그가 없으니 계속 잡힌다★ (backstop 이 죽으면 안 된다)", () => {
    msg(db, "i3", "bill", "hermes", 20);
    msg(db, "i3", "hermes", "steve", 19);
    msg(db, "i3", "hermes", "dbak", 19);
    msg(db, "i3", "steve", "hermes", 18);   // dbak 안 옴
    const st = findStalledCollections(db, AGENTS);
    expect(st).toHaveLength(1);
    expect(st[0]!.missing).toEqual(["dbak"]);
  });
});

describe("★독촉 본문 — 개별보고면 무시하라고 알림이 직접 말한다★", () => {
  /** 실 스키마 DB — 본문은 sweep 이 만든다. 소스 문자열이 아니라 ★실제 발송된 본문★ 을 본다.
   *  ★migrate() 를 쓴다 — schema.sql 만으로는 부족하다★: insertMessage 가 쓰는 parent_message_id 는
   *  schema.sql 에 없고 마이그레이션(migrate.ts:773)에서 붙는다. schema.sql 만 깔면 insert 가 던지고,
   *  sweep 의 catch 가 그걸 삼켜 ★woke=0 이 조용히 나온다★(디버깅에서 실제로 물렸다).
   *  (message.thread_id 는 thread(id) FK → 스레드를 먼저 만든다) */
  function dbReal(threads: string[]): Database {
    const d = new Database(":memory:");
    migrate(d);
    for (const t of threads) {
      d.run(`INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES (?, 't', 'dm', '[]', 'bill')`, [t]);
    }
    return d;
  }
  /** sweep 이 collector 에게 실제로 넣은 [마감] 본문 (없으면 null) */
  function sentBody(d: Database, collector: string): string | null {
    const r = d.prepare(
      `SELECT body FROM message WHERE from_agent_id='system' AND to_agent_id=? ORDER BY created_at DESC LIMIT 1`,
    ).get(collector) as { body: string } | undefined;
    return r?.body ?? null;
  }

  it("★개별보고 오탐: 아무도 아직 안 답했다 → 독촉은 나가되, 본문이 '개별보고면 무시' 를 알려준다★", () => {
    const d = dbReal(["tg-x"]);
    // demis 가 lui·ames 에게 뿌렸다(개별보고 위임). 10분 지나도록 ★아무도 안 답함★.
    // → anyToGd 는 아직 못 켜진다(답이 있어야 켜짐) → 서버는 수집과 구별 못 함 → 독촉 발사.
    msg(d, "tg-x", "demis", "lui", 10);
    msg(d, "tg-x", "demis", "ames", 10);
    const woke = sweepCollectionDeadlines(d, [...AGENTS, { id: "lui" }, { id: "ames" }] as never);
    expect(woke).toBe(1);                        // 오탐은 여전히 발사된다(서버는 못 가른다)
    const body = sentBody(d, "demis");
    expect(body).not.toBeNull();
    expect(body).toContain("지금까지 온 답으로 보고하세요"); // 기본 동작(무조건) 보존
    expect(body).toContain("이 알림은 무시하세요");          // ★탈출구 — 팀원이 룰을 뒤질 필요가 없다★
    // ★순서를 고정한다★ (dbak 리뷰 2026-07-17): 기본 동작이 ★먼저★, 탈출구는 ★예외로 뒤에★.
    //   미응답 분기는 ★진짜 수집이 가장 많이 지나는 분기★ 다. 탈출구가 첫 지시로 오면 무조건 명령이
    //   조건문으로 내려앉고, 애매한 팀원이 진짜 수집을 무시할 확률이 올라간다.
    //   (이 assert 가 없으면 순서를 되돌려도 toContain 은 그대로 통과해 ★회귀가 안 잡힌다★ — dbak 지적)
    expect(body!.indexOf("지금까지 온 답으로 보고하세요")).toBeLessThan(body!.indexOf("이 알림은 무시하세요"));
  });

  it("★진짜 수집(전원 답함, 종합 안 나감)에는 탈출구를 안 붙인다★ — 거기 붙이면 진짜 수집이 무시된다", () => {
    const d = dbReal(["tg-y"]);
    msg(d, "tg-y", "bill", "hermes", 20);   // 위임(요청자=bill)
    msg(d, "tg-y", "hermes", "steve", 19);  // 팬아웃
    msg(d, "tg-y", "hermes", "codex", 19);
    msg(d, "tg-y", "steve", "hermes", 18);  // 답 → collector 에게
    msg(d, "tg-y", "codex", "hermes", 18);  // 답 → collector 에게
    // 전원 답했는데 종합이 안 나갔다 → '전원답함' 분기
    const woke = sweepCollectionDeadlines(d, AGENTS);
    expect(woke).toBe(1);
    const body = sentBody(d, "hermes");
    expect(body).toContain("전원이 이미 답했습니다");
    expect(body).not.toContain("이 알림은 무시하세요");  // ★진짜 수집엔 탈출구 없음★
  });

  it("★기여자가 direct_to_gd 로 답하면 애초에 발사 자체가 없다★ (기존 anyToGd 스킵 — 회귀 확인)", () => {
    const d = dbReal(["tg-z"]);
    msg(d, "tg-z", "demis", "lui", 10);
    msg(d, "tg-z", "demis", "ames", 10);
    msg(d, "tg-z", "lui", "demis", 8, "direct_to_gd");  // 개별보고 = GD 행
    expect(sweepCollectionDeadlines(d, [...AGENTS, { id: "lui" }, { id: "ames" }] as never)).toBe(0);
    expect(sentBody(d, "demis")).toBeNull();
  });
});
