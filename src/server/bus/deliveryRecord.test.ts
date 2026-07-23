// ★배달 기록 — "서버가 무엇을, 누구에게, 실제로 내보냈는가".★ (2026-07-12)
//
// 이 기록이 없어서 우리는 ★검증할 수 없는 것을 하루 종일 고치고 있었다★:
//   · "팀원은 분명히 답했는데 종합에서 빠졌다" → ★종합 본문이 DB 에 없으니 확인할 방법이 없었다★
//   · "종합이 정확히 1번 갔나"                  → 버스에 남은 건 ★중간 ack★ 일 수도 있는데 구별할 수 없었다
// ★관측할 수 없으면 검증할 수 없다.★
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { recordReportDelivery, maskSecrets, previewOf, DELIVERED, DELIVERY_FAILED } from "./deliveryRecord";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}
const audits = (db: Database) =>
  db.prepare(`SELECT actor, action, target, detail_json FROM audit_event ORDER BY id`).all() as Array<{
    actor: string; action: string; target: string | null; detail_json: string;
  }>;

describe("배달 기록 — 무엇을 누구에게 보냈나", () => {
  test("★본문(preview)이 남는다★ — 이게 이 기록의 존재 이유다", () => {
    const db = freshDb();
    recordReportDelivery(db, {
      actor: "hermes", channel: "telegram_dm", recipient: "gd", threadId: "t1", refId: "m1",
      body: "steve: 가을 / dbak: 봄. 미응답: forin", ok: true,
    });
    const a = audits(db);
    expect(a).toHaveLength(1);
    expect(a[0]!.action).toBe(DELIVERED);
    const d = JSON.parse(a[0]!.detail_json);
    expect(d.body_preview).toContain("가을");   // ★팀원 답이 종합에 담겼는지 확인 가능★
    expect(d.body_preview).toContain("forin");  // ★미응답자가 명시됐는지 확인 가능★
    expect(d.to).toBe("gd");
    expect(d.channel).toBe("telegram_dm");
    expect(d.thread_id).toBe("t1");
  });

  test("★배달 실패도 남긴다★ — 조용히 흘리면 collector 는 '보냈다'고 믿고 팀장은 못 받는다", () => {
    const db = freshDb();
    recordReportDelivery(db, {
      actor: "codex", channel: "telegram_group", recipient: "-100123", threadId: "tg-1", refId: "m2",
      body: "종합", ok: false, error: "telegram_send_failed",
    });
    const a = audits(db);
    expect(a[0]!.action).toBe(DELIVERY_FAILED);
    expect(JSON.parse(a[0]!.detail_json).error).toBe("telegram_send_failed");
  });

  test("성공과 실패는 ★다른 액션★이다 (실패를 성공으로 뭉개지 않는다)", () => {
    expect(DELIVERED).not.toBe(DELIVERY_FAILED);
  });

  test("세 경로가 ★같은 액션★으로 남는다 — 수트가 한 곳에서 조회할 수 있어야 한다", () => {
    const db = freshDb();
    for (const ch of ["telegram_dm", "telegram_group", "bus"] as const) {
      recordReportDelivery(db, { actor: "hermes", channel: ch, recipient: "gd", threadId: "t", refId: null, body: "x", ok: true });
    }
    const n = db.prepare(`SELECT COUNT(*) n FROM audit_event WHERE action=?`).get(DELIVERED) as { n: number };
    expect(n.n).toBe(3);
    const chans = audits(db).map((r) => JSON.parse(r.detail_json).channel).sort();
    expect(chans).toEqual(["bus", "telegram_dm", "telegram_group"]);
  });
});

