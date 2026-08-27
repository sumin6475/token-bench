#!/usr/bin/env node
'use strict'

/**
 * TokenBench — read-only report over the Phase 2 store.
 *
 * Not the widget. This exists because PRD Phase 2 says "verify totals against
 * /cost in Claude Code", and that needs a way to read the numbers back before
 * any UI exists.
 *
 * Usage: node stats.js [--db tokenbench.db] [--day YYYY-MM-DD] [--session <id>]
 */

const path = require('node:path')
const { Store, localDate, MAIN_THREAD_SOURCES, CTX_BUCKET_EDGES, fmtK } = require('./src/store.js')

const argv = process.argv.slice(2)
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i === -1 ? fallback : argv[i + 1]
}

const dbPath = path.resolve(arg('--db', 'tokenbench.db'))
const day = arg('--day', localDate())

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s))
const dim = c('2')
const bold = c('1')
const yellow = c('33')

const usd = (micros) => `$${(micros / 1e6).toFixed(4)}`
const n = (v) => (v === null || v === undefined ? dim('—') : Number(v).toLocaleString('en-US'))

let store
try {
  store = new Store(dbPath)
} catch (e) {
  console.error(`cannot open ${dbPath}: ${e.message}`)
  process.exit(1)
}

// --- today -----------------------------------------------------------------

const d = store.getDaily(day)
console.log('')
console.log(bold(`  ${d.local_date}`) + dim(`   ${path.basename(dbPath)}`))
console.log(
  `  ${bold(usd(d.cost_micros))} of ${usd(d.budget_micros)}` +
    (d.budget_fraction !== null ? dim(`   ${(d.budget_fraction * 100).toFixed(1)}% of budget`) : '') +
    dim(`   ${d.request_count} requests`)
)
console.log(
  dim(`  ${n(d.cache_read_tokens)} cache-read · ${n(d.cache_creation_tokens)} cache-write · ` +
      `${n(d.input_tokens)} fresh · ${n(d.output_tokens)} out`)
)

// --- sessions --------------------------------------------------------------

const sessionId = arg('--session', null)
const sessions = sessionId
  ? [store.getSession(sessionId)].filter(Boolean)
  : store.db
      .prepare('SELECT id FROM sessions ORDER BY last_seen_at DESC LIMIT 10')
      .all()
      .map((r) => store.getSession(r.id))

console.log('')
console.log(bold('  Sessions') + dim('  (most recent first)'))

if (sessions.length === 0) {
  console.log(dim('    none'))
}

for (const s of sessions) {
  const gauge = s.gaugePercent !== null
    ? `${(s.gaugePercent * 100).toFixed(1)}%`
    // P0-8: an unknown window must never render as a percentage.
    : yellow('window unknown')
  const level = s.latest_context_tokens === null
    ? dim('no main-thread request yet')
    : `${n(s.latest_context_tokens)}${s.contextWindow ? ` / ${n(s.contextWindow)}` : ''}`

  console.log('')
  console.log(`    ${bold(s.id.slice(0, 8))} ${dim(s.model || 'unknown model')} ${dim(s.start_type || '')}`)
  console.log(`      context  ${level}  ${gauge}`)
  console.log(
    `      cost     ${usd(s.cumulative_cost_micros)}` +
      dim(`   ${s.request_count} requests, ${s.compaction_count} compactions`)
  )
}

// --- breakdown by query_source --------------------------------------------
// Worth seeing separately: only `main` drives the needle, but subagent and sdk
// requests are still billed and still land in the cost totals.

const bySource = store.db
  .prepare(`SELECT query_source, COUNT(*) AS n, SUM(cost_micros) AS cost, MAX(context_tokens) AS peak
              FROM requests WHERE local_date = ? GROUP BY query_source ORDER BY cost DESC`)
  .all(day)

if (bySource.length) {
  console.log('')
  console.log(bold('  By query_source') + dim(`  (${day})`))
  for (const r of bySource) {
    const drives = MAIN_THREAD_SOURCES.has(r.query_source) ? dim(' ← drives the needle') : ''
    console.log(
      `    ${(r.query_source || 'unknown').padEnd(9)} ${String(r.n).padStart(4)} req` +
        `   ${usd(r.cost).padStart(10)}   peak ctx ${n(r.peak)}${drives}`
    )
  }
}

// --- by context fit (PRIMARY axis) -----------------------------------------
// Objective, per-request: what share of requests (and of cost) falls in each
// context-size band. Answers "what could a local model even hold" with no
// labels. Bucket edges are the shared CTX_BUCKET_EDGES (integer literals →
// injection-safe in the CASE).

