'use strict'

/**
 * Phase 2 tests. Run: node src/test.js [fixture.jsonl]
 *
 * The fixtures are real captured records, not hand-written ones — the point of
 * Phase 1 was to stop trusting the spec, and a hand-written fixture would
 * quietly reintroduce the spec's assumptions.
 *
 * One edit was made to the capture: the five identity VALUES are replaced with
 * same-shaped synthetic ones, so this repo never carries a real account id or
 * email. Field names, field presence, and value TYPES are untouched — those are
 * what the tests actually assert on.
 */

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { Store, int, bool, localDate, resolveContextWindow, CTX_BUCKET_EDGES } = require('./store.js')
const { loadPricing, resolvePricing, computeCostMicros } = require('./pricing.js')

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    console.log(`  \x1b[32mok\x1b[0m   ${name}`)
    passed++
  } catch (e) {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}\n       ${e.message}`)
    failed++
  }
}

function tmpDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-test-')), 'tb.db')
}

// Captured from the wire 2026-08-20; identity values synthetic, types verbatim.
const REAL_API_REQUEST = {
  'user.id': '0000000000000000000000000000000000000000000000000000000000000000',
  'session.id': '12fb14f6-e715-4aa3-b6b6-6ab40d4c9d51',
  'organization.id': '22222222-2222-4222-8222-222222222222',
  'user.email': 'user@example.invalid',
  'user.account_uuid': '11111111-1111-4111-8111-111111111111',
  'user.account_id': 'user_00000000000000000000000',
  'terminal.type': 'non-interactive',
  'event.timestamp': '2026-08-20T04:54:19.281Z',
  'event.sequence': 16,
  'prompt.id': '987206be-a400-4b39-a689-b3b792a27719',
  model: 'claude-haiku-4-5-20251001',
  input_tokens: 10,
  output_tokens: 44,
  cache_read_tokens: 0,
  cache_creation_tokens: 27541,
  cost_usd: 0.055312,
  cost_usd_micros: 55312,
  duration_ms: 1339,
  request_id: 'req_011CeDQMKnn8NtLCTxYc9Zod',
  speed: 'normal',
  query_source: 'sdk',
}

// Same. Note every numeric is a STRING on this event, and success is "true".
const REAL_COMPACTION = {
  'user.id': '0000000000000000000000000000000000000000000000000000000000000000',
  'session.id': '12fb14f6-e715-4aa3-b6b6-6ab40d4c9d51',
  'organization.id': '22222222-2222-4222-8222-222222222222',
  'user.email': 'user@example.invalid',
  'user.account_uuid': '11111111-1111-4111-8111-111111111111',
  'user.account_id': 'user_00000000000000000000000',
  'terminal.type': 'non-interactive',
  'event.timestamp': '2026-08-20T04:54:35.335Z',
  'event.sequence': 22,
  'prompt.id': 'a90a183b-617f-4ac4-8671-2f6c0deb33ad',
  trigger: 'manual',
  success: 'true',
  duration_ms: '11109',
  pre_tokens: '3273',
  post_tokens: '1403',
  precompute_reuse: 'miss_not_ready',
}

const req = (over = {}) => ({ kind: 'log', name: 'api_request', attrs: { ...REAL_API_REQUEST, ...over } })
const comp = (over = {}) => ({ kind: 'log', name: 'compaction', attrs: { ...REAL_COMPACTION, ...over } })

console.log('\ncoercion — the wire mixes types per event, not per field')

test('int() parses the strings compaction actually sends', () => {
  assert.strictEqual(int('3273'), 3273)
  assert.strictEqual(int('11109'), 11109)
})
test('int() passes through the numbers api_request actually sends', () => {
  assert.strictEqual(int(27541), 27541)
})
test('int() does not concatenate — the failure OTLP string ints invite', () => {
  assert.strictEqual(int('10') + int('20'), 30)
})
test('int() falls back for missing fields', () => {
  assert.strictEqual(int(undefined), 0)
  assert.strictEqual(int(null, null), null)
})
test('bool() handles the string "true" compaction sends', () => {
  assert.strictEqual(bool('true'), 1)
  assert.strictEqual(bool('false'), 0)
  // The PRD assumes a boolean. Support it too, in case the wire ever changes.
  assert.strictEqual(bool(true), 1)
})

console.log('\nPII allowlist (P0-9)')

test('no identity column survives ingest', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(req())
  s.ingest(comp())
  const row = s.db.prepare('SELECT * FROM requests LIMIT 1').get()
  for (const k of Object.keys(row)) {
    assert.ok(!/email|user|account|organization/i.test(k), `identity-shaped column: ${k}`)
  }
  s.close()
})

test('acceptance: identity values are absent from the DB file on disk', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(req())
  s.ingest(comp())
  s.ingest({ kind: 'metric', name: 'claude_code.session.count', attrs: REAL_API_REQUEST })
  s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  s.close()
  // Read every byte SQLite wrote, WAL and all, and look for the real values.
  const bytes = [db, `${db}-wal`, `${db}-shm`]
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f).toString('latin1'))
    .join('')
  for (const secret of [
    'user@example.invalid',
    '0000000000000000000000000000000000000000000000000000000000000000',
    '11111111-1111-4111-8111-111111111111',
    'user_00000000000000000000000',
    '22222222-2222-4222-8222-222222222222',
  ]) {
    assert.ok(!bytes.includes(secret), `identity value reached disk: ${secret.slice(0, 24)}…`)
  }
})

test('user.account_id is caught — the field the PRD list omits', () => {
  const { pick, ALLOW } = require('./store.js')
  const picked = pick(REAL_API_REQUEST, ALLOW.api_request)
  assert.ok(!('user.account_id' in picked))
})

test('a future identity field is excluded by default', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(req({ 'user.real_name': 'Sumin Kim', new_pii_field_2027: 'whatever' }))
  const row = s.db.prepare('SELECT * FROM requests LIMIT 1').get()
  assert.ok(!Object.keys(row).some((k) => k.includes('real_name') || k.includes('2027')))
  s.close()
})

console.log('\ncontext derivation (PRD 5.1)')

test('context = input + cacheRead + cacheCreation, output excluded', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(req())
  const r = s.db.prepare('SELECT * FROM requests LIMIT 1').get()
  assert.strictEqual(r.context_tokens, 10 + 0 + 27541)
  assert.ok(!String(r.context_tokens).includes(String(r.output_tokens)))
  s.close()
})

test('context is a LEVEL — five turns never sum (P0-2)', () => {
  const db = tmpDb()
  const s = new Store(db)
  const levels = [20000, 40000, 60000, 80000, 100000]
  levels.forEach((lvl, i) => {
    s.ingest(req({
      query_source: 'main',
      request_id: `req_turn_${i}`,
      'event.sequence': 10 + i,
      input_tokens: 0, cache_read_tokens: lvl, cache_creation_tokens: 0,
    }))
  })
  const sess = s.getSession(REAL_API_REQUEST['session.id'])
  assert.strictEqual(sess.latest_context_tokens, 100000, 'should be the latest, not a sum')
  assert.notStrictEqual(sess.latest_context_tokens, levels.reduce((a, b) => a + b, 0))
  assert.strictEqual(sess.request_count, 5)
  s.close()
})

test('only main-thread requests move the needle (PRD 5.1)', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(req({ query_source: 'main', request_id: 'r_main', 'event.sequence': 1, cache_read_tokens: 50000, input_tokens: 0, cache_creation_tokens: 0 }))
  s.ingest(req({ query_source: 'subagent', request_id: 'r_sub', 'event.sequence': 2, cache_read_tokens: 999999, input_tokens: 0, cache_creation_tokens: 0 }))
  s.ingest(req({ query_source: 'sdk', request_id: 'r_sdk', 'event.sequence': 3, cache_read_tokens: 888888, input_tokens: 0, cache_creation_tokens: 0 }))
  const sess = s.getSession(REAL_API_REQUEST['session.id'])
  assert.strictEqual(sess.latest_context_tokens, 50000)
  assert.strictEqual(sess.request_count, 3, 'but all three are still stored')
  s.close()
})

test('repl_main_thread drives the needle (the value the interactive wire actually sends)', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(req({ query_source: 'repl_main_thread', request_id: 'r_repl', 'event.sequence': 5, cache_read_tokens: 68000, input_tokens: 500, cache_creation_tokens: 0 }))
  assert.strictEqual(s.getSession(REAL_API_REQUEST['session.id']).latest_context_tokens, 68500)
  s.close()
})

test('auxiliary sources never drive the needle — even context-sized ones', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(req({ query_source: 'repl_main_thread', request_id: 'r_m', 'event.sequence': 1, cache_read_tokens: 50000, input_tokens: 0, cache_creation_tokens: 0 }))
  // prompt_suggestion re-sends ~the whole context; it must still not move the needle
  s.ingest(req({ query_source: 'prompt_suggestion', request_id: 'r_ps', 'event.sequence': 2, cache_read_tokens: 69000, input_tokens: 0, cache_creation_tokens: 0 }))
  s.ingest(req({ query_source: 'generate_session_title', request_id: 'r_t', 'event.sequence': 3, cache_read_tokens: 4000, input_tokens: 0, cache_creation_tokens: 0 }))
  s.ingest(req({ query_source: 'away_summary', request_id: 'r_a', 'event.sequence': 4, cache_read_tokens: 68000, input_tokens: 0, cache_creation_tokens: 0 }))
  const sess = s.getSession(REAL_API_REQUEST['session.id'])
  assert.strictEqual(sess.latest_context_tokens, 50000, 'needle stays on the main thread')
  assert.strictEqual(sess.request_count, 4, 'but all four are stored and billed')
  s.close()
})

test('auxiliary calls on cheaper models do not repoint the session model (gauge denominator)', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(req({ query_source: 'repl_main_thread', model: 'claude-opus-4-8', request_id: 'r_m2', 'event.sequence': 1, cache_read_tokens: 75000, input_tokens: 0, cache_creation_tokens: 0 }))
  // haiku title-generation call on the SAME session must not change the window
  s.ingest(req({ query_source: 'generate_session_title', model: 'claude-haiku-4-5-20251001', request_id: 'r_t2', 'event.sequence': 2 }))
  const sess = s.getSession(REAL_API_REQUEST['session.id'])
  assert.strictEqual(sess.model, 'claude-opus-4-8', 'session model follows the main thread')
  assert.strictEqual(sess.contextWindow, 1000000, 'gauge measured against the main model window')
  s.close()
})

test('an out-of-order older event cannot rewind the needle', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(req({ query_source: 'main', request_id: 'r_new', 'event.sequence': 50, cache_read_tokens: 90000, input_tokens: 0, cache_creation_tokens: 0 }))
  s.ingest(req({ query_source: 'main', request_id: 'r_old', 'event.sequence': 5, cache_read_tokens: 100, input_tokens: 0, cache_creation_tokens: 0 }))
  assert.strictEqual(s.getSession(REAL_API_REQUEST['session.id']).latest_context_tokens, 90000)
  s.close()
})

console.log('\ncompaction (PRD 5.3) — against the real event shape')

test('needle drops to post_tokens, parsed from strings', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(req({ query_source: 'main', request_id: 'r1', 'event.sequence': 1, cache_read_tokens: 180000, input_tokens: 0, cache_creation_tokens: 0 }))
  assert.strictEqual(s.getSession(REAL_COMPACTION['session.id']).latest_context_tokens, 180000)
  s.ingest(comp())
  const sess = s.getSession(REAL_COMPACTION['session.id'])
  assert.strictEqual(sess.latest_context_tokens, 1403, 'must be the integer 1403, not "1403"')
  assert.strictEqual(sess.compaction_count, 1)
  s.close()
})

test('a failed compaction does not drop the needle', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(req({ query_source: 'main', request_id: 'r1', 'event.sequence': 1, cache_read_tokens: 180000, input_tokens: 0, cache_creation_tokens: 0 }))
  s.ingest(comp({ success: 'false', 'event.sequence': 9 }))
  assert.strictEqual(s.getSession(REAL_COMPACTION['session.id']).latest_context_tokens, 180000)
  s.close()
})

test('optional fields absent (unconfirmed automatic shape) still stores', () => {
  const db = tmpDb()
  const s = new Store(db)
  const attrs = { ...REAL_COMPACTION, trigger: 'auto', 'event.sequence': 77 }
  delete attrs.precompute_reuse
  delete attrs.duration_ms
  const r = s.ingest({ kind: 'log', name: 'compaction', attrs })
  assert.strictEqual(r.action, 'compaction')
  assert.strictEqual(r.postTokens, 1403)
  s.close()
})

console.log('\ncompaction_events — raw, un-coerced capture for Phase 3')

test('a raw row is written, and it is NOT coerced (strings stay strings)', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(comp())
  const raw = s.db.prepare('SELECT * FROM compaction_events LIMIT 1').get()
  assert.ok(raw, 'a compaction_events row exists')
  assert.strictEqual(raw.session_id, REAL_COMPACTION['session.id'])
  assert.strictEqual(raw.event_sequence, 22)
  const parsed = JSON.parse(raw.raw_json)
  // The point of the raw table: the wire shape is preserved verbatim, so
  // Phase 3 can decide how to read it. post_tokens is still the STRING "1403",
  // not the integer the parsed `compactions` table coerced it to.
  assert.strictEqual(parsed.post_tokens, '1403')
  assert.strictEqual(parsed.success, 'true')
  s.close()
})

test('the raw capture carries no PII either (P0-9 holds in every table)', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(comp())
  const raw = s.db.prepare('SELECT raw_json FROM compaction_events LIMIT 1').get()
  const parsed = JSON.parse(raw.raw_json)
  for (const k of Object.keys(parsed)) {
    assert.ok(!/email|user|account|organization/i.test(k), `identity-shaped key in raw_json: ${k}`)
  }
  for (const secret of [
    'user@example.invalid', 'user_00000000000000000000000',
    '11111111-1111-4111-8111-111111111111',
  ]) {
    assert.ok(!raw.raw_json.includes(secret), 'identity value leaked into raw_json')
  }
  s.close()
})

test('a replayed compaction does not duplicate the raw row (idempotent)', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(comp())
  s.ingest(comp()) // OTLP retry / --jsonl replay, same (session, sequence)
  const n = s.db.prepare('SELECT COUNT(*) AS n FROM compaction_events').get().n
  assert.strictEqual(n, 1)
  s.close()
})

console.log('\ncost accumulation (P0-3)')

test('cost_usd_micros is stored as an integer, not float dollars', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(req())
  const r = s.db.prepare('SELECT cost_micros FROM requests LIMIT 1').get()
  assert.strictEqual(r.cost_micros, 55312)
  assert.ok(Number.isInteger(r.cost_micros))
  s.close()
})

test('session and daily totals sum, and stay exact over many rows', () => {
  const db = tmpDb()
  const s = new Store(db)
  for (let i = 0; i < 1000; i++) {
    s.ingest(req({ request_id: `r${i}`, 'event.sequence': i, cost_usd_micros: 55312 }))
  }
  const sess = s.getSession(REAL_API_REQUEST['session.id'])
  assert.strictEqual(sess.cumulative_cost_micros, 55312 * 1000)
  const day = s.getDaily(localDate(REAL_API_REQUEST['event.timestamp']))
  assert.strictEqual(day.cost_micros, 55312 * 1000)
  assert.strictEqual(day.request_count, 1000)
  s.close()
})

test('a replayed event does not inflate any total (idempotency)', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(req())
  s.ingest(req()) // same request_id — an OTLP retry, or a --jsonl replay
  s.ingest(comp())
  s.ingest(comp())
  const sess = s.getSession(REAL_API_REQUEST['session.id'])
  assert.strictEqual(sess.request_count, 1)
  assert.strictEqual(sess.cumulative_cost_micros, 55312)
  assert.strictEqual(sess.compaction_count, 1)
  assert.strictEqual(s.getDaily(localDate(REAL_API_REQUEST['event.timestamp'])).request_count, 1)
  s.close()
})

test('daily totals bucket by LOCAL date, not UTC date', () => {
  // 02:30 UTC is the previous local day anywhere west of Greenwich.
  const d = localDate('2026-08-20T02:30:00.000Z')
  const expected = new Date('2026-08-20T02:30:00.000Z')
  const p = (n) => String(n).padStart(2, '0')
  assert.strictEqual(d, `${expected.getFullYear()}-${p(expected.getMonth() + 1)}-${p(expected.getDate())}`)
})

console.log('\ncontext window table (P0-8)')

test('dated model id resolves by longest prefix', () => {
  const w = { 'claude-haiku-4-5': 200000, 'claude-sonnet-4': 200000, 'claude-sonnet-4-5': 500000 }
  assert.strictEqual(resolveContextWindow('claude-haiku-4-5-20251001', w), 200000)
  assert.strictEqual(resolveContextWindow('claude-sonnet-4-5-20260101', w), 500000, 'longest prefix must win')
})

test('unknown model resolves to null, never a guess', () => {
  assert.strictEqual(resolveContextWindow('some-local-llama-7b', { 'claude-haiku-4-5': 200000 }), null)
})

test('unknown model yields no gauge percentage', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(req({ model: 'jan-local-qwen-3b', query_source: 'main', request_id: 'rx', 'event.sequence': 1 }))
  const sess = s.getSession(REAL_API_REQUEST['session.id'])
  assert.strictEqual(sess.contextWindow, null)
  assert.strictEqual(sess.gaugePercent, null, 'must be null, not 0 and not a guess')
  assert.strictEqual(sess.windowKnown, false)
  assert.ok(sess.latest_context_tokens > 0, 'but the token count is still known')
  s.close()
})

test('known model yields a percentage', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(req({ query_source: 'main', request_id: 'ry', 'event.sequence': 1 }))
  const sess = s.getSession(REAL_API_REQUEST['session.id'])
  assert.strictEqual(sess.contextWindow, 200000)
  assert.ok(Math.abs(sess.gaugePercent - 27551 / 200000) < 1e-9)
  s.close()
})

console.log('\npricing table (Phase 4, P1-4)')

test('resolvePricing matches by longest prefix, current models beat old ones', () => {
  const { models } = loadPricing()
  // dated haiku id resolves to the haiku family
  assert.deepStrictEqual(resolvePricing('claude-haiku-4-5-20251001', models), { input: 1, output: 5 })
  // the trap: opus-4-8 must NOT fall back to the cheaper-prefix 'claude-opus-4' ($15/$75)
  assert.deepStrictEqual(resolvePricing('claude-opus-4-8', models), { input: 5, output: 25 })
  assert.deepStrictEqual(resolvePricing('claude-opus-4-20250514', models), { input: 15, output: 75 })
})

test('unknown model prices as unknown, never guessed', () => {
  const pricing = loadPricing()
  const r = computeCostMicros(
    { model: 'jan-local-qwen-3b', inputTokens: 1000, outputTokens: 1000 }, pricing)
  assert.strictEqual(r.known, false)
  assert.strictEqual(r.micros, 0)
  assert.strictEqual(r.priceSource, 'unknown')
})

test('local provider is free — a known zero, not an unknown', () => {
  const pricing = loadPricing()
  const r = computeCostMicros(
    { model: 'jan-local-qwen-3b', provider: 'local', inputTokens: 99999, outputTokens: 99999 }, pricing)
  assert.strictEqual(r.known, true)
  assert.strictEqual(r.micros, 0)
  assert.strictEqual(r.priceSource, 'local')
})

test('cache writes bill at the 1-hour rate (2.0x), the default — matches the wire', () => {
  const pricing = loadPricing()
  // The exact numbers from the real captured haiku request.
  const r = computeCostMicros(
    { model: 'claude-haiku-4-5', inputTokens: 10, outputTokens: 44, cacheReadTokens: 0, cacheCreationTokens: 27541 },
    pricing)
  assert.strictEqual(r.micros, 55312, 'must equal the reported cost_usd_micros exactly')
  // The 5-minute rate the PRD 5.2 snippet shows would NOT match:
  const fiveMin = computeCostMicros(
    { model: 'claude-haiku-4-5', inputTokens: 10, outputTokens: 44, cacheCreationTokens: 27541 },
    pricing, '5m')
  assert.strictEqual(fiveMin.micros, 34656)
  assert.notStrictEqual(fiveMin.micros, 55312)
})

test('P1-4: computed cost matches the API-reported cost for a real request (delta 0)', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(req()) // the real haiku api_request, cost_usd_micros 55312
  const row = s.db.prepare('SELECT * FROM requests LIMIT 1').get()
  const cmp = s.computedVsStored(row)
  assert.ok(cmp, 'haiku is priced, so a comparison exists')
  assert.strictEqual(cmp.stored, 55312)
  assert.strictEqual(cmp.computed, 55312)
  assert.strictEqual(cmp.delta, 0, 'pricing table validated against the reported figure')
  s.close()
})

console.log('\nproxy ingest (Phase 4, PRD 4.2)')

test('a proxy request stores with computed cost and source=proxy', () => {
  const db = tmpDb()
  const s = new Store(db)
  const r = s.ingestProxyRequest({
    requestId: 'chatcmpl-1', provider: 'openai', model: 'gpt-4o',
    inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0,
  })
  assert.strictEqual(r.action, 'proxy')
  assert.strictEqual(r.costKnown, true)
  // gpt-4o: 1000*2.5 + 500*10 = 2500 + 5000 = 7500 micros
  assert.strictEqual(r.costMicros, 7500)
  const row = s.db.prepare("SELECT * FROM requests WHERE request_id='chatcmpl-1'").get()
  assert.strictEqual(row.source, 'proxy')
  assert.strictEqual(row.provider, 'openai')
  assert.strictEqual(row.cost_source, 'computed')
  assert.strictEqual(row.context_tokens, 1000)
  s.close()
})

test('a local proxy request records tokens at zero cost', () => {
  const db = tmpDb()
  const s = new Store(db)
  const r = s.ingestProxyRequest({
    requestId: 'local-1', provider: 'local', model: 'llama-3-8b-instruct',
    inputTokens: 5000, outputTokens: 2000,
  })
  assert.strictEqual(r.costMicros, 0)
  assert.strictEqual(r.costKnown, true)
  const row = s.db.prepare("SELECT * FROM requests WHERE request_id='local-1'").get()
  assert.strictEqual(row.cost_source, 'computed') // free, not unknown
  assert.strictEqual(row.input_tokens, 5000)
  s.close()
})

test('an unpriced proxy model stores tokens but marks cost unknown (no guess)', () => {
  const db = tmpDb()
  const s = new Store(db)
  const r = s.ingestProxyRequest({
    requestId: 'mystery-1', provider: 'openai', model: 'some-unlisted-model',
    inputTokens: 1000, outputTokens: 1000,
  })
  assert.strictEqual(r.costKnown, false)
  assert.strictEqual(r.costMicros, 0)
  const row = s.db.prepare("SELECT * FROM requests WHERE request_id='mystery-1'").get()
  assert.strictEqual(row.cost_source, 'unknown')
  assert.strictEqual(row.input_tokens, 1000, 'tokens are still recorded')
  s.close()
})

test('proxy requests accumulate into session and daily totals', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingestProxyRequest({ requestId: 'a', provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 500, ts: '2026-08-20T12:00:00.000Z' })
  s.ingestProxyRequest({ requestId: 'b', provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 500, ts: '2026-08-20T12:01:00.000Z' })
  const sess = s.getSession('proxy:openai:gpt-4o')
  assert.strictEqual(sess.request_count, 2)
  assert.strictEqual(sess.cumulative_cost_micros, 15000)
  assert.strictEqual(sess.latest_context_tokens, 1000, 'proxy drives its own gauge, overwritten not summed')
  const day = s.getDaily(localDate('2026-08-20T12:00:00.000Z'))
  assert.strictEqual(day.cost_micros, 15000)
  s.close()
})

test('a replayed proxy request does not double-count (idempotent on request_id)', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingestProxyRequest({ requestId: 'dup', provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 500 })
  const again = s.ingestProxyRequest({ requestId: 'dup', provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 500 })
  assert.strictEqual(again.action, 'duplicate')
  const sess = s.getSession('proxy:openai:gpt-4o')
  assert.strictEqual(sess.request_count, 1)
  assert.strictEqual(sess.cumulative_cost_micros, 7500)
  s.close()
})

console.log('\nproxy routing (Jan-first: path prefixes)')

const { resolveRoute } = require('./proxy-core.js')
const ROUTE_OPTS = { defaultUpstream: 'https://fallback.example', localUpstream: 'http://127.0.0.1:1337' }

test('prefix routes map to the right upstream and provider', () => {
  const oa = resolveRoute('/openai/v1/chat/completions', {}, ROUTE_OPTS)
  assert.strictEqual(oa.upstreamBase, 'https://api.openai.com')
  assert.strictEqual(oa.forwardPath, '/v1/chat/completions')
  assert.strictEqual(oa.provider, 'openai')

  const an = resolveRoute('/anthropic/v1/messages', {}, ROUTE_OPTS)
  assert.strictEqual(an.upstreamBase, 'https://api.anthropic.com')
  assert.strictEqual(an.forwardPath, '/v1/messages')
  assert.strictEqual(an.provider, 'anthropic')

  const lo = resolveRoute('/local/v1/chat/completions', {}, ROUTE_OPTS)
  assert.strictEqual(lo.upstreamBase, 'http://127.0.0.1:1337')
  assert.strictEqual(lo.forwardPath, '/v1/chat/completions')
  assert.strictEqual(lo.provider, 'local')
})

test('/jan routes to the jan-serve CLI port as a local (free) provider', () => {
  const r = resolveRoute('/jan/v1/chat/completions', {}, ROUTE_OPTS)
  assert.strictEqual(r.upstreamBase, 'http://127.0.0.1:6767')
  assert.strictEqual(r.forwardPath, '/v1/chat/completions')
  assert.strictEqual(r.provider, 'local', 'jan CLI models are local: cost 0, tok/s shown')
})

test('bare /v1 falls back to the default upstream, provider inferred later', () => {
  const r = resolveRoute('/v1/chat/completions', {}, ROUTE_OPTS)
  assert.strictEqual(r.upstreamBase, 'https://fallback.example')
  assert.strictEqual(r.forwardPath, '/v1/chat/completions')
  assert.strictEqual(r.provider, null)
})

test('x-tb-upstream header still wins over everything', () => {
  const r = resolveRoute('/openai/v1/chat', { 'x-tb-upstream': 'http://elsewhere:9' }, ROUTE_OPTS)
  assert.strictEqual(r.upstreamBase, 'http://elsewhere:9')
  assert.strictEqual(r.forwardPath, '/openai/v1/chat', 'header route forwards the path untouched')
  assert.strictEqual(r.provider, null)
})

console.log('\ntask type: auto-default + sticky per source')

test('a new claude-code session auto-labels coding-agent (PRD §6)', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(req())
  assert.strictEqual(s.getSession(REAL_API_REQUEST['session.id']).task_type, 'coding-agent')
  s.close()
})

test('relabeling is sticky: the next session from the same source inherits it', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(req())
  s.setTaskType(REAL_API_REQUEST['session.id'], 'general')
  // A NEW claude-code session starts with the remembered label, not the default.
  s.ingest(req({ 'session.id': 'another-cc-session', request_id: 'r-new' }))
  assert.strictEqual(s.getSession('another-cc-session').task_type, 'general')
  s.close()
})

test('proxy sessions: unset until labeled once, then sticky per provider', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingestProxyRequest({ requestId: 'j1', provider: 'openai', model: 'gpt-4o', inputTokens: 10, outputTokens: 5 })
  assert.strictEqual(s.getSession('proxy:openai:gpt-4o').task_type, 'unset', 'nudge state until first label')

  s.setTaskType('proxy:openai:gpt-4o', 'product-brainstorm')
  // Same provider, different model -> new session inherits the label.
  s.ingestProxyRequest({ requestId: 'j2', provider: 'openai', model: 'gpt-4o-mini', inputTokens: 10, outputTokens: 5 })
  assert.strictEqual(s.getSession('proxy:openai:gpt-4o-mini').task_type, 'product-brainstorm')
  // Different provider is NOT affected.
  s.ingestProxyRequest({ requestId: 'j3', provider: 'local', model: 'llama-3-8b', inputTokens: 10, outputTokens: 5 })
  assert.strictEqual(s.getSession('proxy:local:llama-3-8b').task_type, 'unset')
  s.close()
})

test('a user label is never overwritten by later events in the session', () => {
  const db = tmpDb()
  const s = new Store(db)
  s.ingest(req())
  s.setTaskType(REAL_API_REQUEST['session.id'], 'business-brainstorm')
  s.ingest(req({ request_id: 'r-later', 'event.sequence': 99 })) // same session, new event
  assert.strictEqual(s.getSession(REAL_API_REQUEST['session.id']).task_type, 'business-brainstorm')
  s.close()
})

console.log('\ntoday-by-source (widget panel)')

test('mixed sources group per provider; local rows carry tok/s', () => {
  const db = tmpDb()
  const s = new Store(db)
  const now = new Date().toISOString()
  s.ingest(req({ 'event.timestamp': now, request_id: 'cc-1' }))
  s.ingestProxyRequest({ requestId: 'oa-1', provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 500, ts: now })
  s.ingestProxyRequest({ requestId: 'lo-1', provider: 'local', model: 'llama-3-8b', inputTokens: 500, outputTokens: 200, durationMs: 4000, ts: now })

  const rows = s.getWidgetState().todayBySource
  const key = (r) => `${r.source}/${r.provider}`
  const byKey = Object.fromEntries(rows.map((r) => [key(r), r]))
  assert.ok(byKey['claude-code/anthropic'], 'claude-code row present')
  assert.ok(byKey['proxy/openai'], 'openai row present')
  assert.ok(byKey['proxy/local'], 'local row present')
  assert.strictEqual(byKey['proxy/openai'].cost_micros, 7500)
  assert.strictEqual(byKey['proxy/local'].cost_micros, 0)
  assert.strictEqual(byKey['proxy/local'].toksPerSec, 50, '200 tok over 4s = 50 tok/s')
  s.close()
})

console.log('\ndashboard aggregates')

test('getDashboardData: daily-by-task, by-model, totals agree on one slice', () => {
  const db = tmpDb()
  const s = new Store(db)
  const now = new Date().toISOString()
  s.ingest(req({ 'event.timestamp': now, request_id: 'd1' }))                       // cc / coding-agent (auto)
  s.ingestProxyRequest({ requestId: 'd2', provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 500, ts: now })
  s.ingestProxyRequest({ requestId: 'd3', provider: 'local', model: 'llama-3-8b', inputTokens: 500, outputTokens: 200, durationMs: 4000, ts: now })

  const d = s.getDashboardData(7)
  assert.strictEqual(d.dates.length, 7)
  assert.strictEqual(d.to, d.dates[6], 'today is the last date')
  assert.strictEqual(d.totals.requests, 3)

  const today = d.dates[6]
  const cc = d.dailyByTask.find((r) => r.local_date === today && r.task_type === 'coding-agent')
  assert.ok(cc, 'auto-labeled claude-code request appears under coding-agent')
  assert.strictEqual(cc.cost_micros, 55312)

  const un = d.dailyByTask.filter((r) => r.local_date === today && r.task_type === 'unset')
  assert.strictEqual(un.reduce((a, r) => a + r.requests, 0), 2, 'both proxy requests are unset until labeled')

  const gpt = d.byModel.find((m) => m.model === 'gpt-4o')
  assert.strictEqual(gpt.cost_micros, 7500)
  const local = d.byModel.find((m) => m.provider === 'local')
  assert.strictEqual(local.toksPerSec, 50)

  // slice agreement: byTask total == totals == sum of dailyByTask
  const sumTask = d.byTask.reduce((a, t) => a + t.cost_micros, 0)
  const sumDaily = d.dailyByTask.reduce((a, r) => a + r.cost_micros, 0)
  assert.strictEqual(sumTask, d.totals.cost_micros)
  assert.strictEqual(sumDaily, d.totals.cost_micros)
  s.close()
})

console.log('\ncontext-fit + token anatomy (primary axis)')

test('context-fit bucket boundaries: strict < edge semantics', () => {
  const db = tmpDb()
  const s = new Store(db)
  const now = new Date().toISOString()
  // ctx = input (+0 cache); assert each lands per `context_tokens < edge`.
  const cases = [
    [31999, 0], [32000, 1], [128000, 2], [199999, 2], [200000, 3], [1000000, 4], [1000001, 4],
  ]
  cases.forEach(([ctx], i) =>
    s.ingest(req({
      request_id: 'b' + i, 'prompt.id': 'pb' + i, 'event.timestamp': now,
      input_tokens: ctx, cache_read_tokens: 0, cache_creation_tokens: 0,
    })))
  const d = s.getDashboardData(7)
  const want = { 0: 1, 1: 1, 2: 2, 3: 1, 4: 2 }  // 128000 & 199999 both → bucket 2; 1000000 & 1000001 → bucket 4
  for (const b of d.contextFit) assert.strictEqual(b.requests, want[b.bucket] || 0, `bucket ${b.bucket} (${b.label})`)
  s.close()
})

test('contextFit + tokenAnatomy reconcile with totals (incl. proxy rows)', () => {
  const db = tmpDb()
  const s = new Store(db)
  const now = new Date().toISOString()
  s.ingest(req({
    request_id: 'r1', 'prompt.id': 'p1', 'event.timestamp': now,
    input_tokens: 1000, cache_read_tokens: 5000, cache_creation_tokens: 200, output_tokens: 300,
  }))
  s.ingestProxyRequest({
    requestId: 'r2', provider: 'openai', model: 'gpt-4o',
    inputTokens: 2000, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 400, ts: now,
  })
  const d = s.getDashboardData(7)
  assert.strictEqual(d.contextFit.length, CTX_BUCKET_EDGES.length + 1, 'N+1 densified buckets')
  assert.strictEqual(d.contextFit.reduce((a, b) => a + b.requests, 0), d.totals.requests, 'request counts sum to totals')
  assert.strictEqual(d.contextFit.reduce((a, b) => a + b.cost_micros, 0), d.totals.cost_micros, 'cost sums to totals')
  const a = d.tokenAnatomy
  assert.strictEqual(a.fresh_input + a.cache_read + a.cache_creation, d.totals.in_tokens, 'anatomy in-tokens = totals.in_tokens')
  assert.strictEqual(a.output, d.totals.output_tokens, 'anatomy output = totals.output_tokens')
  s.close()
})

test('agenticIntensity: round-trips = requests sharing a prompt_id (Claude Code only)', () => {
  const db = tmpDb()
  const s = new Store(db)
  const now = new Date().toISOString()
  // Two api_requests of ONE user prompt's tool loop (same prompt.id).
  s.ingest(req({ request_id: 'a1', 'prompt.id': 'shared', 'event.sequence': 1, 'event.timestamp': now, query_source: 'repl_main_thread' }))
  s.ingest(req({ request_id: 'a2', 'prompt.id': 'shared', 'event.sequence': 2, 'event.timestamp': now, query_source: 'repl_main_thread' }))
  // A separate single-round-trip prompt.
  s.ingest(req({ request_id: 'a3', 'prompt.id': 'solo', 'event.sequence': 3, 'event.timestamp': now, query_source: 'repl_main_thread' }))
  // Proxy row has prompt_id NULL → must be excluded.
  s.ingestProxyRequest({ requestId: 'px', provider: 'openai', model: 'gpt-4o', inputTokens: 10, outputTokens: 5, ts: now })

  const d = s.getDashboardData(7)
  const two = d.agenticIntensity.find((r) => r.round_trips === 2)
  const one = d.agenticIntensity.find((r) => r.round_trips === 1)
  assert.ok(two && two.prompts === 1, 'one prompt drove 2 round-trips')
  assert.ok(one && one.prompts === 1, 'one prompt drove 1 round-trip')
  const totalPrompts = d.agenticIntensity.reduce((a, r) => a + r.prompts, 0)
  assert.strictEqual(totalPrompts, 2, 'proxy row (null prompt_id) excluded — only 2 Claude Code prompts')
  s.close()
})

console.log('\nactive sessions (widget pill)')

test('activeSessions: fresh sessions in, stale sessions out', () => {
  const db = tmpDb()
  const s = new Store(db)
  const now = new Date().toISOString()
  const stale = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
  s.ingest(req({ 'session.id': 'fresh-a', query_source: 'repl_main_thread', request_id: 'fa', 'event.timestamp': now }))
  s.ingestProxyRequest({ requestId: 'fb', provider: 'openai', model: 'gpt-4o', inputTokens: 10, outputTokens: 5, ts: now })
  s.ingest(req({ 'session.id': 'stale-c', request_id: 'sc', 'event.timestamp': stale }))
  const st = s.getWidgetState()
  const ids = st.activeSessions.map((a) => a.id)
  assert.ok(ids.includes('fresh-a'), 'fresh claude-code session listed')
  assert.ok(ids.includes('proxy:openai:gpt-4o'), 'fresh proxy session listed')
  assert.ok(!ids.includes('stale-c'), 'a session idle for 2h is not active')
  assert.strictEqual(st.sessionCount, 2, 'pill count = active sessions, not lifetime')
  s.close()
})

console.log('\nend-to-end over the real capture')

const fixture = process.argv[2]
if (fixture && fs.existsSync(fixture)) {
  test(`replays ${path.basename(fixture)} without error`, () => {
    const db = tmpDb()
    const s = new Store(db)
    const rows = fs.readFileSync(fixture, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    for (const r of rows) s.ingest(r)
    assert.strictEqual(s.stats.requests, 3, `expected 3 api_requests, got ${s.stats.requests}`)
    assert.strictEqual(s.stats.compactions, 1)
    assert.ok(s.stats.skipped > 90, 'most events are correctly not persisted')
    // Replaying the same file must change nothing.
    const before = s.getDaily(localDate(REAL_API_REQUEST['event.timestamp'])).cost_micros
    for (const r of rows) s.ingest(r)
    assert.strictEqual(s.getDaily(localDate(REAL_API_REQUEST['event.timestamp'])).cost_micros, before)
    s.close()
  })
} else {
  console.log('  \x1b[2mskip\x1b[0m no fixture given — pass a --jsonl capture as argv[2]')
}

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`)
process.exit(failed === 0 ? 0 : 1)