describe("★시크릿 마스킹★ — 감사로그는 오래 남는다. 토큰이 본문에 섞이면 영구 기록된다", () => {
  test("봇 토큰 · Slack · GitHub · API 키 · JWT · AWS", () => {
    const dirty = [
      "봇토큰 123456789:AAHfake_Token_Value_abcdefghijklmnop 입니다",
      "slack xoxb-1234567890-abcdefghijkl",
      "gh ghp_abcdefghijklmnopqrstuvwxyz0123",
      "openai sk-abcdefghijklmnopqrstuvwxyz12",
      "aws AKIAIOSFODNN7EXAMPLE",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef",
    ].join("\n");
    const clean = maskSecrets(dirty);
    expect(clean).not.toContain("AAHfake_Token_Value");
    expect(clean).not.toContain("xoxb-1234567890");
    expect(clean).not.toContain("ghp_abcdefghijklmnop");
    expect(clean).not.toContain("sk-abcdefghijklmnop");
    expect(clean).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(clean).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(clean).toContain("[REDACTED_BOT_TOKEN]");
  });

  test("'KEY=값' 꼴 (env 를 통째로 붙여넣는 경우)", () => {
    const clean = maskSecrets("TELEGRAM_BOT_TOKEN=abc123secret\nAPI_KEY: zzz999\n정상 문장은 남는다");
    expect(clean).not.toContain("abc123secret");
    expect(clean).not.toContain("zzz999");
    expect(clean).toContain("정상 문장은 남는다"); // ★내용은 지우지 않는다 — 검증에 필요하다★
  });

  test("★평범한 본문은 안 건드린다★ (과잉 마스킹은 검증을 무력화한다)", () => {
    const body = "steve: 가을이요. dbak: 봄입니다. 미응답: forin (질문 미전달)";
    expect(maskSecrets(body)).toBe(body);
  });

  test("★길이 제한★ — DB 를 본문 저장소로 만들지 않는다 (못 잡는 시크릿이 있다는 전제)", () => {
    const long = "가".repeat(5000);
    expect(previewOf(long).length).toBeLessThan(2000);
    expect(previewOf(long)).toContain("생략");
  });

  test("기록된 preview 에도 마스킹이 적용된다 (경로가 아니라 저장 시점에 막는다)", () => {
    const db = freshDb();
    recordReportDelivery(db, {
      actor: "hermes", channel: "bus", recipient: "bill", threadId: "t", refId: "m",
      body: "결과입니다. TOKEN=supersecret123", ok: true,
    });
    expect(JSON.parse(audits(db)[0]!.detail_json).body_preview).not.toContain("supersecret123");
  });
});

describe("★fail-soft★ — 관측이 통신을 죽이면 안 된다", () => {
  test("DB 가 깨져 있어도 ★throw 하지 않는다★ (발송은 이미 됐거나 될 것이다)", () => {
    const db = new Database(":memory:"); // migrate 안 함 → audit_event 테이블 없음
    expect(() =>
      recordReportDelivery(db, {
        actor: "hermes", channel: "bus", recipient: "gd", threadId: "t", refId: "m", body: "x", ok: true,
      }),
    ).not.toThrow();
  });
});

// ★thread_id 는 '어느 위임의 답인가' 를 연결하는 키다.★ (2026-07-12 — 수트 배선 중 라이브에서 발견)
//
// direct_to_gd 는 ★목적지가 팀장 DM thread★ 다. 그걸 thread_id 로 쓰면 그 종합이 ★어느 위임의 답인지
// 연결할 수 없다★ — 실제로 라이브 기록이 ʼdm-1000000001ʼ 로 찍혀 원 위임(ʼdlv2-dm-...ʼ)과 끊겼다.
// ★수트도 사람도 추적을 잃는다.★ 목적지는 dest_thread 로 따로 남긴다.
describe("★thread_id = 원 위임 thread★ (목적지가 아니다 — 추적의 키다)", () => {
  test("direct_to_gd 여도 thread_id 는 ★원 위임 thread★, 목적지는 dest_thread", () => {
    const db = freshDb();
    recordReportDelivery(db, {
      actor: "hermes", channel: "telegram_dm", recipient: "gd",
      threadId: "task-42",          // ★위임이 오간 곳★
      destThread: "dm-70668",       // 실제 배달된 곳(팀장 DM)
      refId: "m1", body: "종합", ok: true,
    });
    const d = JSON.parse(
      (db.prepare(`SELECT detail_json FROM audit_event ORDER BY id DESC LIMIT 1`).get() as { detail_json: string }).detail_json,
    );
    expect(d.thread_id).toBe("task-42");   // ★이걸로 위임과 연결한다★
    expect(d.dest_thread).toBe("dm-70668"); // 목적지는 관측용
  });

  test("dest_thread 가 없으면 키에 안 넣는다 (버스·그룹 경로는 목적지가 곧 그 thread)", () => {
    const db = freshDb();
    recordReportDelivery(db, {
      actor: "hermes", channel: "bus", recipient: "bill", threadId: "task-7", refId: "m", body: "x", ok: true,
    });
    const d = JSON.parse(
      (db.prepare(`SELECT detail_json FROM audit_event ORDER BY id DESC LIMIT 1`).get() as { detail_json: string }).detail_json,
    );
    expect(d.thread_id).toBe("task-7");
    expect(d.dest_thread).toBeUndefined();
  });
});
