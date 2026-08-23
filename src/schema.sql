-- TokenBench — Phase 2 store.
--
-- Written from the collector's observed schema summary (see schema-observed.md),
-- not from the PRD. Where the two disagree, the wire wins.
--
-- Every token and cost column is INTEGER. Costs are micros — millionths of a
-- dollar, straight from `cost_usd_micros` — never float dollars. Summing floats
-- over thousands of rows drifts, and drift in the one number this tool exists
-- to report is not acceptable.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys  = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- sessions
--
-- latest_context_tokens is a LEVEL, not a total: overwritten on each new
-- main-thread request, and reset downward by compaction. Never summed.
-- cumulative_cost_micros is the opposite — summed, never overwritten.
-- Keeping both on one row is what makes that distinction hard to get wrong.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id                        TEXT PRIMARY KEY,
  started_at                TEXT NOT NULL,
  last_seen_at              TEXT NOT NULL,
  source                    TEXT NOT NULL DEFAULT 'claude-code',
  start_type                TEXT,             -- from claude_code.session.count
  model                     TEXT,             -- most recent model seen
  task_type                 TEXT NOT NULL DEFAULT 'unset',

  -- the gauge (PRD 5.1)
  latest_context_tokens     INTEGER,          -- NULL until a main-thread request lands
  latest_context_request_id TEXT,
  latest_context_at         TEXT,

  -- the totals (PRD 5.2)
  cumulative_cost_micros    INTEGER NOT NULL DEFAULT 0,
  request_count             INTEGER NOT NULL DEFAULT 0,
  compaction_count          INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- requests — one row per api_request event
--
-- request_id is UNIQUE and is the idempotency key. OTLP exporters retry on
-- transport failure, and replaying a --jsonl capture would otherwise inflate
-- every cost total. Insert is ON CONFLICT DO NOTHING, and the session/daily
-- accumulators only advance when a row was actually inserted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS requests (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id            TEXT UNIQUE,
  session_id            TEXT NOT NULL REFERENCES sessions(id),
  ts                    TEXT NOT NULL,        -- event.timestamp, ISO 8601 UTC
  local_date            TEXT NOT NULL,        -- YYYY-MM-DD in the machine's tz
  event_sequence        INTEGER,              -- monotonic per session
  prompt_id             TEXT,

  source                TEXT NOT NULL DEFAULT 'claude-code',
  provider              TEXT NOT NULL DEFAULT 'anthropic',
  model                 TEXT,
  query_source          TEXT,                 -- raw: main | subagent | sdk | ...
  speed                 TEXT,
  terminal_type         TEXT,
  task_type             TEXT NOT NULL DEFAULT 'unset',
  project               TEXT,                 -- always NULL: not on the wire

  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,

  -- derived at ingest: input + cache_read + cache_creation (PRD 5.1).
  -- Output is excluded — it did not exist when the request was sent.
  context_tokens        INTEGER NOT NULL DEFAULT 0,

  cost_micros           INTEGER NOT NULL DEFAULT 0,
  cost_source           TEXT NOT NULL DEFAULT 'reported',
  duration_ms           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id, event_sequence);
CREATE INDEX IF NOT EXISTS idx_requests_date    ON requests(local_date);
CREATE INDEX IF NOT EXISTS idx_requests_qsource ON requests(query_source);

-- ---------------------------------------------------------------------------
-- compactions — one row per compaction event
--
-- No request_id on this event, so (session_id, event_sequence) is the
-- idempotency key. event.sequence is monotonic within a session.
-- No model field either; inherit from sessions.model when displaying.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compactions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  ts               TEXT NOT NULL,
  local_date       TEXT NOT NULL,
  event_sequence   INTEGER,
  pre_tokens       INTEGER,
  post_tokens      INTEGER,
  trigger          TEXT,                      -- manual | (auto, unconfirmed)
  success          INTEGER,                   -- 0/1, from the string "true"
  precompute_reuse TEXT,                      -- manual-only, optional
  duration_ms      INTEGER,
  UNIQUE(session_id, event_sequence)
);

-- ---------------------------------------------------------------------------
-- compaction_events — raw, unparsed compaction capture for Phase 3
--
-- The parsed `compactions` table coerces the event down to known columns; any
-- field beyond that set is lost. Automatic compaction has never been observed
-- (only trigger='manual'), so its shape is unconfirmed and may carry fields
-- `compactions` has no column for. This table keeps the event's own shape
-- intact so Phase 3 can decide how to read it, without a schema change now.
--
-- `raw_json` is the compaction attributes serialized WITHOUT coercion — strings
-- stay strings ("1403", "true"), so the wire shape is preserved verbatim.
-- One deliberate exception: the fields are still passed through the same PII
-- allowlist as everything else (P0-9). "Raw" here means un-parsed, never
-- un-filtered — no identity field reaches disk in any table, this one included.
--
-- (session_id, event_sequence) is the idempotency key, matching `compactions`,
-- so an OTLP retry or a --jsonl replay does not duplicate a capture.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compaction_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  ts               TEXT NOT NULL,        -- event.timestamp, ISO 8601 UTC
  event_sequence   INTEGER,              -- monotonic per session
  raw_json         TEXT NOT NULL,        -- allowlisted attributes, un-coerced
  UNIQUE(session_id, event_sequence)
);

-- ---------------------------------------------------------------------------
-- daily_totals — keyed by LOCAL date, so the reset lands at local midnight
-- (P0-5) rather than at UTC midnight. Maintained incrementally at ingest.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_totals (
  local_date            TEXT PRIMARY KEY,
  cost_micros           INTEGER NOT NULL DEFAULT 0,
  request_count         INTEGER NOT NULL DEFAULT 0,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- settings — user-configurable, budget included (P0-5)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
