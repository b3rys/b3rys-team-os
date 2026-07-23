/**
 * ★마감 — 답이 안 오면 그때 상황으로 보고하게 깨운다.★ (GD 2026-07-13)
 *
 * ═══ 왜 필요한가 (팀장 라이브 테스트) ═══
 *   16:22:01  steve → demis / hermes / codex   팬아웃 3명
 *   16:23:13  demis → steve                    답
 *   16:24:01  codex → steve                    답
 *             hermes                            ★영영 안 옴★ (그 턴이 타임아웃으로 죽었다)
 *   → steve 는 ★아무 응답 없이 영원히 대기.★ 대기열 0건 — ★아무도 steve 를 다시 안 깨운다.★
 *
 * ★steve 는 룰을 지킨 것이다★ — "다 안 왔으면 종합하지 마라, 아무 말 안 해도 된다".
 * 그런데 ★다시 깨워주는 게 없으니 거기서 멈췄다.★ 팀장은 "스티브 응답 대기중" 만 본다.
 *
 * ═══ GD 원칙 ═══
 *   "5분/10분 정도 되면 그냥 ★그때 상황으로 응답★ 을 주면 될텐데 심플하게..
 *    문제는 ★그 다음 wake 되면 그거에 맞게 다시 응답★ 주면 되고. 오픈클로·헤르메스도 같은 원칙으로."
 *
 * → 서버는 ★"시간이 됐다" 만 알려준다.★ ★무엇을 보고할지는 팀원이 판단한다.★
 *   (룰이 이미 그걸 시킨다: "끝내 침묵하는 사람이 있으면 보고하고 누가 안 했는지 밝혀라")
 *
 * ═══ 판정은 ★관측 가능한 사실★ 로만 ═══
 *   ★플래그(--collect)로 판정하지 않는다.★ 그게 오늘 우리를 물었다 —
 *   기능을 지웠는데 플래그를 시키는 지시문이 남아 팀원이 오지 않을 번들을 영원히 기다렸다.
 *   여기서는 ★DB 에 실제로 일어난 일★ 만 본다:
 *     · 누가 collector 에게 뭔가 시켰다 (requester → collector)
 *     · collector 가 다른 팀원들에게 물었다 (collector → contributors, 같은 thread)
 *     · 그중 ★아직 답 안 한 사람★ 이 있다
 *     · 마지막 활동 이후 ★마감 시간이 지났다★
 *   → 그러면 깨운다. ★한 번만★ (같은 수집에 두 번 재촉하지 않는다)
 */
import type { Database } from "bun:sqlite";
import type { AgentRecord } from "../types";
import { insertMessage } from "../db/inboxQueries";
import { appendAudit } from "../db/queries";
import { appendAuditFile } from "../lib/auditFile";

/** 위임 후 이 시간이 지나도 종합이 안 나오면 collector 를 깨운다. */
export const COLLECTION_DEADLINE_MIN = Number(process.env.COLLECTION_DEADLINE_MIN ?? 5);
/** ★이보다 오래된 건 깨우지 않는다★ — 5분 마감인데 90분 뒤 재촉은 도움이 아니라 소음이다. */
export const MAX_DEADLINE_AGE_MIN = Number(process.env.MAX_DEADLINE_AGE_MIN ?? 60);

interface StalledCollection {
  threadId: string;
  collector: string;
  missing: string[];    // 아직 답 안 한 기여자
  answered: string[];   // 답한 기여자
  key: string;          // 중복 재촉 방지 키 (thread:collector:마지막팬아웃시각)
}