const ctxBucketExpr =
  'CASE ' +
  CTX_BUCKET_EDGES.map((e, i) => `WHEN context_tokens < ${e} THEN ${i}`).join(' ') +
  ` ELSE ${CTX_BUCKET_EDGES.length} END`
const ctxRows = store.db
  .prepare(`SELECT ${ctxBucketExpr} AS bucket, COUNT(*) AS nreq,
                   SUM(cost_micros) AS cost, MAX(context_tokens) AS peak
              FROM requests WHERE local_date = ? GROUP BY bucket ORDER BY bucket`)
  .all(day)

if (ctxRows.length) {
  const ctxLabels = [
    ...CTX_BUCKET_EDGES.map((e, i) => `${i === 0 ? '0' : fmtK(CTX_BUCKET_EDGES[i - 1])}–${fmtK(e)}`),
    `>${fmtK(CTX_BUCKET_EDGES[CTX_BUCKET_EDGES.length - 1])}`,
  ]
  const totReq = ctxRows.reduce((a, r) => a + r.nreq, 0) || 1
  const totCost = ctxRows.reduce((a, r) => a + r.cost, 0) || 1
  console.log('')
  console.log(bold('  By context fit') + dim(`  (${day}, per-request context size)`))
  for (const r of ctxRows) {
    const reqPct = ((r.nreq / totReq) * 100).toFixed(0)
    const costPct = ((r.cost / totCost) * 100).toFixed(0)
    console.log(
      `    ${ctxLabels[r.bucket].padEnd(11)} ${String(r.nreq).padStart(4)} req (${reqPct.padStart(3)}%)` +
        `   ${usd(r.cost).padStart(10)} (${costPct.padStart(3)}%)`
    )
  }
}

// --- token anatomy ---------------------------------------------------------
// What the token spend is actually made of. The cache-read majority is the
// point (largest hidden factor in coding-agent cost).

const anat = store.db
  .prepare(`SELECT COALESCE(SUM(input_tokens),0) AS fresh, COALESCE(SUM(cache_read_tokens),0) AS cread,
                   COALESCE(SUM(cache_creation_tokens),0) AS cwrite, COALESCE(SUM(output_tokens),0) AS out
              FROM requests WHERE local_date = ?`)
  .get(day)

const anatTot = anat.fresh + anat.cread + anat.cwrite + anat.out
if (anatTot > 0) {
  const pct = (v) => `${((v / anatTot) * 100).toFixed(1)}%`
  console.log('')
  console.log(bold('  Token anatomy') + dim(`  (${day}, ${n(anatTot)} tokens)`))
  console.log(
    `    fresh ${pct(anat.fresh).padStart(6)}   cache-read ${pct(anat.cread).padStart(6)}` +
      `   cache-write ${pct(anat.cwrite).padStart(6)}   output ${pct(anat.out).padStart(6)}`
  )
}

// --- by task type (SECONDARY lens) -----------------------------------------
// Kept as an optional lens. A single session spans many kinds of work, so this
// manual per-session label is a rough tag — the context-fit axis above is the
// objective view.

const byTask = store.db
  .prepare(`SELECT s.task_type, COUNT(*) AS n, SUM(r.cost_micros) AS cost,
                   SUM(r.output_tokens) AS out_tokens, MAX(r.context_tokens) AS peak
              FROM requests r JOIN sessions s ON s.id = r.session_id
             WHERE r.local_date = ? GROUP BY s.task_type ORDER BY cost DESC`)
  .all(day)

if (byTask.length) {
  console.log('')
  console.log(bold('  By task type') + dim(`  (${day})`))
  for (const t of byTask) {
    const label = t.task_type === 'unset' ? yellow('unset'.padEnd(19)) : (t.task_type || '?').padEnd(19)
    console.log(
      `    ${label} ${String(t.n).padStart(4)} req   ${usd(t.cost).padStart(10)}   peak ctx ${n(t.peak)}`
    )
  }
}

// --- P1-4: reported vs computed --------------------------------------------
// Validate pricing.json against the cost Claude Code actually reported. For a
// well-formed table the per-day delta is ~0; a non-zero delta means a price (or
// a cache multiplier) is wrong. This is what lets the proxy path trust the table.

const priced = store.db
  .prepare(`SELECT * FROM requests WHERE local_date = ? AND cost_source = 'reported'`)
  .all(day)

