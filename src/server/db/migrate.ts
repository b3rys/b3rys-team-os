import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function openDb(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function migrate(db: Database): void {
  const schemaPath = join(__dirname, "schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");
  db.exec(schema);
  widenAgentRuntimeChecks(db);
  widenSearchSourceTypes(db);
  runBusMigration(db);
  migrateCodexRuntimeState(db);
  migrateSchedulerState(db);
  migrateDmCapture(db);
  migratePendingFollowup(db);
  migrateGdReportFlag(db);
  migrateTeamCollect(db);
  // 팀원 SVG 아이콘 컬럼(2026-06-08 OWNER): 기존 DB에 idempotent 추가.
  try {
    db.exec("ALTER TABLE agent ADD COLUMN icon TEXT");
  } catch {
    /* 이미 존재 */
  }
  // 그룹 owner 영속화(2026-06-05 OWNER): 재시작에도 owner 유지. 단일 작은 행(thread_id='group').
  db.exec(
    `CREATE TABLE IF NOT EXISTS group_owner (
       thread_id TEXT PRIMARY KEY,
       owner_ids_json TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
  );
  // 승인 큐(2026-06-10 OWNER): OWNER 승인이 필요한 권한 액션(런타임 활성화·게이트웨이 재시작 등)을
  // 큐에 쌓아 팀방 /menu·대시보드에서 PIN 승인 → 서버 실행(터미널 0). status 흐름:
  // pending → approved → executing → done|failed / rejected|expired. params_json·result 는 TEXT.
  db.exec(
    `CREATE TABLE IF NOT EXISTS approval_request (
       id TEXT PRIMARY KEY,
       action_key TEXT NOT NULL,
       params_json TEXT NOT NULL DEFAULT '{}',
       title TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'pending'
         CHECK(status IN ('pending','approved','executing','done','failed','rejected','expired','deferred')),
       requested_by TEXT NOT NULL DEFAULT 'system',
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       decided_at TEXT,
       result TEXT
     )`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_request(status, created_at DESC)");
  // 승인 시스템 v2(2026-07-08 OWNER): 10분 미승인 자동 '보류(deferred)'. 기존 DB는 CHECK에 'deferred'가
  // 없으니(위 CREATE는 IF NOT EXISTS라 기존 테이블 안 바꿈) 1회 재빌드로 enum 확장.
  migrateApprovalDeferredStatus(db);

  // Cross-runtime permission gate (2026-07-05): runtime permission requests use their own
  // table so the existing action approval queue remains whitelist-only.
  db.exec(
    `CREATE TABLE IF NOT EXISTS permission_request (
       id TEXT PRIMARY KEY,
       scope_key TEXT NOT NULL,
       runtime TEXT NOT NULL,
       agent_id TEXT,
       action TEXT NOT NULL,
       target TEXT NOT NULL,
       payload_json TEXT NOT NULL DEFAULT '{}',
       status TEXT NOT NULL DEFAULT 'pending'
         CHECK(status IN ('pending','allowed_once','allowed_always','denied','expired')),
       requested_by TEXT NOT NULL DEFAULT 'system',
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       decided_at TEXT,
       approver TEXT,
       provenance_json TEXT
     )`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_permission_request_status ON permission_request(status, created_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_permission_request_scope ON permission_request(scope_key, status, created_at DESC)");
  db.exec(
    `CREATE TABLE IF NOT EXISTS permission_grant (
       id TEXT PRIMARY KEY,
       scope_key TEXT NOT NULL UNIQUE,
       runtime TEXT NOT NULL,
       agent_id TEXT,
       action TEXT NOT NULL,
       target TEXT NOT NULL,
       approver TEXT NOT NULL,
       provenance_json TEXT NOT NULL DEFAULT '{}',
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       expires_at TEXT
     )`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_permission_grant_scope ON permission_grant(scope_key, expires_at)");
  db.exec(
    `CREATE TABLE IF NOT EXISTS perm_request_audit (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       request_id TEXT,
       scope_key TEXT NOT NULL,
       runtime TEXT NOT NULL,
       agent_id TEXT,
       action TEXT NOT NULL,
       target TEXT NOT NULL,
       decision TEXT NOT NULL,
       approver TEXT,
       provenance_json TEXT NOT NULL DEFAULT '{}',
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_perm_request_audit_request ON perm_request_audit(request_id, created_at DESC)");

  // ── Team Self-Loop Governance — Proposal 시스템 (Bill+Codex 설계 + 5명 팀 얼라인, 2026-06-12) ──
  //   루프=제안 생성 엔진(실행X). 파이프라인: draft→peer_review(단일 review)→gd_report→accepted/rejected.
  //   품질 하한선(evidence 필수)·dedup(duplicate_of)·북극성 정렬(north_star_alignment)·반대리뷰(is_adversarial) 데이터모델에 강제.
  db.exec(
    `CREATE TABLE IF NOT EXISTS proposal (
       id TEXT PRIMARY KEY,
       title TEXT NOT NULL,
       summary TEXT NOT NULL,
       body TEXT,
       source TEXT NOT NULL DEFAULT 'loop',
       proposer_agent TEXT NOT NULL,
       author_agent TEXT,
       status TEXT NOT NULL DEFAULT 'draft'
         CHECK(status IN ('draft','peer_review','pm_review','gd_report','accepted','rejected','revise_requested','archived_duplicate')),
       priority TEXT,
       effort_minutes INTEGER,
       expected_value TEXT,
       risk_level TEXT,
       evidence_refs TEXT,
       north_star_alignment TEXT,
       duplicate_of TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_proposal_status ON proposal(status, updated_at DESC)");
  addColumnIfMissing(db, "proposal", "body", "TEXT");
  addColumnIfMissing(db, "proposal", "author_agent", "TEXT");
  // 승인 후 실행 유형(OWNER 2026-07-04): skill/rule/task/other. 생성 시 지정 또는 제목 태그에서 파생.
  addColumnIfMissing(db, "proposal", "type", "TEXT");
  db.exec("UPDATE proposal SET author_agent = proposer_agent WHERE author_agent IS NULL OR trim(author_agent) = ''");
  db.exec(
    `CREATE TABLE IF NOT EXISTS proposal_review (
       id TEXT PRIMARY KEY,
       proposal_id TEXT NOT NULL,
       reviewer_agent TEXT NOT NULL,
       stage TEXT NOT NULL CHECK(stage IN ('peer','pm','owner')),
       verdict TEXT CHECK(verdict IN ('approve','reject','concern','revise')),
       is_adversarial INTEGER NOT NULL DEFAULT 0,
       comments TEXT,
       required_changes TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_proposal_review_pid ON proposal_review(proposal_id, created_at)");
  db.exec(
    `CREATE TABLE IF NOT EXISTS proposal_decision_log (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       proposal_id TEXT NOT NULL,
       actor TEXT NOT NULL,
       action TEXT NOT NULL,
       from_status TEXT,
       to_status TEXT,
       reason TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_proposal_decision_pid ON proposal_decision_log(proposal_id, id)");
  db.exec(
    `CREATE TABLE IF NOT EXISTS proposal_followup_task (
       task_id TEXT PRIMARY KEY,
       proposal_id TEXT NOT NULL,
       status TEXT NOT NULL,
       owner TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       closed_at TEXT
     )`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_proposal_followup_open ON proposal_followup_task(proposal_id, status, closed_at)");
  // Proposal 자동화 멱등 레이어(2026-07-04, OWNER 지시 · codex/gemini 교차검토).
  //   자동 전이/알림의 부수효과 중복 방지: action_key(PK unique)를 실행 전 insert 시도해
  //   이미 있으면(중복) skip. sweeper·이벤트 승격이 동시에 같은 전이를 밀어도 1회만 발생.
  //   advanceProposalIfCurrent(db/proposal.ts)가 이 테이블만 통해 자동 액션을 게이트한다.
  db.exec(
    `CREATE TABLE IF NOT EXISTS proposal_automation_action (
       action_key TEXT PRIMARY KEY,
       proposal_id TEXT NOT NULL,
       kind TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_proposal_automation_pid ON proposal_automation_action(proposal_id, created_at)");
  // b3os_native M1.5: 재시작 턴 복구용 처리중 마커. 턴 START에 행 기록 → 정상 종료 시 삭제.
  // 크래시로 남은 행은 부팅·주기 sweep(recoverB3osNativeInflight)이 재처리. blast radius 격리
  // (공유 디스패처 상태기계 무수정 — 부팅/주기 훅 호출만 추가).
  db.exec(
    `CREATE TABLE IF NOT EXISTS b3os_native_inflight (
       message_id TEXT NOT NULL,
       agent_id   TEXT NOT NULL,
       thread_id  TEXT NOT NULL,
       started_at TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY (message_id, agent_id)
     )`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_b3os_native_inflight_started ON b3os_native_inflight(started_at)");
  // 받는이-단일화 backfill (2026-06-13 OWNER 데이터모델 정리): inboxFor 를 message_recipient 단일
  // 기준으로 통일하기 위해, 받는이 행이 없는 옛 1:1 메시지에 행을 채운다. recipientStateBackfill
  // (runBusMigration 안, 위에서 이미 실행됨) 이후라 그 일회성 backfill 이 여기서 만든 행을 다시
  // 건드리지 않는다.
  directedRecipientRowBackfill(db);
}

export function migrateCodexRuntimeState(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS codex_session_map (
       agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
       surface TEXT NOT NULL,
       conversation_key TEXT NOT NULL,
       codex_session_id TEXT NOT NULL,
       last_message_id TEXT,
       last_task_id TEXT,
       updated_at TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY (agent_id, surface, conversation_key)
     )`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_codex_session_updated ON codex_session_map(updated_at DESC)");
  db.exec(
    `CREATE TABLE IF NOT EXISTS codex_run_artifact (
       id TEXT PRIMARY KEY,
       agent_id TEXT NOT NULL,
       message_id TEXT NOT NULL,
       thread_id TEXT NOT NULL,
       task_id TEXT,
       codex_session_id TEXT,
       status TEXT NOT NULL CHECK(status IN ('started','succeeded','failed','timed_out','deduped')),
       elapsed_ms INTEGER,
       reply_message_id TEXT,
       detail TEXT,
       artifact_json TEXT NOT NULL DEFAULT '{}',
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
  ensureCodexRunArtifactPreservesEvidence(db);
  db.exec("CREATE INDEX IF NOT EXISTS idx_codex_artifact_agent_created ON codex_run_artifact(agent_id, created_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_codex_artifact_message ON codex_run_artifact(message_id, agent_id)");
  db.exec(
    `CREATE TABLE IF NOT EXISTS codex_inflight (
       message_id TEXT NOT NULL,
       agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
       thread_id TEXT NOT NULL,
       started_at TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY (message_id, agent_id)
     )`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_codex_inflight_started ON codex_inflight(started_at)");
}

export function migrateSchedulerState(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS scheduled_job (
       id TEXT PRIMARY KEY,
       kind TEXT NOT NULL CHECK(kind IN ('oneshot','recurring')),
       schedule_kind TEXT NOT NULL CHECK(schedule_kind IN ('once','interval','cron')),
       status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','succeeded','failed','cancelled')),
       enabled INTEGER NOT NULL DEFAULT 1,
       title TEXT NOT NULL,
       owner_agent_id TEXT,
       target_agent_id TEXT,
       created_by TEXT NOT NULL DEFAULT 'system',
       timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
       next_run_at TEXT NOT NULL,
       last_run_at TEXT,
       schedule_expr TEXT,
       payload_json TEXT NOT NULL,
       dedupe_key TEXT,
       misfire_policy TEXT NOT NULL DEFAULT 'coalesce' CHECK(misfire_policy IN ('coalesce','skip','catch_up_once')),
       max_runs INTEGER,
       run_count INTEGER NOT NULL DEFAULT 0,
       lock_until TEXT,
       lock_owner TEXT,
       last_error TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_scheduled_job_due ON scheduled_job(enabled, status, next_run_at, lock_until)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_scheduled_job_target ON scheduled_job(target_agent_id, next_run_at)");
  db.exec(
    `CREATE TABLE IF NOT EXISTS scheduled_job_run (
       id TEXT PRIMARY KEY,
       job_id TEXT NOT NULL REFERENCES scheduled_job(id) ON DELETE CASCADE,
       scheduled_for TEXT NOT NULL,
       started_at TEXT NOT NULL DEFAULT (datetime('now')),
       finished_at TEXT,
       outcome TEXT NOT NULL CHECK(outcome IN ('started','succeeded','failed','skipped')),
       emitted_message_id TEXT,
       detail_json TEXT,
       error TEXT
     )`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_scheduled_job_run_job ON scheduled_job_run(job_id, scheduled_for DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_scheduled_job_run_started ON scheduled_job_run(started_at DESC)");
  // Holiday calendar (2026-07-05): cron jobs with holidayPolicy skip/shift consult this
  // table. Keyed by local date (YYYY-MM-DD) + country so KR/other calendars can coexist.
  db.exec(
    `CREATE TABLE IF NOT EXISTS holiday (
       date TEXT NOT NULL,
       country TEXT NOT NULL DEFAULT 'KR',
       label TEXT NOT NULL DEFAULT '',
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY (country, date)
     )`,
  );
  // No secondary index: the (country,date) PRIMARY KEY already serves the exact
  // 2-column equality seek that isHolidayOn does.
  seedKrHolidays(db);
}

// OWNER 1:1 DM 캡처 테이블 (2026-07-06). 버스 message와 분리 — dispatch/wake 컬럼이 없어
// 이중응대 함정 구조적 불가. recall 전용. member_id 필터로 멤버별 격리(타 멤버 OWNER DM 열람 불가).
// dedupe_key UNIQUE로 훅이 같은 메시지를 두 번 봐도 행 1개.
export function migrateDmCapture(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS dm_message (
       id TEXT PRIMARY KEY,
       member_id TEXT NOT NULL,
       runtime TEXT,
       direction TEXT NOT NULL CHECK(direction IN ('in','out')),
       body TEXT,
       created_at TEXT NOT NULL,
       dedupe_key TEXT NOT NULL,
       source_ref TEXT,
       UNIQUE(member_id, dedupe_key)
     )`,
    // ★Devon 리뷰 MUST-FIX(2026-07-09): dedupe_key 전역 UNIQUE → (member_id, dedupe_key) 복합 UNIQUE.
    //   전역이면 같은 telegram user/message_id 가 멤버 간 충돌 시 뒤 멤버 DM 이 조용히 누락(recall=0)됨.
    //   복합키로 멤버별 격리. (dm_message 는 라이브 미배포라 CREATE 만 정정하면 됨 — 기존 DB 없음.)
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_dm_message_member ON dm_message(member_id, created_at DESC)");
  // 파서 실패와 "새 DM 없음"을 구분하는 멤버별 런타임 health. 매 tick UPSERT라 로그 폭증 없이
  // 현재 상태와 마지막 성공/실패 시각을 보존한다.
  db.exec(
    `CREATE TABLE IF NOT EXISTS dm_sync_health (
       member_id TEXT PRIMARY KEY,
       runtime TEXT NOT NULL,
       state TEXT NOT NULL CHECK(state IN ('ok','error')),
       scanned INTEGER NOT NULL DEFAULT 0,
       inserted INTEGER NOT NULL DEFAULT 0,
       last_success_at TEXT,
       last_error_at TEXT,
       error TEXT,
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
}

// Pending follow-up tracker (2026-07-10) — when a requester flags a directed request with
// expect_report_by AND the recipient is a one-shot runtime (openclaw/hermes), the inbox route
// records a row here. A ~60s worker re-wakes the recipient once if no substantive report arrives
// by the deadline, then the row is fired/cleaned. Small, self-cleaning. Idempotent CREATE.
export function migratePendingFollowup(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS pending_followup (
       id TEXT PRIMARY KEY,
       recipient_agent_id TEXT NOT NULL,
       target_agent_id TEXT NOT NULL,
       thread_id TEXT,
       source_message_id TEXT,
       deadline_at TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       fired INTEGER NOT NULL DEFAULT 0
     )`,
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_pending_followup_deadline ON pending_followup(deadline_at)");
}

/**
 * OWNER-report reminder flag (2026-07-11, OWNER — prompt-injection approach). A lightweight per-(collector,
 * thread) bit that says "this non-claude collector is running a team-lead collection." Set when the
 * collector's fan-out handoff (OWNER provenance) is observed; while set, wakeDispatcher appends a soft
 * "wrap up & report to the team lead" reminder to the collector's wake body. Cleared when the
 * collector's report to the team lead (reply_mode=direct_to_gd) is observed. TTL-bounded (created_at)
 * so a missed clear can't linger. NO central watchdog — set/inject/clear only.
 */
export function migrateGdReportFlag(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS gd_report_flag (
       collector_agent_id TEXT NOT NULL,
       thread_id TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       cleared INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (collector_agent_id, thread_id)
     )`,
  );
}

/**
 * Team-Collect orchestration (2026-07-11, docs/TEAM_COLLECT_ORCHESTRATION.md). Durable state for a
 * collector's team-lead collection: the collection header, the append-only expected contributors (keyed by
 * call_msg_id for reply matching), and one row per contributor reply (last-write-wins). Feature-flagged OFF.
 */
export function migrateTeamCollect(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS collection (
       collection_id TEXT PRIMARY KEY,
       collector_agent_id TEXT NOT NULL,
       thread_id TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'collecting',   -- collecting | completed | timed_out
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       closed_at TEXT,
       close_wake_message_id TEXT                    -- exactly-once close-wake guard
     )`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS collection_expected (
       collection_id TEXT NOT NULL,
       contributor_id TEXT NOT NULL,
       call_msg_id TEXT NOT NULL,                    -- the fan-out handoff msg id → matches reply.in_reply_to
       added_at TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY (collection_id, contributor_id, call_msg_id)  -- one row PER handoff (re-fan-out appends)
     )`,
  );
  // Migrate an old (collection_id, contributor_id) PK to include call_msg_id so a re-fan-out to an
  // already-expected contributor APPENDS a second handoff row instead of overwriting call_msg_id (which
  // orphaned a reply to the prior handoff — bug #6). Idempotent; preserves rows. Safe (feature flag-OFF).
  {
    const pk = (db.prepare(`SELECT name FROM pragma_table_info('collection_expected') WHERE pk>0 ORDER BY pk`)
      .all() as Array<{ name: string }>).map((r) => r.name).join(",");
    if (pk === "collection_id,contributor_id") {
      db.exec(
        `CREATE TABLE collection_expected__new (
           collection_id TEXT NOT NULL, contributor_id TEXT NOT NULL, call_msg_id TEXT NOT NULL,
           added_at TEXT NOT NULL DEFAULT (datetime('now')),
           PRIMARY KEY (collection_id, contributor_id, call_msg_id)
         );
         INSERT OR IGNORE INTO collection_expected__new (collection_id, contributor_id, call_msg_id, added_at)
           SELECT collection_id, contributor_id, call_msg_id, added_at FROM collection_expected;
         DROP TABLE collection_expected;
         ALTER TABLE collection_expected__new RENAME TO collection_expected;`,
      );
    }
  }
  db.exec(
    `CREATE TABLE IF NOT EXISTS collection_reply (
       collection_id TEXT NOT NULL,
       contributor_id TEXT NOT NULL,
       reply_message_id TEXT NOT NULL,
       body TEXT NOT NULL,
       received_at TEXT NOT NULL DEFAULT (datetime('now')),
       is_late INTEGER NOT NULL DEFAULT 0,           -- arrived after close → stored, not bundled
       PRIMARY KEY (collection_id, contributor_id)   -- last-write-wins per contributor
     )`,
  );
  // ★'답은 왔는데 붙이지 못한' 사실을 기록한다 (D4, 2026-07-12).★
  //   매칭은 in_reply_to == call_msg_id 로만 한다. 그 id 는 LLM 이 손으로 복사하므로 ★반드시 가끔 틀린다.★
  //   틀리면 답이 collection_reply 에 안 들어가고, 번들은 그 사람을 ★'미응답'으로 보고한다 = 거짓말.
  //   → 못 붙인 답을 여기 기록해 두고, 번들이 '미응답'이 아니라 ★'미매칭(답변은 있음)'★ 으로 말하게 한다.
  //   (거짓 보고 > 중복 보고. 모르면 모른다고 말한다.)
  db.run(
    `CREATE TABLE IF NOT EXISTS collection_unmatched (
       collection_id TEXT NOT NULL,
       contributor_id TEXT NOT NULL,
       reply_message_id TEXT NOT NULL,
       received_at TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY (collection_id, contributor_id)   -- 마지막 미매칭 답만 유지(last-write-wins)
     )`,
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_collection_status ON collection(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_collection_expected_call ON collection_expected(call_msg_id)`);
}

// KR public holidays. Seeded idempotently via UPSERT (label edits self-heal on the
// next boot; corrected dates need a manual DELETE of the stale row). Substitute
// holidays (대체공휴일) included where they applied. Extend per year — lunar-calendar
// holidays (설날/추석) are enumerated per Gregorian date. Coverage cliff: past the last
// seeded year, isHolidayOn returns false, so skip/shift jobs silently behave as run —
// core.holidayCoverageThroughYear() surfaces this so a warning can be logged.
const KR_HOLIDAYS: Array<[date: string, label: string]> = [
  // 2026
  ["2026-01-01", "신정"],
  ["2026-02-16", "설날 연휴"],
  ["2026-02-17", "설날"],
  ["2026-02-18", "설날 연휴"],
  ["2026-03-01", "삼일절"],
  ["2026-03-02", "삼일절 대체공휴일"],
  ["2026-05-05", "어린이날"],
  ["2026-05-24", "부처님오신날"],
  ["2026-05-25", "부처님오신날 대체공휴일"],
  ["2026-06-06", "현충일"],
  ["2026-07-17", "제헌절"], // 2026 법정공휴일 재지정(2008년 제외 후 부활)
  ["2026-08-15", "광복절"],
  ["2026-08-17", "광복절 대체공휴일"],
  ["2026-09-24", "추석 연휴"],
  ["2026-09-25", "추석"],
  ["2026-09-26", "추석 연휴"],
  ["2026-10-03", "개천절"],
  ["2026-10-05", "개천절 대체공휴일"],
  ["2026-10-09", "한글날"],
  ["2026-12-25", "성탄절"],
];

export function seedKrHolidays(db: Database): void {
  const stmt = db.prepare(
    `INSERT INTO holiday (country, date, label) VALUES ('KR', ?, ?)
     ON CONFLICT(country, date) DO UPDATE SET label = excluded.label`,
  );
  const tx = db.transaction(() => {
    for (const [date, label] of KR_HOLIDAYS) stmt.run(date, label);
  });
  tx();
}

function ensureCodexRunArtifactPreservesEvidence(db: Database): void {
  const fks = db.prepare(`PRAGMA foreign_key_list('codex_run_artifact')`).all() as Array<{
    table: string;
    from: string;
    on_delete: string;
  }>;
  if (!fks.some((fk) => fk.table === "agent" && fk.from === "agent_id" && fk.on_delete.toUpperCase() === "CASCADE")) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    db.exec(
      `CREATE TABLE codex_run_artifact_new (
         id TEXT PRIMARY KEY,
         agent_id TEXT NOT NULL,
         message_id TEXT NOT NULL,
         thread_id TEXT NOT NULL,
         task_id TEXT,
         codex_session_id TEXT,
         status TEXT NOT NULL CHECK(status IN ('started','succeeded','failed','timed_out','deduped')),
         elapsed_ms INTEGER,
         reply_message_id TEXT,
         detail TEXT,
         artifact_json TEXT NOT NULL DEFAULT '{}',
         created_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
    );
    db.exec(
      `INSERT INTO codex_run_artifact_new
         (id, agent_id, message_id, thread_id, task_id, codex_session_id, status,
          elapsed_ms, reply_message_id, detail, artifact_json, created_at)
       SELECT id, agent_id, message_id, thread_id, task_id, codex_session_id, status,
              elapsed_ms, reply_message_id, detail, artifact_json, created_at
       FROM codex_run_artifact`,
    );
    db.exec("DROP TABLE codex_run_artifact");
    db.exec("ALTER TABLE codex_run_artifact_new RENAME TO codex_run_artifact");
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw e;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function addColumnIfMissing(db: Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info('${table.replace(/'/g, "''")}')`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/**
 * Widen the existing agent table's runtime/status_provider CHECK to the current
 * full set (claude_channel/openclaw/hermes_agent/b3os_native + matching status
 * providers). SQLite cannot ALTER a CHECK constraint, so existing DBs need a
 * small table rebuild; the alreadyWidened guard makes it idempotent (a DB widened
 * for hermes but not b3os_native rebuilds once more). New DBs from schema.sql
 * already have the widened constraint.
 * NOTE (Steve review): per-runtime CHECK rebuild is heavier than the "런타임 추가=
 * config 한 줄" goal — a future improvement is app-level validation in loadRegistry.
 */
export function widenAgentRuntimeChecks(db: Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent'")
    .get() as { sql: string } | undefined;
  const sql = row?.sql ?? "";
  const alreadyWidened =
    sql.includes("hermes_agent") &&
    sql.includes("hermes_gateway") &&
    sql.includes("hermes_profile") &&
    sql.includes("hermes_alias") &&
    sql.includes("gateway_service") &&
    // b3os_native 추가(M1): 기존 hermes-widened DB도 이 마커가 없으면 1회 더 재빌드해 native enum 허용.
    sql.includes("b3os_native") &&
    // codex 런타임 추가(2026-06-27 OWNER): 'codex' enum 마커 없으면 1회 더 재빌드해 codex 허용.
    sql.includes("'codex'");
  if (alreadyWidened) return;

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    db.exec(
      `CREATE TABLE agent_new (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        runtime TEXT NOT NULL CHECK(runtime IN ('claude_channel','openclaw','hermes_agent','b3os_native','codex')),
        status_provider TEXT NOT NULL CHECK(status_provider IN ('claude_tmux','openclaw_gateway','hermes_gateway','b3os_native_runner','codex_cli')),
        tmux_session TEXT,
        telegram_bot_username TEXT,
        workspace_path TEXT NOT NULL,
        persona_file TEXT NOT NULL,
        moderator_eligible INTEGER NOT NULL DEFAULT 0,
        avatar_emoji TEXT NOT NULL DEFAULT '🤖',
        hermes_profile TEXT,
        hermes_alias TEXT,
        gateway_service TEXT,
        icon TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    // ★ 데이터 보존(하네스 리뷰 발견): 고정 컬럼 목록으로 복사하면 나중에 추가된 컬럼(icon·hermes_profile·
    // hermes_alias·gateway_service)이 재빌드 때 날아간다. 소스∩신규 '공통 컬럼'만 동적으로 복사해 드리프트 안전하게.
    const srcCols = (db.prepare("PRAGMA table_info('agent')").all() as { name: string }[]).map((c) => c.name);
    const newCols = new Set(
      (db.prepare("PRAGMA table_info('agent_new')").all() as { name: string }[]).map((c) => c.name),
    );
    const shared = srcCols.filter((c) => newCols.has(c));
    const colList = shared.map((c) => `"${c}"`).join(", ");
    db.exec(`INSERT INTO agent_new (${colList}) SELECT ${colList} FROM agent`);
    db.exec("DROP TABLE agent");
    db.exec("ALTER TABLE agent_new RENAME TO agent");
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback failure
    }
    throw e;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * 승인 시스템 v2(2026-07-08 OWNER): approval_request.status CHECK 에 'deferred'(10분 미승인 자동 보류) 추가.
 * SQLite 는 CHECK 를 in-place ALTER 못 하므로 기존 DB 는 작은 테이블 재빌드. sql 에 'deferred' 마커가
 * 있으면 idempotent skip. 공통 컬럼만 동적 복사(widenAgentRuntimeChecks 와 동일 드리프트-안전 패턴).
 */
export function migrateApprovalDeferredStatus(db: Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='approval_request'")
    .get() as { sql: string } | undefined;
  const sql = row?.sql ?? "";
  if (!sql || sql.includes("'deferred'")) return; // 테이블 없음(fresh=CREATE가 이미 포함) 또는 이미 확장됨

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    db.exec(
      `CREATE TABLE approval_request_new (
        id TEXT PRIMARY KEY,
        action_key TEXT NOT NULL,
        params_json TEXT NOT NULL DEFAULT '{}',
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','approved','executing','done','failed','rejected','expired','deferred')),
        requested_by TEXT NOT NULL DEFAULT 'system',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        decided_at TEXT,
        result TEXT
      )`,
    );
    const srcCols = (db.prepare("PRAGMA table_info('approval_request')").all() as { name: string }[]).map((c) => c.name);
    const newCols = new Set(
      (db.prepare("PRAGMA table_info('approval_request_new')").all() as { name: string }[]).map((c) => c.name),
    );
    const shared = srcCols.filter((c) => newCols.has(c));
    const colList = shared.map((c) => `"${c}"`).join(", ");
    db.exec(`INSERT INTO approval_request_new (${colList}) SELECT ${colList} FROM approval_request`);
    db.exec("DROP TABLE approval_request");
    db.exec("ALTER TABLE approval_request_new RENAME TO approval_request");
    db.exec("CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_request(status, created_at DESC)");
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback failure
    }
    throw e;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * Team Search V0.5: widen source_type to include task cards.
 * Existing SQLite CHECK constraints cannot be altered in place, so rebuild only
 * the small derived search chunk table. The index is derived and can be rebuilt
 * by the normal search reindex path; existing rows are copied to keep reads alive.
 */
export function widenSearchSourceTypes(db: Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='team_search_chunk'")
    .get() as { sql: string } | undefined;
  const sql = row?.sql ?? "";
  if (!sql || sql.includes("'task'")) return;

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    db.exec(
      `CREATE TABLE team_search_chunk_new (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL CHECK(source_type IN ('message','audit','doc','report','rule','registry','task')),
        source_id TEXT,
        source_ref TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        actor TEXT,
        thread_id TEXT,
        message_id TEXT,
        created_at TEXT,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    db.exec(
      `INSERT INTO team_search_chunk_new
        (id, source_type, source_id, source_ref, title, content, actor, thread_id, message_id, created_at, indexed_at)
       SELECT id, source_type, source_id, source_ref, title, content, actor, thread_id, message_id, created_at, indexed_at
       FROM team_search_chunk`,
    );
    db.exec("DROP TABLE team_search_chunk");
    db.exec("ALTER TABLE team_search_chunk_new RENAME TO team_search_chunk");
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback failure
    }
    throw e;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }

  db.exec("CREATE INDEX IF NOT EXISTS idx_search_chunk_source ON team_search_chunk(source_type, created_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_search_chunk_thread ON team_search_chunk(thread_id)");
}

/**
 * Team Bus v1: idempotent column additions.
 * SQLite does not support IF NOT EXISTS on ALTER TABLE ADD COLUMN, so we attempt
 * each ALTER separately and swallow "duplicate column" errors (SQLITE_ERROR with
 * "duplicate column name" message). Safe to run on every startup.
 */
export function runBusMigration(db: Database): void {
  const alterStatements: string[] = [
    // message_recipient → dispatch outbox
    "ALTER TABLE message_recipient ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending'",
    "ALTER TABLE message_recipient ADD COLUMN claimed_at TEXT",
    "ALTER TABLE message_recipient ADD COLUMN lease_until TEXT",
    "ALTER TABLE message_recipient ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE message_recipient ADD COLUMN last_error TEXT",
    // v1.1: deferred-count columns for starvation observability (issue 2)
    "ALTER TABLE message_recipient ADD COLUMN deferred_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE message_recipient ADD COLUMN last_deferred_at TEXT",
    // v1.1: shadow_seen_at to track first shadow log per row (issue 5)
    "ALTER TABLE message_recipient ADD COLUMN shadow_seen_at TEXT",
    // message → bus metadata
    "ALTER TABLE message ADD COLUMN created_by TEXT",
    "ALTER TABLE message ADD COLUMN max_hop INTEGER NOT NULL DEFAULT 16",
    // 2026-06-11: hop cap 5→16 정렬(pingpong cap 6보다 hop cap 5가 낮아 정당한 다단계/handoff 차단되던 버그).
    // 기존 행(default 5로 박힌 것)도 미전달분이 차단 안 되게 상향. 신규는 insertMessage가 16 명시. (위 ALTER는
    // 기존 DB에선 duplicate column 으로 무시되므로 fresh DB 전용 — 기존 DB는 이 UPDATE 로 보정.)
    "UPDATE message SET max_hop = 16 WHERE max_hop = 5",
    "ALTER TABLE message ADD COLUMN owner TEXT",
    "ALTER TABLE message ADD COLUMN expected_response INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE message ADD COLUMN parent_message_id TEXT",
    "ALTER TABLE message ADD COLUMN ack_at TEXT",
    "ALTER TABLE message ADD COLUMN sync TEXT NOT NULL DEFAULT 'none'",
    // Tasks kanban: owner-maintained free-form description (목표·범위·계획·완료기준·메모)
    "ALTER TABLE task ADD COLUMN description TEXT",
    // 결과물 포털: report 분류(보고서/교육자료/리서치) — /research 통합 후 category 로 구분 (2026-06-07)
    "ALTER TABLE report ADD COLUMN category TEXT",
    // 결과물 포털: OWNER 중요표시 별표 필터 (2026-07-02)
    "ALTER TABLE report ADD COLUMN is_important INTEGER NOT NULL DEFAULT 0",
    // ── SLG cycle1 A (ack-close, 2026-06-13): semantic 닫힘 레이어 ──────────────
    // delivery_state(transport: 전달했나)와 분리된 recipient_state(work/closure: 끝났나).
    // transport-completed 가 'done 으로 오독'되던 false-green/false-red 를 데이터에서 차단.
    // app-enum: open|acknowledged|in_progress|completed|blocked|needs_match_review|expired
    "ALTER TABLE message_recipient ADD COLUMN recipient_state TEXT NOT NULL DEFAULT 'open'",
    // close_reason: ack_only|reply_observed|explicit_done|task_status_mirror|needs_match_review|expired|manual
    "ALTER TABLE message_recipient ADD COLUMN close_reason TEXT",
    // closed_at: terminal(completed/expired)에만 set, 비완료는 NULL
    "ALTER TABLE message_recipient ADD COLUMN closed_at TEXT",
    // state_source: reply|ack|task|manual|system — 전이 출처 provenance
    "ALTER TABLE message_recipient ADD COLUMN state_source TEXT",
    // closing_message_id: 전이 유발 reply/message id (drilldown + 되돌리기)
    "ALTER TABLE message_recipient ADD COLUMN closing_message_id TEXT",
    // message.task_link_id: task.lane=정본, recipient_state=mirror (req#2) + 매칭키 (req#4)
    "ALTER TABLE message ADD COLUMN task_link_id TEXT",
  ];
  for (const stmt of alterStatements) {
    try {
      db.exec(stmt);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("duplicate column name")) {
        throw e;
      }
      // Column already exists — idempotent, skip.
    }
  }

  // Index for pending dispatch polling (idempotent CREATE INDEX IF NOT EXISTS)
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_recipient_dispatch
     ON message_recipient(delivery_state, lease_until)`,
  );
  // v1.1: index for broadcast delivery aggregation by message (issue 6)
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_recipient_msg_state
     ON message_recipient(message_id, delivery_state)`,
  );
  // busviz-v1: per-member aggregation index for the topology view's
  // GROUP BY agent_id, delivery_state — keeps that read off a full table scan so
  // it doesn't contend with the dispatcher's pending-poll (Gemini #2).
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_recipient_agent_state
     ON message_recipient(agent_id, delivery_state)`,
  );
  // SLG cycle1 A: per-member aggregation by semantic recipient_state (topology/dashboard
  // read 'engaged vs open' off this instead of transport delivery_state).
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_recipient_semantic
     ON message_recipient(agent_id, recipient_state)`,
  );

  // SLG cycle1 A: one-time recipient_state backfill from transport delivery_state.
  // Maps existing rows so the new semantic layer has sane initial values without a
  // mass re-open. Idempotent: only touches rows still at the DEFAULT 'open'.
  recipientStateBackfill(db);

  // v1.1: mass-wake backfill — mark pre-v1.1 'pending' rows as 'completed' to prevent
  // a flood of stale wakes on first deploy. Cutoff = rows created before bus migration
  // ran (approximated as rows whose message was created before the first runBusMigration
  // call, i.e. rows where the message pre-dates any dispatching activity). We use a
  // conservative heuristic: 'pending' rows whose message was created before the oldest
  // 'wake_dispatched' or 'dead_letter' row — meaning bus was already running when these
  // were created, so they are genuinely stale. If no dispatched rows exist yet (first
  // ever run), we mark ALL existing pending rows as completed (safe: they accumulated
  // before the dispatcher was active). Idempotent: the flag table entry prevents re-run.
  massWakeBackfill(db);

  // root fix 2026-06-22: retroactively close the transport orphans that the new ackClose
  // coupling now prevents going forward. Without this the existing engaged-but-wake_dispatched
  // backlog (claude_channel rows handled out-of-band, never closed) lingers red until a TTL
  // sweep. Same safe rule applied to history. Idempotent + flag-guarded.
  orphanedDeliveryBackfill(db);

  // broadcast complete 로직 (OWNER 2026-06-22): broadcast(@all/announce)는 FYI인데 비응답자 수신행이
  // 'open'으로 남아 inbox에 action-required로 영구 누적됨(@all 인사 후 "주르륵"). 이제 신규는
  // acknowledged로 생성하고(insertMessage), 기존 open broadcast 행도 일회 정리. Idempotent + flag-guarded.
  broadcastOpenBackfill(db);

  // inbox out-of-band root fix (2026-06-23): 캡처 워커가 팀 에이전트 봇 발신을 ingest하지 않던
  // 기간에 쌓인 agent recipient_state(open/needs_match_review)를 일회 정리한다. Forward path는
  // telegramCapture의 bot-activity auto-ack가 담당한다.
  outOfBandRecipientBackfill(db);
}

/**
 * One-time backfill: mark pre-dispatch 'pending' rows as 'completed' to avoid a
 * mass-wake flood on first v1.1 deployment. Idempotent — guarded by a flag row in
 * runtime_lock table (key='bus_backfill_v1_1'). Safe on empty DB and re-runs.
 */
export function massWakeBackfill(db: Database): void {
  // Guard: skip if already done
  const done = db
    .prepare(`SELECT key FROM runtime_lock WHERE key = 'bus_backfill_v1_1'`)
    .get() as { key: string } | undefined;
  if (done) return;

  // Find cutoff: oldest already-dispatched row's created_at (marks when dispatcher began)
  const cutoffRow = db
    .prepare(
      `SELECT MIN(m.created_at) AS cutoff
       FROM message_recipient mr
       JOIN message m ON m.id = mr.message_id
       WHERE mr.delivery_state IN ('wake_dispatched', 'dead_letter', 'agent_ack', 'completed')`,
    )
    .get() as { cutoff: string | null } | undefined;

  const cutoff = cutoffRow?.cutoff ?? null;

  let changed: number;
  if (cutoff) {
    // Mark 'pending' rows whose message predates the first successful dispatch
    const result = db
      .prepare(
        `UPDATE message_recipient
         SET delivery_state = 'completed', last_error = 'backfilled_v1_1'
         WHERE delivery_state = 'pending'
           AND message_id IN (
             SELECT id FROM message WHERE created_at < ?
           )`,
      )
      .run(cutoff);
    changed = result.changes;
  } else {
    // No dispatched rows at all → mark ALL existing pending rows completed
    // (they predate the dispatcher entirely)
    const result = db
      .prepare(
        `UPDATE message_recipient
         SET delivery_state = 'completed', last_error = 'backfilled_v1_1'
         WHERE delivery_state = 'pending'`,
      )
      .run();
    changed = result.changes;
  }

  if (changed > 0) {
    console.log(`[bus_migrate] mass-wake backfill: marked ${changed} stale pending rows → completed`);
  }

  // Record the flag so this never runs again
  db.prepare(
    `INSERT OR IGNORE INTO runtime_lock (key, holder_agent_id, acquired_at, expires_at)
     VALUES ('bus_backfill_v1_1', 'system', datetime('now'), datetime('now', '+100 years'))`,
  ).run();
}

/**
 * Transport-orphan backfill — the retroactive half of the red-"대기" root fix (2026-06-22).
 *
 * The new ackClose coupling closes a wake's transport row once the recipient ENGAGES, but only
 * going forward. Existing rows that already engaged (recipient_state past 'open') yet are still
 * stuck at delivery_state='wake_dispatched' would linger red until a TTL sweep. This applies the
 * exact same rule once to history: engaged + orphaned → 'completed'.
 *
 * SCOPE matches the forward fix: recipient_state IN (acknowledged, in_progress, completed,
 * blocked) — i.e. the recipient demonstrably handled it. EXCLUDES 'needs_match_review' (ambiguous
 * — same skip as the live path) and 'expired' (terminal; let it sweep, not falsely "completed").
 * Idempotent — guarded by a runtime_lock flag; re-runs find nothing. last_error tags provenance.
 */
export function orphanedDeliveryBackfill(db: Database): void {
  const done = db
    .prepare(`SELECT key FROM runtime_lock WHERE key = 'delivery_orphan_close_v1'`)
    .get() as { key: string } | undefined;
  if (done) return;

  const result = db
    .prepare(
      `UPDATE message_recipient
       SET delivery_state = 'completed',
           last_error     = 'backfilled_orphan_engaged',
           lease_until    = NULL,
           claimed_at     = NULL
       WHERE delivery_state = 'wake_dispatched'
         AND recipient_state IN ('acknowledged', 'in_progress', 'completed', 'blocked')`,
    )
    .run();
  if (result.changes > 0) {
    console.log(`[bus_migrate] orphaned-delivery backfill: closed ${result.changes} engaged wake_dispatched rows → completed`);
  }
  db.prepare(
    `INSERT OR IGNORE INTO runtime_lock (key, holder_agent_id, acquired_at, expires_at)
     VALUES ('delivery_orphan_close_v1', 'system', datetime('now'), datetime('now', '+100 years'))`,
  ).run();
}

/**
 * broadcast-open backfill — broadcast complete 로직의 retroactive 절반 (OWNER 2026-06-22).
 * 기존 broadcast(@all/announce) 수신행이 recipient_state='open'으로 남아 inbox에 action-required로
 * 영구 누적된 걸 'acknowledged'(broadcast_fyi)로 일회 정리. 새 broadcast는 insertMessage가 이미 ack로 생성.
 * SCOPE: message.type='broadcast' OR to_agent_id='broadcast' 인 메시지의 'open' 수신행만. needs_match_review·
 * 기타 상태는 안 건드림. Idempotent — runtime_lock 플래그로 1회.
 */
export function broadcastOpenBackfill(db: Database): void {
  const done = db
    .prepare(`SELECT key FROM runtime_lock WHERE key = 'broadcast_open_close_v1'`)
    .get() as { key: string } | undefined;
  if (done) return;

  const result = db
    .prepare(
      `UPDATE message_recipient
       SET recipient_state = 'acknowledged',
           close_reason = 'broadcast_fyi',
           state_source = 'system'
       WHERE recipient_state = 'open'
         AND message_id IN (
           SELECT id FROM message WHERE type = 'broadcast' OR to_agent_id = 'broadcast'
         )`,
    )
    .run();
  if (result.changes > 0) {
    console.log(`[bus_migrate] broadcast-open backfill: closed ${result.changes} open broadcast rows → acknowledged(broadcast_fyi)`);
  }
  db.prepare(
    `INSERT OR IGNORE INTO runtime_lock (key, holder_agent_id, acquired_at, expires_at)
     VALUES ('broadcast_open_close_v1', 'system', datetime('now'), datetime('now', '+100 years'))`,
  ).run();
}

/**
 * out-of-band recipient backfill — retroactive half of the Telegram bot activity auto-ack fix.
 *
 * Team-agent Telegram bot replies are visible in the group but intentionally not ingested into
 * the bus as full messages, to avoid loops. Before the forward fix, that meant the sender's
 * previous recipient rows could remain action-required forever. This one-time migration closes
 * stale rows for agents that have a Telegram bot identity.
 *
 * Scope is intentionally narrow:
 *   - recipient belongs to an agent with telegram_bot_username
 *   - semantic state is open or needs_match_review
 *   - source message is from user and older than the activity grace
 *   - broadcast FYI is excluded; broadcastOpenBackfill handles that separately
 */
export function outOfBandRecipientBackfill(db: Database): void {
  const done = db
    .prepare(`SELECT key FROM runtime_lock WHERE key = 'outofband_recipient_backfill_v1'`)
    .get() as { key: string } | undefined;
  if (done) return;

  const result = db
    .prepare(
      `UPDATE message_recipient
       SET recipient_state = 'acknowledged',
           close_reason = 'outofband_activity_backfill',
           state_source = 'system',
           delivery_state = CASE
             WHEN delivery_state IN ('pending', 'dispatching', 'wake_dispatched', 'failed') THEN 'completed'
             ELSE delivery_state
           END,
           lease_until = NULL,
           claimed_at = NULL,
           last_error = 'backfilled_outofband_activity'
       WHERE recipient_state IN ('open', 'needs_match_review')
         AND agent_id IN (
           SELECT id FROM agent WHERE telegram_bot_username IS NOT NULL AND trim(telegram_bot_username) != ''
         )
         AND message_id IN (
           SELECT id FROM message
           WHERE source = 'user'
             AND type != 'broadcast'
             AND to_agent_id != 'broadcast'
             AND created_at < datetime('now', '-30 seconds')
         )`,
    )
    .run();
  if (result.changes > 0) {
    console.log(`[bus_migrate] out-of-band recipient backfill: closed ${result.changes} stale agent rows`);
  }
  db.prepare(
    `INSERT OR IGNORE INTO runtime_lock (key, holder_agent_id, acquired_at, expires_at)
     VALUES ('outofband_recipient_backfill_v1', 'system', datetime('now'), datetime('now', '+100 years'))`,
  ).run();
}

/**
 * SLG cycle1 A — one-time recipient_state backfill from transport delivery_state.
 *
 * The new semantic layer (recipient_state) defaults to 'open'. For pre-existing rows
 * we derive a sane initial semantic state from how transport already ended:
 *   transport completed/agent_ack → semantic 'completed'  (already handled, don't re-open)
 *   transport blocked             → semantic 'blocked'    (keep tracking)
 *   transport expired/dead_letter → semantic 'expired'    (terminal, no action)
 *   everything else (pending/dispatching/wake_dispatched/failed) → stays 'open'
 *
 * Note: this is a heuristic seed, NOT a truth claim — transport-completed does NOT mean
 * the work was actually done (that conflation is the bug A fixes). But for HISTORICAL
 * rows there is no reply signal to replay, so we seed them closed to avoid a backlog of
 * fake-red, while close_reason='backfill_transport' marks them as un-verified in audit.
 * Idempotent: only rewrites rows still at the DEFAULT 'open'. Guarded by a flag row.
 */
export function recipientStateBackfill(db: Database): void {
  const done = db
    .prepare(`SELECT key FROM runtime_lock WHERE key = 'recipient_state_backfill_a1'`)
    .get() as { key: string } | undefined;
  if (done) return;

  const map: Array<[from: string, to: string]> = [
    ["completed", "completed"],
    ["agent_ack", "completed"],
    ["blocked", "blocked"],
    ["expired", "expired"],
    ["dead_letter", "expired"],
  ];
  let changed = 0;
  for (const [from, to] of map) {
    const terminal = to === "completed" || to === "expired";
    const result = db
      .prepare(
        `UPDATE message_recipient
         SET recipient_state = ?,
             close_reason = 'backfill_transport',
             state_source = 'system',
             closed_at = ${terminal ? "datetime('now')" : "NULL"}
         WHERE delivery_state = ? AND recipient_state = 'open'`,
      )
      .run(to, from);
    changed += result.changes;
  }
  if (changed > 0) {
    console.log(`[bus_migrate] recipient_state backfill: seeded ${changed} rows from transport state`);
  }
  db.prepare(
    `INSERT OR IGNORE INTO runtime_lock (key, holder_agent_id, acquired_at, expires_at)
     VALUES ('recipient_state_backfill_a1', 'system', datetime('now'), datetime('now', '+100 years'))`,
  ).run();
}

/**
 * Directed-message recipient-row backfill (2026-06-13, OWNER 데이터모델 정리).
 *
 * inboxFor 를 '받는이(message_recipient) 테이블 단일 기준'으로 통일하기 위한 일회성 backfill.
 * 과거(Team Bus v1 이전) 1:1 메시지는 message_recipient 행 없이 message.read_at 으로만 inbox 에
 * 떴다. inboxFor 의 message-level 분기(m.to_agent_id=? AND m.read_at IS NULL)를 제거하면 그 행 없는
 * 옛 메시지가 inbox 에서 사라지므로, 받는이가 실제 agent 인 모든 메시지에 행을 채운다.
 *   · read_at = message.read_at  (읽음/안읽음 상태 그대로 보존 — 핵심)
 *   · delivery_state = 'completed'  (과거 메시지 = 이미 배달됨, 재dispatch 방지)
 *   · recipient_state = 읽음이면 'acknowledged'(+close_reason='backfill_legacy'), 안읽음이면 'open'
 * 멱등: NOT EXISTS + INSERT OR IGNORE(PK=(message_id,agent_id)). 행을 INSERT 만 하므로(UPDATE 아님)
 * 별도 완료 플래그 없이 매 부팅 재실행해도 안전하다(첫 실행 후엔 채울 행이 없어 no-op).
 */
export function directedRecipientRowBackfill(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO message_recipient
       (message_id, agent_id, read_at, delivery_state, recipient_state, close_reason, state_source)
     SELECT m.id, m.to_agent_id, m.read_at, 'completed',
            CASE WHEN m.read_at IS NOT NULL THEN 'acknowledged' ELSE 'open' END,
            CASE WHEN m.read_at IS NOT NULL THEN 'backfill_legacy' ELSE NULL END,
            'backfill'
     FROM message m
     WHERE m.to_agent_id IN (SELECT id FROM agent)
       AND NOT EXISTS (
         SELECT 1 FROM message_recipient mr
         WHERE mr.message_id = m.id AND mr.agent_id = m.to_agent_id
       )`,
  ).run();
}