/**
 * ★막힌 수집★ — 여러 명에게 물어놓고, 마감이 지나도 아무 데도 보고를 안 한 것.
 *
 * ═══ ★요청자를 알아내려 하지 마라★ (내가 여기서 두 번 틀렸다) ═══
 *   ① thread+collector 로 묶었더니 ★200개 넘는 가짜 수집★ 을 찾아냈다.
 *      요청자(bill)를 '미응답 기여자' 로 세고, 배포했으면 ★전 팀원에게 마감 폭탄★ 이었다.
 *   ② 위임 메시지를 찾으려 했더니 ★답변을 위임으로 오인★ 했다 (방향만으론 구분이 안 된다).
 *   ③ 결정타: ★팀장이 단톡방에서 시킨 건 message 테이블에 아예 없다★ (텔레그램 캡처로 직접 주입).
 *      → 위임 행을 anchor 로 삼으면 ★정작 잡아야 할 케이스를 못 본다.★
 *
 *   ★요청자를 알 필요가 없다. collector 가 안다.★
 *   서버는 "시간이 됐다 + 누가 안 왔다" 만 말한다. 누구에게 보고할지는 팀원이 판단한다.
 *
 * ═══ 판정 = ★팬아웃 버스트★ (관측 가능한 사실만) ═══
 *   · collector 가 ★60초 안에 서로 다른 팀원 2명 이상★ 에게 directed 로 물었다 = 수집이다
 *     (한 명에게 보낸 건 그냥 답변일 수 있다 — 2명 이상이어야 '뿌린' 것이다)
 *   · 그중 아직 답 안 한 사람이 있다
 *   · collector 가 마지막 팬아웃 이후 ★기여자가 아닌 누군가에게★ 아무것도 안 보냈다 (=보고 안 함)
 *   · 마감 시간이 지났다
 *   → 깨운다. ★한 번만.★
 */
