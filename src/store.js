'use strict'

/**
 * TokenBench — Phase 2 store.
 *
 * Turns collector events into SQLite rows. Four jobs, in order of how badly
 * they fail if done wrong:
 *
 *   1. PII allowlist   — identity fields never reach disk (P0-9)
 *   2. Coercion        — the wire mixes strings and numbers per event, not per field
 *   3. Derivation      — context is a level, overwritten; cost is a total, summed
 *   4. Accumulation    — per session and per LOCAL day, in integer micros
 *
 * The schema is written from schema-observed.md, which is generated from the
 * collector's own summary. Not from the PRD.
 */

const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const path = require('node:path')
const { loadPricing, computeCostMicros, resolvePricing } = require('./pricing.js')

const SCHEMA_PATH = path.join(__dirname, 'schema.sql')
const WINDOWS_PATH = path.join(__dirname, '..', 'context-windows.json')

// ---------------------------------------------------------------------------
// 1. PII allowlist
//
// An ALLOWLIST, not a blocklist. The wire carries five identity fields, and the
// PRD's own list names only four of them — it misses `user.account_id`. A
// blocklist written from that list would have leaked it silently, forever.
//
// These sets are the ONLY route from a wire attribute to a SQL parameter. A
// field that is not named here cannot be stored, including fields Anthropic
// adds to the telemetry in some future release.
// ---------------------------------------------------------------------------

const ALLOW = {
  api_request: new Set([
    'model', 'input_tokens', 'output_tokens', 'cache_read_tokens',
    'cache_creation_tokens', 'cost_usd_micros', 'duration_ms', 'query_source',
    'request_id', 'speed', 'session.id', 'prompt.id', 'event.sequence',
    'event.timestamp', 'terminal.type',
  ]),
  compaction: new Set([
    'pre_tokens', 'post_tokens', 'trigger', 'success', 'precompute_reuse',
    'duration_ms', 'session.id', 'prompt.id', 'event.sequence',
    'event.timestamp', 'terminal.type',
  ]),
  'claude_code.session.count': new Set([
    'start_type', 'session.id', 'event.timestamp',
  ]),
}

/**
 * query_source values that ARE the main conversation thread — the ones that
 * drive the needle (PRD 5.1). Observed 2026-08-23, first interactive capture:
 * Claude Code 2.1.208 sends 'repl_main_thread' for the interactive main
 * thread — not the 'main' the PRD documents. The same session also carries
 * auxiliary calls (away_summary, generate_session_title, prompt_suggestion);
 * prompt_suggestion re-sends nearly the whole context, so size can't be the
 * discriminator — membership is. Unknown future values stay NON-driving
 * (same allowlist discipline as PII: observed values only, no guessing).
 */
const MAIN_THREAD_SOURCES = new Set(['main', 'repl_main_thread'])

/**
 * Upper edges (exclusive) for the per-request context-fit buckets — the primary
 * analytical axis (replaces the subjective per-session task label). A request's
 * context_tokens falls in bucket i if it is < CTX_BUCKET_EDGES[i]; anything
 * >= the last edge lands in the final overflow bucket (index === edges.length).
 * The thresholds map to real local-model windows: 32K/128K are common 24–35B
 * ceilings, 200K is the Claude default, 1M is frontier. Integer literals, so
 * they are injection-safe when interpolated into the bucketing CASE.
 */
const CTX_BUCKET_EDGES = [32000, 128000, 200000, 1000000]

/**
 * Known identity fields. NOT used for filtering — the allowlist above does the
 * filtering. This list exists only as a tripwire: if one of these ever makes it
 * into a value being written, something has gone badly wrong and we want a
 * loud failure rather than a quiet leak. See assertNoPii().
 */
const KNOWN_PII = [
  'user.email', 'user.id', 'user.account_uuid', 'user.account_id',
  'organization.id',
]

function pick(attrs, allowed) {
  const out = {}
  for (const k of allowed) if (k in attrs) out[k] = attrs[k]
  return out
}