let reportedSum = 0
let computedSum = 0
let comparable = 0
for (const r of priced) {
  const cmp = store.computedVsStored(r)
  if (!cmp) continue
  comparable++
  reportedSum += cmp.stored
  computedSum += cmp.computed
}

if (comparable) {
  const delta = computedSum - reportedSum
  const pct = reportedSum ? (delta / reportedSum) * 100 : 0
  console.log('')
  console.log(bold('  Reported vs computed') + dim(`  (${day}, P1-4 — validates pricing.json)`))
  console.log(
    `    reported ${usd(reportedSum)}   computed ${usd(computedSum)}` +
      `   ${Math.abs(delta) === 0 ? dim('delta $0.0000 ✓') : yellow(`delta ${usd(delta)} (${pct.toFixed(2)}%)`)}` +
      dim(`   over ${comparable} priced requests`)
  )
}

// --- proxy usage (Phase 4) -------------------------------------------------
const proxy = store.db
  .prepare(`SELECT provider, COUNT(*) AS n, SUM(cost_micros) AS cost,
                   SUM(CASE WHEN cost_source = 'unknown' THEN 1 ELSE 0 END) AS unpriced
              FROM requests WHERE source = 'proxy' AND local_date = ?
             GROUP BY provider ORDER BY cost DESC`)
  .all(day)

if (proxy.length) {
  console.log('')
  console.log(bold('  Proxy usage') + dim(`  (${day}, cost computed from pricing.json)`))
  for (const p of proxy) {
    const unk = p.unpriced ? yellow(`  ${p.unpriced} unpriced`) : ''
    console.log(`    ${(p.provider || '?').padEnd(9)} ${String(p.n).padStart(4)} req   ${usd(p.cost).padStart(10)}${unk}`)
  }
  const ps = store.getProxyStats()
  if (ps.noUsage || ps.upstreamErrors) {
    console.log(
      dim(`    capture truth: ${ps.noUsage} usage-unavailable, ${ps.upstreamErrors} upstream-errors — both counted, not dropped`)
    )
  }
}

// --- query_source census (sensitivity) -------------------------------------
// Every value seen on the wire, with whether it drives the needle. A Claude
// Code update that introduces a NEW main-thread value shows up HERE as "not
// driving", instead of silently failing to move the gauge.
const qsRows = store.db
  .prepare(`SELECT query_source, COUNT(*) AS n,
                   SUM(CASE WHEN usage_status IS NULL THEN 0 ELSE 1 END) AS via_proxy
              FROM requests GROUP BY query_source ORDER BY n DESC`)
  .all()
if (qsRows.length) {
  console.log('')
  console.log(bold('  Query sources observed (all history)'))
  for (const r of qsRows) {
    const drives = MAIN_THREAD_SOURCES.has(r.query_source) ? dim(' ← main thread') : yellow(' not main-road — need manual review')
    console.log(`    ${(r.query_source || 'unknown').padEnd(22)} ${String(r.n).padStart(4)} req${drives}`)
  }
}

// --- wire-schema census (Phase 4) ------------------------------------------
// Every event type observed (attribute KEYS only, never values). Things ingest
// deliberately drops still show up here, so a changed wire is visible instead
// of melting silently.
const cov = store.getEventCoverage()
if (cov.length) {
  console.log('')
  console.log(bold('  Wire events observed') + dim('  (keys only, no values — PII cannot reach this)' ))
  const skip = cov.filter((e) => !e.persisted)
  for (const e of cov) {
    const tag = e.persisted ? dim(' stored') : yellow(' not-persisted')
    const keys = e.attributes.length ? dim(`  [${e.attributes.join(', ')}]`) : ''
    console.log(`    ${(e.kind + ':' + e.name).padEnd(38)} ×${String(e.count).padStart(3)}${tag}` + (e.attributes.length > 60 ? dim('  …') : keys.slice(0, 140)))
  }
  if (skip.length) {
    console.log(yellow(`    ${skip.length} event type(s) not persisted — see README for which and why`))
  }
}

// --- compactions -----------------------------------------------------------

const comps = store.db
  .prepare(`SELECT * FROM compactions ORDER BY ts DESC LIMIT 5`)
  .all()

if (comps.length) {
  console.log('')
  console.log(bold('  Recent compactions'))
  for (const k of comps) {
    console.log(
      `    ${dim(k.ts.slice(11, 19))}  ${n(k.pre_tokens)} ${dim('->')} ${bold(n(k.post_tokens))}` +
        dim(`   trigger=${k.trigger} success=${k.success ? 'true' : 'false'}`)
    )
  }
}

console.log('')
store.close()