export function findStalledCollections(db: Database, agents: AgentRecord[]): StalledCollection[] {
  const ids = new Set(agents.map((a) => a.id));
  const collectors = [...ids];
  const out: StalledCollection[] = [];

  for (const C of collectors) {
    // 이 collector 가 최근 관여한 thread 들
    const threads = db
      .prepare(
        `SELECT DISTINCT thread_id FROM message
          WHERE from_agent_id = ? AND source='agent' AND created_at > datetime('now','-90 minutes')`,
      )
      .all(C) as { thread_id: string }[];

    for (const { thread_id } of threads) {
      // C 가 보낸 directed 메시지 (질문일 수도, 보고일 수도)
      const sends = db
        .prepare(
          `SELECT to_agent_id AS peer, created_at,
                  json_extract(meta_json,'$.individual') AS individual
             FROM message
            WHERE thread_id = ? AND from_agent_id = ? AND source='agent'
              AND to_agent_id IS NOT NULL AND to_agent_id NOT IN ('broadcast','user','system')
              AND to_agent_id <> ? AND created_at > datetime('now','-90 minutes')
            ORDER BY created_at`,
        )
        .all(thread_id, C, C) as { peer: string; created_at: string; individual: number | null }[];
      if (sends.length < 2) continue;

      // C 에게 들어온 메시지 (답·지시)
      // ★direct_to_gd 답은 제외한다★ (2026-07-15, GD) — 기여자가 `--to <collector>` 로 보냈어도
      //   reply_mode=direct_to_gd 면 그건 ★개별보고(GD 행)★ 지 collector 를 위한 수집 기여가 아니다.
      //   (2026-07-15 라이브: 서귀포 개별보고에서 hermes·codex 가 `--to steve --direct-to-gd` 로 보내자
      //    steve 가 '수집 collector' 로 오판돼 [마감] 독촉을 맞았다.) → direct_to_gd 는 '수집 답' 으로 안 센다.
      const inbound = db
        .prepare(
          `SELECT from_agent_id AS peer, created_at FROM message
            WHERE thread_id = ? AND to_agent_id = ? AND source='agent'
              AND created_at > datetime('now','-90 minutes')
              AND (json_extract(meta_json,'$.reply_mode') IS NULL
                   OR json_extract(meta_json,'$.reply_mode') != 'direct_to_gd')
            ORDER BY created_at`,
        )
        .all(thread_id, C) as { peer: string; created_at: string }[];

      // ★질문은 답보다 먼저 나간다.★ (이게 질문과 보고를 가르는 유일하게 믿을 수 있는 신호다)
      //   ★내가 여기서 세 번 틀렸다★:
      //   ① thread+collector 로 묶음 → 가짜 수집 200개 (요청자를 기여자로 셈 → ★마감 폭탄★)
      //   ② 위임 행을 anchor → ★팀장의 단톡방 지시는 message 테이블에 없다★ (캡처로 직접 주입)
      //   ③ "요청자는 먼저 말 건 사람" → 장수 그룹방에선 기여자도 예전에 말한 적이 있다 → ★0건★
      //   → ★버스트 = 답이 하나라도 들어오기 전에 연달아 나간 발신★. 보고는 답 뒤에 나온다.
      let burst: { peer: string; at: string; individual: number | null }[] = [];
      for (const s of sends) {
        const answeredBetween = burst.length > 0 &&
          inbound.some((i) => i.created_at > burst[0]!.at && i.created_at < s.created_at);
        if (answeredBetween) break;          // 답이 끼어들었다 → 여기부터는 보고다
        burst.push({ peer: s.peer, at: s.created_at, individual: s.individual });  // ★손에 있는 걸 버리지 않는다★ (dbak)
      }
      // ★요청자에게 보낸 ack 은 질문이 아니다★ — codex 는 팬아웃 ★전에★ 요청자에게 "확인했습니다" 를 보낸다.
      //   그러면 그 ack 이 버스트에 섞여 ★요청자가 '미응답 기여자'★ 로 잡힌다 (실측: 미응답=[bill]).
      //   ★요청자 = 버스트 직전에 collector 에게 들어온 메시지의 발신자.★ 그를 대상에서 뺀다.
      //   (팀장이 단톡방에서 시킨 경우는 그 행이 아예 없다 → 뺄 것도 없다. 그래서 그 케이스는 그대로 잡힌다)
      const firstAt = burst[0]!.at;
      // ★요청자는 ★버스트 기준★ 으로 찾는다 — 'now-90분' 윈도로 찾으면 안 된다.★ (2026-07-13 실측 오탐, dbak 이 잡았다)
      //   ═══ 무슨 일이 있었나 ═══
      //     18:14:54  bill  → dbak   위임
      //     18:15:03  dbak  → demis  질문     ┐ 같은 초
      //     18:15:03  dbak  → bill   ack      ┘
      //     18:15:26  demis → dbak   답
      //     18:15:34  dbak  → bill   ★종합 보고 (완료!)★
      //     19:44:54  system→ dbak   ★[마감] 미응답: bill★   ← 90분 뒤에, ★이미 끝난 수집에★
      //   ★90분 윈도의 시작이 정확히 18:14:54 를 지나가는 40초짜리 틈★ 에서:
      //     위임 행만 윈도 밖으로 밀려나고(★>★ 는 경계 배타) dbak 의 이후 메시지는 안에 남았다 →
      //     ① 요청자를 못 찾음 → ② ack("접수") 이 ★팬아웃 질문★ 으로 오인 → ③ bill 이 '기여자' 가 됨 →
      //     ④ bill 을 '미응답' 으로 고발 + ★bill 에게 간 진짜 종합이 '보고' 로 안 세짐★ (기여자에게 간 거라서).
      //   ★훼손된 시야로 판단하면 룰을 완벽히 지킨 팀원을 고발한다.★
      //   → 요청자 조회는 now 가 아니라 ★버스트 직전★ 을 기준으로 한다. 위임은 팬아웃 ★직전★ 에 오므로
      //     30분 lookback 이면 충분하고, 장수 그룹방에서 옛 메시지를 요청자로 오인할 위험도 막는다.
      const requester = (db
        .prepare(
          `SELECT from_agent_id AS peer FROM message
            WHERE thread_id = ? AND to_agent_id = ? AND source='agent'
              AND created_at <= ? AND created_at > datetime(?, '-30 minutes')
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(thread_id, C, firstAt, firstAt) as { peer: string } | null)?.peer;
      const targets = [...new Set(burst.map((b) => b.peer))].filter((t) => t !== requester);
      if (targets.length < 2) continue;      // ★2명 이상이어야 '뿌린' 것★

      const lastAsk = burst.at(-1)!.at;
      const minsSince = (db.prepare(`SELECT CAST((julianday('now') - julianday(?)) * 1440 AS INTEGER) AS m`)
        .get(lastAsk) as { m: number }).m;
      if (minsSince < COLLECTION_DEADLINE_MIN) continue;
      // ★너무 늦은 건 깨우지 않는다★ — 마감이 5분인데 ★90분 뒤에★ 재촉하는 건 도움이 아니라 소음이다.
      //   윈도 경계에서 시야가 훼손되는 구간이 바로 여기(윈도 끝자락)라서, 그 구간을 아예 안 쓴다.
      //   (정상 경로는 5분에 잡힌다. 여기까지 온 건 감지가 뭔가 놓친 것이다 → ★조용히 넘긴다★)
      if (minsSince > MAX_DEADLINE_AGE_MIN) continue;

      // 마지막 질문 이후 ★기여자가 아닌 누군가에게★ 보냈나 = 보고했다 (중간보고도 발신이다)
      //
      // ★sends 는 팀원에게 간 것만 본다★ — 그런데 보고는 ★팀장(user)·방(broadcast)★ 으로도 간다.
      //   실측(2026-07-13): codex 가 팀장께 직보(to='user')했는데 sends 에 안 잡혀 ★불필요한 재촉★ 6건.
      //   ★"보고했나" 는 수신자를 가리지 않는다.★ 기여자 아닌 ★어디로든★ 나갔으면 보고한 것이다.
      // 'gd' 리터럴에 대하여:
      //   아래 `IN ('user','broadcast','gd')` 의 'gd' 는 옛 owner agent-id 표기의 잔재다. 리포트는
      //   'user'(owner DM)·'broadcast'(방) 로 가고 이 둘이 실제 케이스를 다 커버하므로 'gd' 는
      //   매칭되지 않는 무해한 leftover다. 게다가 바로 아래 `NOT IN (targets)` 절이 '기여자가 아닌
      //   어디로든' 을 이미 잡으므로 'gd' 없이도 동작은 동일하다(하위호환을 위해 남겨 둠).
      const reportedElsewhere = (db
        .prepare(
          `SELECT COUNT(*) AS n FROM message
            WHERE thread_id = ? AND from_agent_id = ? AND created_at > ?
              AND (to_agent_id IS NULL
                   OR to_agent_id IN ('user','broadcast','gd')
                   OR to_agent_id NOT IN (${targets.map(() => "?").join(",")}))`,
        )
        .get(thread_id, C, lastAsk, ...targets) as { n: number }).n;
      if (reportedElsewhere > 0) continue;

      const missing: string[] = [];
      const answered: string[] = [];
      // ★'누구에게' 답했는지가 두 패턴을 가른다★ — collector 에게 답했으면 종합을 기다리는 것이고,
      //   ★요청자에게 직접 답했으면 그건 개별보고다 (종합이 필요 없다).★
      const answeredToCollector: string[] = [];
      let anyToGd = false;   // 기여자 중 하나라도 direct_to_gd 로 답하면 = 개별보고 → backstop 통째 스킵
      for (const t of targets) {
        const askedAt = burst.filter((b) => b.peer === t).at(-1)!.at;
        // ★답했나★ = collector 에게 보냈거나, ★요청자에게 직접 보냈거나★.
        //   '각자 직접 보고해라' 패턴에선 기여자가 ★collector 가 아니라 요청자에게★ 답한다.
        //   그걸 '미응답' 으로 읽으면 멀쩡한 개별보고를 막힌 수집으로 오인한다(실측).
        const toCollector = inbound.some((i) => i.peer === t && i.created_at > askedAt);
        const toRequester = requester
          ? (db.prepare(
              `SELECT COUNT(*) AS n FROM message
                WHERE thread_id = ? AND from_agent_id = ? AND to_agent_id = ? AND created_at > ?`)
              .get(thread_id, t, requester, askedAt) as { n: number }).n > 0
          : false;
        // ★direct_to_gd 로 답한 것도 '답함' 이다 — ★개별보고(GD 행)★.★ (2026-07-15, GD)
        //   기여자가 `--to <collector> --direct-to-gd` 로 보내면 목적지는 GD 다(inbound 에선 이미 제외됨).
        //   이걸 '답함' 으로 안 세면 → missing 으로 잡혀 ★"안 왔다" 독촉★ 이 나간다 (서귀포 오탐의 다른 얼굴).
        //   → answered 에는 넣되(=안 왔다 아님), answeredToCollector 에는 ★안 넣는다★(=종합 대상 아님) → 개별보고로 판정돼 발사 안 됨.
        const toGd = (db.prepare(
              `SELECT COUNT(*) AS n FROM message
                WHERE thread_id = ? AND from_agent_id = ? AND created_at > ?
                  AND json_extract(meta_json,'$.reply_mode') = 'direct_to_gd'`)
              .get(thread_id, t, askedAt) as { n: number }).n > 0;
        if (toCollector) answeredToCollector.push(t);
        if (toGd) anyToGd = true;
        (toCollector || toRequester || toGd ? answered : missing).push(t);
      }
      // ★개별보고면 전원/일부 무관하게 통째 스킵★ (2026-07-15 ①, GD) — 기여자가 direct_to_gd 로 GD께 답하기
      //   시작하면 이건 '개별보고' 다. collector 는 종합할 게 없다. 그런데 옛 narrowing 은 '전원 답함' 분기에만
      //   스킵을 넣어, 일부 미응답(다른 기여자가 늦음)이면 여전히 "missing: X" 독촉이 나갔다(라이브 dbak 오탐).
      //   → direct_to_gd 답이 하나라도 있으면 개별보고 확정 → 어느 분기든 깨우지 않는다.
      if (anyToGd) continue;

      // ★--individual = 확정이 아니라 '사실로 반박 가능한 힌트' 다.★ (dbak 리뷰 2026-07-17, GD 지시로 도입)
      //
      //   위임자가 `send.sh --individual` 로 뿌렸다 = "각자 GD께 직접 보고해라". 종합할 사람이 없으니 안 깨운다.
      //   ★meta 의 칸 하나만 본다 — 본문은 안 읽는다★ (본문의 "각자 보고하세요" 를 서버는 못 읽는다).
      //   이게 닫는 창: anyToGd 는 ★답이 와야★ 켜지므로 아무도 안 답한 5분 시점엔 개별보고와 수집이
      //   서버 눈에 똑같다(둘 다 '2명 이상에게 뿌림') → 개별보고가 독촉을 맞았다.
      //
      //   ═══ ★그런데 무조건 믿으면 안 된다★ (dbak 이 잡은 축) ═══
      //     --collect 와 비교할 때 '없으면 고장나나' 축만 봤다. 축이 하나 더 있다 — ★잘못 붙이면?★
      //       · --collect 오남용    → 안 올 번들 무한대기
      //       · --individual 오남용 → backstop 사망 → collector 무한대기
      //     ★실패 모양이 같다.★ 플래그는 실패를 없앤 게 아니라 '누락' 에서 '오남용' 으로 옮겼을 뿐이다.
      //     그리고 오남용의 결말은 ★이 파일이 애초에 만들어진 그 사고★(steve 가 hermes 답을 영영 못 받고
      //     정지)와 정확히 같다. 조용히 죽어서 발견도 안 된다.
      //
      //   ═══ 그래서 이 파일 자신의 원칙을 적용한다 (line 21-29 ★판정은 관측 가능한 사실로만★) ═══
      //     ★기여자가 collector 에게 실제로 답하고 있다 = 개별보고가 아니라는 관측된 증거다.★
      //     (진짜 개별보고면 기여자는 direct_to_gd 나 요청자에게 답한다 — 둘 다 answeredToCollector 에 안 쌓인다)
      //     → 플래그는 ★collector 에게 답이 하나도 안 왔을 때만★ 믿는다. 사실이 반박하면 backstop 이 되살아난다.
      //
      //   실패 등급이 내려간다:
      //     · 오남용 + 답이 오는 중 → backstop 부활 → 부분보고 독촉 (무한대기 아님)
      //     · 진짜 개별보고인데 누가 착각하고 collector 에게 답함 → 독촉 1회 + 본문 탈출구 = 안전한 실패
      //   ★한계(명시)★: 오남용 + 아무도 안 답함 = 여전히 조용히 스킵. ★완전 방어가 아니다.★
      //     다만 실측 사고(steve 건)는 2명 답 + 1명 미응답이었으므로 다수 케이스는 덮는다.
      if (burst.some((b) => b.individual) && answeredToCollector.length === 0) continue;
      // ★"다 왔는데 종합이 안 나갔다" — 여기서 그냥 넘겼다. 그게 구멍이었다.★ (2026-07-14 실측)
      //
      // ═══ 실측: codex 가 35분째 멈췄다 ═══
      //   09:31:24  codex → steve·hermes   팬아웃
      //   09:31:43  codex → hermes         ★"의견 반영 완료" (ack)★
      //   09:32:32  steve → codex          입력 도착 → ★이 wake 가 codex 의 마지막 기회였다★
      //   09:32:48  codex → steve          ★"입력 반영 완료" (또 ack) — 종합 대신 ack 으로 턴을 끝냈다★
      //   그 뒤로 ★아무도 codex 를 다시 안 깨운다.★ 팀장은 영원히 기다린다.
      //
      // ★옛 주석: "다 왔는데 보고 안 한 건 침묵 룰 소관" — ★그런데 룰은 아무도 깨우지 않는다.★★
      //   ★한 턴짜리 런타임은 다음 순간의 자기가 없다.★ 깨워주지 않으면 그걸로 끝이다.
      //   ★팀장 기준: "답이 영영 안 옴" = 의도하지 않은 결과 → 시스템이 잡는다.★
      //
      // (여기 도달했다는 건 이미 reportedElsewhere === 0 을 통과했다는 뜻 = ★보고가 정말 안 나갔다★)
      if (missing.length === 0) {
        // ★전원 답했다 — 그런데 종합이 안 나갔다.★ 이때만 깨운다.
        //   ★단, 기여자가 ★요청자에게 직접★ 답한 거라면 그건 개별보고다 — ★종합이 필요 없다.★★
        //   (팀장이 "각자 나에게 직접 보고해" 라고 시킨 것. 여기서 깨우면 멀쩡한 걸 재촉하는 것)
        //   → ★collector 에게 답한 사람이 전원일 때만★ "종합을 보내라" 고 깨운다.
        if (answeredToCollector.length !== targets.length) continue;
      }

      out.push({ threadId: thread_id, collector: C, missing, answered, key: `${thread_id}:${C}:${lastAsk}` });
    }
  }
  return out;
}

/**
 * 막힌 수집의 collector 를 ★한 번★ 깨운다.
 * ★무엇을 보고할지는 안 정해준다★ — "시간이 됐다 + 누가 안 왔다" 만 알려주고 판단은 팀원이 한다.
 */
export function sweepCollectionDeadlines(db: Database, agents: AgentRecord[]): number {
  let woke = 0;
  for (const c of findStalledCollections(db, agents)) {
    try {
      // ★하드캡 — 감지가 틀려도 스팸이 되면 안 된다.★ (2026-07-13 사고: steve 를 ★47번★ 재촉했다)
      //   dedupe_key 는 못 믿는다 — ★insertMessage 는 dedupe 를 하지 않는다★ (명시 체크가 필요하다).
      //   ★audit 을 진실의 원천으로 쓴다★: 이 수집을 이미 깨웠으면 두 번 다시 안 깨운다.
      //   ★감지 로직이 아무리 틀려도 수집 하나당 최대 1회.★ 그게 스팸을 구조적으로 불가능하게 한다.
      const key = `collect-deadline:${c.key}`;
      const already = (db
        .prepare(
          `SELECT COUNT(*) AS n FROM audit_event
            WHERE action = 'collection_deadline_woke'
              AND json_extract(detail_json, '$.key') = ?`,
        )
        .get(key) as { n: number }).n;
      if (already > 0) continue;   // ★수집 하나당 한 번만 — 예외 없다★

      // ★두 상황은 다르다 — 다르게 말해줘야 팀원이 옳게 판단한다.★
      const body = c.missing.length === 0
        // ★전원 답했는데 종합이 안 나갔다★ (실측: collector 가 ack 으로 마지막 턴을 써버렸다)
        ? `[마감] ${COLLECTION_DEADLINE_MIN}분이 지났는데 아직 보고가 없습니다. ` +
          `★${c.answered.join(", ")} 전원이 이미 답했습니다.★ ` +
          // ★훈계는 뺀다★ (GD: "이건 빼도 되지 않아?") — 서버는 ★"시간이 됐다 + 지금 상황"★ 만 말한다.
          //   "ack 은 보고가 아니다" 는 ★이미 룰에 있다.★ 시스템 알림이 룰을 다시 읊을 이유가 없다.
          `★지금 종합해서 요청자에게 보내세요.★`
        : `[마감] ${COLLECTION_DEADLINE_MIN}분이 지났는데 아직 보고가 없습니다. ` +
          `미응답: ${c.missing.join(", ")}` +
          (c.answered.length ? ` / 답함: ${c.answered.join(", ")}` : "") +
          // ★개별보고면 이 알림 자체가 틀린 것이다 — 그런데 서버는 아직 그걸 알 수가 없다.★ (GD 2026-07-17)
          //   위 anyToGd 판정은 ★기여자가 direct_to_gd 로 답해야★ 켜진다. 아무도 아직 안 답한 5분 시점엔
          //   개별보고와 수집이 ★서버 눈에 똑같이 생겼다★ — 둘 다 '60초 안에 2명 이상에게 뿌림' 이다.
          //   요청 본문의 "각자 GD께 직접 보고하세요" 는 meta 에 없어서 서버가 못 읽는다.
          //   → ★플래그를 새로 만들지 않는다(line 22 의 교훈).★ 대신 ★사실만 말하고 판단은 팀원이 한다(line 18).★
          //   ★★이 탈출구 문구를 빼지 마라 — `--individual` 의 선택성이 여기 얹혀 있다.★★ (dbak 리뷰 2026-07-17)
          //     "--individual 은 안 붙여도 안 깨진다(=계약이 아니라 최적화)" 가 참인 ★유일한 이유★ 가 이 문구다.
          //     이걸 노이즈로 보고 빼면 --individual 이 조용히 ★필수 플래그로 승격★ 된다(안 붙이면 탈출구 없는
          //     독촉 → 원래 혼란 복귀). 그건 --collect 가 팀을 물었던 바로 그 구조다.
          //     팀원은 자기가 개별보고를 시켰는지 ★안다.★ 서버가 못 가르는 걸 팀원은 가른다.
          //     (2026-07-17 demis 라이브: 개별보고 위임 후 "5분 뒤 독촉 오면 무시하겠다" — 무시가 맞다.
          //      그런데 그걸 ★알림 자체가 말해줘야★ 팀원이 룰을 뒤져 추론하지 않는다.)
          //   ★순서가 중요하다 — 기본 동작이 먼저, 탈출구는 예외로.★ (dbak 리뷰 2026-07-17)
          //     미응답 분기는 ★이 기능이 원래 잡으려던 케이스★ 가 착지하는 곳이다(steve 가 hermes 답을
          //     영영 못 받고 정지). 즉 ★진짜 수집 트래픽이 가장 많이 지나는 분기★ 다(전원답함이 오히려 희귀).
          //     첫 버전은 '무시하세요' 를 앞에 둬서 ★무조건 명령을 조건문으로★ 바꿨다 — collector 가 처음
          //     읽는 지시가 탈출구가 되면, 애매한 상태의 팀원이 진짜 수집을 무시할 확률이 올라간다.
          //     → 기본 동작은 ★무조건★ 으로 두고, 탈출구는 ★괄호 예외★ 로 내린다.
          `. ★지금까지 온 답으로 보고하세요★ — 안 온 사람은 '미응답' 이라고 명시하면 됩니다. ` +
          `(각자 GD께 직접 보고하도록 시킨 건이면 종합할 게 없으니 이 알림은 무시하세요.) ` +
          `(늦게 답이 오면 그때 다시 깨워드립니다. 그때 상황에 맞게 응답하시면 됩니다)`;

      const msg = insertMessage(db, {
        thread_id: c.threadId,
        from_agent_id: "system",
        to_agent_id: c.collector,
        // ★알림이 "누구 일인지" 를 실어 보낸다★ — 수집자의 종합은 ★수집을 시킨 사람★ 에게 간다.
        //   이게 없으면 디스패처가 "보낸 사람(system)에게 답해라" 라고 한다 → ★--to system = 블랙홀★.
        type: "dm",
        body,
        source: "system",
        hop_count: 0,
        priority: "high",
        dedupe_key: key,
      } as Parameters<typeof insertMessage>[1]);

      appendAudit(db, "bus_dispatcher", "collection_deadline_woke", msg.id, {
        key,   // ★하드캡의 진실의 원천★ — 이게 없으면 위 체크가 영영 0을 반환해 무한 발사된다
        thread_id: c.threadId, collector: c.collector, missing: c.missing, answered: c.answered,
      });
      woke++;
    } catch (e) {
      appendAuditFile("bus_dispatcher", "collection_deadline_failed", null, {
        thread_id: c.threadId, collector: c.collector,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return woke;
}