function assertNoPii(attrs, picked) {
  for (const k of KNOWN_PII) {
    if (k in picked) throw new Error(`PII allowlist breach: ${k} survived pick()`)
  }
  // Value-level check: catch an identity value smuggled under a benign key.
  const identityValues = new Set(KNOWN_PII.map((k) => attrs[k]).filter((v) => typeof v === 'string' && v.length > 8))
  for (const [k, v] of Object.entries(picked)) {
    if (typeof v === 'string' && identityValues.has(v)) {
      throw new Error(`PII allowlist breach: ${k} carries an identity value`)
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Coercion
//
// The wire mixes types PER EVENT, not per field. Every api_request numeric
// arrives as a real number; every compaction numeric arrives as a string.
// `duration_ms` is a number on one event and the string "11109" on the other,
// and `success` is the string "true", never a boolean. Nothing here may assume
// a field is "already typed".
// ---------------------------------------------------------------------------

/** Wire value -> integer. Returns `fallback` for null/undefined/unparseable. */
function int(v, fallback = 0) {
  if (v === null || v === undefined) return fallback
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : fallback
  if (typeof v === 'string') {
    const n = parseInt(v, 10)
    return Number.isNaN(n) ? fallback : n
  }
  return fallback
}

/** Wire value -> 0/1. Handles the string "true" that compaction actually sends. */
function bool(v) {
  if (v === true) return 1
  if (v === false) return 0
  if (typeof v === 'string') return v.toLowerCase() === 'true' ? 1 : 0
  if (typeof v === 'number') return v ? 1 : 0
  return 0
}

function str(v) {
  return v === null || v === undefined ? null : String(v)
}

/**
 * Local calendar date for a UTC timestamp, as YYYY-MM-DD.
 *
 * The daily budget resets at LOCAL midnight (P0-5), and event.timestamp is UTC.
 * Slicing the ISO string would bucket late-evening work into tomorrow for
 * anyone west of Greenwich. Go through the Date's local getters instead.
 */
function localDate(iso) {
  const d = iso ? new Date(iso) : new Date()
  const t = Number.isNaN(d.getTime()) ? new Date() : d
  const p = (n) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
}

/**
 * Compact human label for a token count on a bucket edge: 32000 → '32K',
 * 1000000 → '1M'. Only ever fed the CTX_BUCKET_EDGES literals, so the cases
 * are exhaustive for our use; falls back to the raw number otherwise.
 */
function fmtK(n) {
  if (n >= 1000000) return `${n / 1000000}M`
  if (n >= 1000) return `${n / 1000}K`
  return String(n)
}

// ---------------------------------------------------------------------------
// Context window lookup (P0-8)
// ---------------------------------------------------------------------------

function loadContextWindows(file = WINDOWS_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed.models || {}
  } catch (e) {
    console.error(`  ! could not read ${file}: ${e.message} — all models will resolve as unknown`)
    return {}
  }
}

/**
 * Resolve a model id to its context window: exact match, then longest prefix.
 * Returns null for unknown — deliberately, so the caller renders an explicit
 * unknown state instead of a wrong percentage. There is no default.
 */
function resolveContextWindow(model, windows) {
  if (!model) return null
  if (windows[model] !== undefined) return windows[model]
  let best = null
  let bestLen = -1
  for (const [prefix, win] of Object.entries(windows)) {
    if (model.startsWith(prefix) && prefix.length > bestLen) {
      best = win
      bestLen = prefix.length
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

class Store {
  constructor(dbPath, { windowsFile = WINDOWS_PATH } = {}) {
    this.db = new DatabaseSync(dbPath)
    this.db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
    this.windows = loadContextWindows(windowsFile)
    this.pricing = loadPricing() // Phase 4: proxy cost + P1-4 reported-vs-computed
    this.stats = { requests: 0, compactions: 0, sessions: 0, duplicates: 0, skipped: 0, proxy: 0 }

    this.db
      .prepare(`INSERT INTO schema_meta(key, value) VALUES('written_from', 'schema-observed.md')
                ON CONFLICT(key) DO NOTHING`)
      .run()
    this.db
      .prepare(`INSERT INTO settings(key, value) VALUES('daily_budget_micros', '5000000')
                ON CONFLICT(key) DO NOTHING`)
      .run()

    this.#prepare()
  }

  #prepare() {
    const d = this.db
    this.q = {
      // task_type is set on INSERT only (auto/sticky default) — never touched
      // on conflict, so a label the user set survives every later event.
      upsertSession: d.prepare(`
        INSERT INTO sessions (id, started_at, last_seen_at, source, start_type, model, task_type)
        VALUES (?, ?, ?, 'claude-code', ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          start_type   = COALESCE(sessions.start_type, excluded.start_type),
          model        = COALESCE(excluded.model, sessions.model)`),

      // Phase 4: proxy requests (Jan/IDE/local) get their own sessions, keyed
      // per provider+model so the gauge reflects the latest call to each.
      upsertSessionProxy: d.prepare(`
        INSERT INTO sessions (id, started_at, last_seen_at, source, model, task_type)
        VALUES (?, ?, ?, 'proxy', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          model        = COALESCE(excluded.model, sessions.model)`),

      selSetting: d.prepare(`SELECT value FROM settings WHERE key = ?`),

      // source/provider/cost_source are parameters now: the Claude Code path
      // passes claude-code/anthropic/reported, the proxy path passes
      // proxy/<provider>/computed (or /unknown when the model isn't priced).
      insertRequest: d.prepare(`
        INSERT INTO requests (
          request_id, session_id, ts, local_date, event_sequence, prompt_id,
          source, provider, model, query_source, speed, terminal_type,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          context_tokens, cost_micros, cost_source, duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id) DO NOTHING`),

      // The gauge. Overwrite, never add. Guarded on event_sequence so a
      // late-arriving older event cannot rewind the needle.
      setContext: d.prepare(`
        UPDATE sessions
           SET latest_context_tokens     = ?,
               latest_context_request_id = ?,
               latest_context_at         = ?
         WHERE id = ?`),

      bumpSessionTotals: d.prepare(`
        UPDATE sessions
           SET cumulative_cost_micros = cumulative_cost_micros + ?,
               request_count          = request_count + 1
         WHERE id = ?`),

      bumpDaily: d.prepare(`
        INSERT INTO daily_totals (local_date, cost_micros, request_count,
                                  input_tokens, output_tokens,
                                  cache_read_tokens, cache_creation_tokens)
        VALUES (?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(local_date) DO UPDATE SET
          cost_micros           = daily_totals.cost_micros           + excluded.cost_micros,
          request_count         = daily_totals.request_count         + 1,
          input_tokens          = daily_totals.input_tokens          + excluded.input_tokens,
          output_tokens         = daily_totals.output_tokens         + excluded.output_tokens,
          cache_read_tokens     = daily_totals.cache_read_tokens     + excluded.cache_read_tokens,
          cache_creation_tokens = daily_totals.cache_creation_tokens + excluded.cache_creation_tokens`),

      insertCompaction: d.prepare(`
        INSERT INTO compactions (
          session_id, ts, local_date, event_sequence,
          pre_tokens, post_tokens, trigger, success, precompute_reuse, duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, event_sequence) DO NOTHING`),

      // Raw, un-coerced capture for Phase 3 (see schema.sql). Same idempotency
      // key as `compactions`, so it stays in lock-step under retry/replay.
      insertCompactionRaw: d.prepare(`
        INSERT INTO compaction_events (session_id, ts, event_sequence, raw_json)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, event_sequence) DO NOTHING`),

      bumpCompactionCount: d.prepare(`
        UPDATE sessions SET compaction_count = compaction_count + 1 WHERE id = ?`),

      latestSeq: d.prepare(`
        SELECT COALESCE(MAX(event_sequence), -1) AS seq FROM requests
         WHERE session_id = ? AND query_source IN ('main', 'repl_main_thread')`),
    }
  }

  /**
   * Task-type auto-default (the "I forgot to set it" fix, part 1+2).
   * New sessions start labeled: the sticky per-source choice if one was ever
   * made (settings key `task_type_default:<source>`), else the fallback —
   * 'coding-agent' for Claude Code (PRD §6), 'unset' for proxy providers
   * (the widget nudges until labeled once; after that, sticky takes over).
   * Applies to NEW sessions only — the upserts never touch task_type on
   * conflict, so a user's label is never overwritten by later events.
   */
  #defaultTaskType(sourceKey, fallback) {
    const r = this.q.selSetting.get(`task_type_default:${sourceKey}`)
    return r ? r.value : fallback
  }

  /**
   * Ingest one flattened collector record. Returns what happened, for logging.
   * Anything not in the three persisted event types is skipped by design.
   */
  ingest(rec) {
    const { kind, name, attrs } = rec
    const key = kind === 'metric' ? name : name
    if (!ALLOW[key]) {
      this.stats.skipped++
      return { action: 'skipped', name }
    }

    const picked = pick(attrs, ALLOW[key])
    assertNoPii(attrs, picked)

    if (key === 'api_request') return this.#ingestRequest(picked)
    if (key === 'compaction') return this.#ingestCompaction(picked)
    if (key === 'claude_code.session.count') return this.#ingestSessionStart(picked)
    this.stats.skipped++
    return { action: 'skipped', name }
  }

  #ingestSessionStart(a) {
    const sid = str(a['session.id'])
    if (!sid) return { action: 'skipped', name: 'session.count' }
    const ts = str(a['event.timestamp']) || new Date().toISOString()
    this.q.upsertSession.run(sid, ts, ts, str(a.start_type), null, this.#defaultTaskType('claude-code', 'coding-agent'))
    this.stats.sessions++
    return { action: 'session', sessionId: sid }
  }

  #ingestRequest(a) {
    const sid = str(a['session.id'])
    if (!sid) return { action: 'skipped', name: 'api_request' }

    const ts = str(a['event.timestamp']) || new Date().toISOString()
    const model = str(a.model)
    const querySource = str(a.query_source)
    const isMainThread = MAIN_THREAD_SOURCES.has(querySource)

    // The session's model — the gauge's DENOMINATOR (context window) — follows
    // the main thread only. Auxiliary calls (generate_session_title,
    // prompt_suggestion, away_summary) run on cheaper models; letting them
    // repoint sessions.model made an Opus session read 37.8% of haiku's 200k
    // instead of 7.6% of Opus's 1M. Observed live 2026-08-23.
    this.q.upsertSession.run(sid, ts, ts, null, isMainThread ? model : null, this.#defaultTaskType('claude-code', 'coding-agent'))

    const inputTokens = int(a.input_tokens)
    const outputTokens = int(a.output_tokens)
    const cacheRead = int(a.cache_read_tokens)
    const cacheCreation = int(a.cache_creation_tokens)

    // Derivation (PRD 5.1). Output is excluded: it did not exist when the
    // request was sent, and enters the window on the next turn instead.
    const contextTokens = inputTokens + cacheRead + cacheCreation

    const costMicros = int(a.cost_usd_micros)
    const seq = int(a['event.sequence'], -1)
    const day = localDate(ts)
    const requestId = str(a.request_id)

    const res = this.q.insertRequest.run(
      requestId, sid, ts, day, seq, str(a['prompt.id']),
      'claude-code', 'anthropic', model, querySource, str(a.speed), str(a['terminal.type']),
      inputTokens, outputTokens, cacheRead, cacheCreation,
      contextTokens, costMicros, 'reported', int(a.duration_ms, null)
    )

    // Idempotency: a retried or replayed event must not inflate any total.
    if (res.changes === 0) {
      this.stats.duplicates++
      return { action: 'duplicate', requestId, sessionId: sid }
    }

    this.stats.requests++
    this.q.bumpSessionTotals.run(costMicros, sid)
    this.q.bumpDaily.run(day, costMicros, inputTokens, outputTokens, cacheRead, cacheCreation)

    // The needle follows the main thread only (PRD 5.1). Subagent and SDK
    // requests carry their own context, which is not the main thread's; letting
    // them drive the gauge makes it jump between unrelated conversations.
    let droveGauge = false
    if (isMainThread) {
      const { seq: lastSeq } = this.q.latestSeq.get(sid)
      if (seq >= lastSeq) {
        this.q.setContext.run(contextTokens, requestId, ts, sid)
        droveGauge = true
      }
    }

    return {
      action: 'request', requestId, sessionId: sid, model, querySource,
      contextTokens, costMicros, droveGauge,
      contextWindow: resolveContextWindow(model, this.windows),
    }
  }

  #ingestCompaction(a) {
    const sid = str(a['session.id'])
    if (!sid) return { action: 'skipped', name: 'compaction' }

    const ts = str(a['event.timestamp']) || new Date().toISOString()
    this.q.upsertSession.run(sid, ts, ts, null, null, this.#defaultTaskType('claude-code', 'coding-agent'))

    const preTokens = int(a.pre_tokens, null)
    const postTokens = int(a.post_tokens, null)
    const success = bool(a.success) // arrives as the STRING "true"
    const seq = int(a['event.sequence'], -1)

    // Raw capture for Phase 3 (schema.sql). `a` is the already-allowlisted
    // picked object — PII was dropped in ingest() before we got here — so this
    // is un-coerced but never un-filtered. Idempotent on its own key, so a
    // replay is a no-op independent of the parsed insert below.
    this.q.insertCompactionRaw.run(sid, ts, seq, JSON.stringify(a))

    const res = this.q.insertCompaction.run(
      sid, ts, localDate(ts), seq,
      preTokens, postTokens, str(a.trigger), success,
      str(a.precompute_reuse), int(a.duration_ms, null)
    )
    if (res.changes === 0) {
      this.stats.duplicates++
      return { action: 'duplicate', sessionId: sid }
    }

    this.stats.compactions++
    this.q.bumpCompactionCount.run(sid)

    // The needle drops (PRD 5.3). Only on success — a failed compaction did
    // not shrink the window, so the level must stand.
    if (success && postTokens !== null) {
      this.q.setContext.run(postTokens, null, ts, sid)
    }

    return {
      action: 'compaction', sessionId: sid, preTokens, postTokens,
      trigger: str(a.trigger), success: !!success,
    }
  }

  // -------------------------------------------------------------------------
  // Phase 4 — proxy ingest (PRD 4.2). No OTLP, no PII: proxy records carry
  // token counts and a model, never identity. Cost is COMPUTED from the pricing
  // table (the proxy path reports none), stored as integer micros exactly like
  // the reported path. Same accumulators, so session/daily totals mix cleanly.
  // -------------------------------------------------------------------------
  ingestProxyRequest(rec) {
    const requestId = str(rec.requestId)
    const provider = str(rec.provider) || 'openai'
    const model = str(rec.model)
    if (!requestId) return { action: 'skipped', name: 'proxy' }

    const ts = str(rec.ts) || new Date().toISOString()
    // One session per provider+model so the gauge tracks the latest call to it.
    const sid = str(rec.sessionId) || `proxy:${provider}:${model || 'unknown'}`
    this.q.upsertSessionProxy.run(sid, ts, ts, model, this.#defaultTaskType(`proxy:${provider}`, 'unset'))

    const inputTokens = int(rec.inputTokens)
    const outputTokens = int(rec.outputTokens)
    const cacheRead = int(rec.cacheReadTokens)
    const cacheCreation = int(rec.cacheCreationTokens)
    const contextTokens = inputTokens + cacheRead + cacheCreation

    const cost = computeCostMicros(
      { model, provider, inputTokens, outputTokens, cacheReadTokens: cacheRead, cacheCreationTokens: cacheCreation },
      this.pricing,
      rec.cacheTtl // undefined -> defaults to 1h in computeCostMicros
    )
    const day = localDate(ts)
    const seq = int(rec.seq, -1)

    const res = this.q.insertRequest.run(
      requestId, sid, ts, day, seq, null,
      'proxy', provider, model, 'main', null, null,
      inputTokens, outputTokens, cacheRead, cacheCreation,
      contextTokens, cost.micros, cost.known ? 'computed' : 'unknown', int(rec.durationMs, null)
    )
    if (res.changes === 0) {
      this.stats.duplicates++
      return { action: 'duplicate', requestId, sessionId: sid }
    }

    this.stats.proxy++
    this.q.bumpSessionTotals.run(cost.micros, sid)
    this.q.bumpDaily.run(day, cost.micros, inputTokens, outputTokens, cacheRead, cacheCreation)
    // Proxy requests are their own main thread, so they always drive their gauge.
    this.q.setContext.run(contextTokens, requestId, ts, sid)

    return {
      action: 'proxy', requestId, sessionId: sid, provider, model,
      contextTokens, costMicros: cost.micros, costKnown: cost.known,
      contextWindow: resolveContextWindow(model, this.windows),
    }
  }

  /**
   * P1-4: recompute a stored request's cost from the pricing table and return it
   * alongside the figure actually stored. For a Claude Code row (cost reported by
   * the API) the two should match — that is how the table gets validated before
   * the proxy path has to rely on it. Returns null when the model isn't priced.
   */
  computedVsStored(row) {
    const price = resolvePricing(row.model, this.pricing.models)
    if (!price) return null
    const provider = row.source === 'proxy' ? row.provider : 'anthropic'
    const { micros, known } = computeCostMicros(
      {
        model: row.model, provider,
        inputTokens: row.input_tokens, outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens, cacheCreationTokens: row.cache_creation_tokens,
      },
      this.pricing
    )
    if (!known) return null
    return { computed: micros, stored: row.cost_micros, delta: micros - row.cost_micros }
  }

  // -------------------------------------------------------------------------
  // Read side — no UI, but Phase 2 has to be verifiable against `/cost`.
  // -------------------------------------------------------------------------

  getSession(id) {
    const s = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
    if (!s) return null
    return this.#decorate(s)
  }

  getActiveSession() {
    const s = this.db.prepare('SELECT * FROM sessions ORDER BY last_seen_at DESC LIMIT 1').get()
    return s ? this.#decorate(s) : null
  }

  #decorate(s) {
    const win = resolveContextWindow(s.model, this.windows)
    return {
      ...s,
      contextWindow: win,
      // Explicit unknown state (P0-8): a token count with no percentage,
      // rather than a percentage against a guessed window.
      gaugePercent: win && s.latest_context_tokens != null
        ? s.latest_context_tokens / win
        : null,
      windowKnown: win !== null,
    }
  }

  getDaily(day = localDate()) {
    const row = this.db.prepare('SELECT * FROM daily_totals WHERE local_date = ?').get(day)
    const budget = int(this.getSetting('daily_budget_micros'), 0)
    const spent = row ? row.cost_micros : 0
    return {
      local_date: day,
      cost_micros: spent,
      request_count: row ? row.request_count : 0,
      input_tokens: row ? row.input_tokens : 0,
      output_tokens: row ? row.output_tokens : 0,
      cache_read_tokens: row ? row.cache_read_tokens : 0,
      cache_creation_tokens: row ? row.cache_creation_tokens : 0,
      budget_micros: budget,
      budget_fraction: budget ? spent / budget : null,
    }
  }

  /**
   * Everything the widget needs in one call (PRD §6), assembled read-side so the
   * gauge math lives in exactly one place. The needle and the cache split both
   * come from the SAME request — the latest main-thread one — so they can never
   * disagree on screen.
   */
  getWidgetState() {
    const session = this.getActiveSession()

    // Cache split (PRD §6 line 6): cached = cache_read, fresh = input +
    // cache_creation. The three sum to context_tokens (the gauge), so the split
    // shown under the dial always adds up to the number on the dial.
    let split = null
    if (session && session.latest_context_request_id) {
      const r = this.db
        .prepare('SELECT input_tokens, cache_read_tokens, cache_creation_tokens FROM requests WHERE request_id = ?')
        .get(session.latest_context_request_id)
      if (r) split = { cached: r.cache_read_tokens, fresh: r.input_tokens + r.cache_creation_tokens }
    }

    const daily = this.getDaily()

    // ACTIVE sessions (PRD Q4): seen in the last 30 minutes — a lifetime count
    // only ever grows and answers nothing. The widget's pill shows this count
    // and lists these sessions on click.
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    const activeSessions = this.db
      .prepare(`SELECT id, source, model, task_type, cumulative_cost_micros,
                       latest_context_tokens, last_seen_at
                  FROM sessions WHERE last_seen_at >= ?
                 ORDER BY last_seen_at DESC LIMIT 6`)
      .all(cutoff)
    const sessionCount = activeSessions.length

    // Today, per source/provider (the Jan-first panel). For local models cost
    // is always $0, so the row carries tokens + tokens/sec instead (P1-3) —
    // throughput is the number that matters when the constraint is hardware.
    const todayBySource = this.db
      .prepare(`SELECT source, provider, COUNT(*) AS requests,
                       SUM(cost_micros) AS cost_micros,
                       SUM(output_tokens) AS output_tokens,
                       SUM(duration_ms) AS duration_ms,
                       SUM(CASE WHEN cost_source = 'unknown' THEN 1 ELSE 0 END) AS unpriced
                  FROM requests WHERE local_date = ?
                 GROUP BY source, provider ORDER BY cost_micros DESC`)
      .all(daily.local_date)
      .map((r) => ({
        ...r,
        toksPerSec: r.duration_ms > 0 ? Math.round((r.output_tokens / (r.duration_ms / 1000)) * 10) / 10 : null,
      }))

    return { session, split, daily, sessionCount, activeSessions, todayBySource, now: new Date().toISOString() }
  }

  /**
   * Manual task-type override (P1-2), persisted on the session row. Constrained
   * to the five known types; anything else falls back to 'unset' rather than
   * writing a junk value the dashboard would later have to special-case.
   *
   * Relabeling is RETROACTIVE by design (it's a session-level column), and the
   * choice becomes STICKY: it's remembered per source (claude-code, or per
   * proxy provider) so the NEXT session from that source starts with it —
   * label a Jan session once and future Jan sessions inherit the label.
   */
  setTaskType(sessionId, taskType) {
    const allowed = new Set(['coding-agent', 'product-brainstorm', 'business-brainstorm', 'general', 'unset'])
    const t = allowed.has(taskType) ? taskType : 'unset'
    const res = this.db.prepare('UPDATE sessions SET task_type = ? WHERE id = ?').run(t, sessionId)
    if (res.changes === 0) return null

    const sess = this.db.prepare('SELECT id, source FROM sessions WHERE id = ?').get(sessionId)
    let key = null
    if (sess.source === 'claude-code') key = 'claude-code'
    else if (sess.source === 'proxy') {
      // Provider from the conventional id `proxy:<provider>:<model>`, else from
      // the session's rows (covers caller-supplied session ids).
      const m = sess.id.match(/^proxy:([^:]+):/)
      const provider = m
        ? m[1]
        : (this.db.prepare('SELECT provider FROM requests WHERE session_id = ? LIMIT 1').get(sessionId) || {}).provider
      if (provider) key = `proxy:${provider}`
    }
    if (key) this.setSetting(`task_type_default:${key}`, t)
    return t
  }

  /**
   * Dashboard aggregates (the app's identity: task-aware cost). One call, one
   * JSON payload: daily cost stacked by task type, per-task totals, per-model
   * totals — all scoped to the last `days` LOCAL dates so every chart and tile
   * agrees on the same slice.
   */
  getDashboardData(days = 14) {
    const d = Math.max(1, Math.min(365, int(days, 14)))
    const dates = []
    const now = Date.now()
    for (let i = d - 1; i >= 0; i--) dates.push(localDate(new Date(now - i * 86400000).toISOString()))
    const from = dates[0]

    const dailyByTask = this.db
      .prepare(`SELECT r.local_date, s.task_type, SUM(r.cost_micros) AS cost_micros, COUNT(*) AS requests
                  FROM requests r JOIN sessions s ON s.id = r.session_id
                 WHERE r.local_date >= ? GROUP BY r.local_date, s.task_type`)
      .all(from)

    const byTask = this.db
      .prepare(`SELECT s.task_type, COUNT(*) AS requests, COUNT(DISTINCT r.session_id) AS sessions,
                       SUM(r.cost_micros) AS cost_micros,
                       SUM(r.input_tokens) AS input_tokens, SUM(r.output_tokens) AS output_tokens,
                       SUM(r.cache_read_tokens) AS cache_read_tokens,
                       SUM(r.cache_creation_tokens) AS cache_creation_tokens,
                       MAX(r.context_tokens) AS peak_context
                  FROM requests r JOIN sessions s ON s.id = r.session_id
                 WHERE r.local_date >= ? GROUP BY s.task_type ORDER BY cost_micros DESC`)
      .all(from)

    const byModel = this.db
      .prepare(`SELECT r.model, r.provider, r.source, COUNT(*) AS requests,
                       SUM(r.cost_micros) AS cost_micros,
                       SUM(r.input_tokens + r.cache_read_tokens + r.cache_creation_tokens) AS in_tokens,
                       SUM(r.output_tokens) AS output_tokens, SUM(r.duration_ms) AS duration_ms,
                       SUM(CASE WHEN r.cost_source = 'unknown' THEN 1 ELSE 0 END) AS unpriced
                  FROM requests r WHERE r.local_date >= ?
                 GROUP BY r.model, r.provider ORDER BY cost_micros DESC`)
      .all(from)
      .map((r) => ({
        ...r,
        toksPerSec: r.duration_ms > 0 ? Math.round((r.output_tokens / (r.duration_ms / 1000)) * 10) / 10 : null,
      }))

    const totals = this.db
      .prepare(`SELECT COALESCE(SUM(cost_micros),0) AS cost_micros, COUNT(*) AS requests,
                       COALESCE(SUM(output_tokens),0) AS output_tokens,
                       COALESCE(SUM(input_tokens + cache_read_tokens + cache_creation_tokens),0) AS in_tokens
                  FROM requests WHERE local_date >= ?`)
      .get(from)

    // Daily cost stacked by SOURCE (objective) rather than task label. The
    // daily trend is still useful; only its old stacking axis (task_type) was
    // broken. source+provider ('claude-code' / 'proxy'+'openai' / 'proxy'+'local'…)
    // is a fact off the wire, not a guess.
    const dailyBySource = this.db
      .prepare(`SELECT r.local_date, r.source, r.provider,
                       SUM(r.cost_micros) AS cost_micros, COUNT(*) AS requests
                  FROM requests r WHERE r.local_date >= ?
                 GROUP BY r.local_date, r.source, r.provider`)
      .all(from)

    // PRIMARY axis — per-request context-fit distribution. Every request is
    // bucketed by its own context_tokens; we report BOTH request count and cost
    // per bucket (a few huge-context requests can dominate spend while most
    // requests sit small). Objective, label-free, works on existing data.
    // Counts ALL requests (main + subagent + aux): every model round-trip is
    // real work carrying its own context. (A main-thread-only variant would add
    //   AND query_source IN ('main','repl_main_thread')
    // — not built now.)
    const bucketExpr =
      'CASE ' +
      CTX_BUCKET_EDGES.map((e, i) => `WHEN context_tokens < ${e} THEN ${i}`).join(' ') +
      ` ELSE ${CTX_BUCKET_EDGES.length} END`
    const contextFitRows = this.db
      .prepare(`SELECT ${bucketExpr} AS bucket,
                       COUNT(*) AS requests,
                       COALESCE(SUM(cost_micros),0) AS cost_micros,
                       COALESCE(SUM(output_tokens),0) AS output_tokens
                  FROM requests WHERE local_date >= ?
                 GROUP BY bucket ORDER BY bucket`)
      .all(from)
    // Densify to all N+1 buckets (emit empties) so the chart axis is stable
    // across date ranges, and attach a human label per bucket.
    const ctxLabels = [
      ...CTX_BUCKET_EDGES.map((e, i) => `${i === 0 ? '0' : fmtK(CTX_BUCKET_EDGES[i - 1])}–${fmtK(e)}`),
      `>${fmtK(CTX_BUCKET_EDGES[CTX_BUCKET_EDGES.length - 1])}`,
    ]
    const byBucket = Object.fromEntries(contextFitRows.map((r) => [r.bucket, r]))
    const contextFit = ctxLabels.map((label, i) => ({
      bucket: i,
      label,
      requests: byBucket[i] ? byBucket[i].requests : 0,
      cost_micros: byBucket[i] ? byBucket[i].cost_micros : 0,
      output_tokens: byBucket[i] ? byBucket[i].output_tokens : 0,
    }))

    // SECONDARY — period token anatomy. One row, four numbers: what the token
    // spend is actually made of. Makes the cheap-cache-read majority visible
    // (the largest hidden factor in coding-agent cost, PRD goal #2).
    const tokenAnatomy = this.db
      .prepare(`SELECT COALESCE(SUM(input_tokens),0)          AS fresh_input,
                       COALESCE(SUM(cache_read_tokens),0)     AS cache_read,
                       COALESCE(SUM(cache_creation_tokens),0) AS cache_creation,
                       COALESCE(SUM(output_tokens),0)         AS output
                  FROM requests WHERE local_date >= ?`)
      .get(from)

    // TERTIARY (PROXY, not truth) — agentic intensity as round-trips per user
    // prompt. Rests on the verified fact that Claude Code reuses one prompt.id
    // across the api_requests of a turn's tool loop, so COUNT(*) GROUP BY
    // prompt_id === model round-trips for one user ask. Claude Code only:
    // proxy rows carry prompt_id = NULL and are excluded. If the wire ever
    // stopped reusing prompt.id this degrades to all-ones (honest, not faked).
    const agenticIntensity = this.db
      .prepare(`SELECT rt.round_trips,
                       COUNT(*)             AS prompts,
                       SUM(rt.cost_micros)  AS cost_micros
                  FROM (SELECT prompt_id,
                               COUNT(*)          AS round_trips,
                               SUM(cost_micros)  AS cost_micros
                          FROM requests
                         WHERE local_date >= ? AND source = 'claude-code'
                           AND prompt_id IS NOT NULL
                         GROUP BY prompt_id) rt
                 GROUP BY rt.round_trips ORDER BY rt.round_trips`)
      .all(from)

    return {
      days: d, from, to: dates[dates.length - 1], dates,
      dailyByTask, dailyBySource, byTask, byModel, totals,
      contextFit, tokenAnatomy, agenticIntensity, ctxBucketEdges: CTX_BUCKET_EDGES,
      today: this.getDaily(),
      budget_micros: int(this.getSetting('daily_budget_micros'), 0),
    }
  }

  getSetting(key) {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
    return r ? r.value : null
  }

  setSetting(key, value) {
    this.db
      .prepare(`INSERT INTO settings(key, value) VALUES(?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, String(value))
  }

  close() {
    this.db.close()
  }
}

module.exports = {
  Store,
  MAIN_THREAD_SOURCES,
  CTX_BUCKET_EDGES,
  // exported for tests
  int, bool, localDate, fmtK, pick, assertNoPii, resolveContextWindow,
  loadContextWindows, ALLOW, KNOWN_PII,
}
