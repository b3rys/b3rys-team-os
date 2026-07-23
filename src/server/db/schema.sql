PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agent (
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
  icon TEXT,
  hermes_profile TEXT,
  hermes_alias TEXT,
  gateway_service TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_status (
  agent_id TEXT PRIMARY KEY REFERENCES agent(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  last_activity_at TEXT,
  last_log_line TEXT,
  tmux_pid INTEGER,
  ctx_percent INTEGER,
  probed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phase 2c: idempotent migration to add ctx_percent on existing dbs (PRAGMA returns error if column exists; ignored).
-- Bun's exec is wrapped, so we rely on transaction rollback to keep things tidy. New deploys hit the CREATE TABLE above.

CREATE TABLE IF NOT EXISTS log_line (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  line TEXT NOT NULL,
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_log_agent_captured ON log_line(agent_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS metric (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cpu_percent REAL,
  mem_used_mb INTEGER,
  load_1min REAL,
  ollama_running INTEGER,
  probed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_metric_probed ON metric(probed_at DESC);

CREATE TABLE IF NOT EXISTS audit_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail_json TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_event(at DESC);

-- Phase 1.5: message bus tables (multi-AI review reflected schema).

CREATE TABLE IF NOT EXISTS thread (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('dm','meeting','broadcast')),
  participants_json TEXT NOT NULL,
  moderator_agent_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','paused','closed','failed')),
  state TEXT NOT NULL DEFAULT 'idle' CHECK(state IN ('opening','round_prompting','collecting','summarizing','idle')),
  round_no INTEGER NOT NULL DEFAULT 0,
  state_json TEXT,
  next_responder_agent_id TEXT,
  last_message_at TEXT,
  opened_by TEXT NOT NULL,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_thread_status_last ON thread(status, last_message_at DESC);

CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('agent','user','system')),
  hop_count INTEGER NOT NULL DEFAULT 0,
  in_reply_to TEXT,
  read_at TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_status IN ('pending','delivered','failed','expired')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high')),
  dedupe_key TEXT,
  attachments_json TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_message_thread_created ON message(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_to_read_created ON message(to_agent_id, read_at, created_at);
CREATE INDEX IF NOT EXISTS idx_message_dedupe ON message(dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_recipient (
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  read_at TEXT,
  PRIMARY KEY (message_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_recipient_unread ON message_recipient(agent_id, read_at);

CREATE TABLE IF NOT EXISTS runtime_lock (
  key TEXT PRIMARY KEY,
  holder_agent_id TEXT,
  acquired_at TEXT,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS codex_session_map (
  agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  surface TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  codex_session_id TEXT NOT NULL,
  last_message_id TEXT,
  last_task_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, surface, conversation_key)
);
CREATE INDEX IF NOT EXISTS idx_codex_session_updated ON codex_session_map(updated_at DESC);

CREATE TABLE IF NOT EXISTS codex_run_artifact (
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
);
CREATE INDEX IF NOT EXISTS idx_codex_artifact_agent_created ON codex_run_artifact(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_codex_artifact_message ON codex_run_artifact(message_id, agent_id);

CREATE TABLE IF NOT EXISTS codex_inflight (
  message_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_codex_inflight_started ON codex_inflight(started_at);

CREATE TABLE IF NOT EXISTS scheduled_job (
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
);
CREATE INDEX IF NOT EXISTS idx_scheduled_job_due ON scheduled_job(enabled, status, next_run_at, lock_until);
CREATE INDEX IF NOT EXISTS idx_scheduled_job_target ON scheduled_job(target_agent_id, next_run_at);

CREATE TABLE IF NOT EXISTS scheduled_job_run (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES scheduled_job(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('started','succeeded','failed','skipped')),
  emitted_message_id TEXT,
  detail_json TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_job_run_job ON scheduled_job_run(job_id, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_job_run_started ON scheduled_job_run(started_at DESC);

-- Holiday calendar for cron jobs with holidayPolicy skip/shift (2026-07-05).
-- The (country,date) PRIMARY KEY already serves isHolidayOn's equality seek; no
-- secondary index needed.
CREATE TABLE IF NOT EXISTS holiday (
  date TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'KR',
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (country, date)
);

-- busviz-v2: Tasks kanban board (independent of the bus — own table, own routes).
-- 'lane' is the kanban column (plan/doing/done); exposed as `column` in the API JSON.
-- DB uses 'lane' to avoid SQLite's reserved-word handling around `column`.
CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  lane TEXT NOT NULL DEFAULT 'plan' CHECK(lane IN ('plan','doing','done')),
  owner TEXT,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_lane ON task(lane, sort_order);

-- 팀 보고서 포털 (/reports). b3os-report 스킬이 렌더 후 등록, your-team.example.com/reports 에서 목록·열람.
-- forms_json = [{"type":"md|html|pdf|pptx|audio","path":"reports/<id>/<file>"}] (향후 형태 추가는 항목만 늘림)
-- category: '보고서' | '교육자료' | '리서치' | ... (2026-06-07 /research 통합 — 모든 팀 산출물이 report 로)
CREATE TABLE IF NOT EXISTS report (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT,
  summary TEXT,
  category TEXT,
  is_important INTEGER NOT NULL DEFAULT 0,
  forms_json TEXT NOT NULL DEFAULT '[]',
  project TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_report_created ON report(created_at DESC);

-- 팀 셀프 커스터마이즈 설정 (key-value). 팀명/태그라인 등. Mission·팀원은 파일이 정본.
CREATE TABLE IF NOT EXISTS setting (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 신규 영입 OT(오리엔테이션) 추적: 영입=등록→프로비저닝→OT번들→합류 흐름 상태.
CREATE TABLE IF NOT EXISTS ot (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'register',
  steps_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Team Search V0: source-grounded FTS index.
-- Additive only; source records stay in their original tables/files.
CREATE TABLE IF NOT EXISTS team_search_chunk (
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
);
CREATE INDEX IF NOT EXISTS idx_search_chunk_source ON team_search_chunk(source_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_chunk_thread ON team_search_chunk(thread_id);

CREATE VIRTUAL TABLE IF NOT EXISTS team_search_fts USING fts5(
  chunk_id UNINDEXED,
  title,
  content,
  source_ref,
  tokenize = 'trigram'
);

-- Team Bus v1: idempotent migrations (ALTER TABLE ADD COLUMN — silently ignored if column exists via
-- the migration helper in migrate.ts which runs each statement separately and ignores duplicate-column errors).

-- message_recipient: dispatch outbox columns
-- delivery_state: pending → dispatching → wake_dispatched → agent_ack → completed / failed / dead_letter
-- ALTER TABLE message_recipient ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending'
--   CHECK(delivery_state IN ('pending','dispatching','wake_dispatched','agent_ack','completed','failed','dead_letter'));
-- (Note: SQLite CHECK on ADD COLUMN applies on new rows only; safe to add)

-- message: bus metadata columns
-- ALTER TABLE message ADD COLUMN created_by TEXT;
-- ALTER TABLE message ADD COLUMN max_hop INTEGER NOT NULL DEFAULT 5;
-- ALTER TABLE message ADD COLUMN owner TEXT;
-- ALTER TABLE message ADD COLUMN expected_response INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE message ADD COLUMN parent_message_id TEXT;
-- ALTER TABLE message ADD COLUMN ack_at TEXT;
-- ALTER TABLE message ADD COLUMN sync TEXT NOT NULL DEFAULT 'none'
--   CHECK(sync IN ('none','status','handoff','result'));
-- (These are executed by runBusMigration() in migrate.ts, not inline, because
--  SQLite does not support CHECK constraints on ADD COLUMN in older builds.)
