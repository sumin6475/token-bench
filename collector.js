#!/usr/bin/env node
/**
 * TokenBench — Phase 1: prove the pipe.
 *
 * A zero-dependency OTLP/HTTP JSON receiver on localhost:4318 that prints every
 * event Claude Code sends. No storage, no UI — the only job is to answer the
 * question Phase 1 exists to answer: do the events arrive, and what is actually
 * in them?
 *
 * Because that second half matters, this deliberately prints EVERY attribute
 * verbatim rather than only the fields the PRD expects. The PRD's field list is
 * an assumption; the console output is the evidence. Run it, then compare.
 *
 * Usage:
 *   node collector.js [--port 4318] [--raw] [--jsonl events.jsonl] [--quiet]
 */

'use strict'

const http = require('node:http')
const zlib = require('node:zlib')
const fs = require('node:fs')
const path = require('node:path')

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { port: 4318, host: '127.0.0.1', raw: false, jsonl: null, quiet: false, only: null, db: null, proxy: null, localUpstream: 'http://127.0.0.1:1337', upstream: 'https://api.openai.com', check: false, allowPrivateUpstream: false, staleAfter: 15 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') opts.port = Number(argv[++i])
    else if (a === '--host') opts.host = argv[++i]
    else if (a === '--raw') opts.raw = true
    else if (a === '--quiet') opts.quiet = true
    else if (a === '--check') opts.check = true
    else if (a === '--allow-private-upstream') opts.allowPrivateUpstream = true
    else if (a === '--stale-after') opts.staleAfter = Number(argv[++i])
    else if (a === '--jsonl') opts.jsonl = argv[++i]
    else if (a === '--db') opts.db = argv[++i]
    else if (a === '--proxy') {
      // Optional numeric value: `--proxy` (default 8787) or `--proxy 9000`.
      opts.proxy = /^\d+$/.test(argv[i + 1] || '') ? Number(argv[++i]) : 8787
    }
    else if (a === '--local-upstream') opts.localUpstream = argv[++i]
    else if (a === '--upstream') opts.upstream = argv[++i]
    else if (a === '--only') opts.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--tokens') opts.only = ['api_request', 'compaction', 'session', 'token.usage', 'cost.usage']
    else if (a === '--help' || a === '-h') {
      console.log(`TokenBench Phase 1 collector

  --port <n>        listen port (default 4318)
  --host <addr>     bind address (default 127.0.0.1, loopback only)
  --raw             also dump the full OTLP JSON body of every request
  --jsonl <file>    append each flattened record as one JSON line (for Phase 2 replay)
  --db <file>       persist api_request / compaction / session.count to SQLite
  --proxy [port]    ALSO run the Phase 4 proxy in this process (default 8787),
                    sharing the same store — the mode the Mac app uses
  --local-upstream <url>  proxy /local/* target (default http://127.0.0.1:1337, Jan's server)
  --upstream <url>  proxy default for bare /v1 paths (default https://api.openai.com)
  --allow-private-upstream  permit x-tb-upstream proxy targets on private/loopback hosts
  --only a,b        only print events whose name contains one of these substrings
  --tokens          shorthand for the token/cost-relevant events only
  --stale-after <n> console-warn after n min without telemetry (default 15)
  --check           diagnose the pipe (port, env vars, probe POST) and exit
  --quiet           suppress the per-event block, keep only the running counters

Filtering affects PRINTING only. The schema summary on Ctrl-C, --jsonl,
/state and /healthz .. /tracking-status always cover every event received.
`)
      process.exit(0)
    } else {
      console.error(`unknown argument: ${a}`)
      process.exit(1)
    }
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
// Increment when the desktop shell must reject an older sidecar. This keeps a
// stale orphaned collector from serving old widget/API code after an app update.
const WIDGET_PROTOCOL_VERSION = 2

// ---------------------------------------------------------------------------
// Terminal colors (skipped when piped, or when NO_COLOR is set)
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s))
const dim = c('2')
const bold = c('1')
const red = c('31')
const green = c('32')
const yellow = c('33')
const blue = c('34')
const magenta = c('35')
const cyan = c('36')

// ---------------------------------------------------------------------------
// Health state (Phase 1) — answers "is the pipe actually working?" instead of
// letting a silent $0.00 on the dashboard pass for 'nothing happened'. Every
// event-level value here is wired-level truth: what actually ARRIVED at the
// collector, before ingest decides what to persist.
// ---------------------------------------------------------------------------

const health = {
  startedAt: new Date(),
  lastRequestAt: null, // any HTTP request handled
  lastEventAt: null, // last telemetry EVENT timestamp (data semantics)
  lastEventArrivedAt: null, // when that event was RECEIVED (liveness semantics)
  lastApiRequestAt: null, // any api_request event seen
  otlpRequestCount: 0,
  eventCount: 0,
  apiRequestCount: 0,
  malformedRequestCount: 0,
  kinds: {}, // '/v1/logs' -> count
  lastWarnedAt: 0,
}

function healthSnapshot() {
  return {
    startedAt: health.startedAt.toISOString(),
    lastRequestAt: health.lastRequestAt,
    lastEventAt: health.lastEventAt,
    lastEventArrivedAt: health.lastEventArrivedAt,
    lastApiRequestAt: health.lastApiRequestAt,
    otlpRequestCount: health.otlpRequestCount,
    eventCount: health.eventCount,
    apiRequestCount: health.apiRequestCount,
    malformedRequestCount: health.malformedRequestCount,
    kinds: { ...health.kinds },
  }
}

// --check: diagnose the pipe without starting the server, then exit.
if (opts.check) {
  runCheck(opts).then((code) => process.exit(code)).catch((e) => { console.error(red(`  ! check failed: ${e.stack || e}`)); process.exit(1) })
}

// ---------------------------------------------------------------------------
// OTLP/JSON decoding helpers
//
// The OTLP JSON encoding follows proto3's JSON mapping, which has two traps:
//   1. Every attribute value is wrapped in an "AnyValue" union
//      ({stringValue}, {intValue}, {doubleValue}, ...).
//   2. 64-bit integers are serialized as STRINGS, not numbers. `intValue` of
//      61400 arrives as "61400". Forgetting this gives you string concatenation
//      instead of arithmetic, which is exactly the class of bug that would make
//      the Phase 2 gauge silently wrong.
// ---------------------------------------------------------------------------

function anyValue(v) {
  if (v === null || typeof v !== 'object') return v ?? null
  if ('stringValue' in v) return v.stringValue
  if ('intValue' in v) return Number(v.intValue)
  if ('doubleValue' in v) return Number(v.doubleValue)
  if ('boolValue' in v) return v.boolValue
  if ('bytesValue' in v) return v.bytesValue
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(anyValue)
  if ('kvlistValue' in v) return attributesToObject(v.kvlistValue.values)
  return null
}

function attributesToObject(attrs) {
  const out = {}
  for (const a of attrs || []) out[a.key] = anyValue(a.value)
  return out
}

/** OTLP timestamps are nanoseconds since epoch, as a decimal string. */
function nanosToDate(nanos) {
  if (!nanos) return new Date()
  return new Date(Number(BigInt(nanos) / 1000000n))
}

function hhmmss(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

// ---------------------------------------------------------------------------
// Schema discovery — the real Phase 1 deliverable
//
// Instead of trusting the PRD's field list, accumulate what actually arrived:
// which event names showed up, how often, and the union of attribute keys on
// each. Printed on Ctrl-C. This is what Phase 2's schema gets written from.
// ---------------------------------------------------------------------------

const seen = new Map() // eventName -> { count, keys: Set }
// First-sighting alarm: names that arrived but that ingest will DROP are worth
// one loud line — a Claude Code update changing the wire must not melt silently.
const seenEventNames = new Set()

function record(kind, name, attrs) {
  const id = `${kind}:${name}`
  let entry = seen.get(id)
  if (!entry) {
    entry = { count: 0, keys: new Set() }
    seen.set(id, entry)
  }
  entry.count++
  for (const k of Object.keys(attrs)) entry.keys.add(k)
}

// ---------------------------------------------------------------------------
// Optional JSONL tee
// ---------------------------------------------------------------------------

let jsonlStream = null
if (opts.jsonl) {
  const p = path.resolve(opts.jsonl)
  jsonlStream = fs.createWriteStream(p, { flags: 'a' })
  console.log(dim(`  teeing flattened records to ${p}`))
}

function tee(obj) {
  if (jsonlStream) jsonlStream.write(JSON.stringify(obj) + '\n')
}

// ---------------------------------------------------------------------------
// Optional SQLite store (Phase 2)
//
// Loaded lazily so Phase 1's "prove the pipe" mode stays dependency-free and
// keeps working even if the store is broken or the schema file is missing.
// ---------------------------------------------------------------------------

let store = null
let cliScanner = null
if (opts.db) {
  const { Store } = require('./src/store.js')
  store = new Store(path.resolve(opts.db))
  const { CliSessionScanner } = require('./src/cli-session-scanner.js')
  cliScanner = new CliSessionScanner({ store })
  cliScanner.start()
  console.log(dim(`  storing to ${path.resolve(opts.db)}`))
}

// ---------------------------------------------------------------------------
// Optional in-process proxy (Phase 4 / Jan-first pivot)
//
// Same process, same Store — one SQLite writer, one lifecycle. This is what
// the Mac app runs: the OTel listener on :4318 and the provider proxy on
// :8787 out of a single sidecar.
// ---------------------------------------------------------------------------

let proxyServer = null
// In --check mode we must not bind ANYTHING: runCheck probes the port by
// connecting to it, and binding our own listener would answer ourselves.
if (!opts.check && opts.proxy) {
  const { createProxyServer } = require('./src/proxy-core.js')
  if (!store) console.log(yellow('  ! --proxy without --db: forwarding works but usage will NOT be stored'))
  proxyServer = createProxyServer({
    store,
    defaultUpstream: opts.upstream,
    localUpstream: opts.localUpstream,
    quiet: opts.quiet,
    allowPrivateUpstream: opts.allowPrivateUpstream,
  })
  proxyServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(red(`  ! proxy port ${opts.proxy} already in use (standalone proxy.js running?) — proxy disabled, collector continues`))
      proxyServer = null
      return
    }
    throw e
  })
  proxyServer.listen(opts.proxy, opts.host, () => {
    console.log(dim(`  proxy on http://${opts.host}:${opts.proxy}  (/openai/v1, /anthropic/v1, /local/v1 -> ${opts.localUpstream})`))
  })
}

function persist(rec) {
  if (!store) return null
  try {
    return store.ingest(rec)
  } catch (e) {
    // A store failure must never take the collector down — dropping telemetry
    // is worse than dropping a row, because the session cannot be replayed.
    console.error(red(`  ! store: ${e.message}`))
    return null
  }
}

// ---------------------------------------------------------------------------
// Read/serve side — the widget (Phase 3, PRD §6)
//
// The architecture diagram has the sidecar feeding the widget, so the widget is
// served from this same process rather than a second server. It is a single
// self-contained HTML file that polls /state; there is no build step and no
// dependency, which is the whole point of the sidecar staying Node.
//
// widget.html is read fresh on each request so it can be edited live without a
// collector restart.
// ---------------------------------------------------------------------------

const WIDGET_PATH = path.join(__dirname, 'widget.html')
const DASH_PATH = path.join(__dirname, 'dashboard.html')

function serveState(res, requestUrl = '/state') {
  res.writeHead(200, { 'content-type': 'application/json' })
  const collector = healthSnapshot()
  const { deriveTrackingStatus } = require('./src/store.js')
  if (!store) {
    return res.end(JSON.stringify({
      store: false,
      collector,
      tracking: deriveTrackingStatus({ now: new Date(), ...collector }),
      message: 'collector is running without --db. Restart with --db <file> to see live numbers.',
    }))
  }
  try {
    const params = new URL(requestUrl, 'http://x').searchParams
    const selectedSession = params.get('session')
    // A manual/automatic widget retry replays only the bounded recent log
    // slices. Request rows are idempotent; the session upsert can still repair
    // metadata that was missing during the first pass (notably Codex's exact
    // model_context_window).
    const refresh = params.get('refresh') === '1' && cliScanner
      ? cliScanner.refreshLogs()
      : null
    const runtime = cliScanner ? cliScanner.snapshot() : { runningClis: [], processDetection: 'unavailable' }
    const runningSources = runtime.runningClis.map((p) => p.source)
    res.end(JSON.stringify({
      store: true,
      ...store.getWidgetState(selectedSession, runningSources),
      runtime,
      refresh,
      collector,
      tracking: store.getTrackingStatus(collector),
    }))
  } catch (e) {
    res.end(JSON.stringify({ store: true, error: e.message }))
  }
}

function serveHealthz(res) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    status: 'ok',
    widgetProtocol: WIDGET_PROTOCOL_VERSION,
    uptimeMs: Date.now() - health.startedAt.getTime(),
    pid: process.pid,
  }))
}

function serveReadyz(res) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ status: 'ready' }))
}

function serveTrackingStatus(res) {
  res.writeHead(200, { 'content-type': 'application/json' })
  const collector = healthSnapshot()
  try {
    const { deriveTrackingStatus } = require('./src/store.js')
    const body = store
      ? store.getTrackingStatus(collector)
      : { ...deriveTrackingStatus({ now: new Date(), ...collector }), store: false }
    res.end(JSON.stringify(body))
  } catch (e) {
    res.end(JSON.stringify({ error: e.message }))
  }
}

function serveEventCoverage(res) {
  res.writeHead(200, { 'content-type': 'application/json' })
  if (!store) return res.end(JSON.stringify({ store: false }))
  try {
    const rows = store.getEventCoverage()
    res.end(JSON.stringify({
      store: true,
      total: rows.length,
      persisted: rows.filter((r) => r.persisted).length,
      events: rows,
    }))
  } catch (e) {
    res.end(JSON.stringify({ store: true, error: e.message }))
  }
}

function serveHtml(res, file) {
  let html = null
  try { html = fs.readFileSync(file, 'utf8') } catch { /* falls through */ }
  if (!html) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    return res.end(`${path.basename(file)} not found next to collector.js\n`)
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
}
const serveWidget = (res) => serveHtml(res, WIDGET_PATH)

function serveDashboardData(res, url) {
  res.writeHead(200, { 'content-type': 'application/json' })
  if (!store) return res.end(JSON.stringify({ store: false }))
  try {
    const params = new URL(url, 'http://x').searchParams
    const days = Number(params.get('days')) || 14
    const session = params.get('session') || null
    res.end(JSON.stringify({ store: true, ...store.getDashboardData(days, session) }))
  } catch (e) {
    res.end(JSON.stringify({ store: true, error: e.message }))
  }
}

async function handleMutation(urlPath, req, res) {
  let body = {}
  try { body = JSON.parse((await readBody(req)).toString('utf8')) } catch { body = {} }
  res.writeHead(200, { 'content-type': 'application/json' })
  if (!store) return res.end(JSON.stringify({ ok: false, message: 'no --db' }))
  try {
    if (urlPath === '/task-type') {
      const t = store.setTaskType(String(body.sessionId || ''), String(body.taskType || 'unset'))
      return res.end(JSON.stringify({ ok: t !== null, taskType: t }))
    }
    // /budget
    const micros = Math.max(0, Math.round(Number(body.micros) || 0))
    store.setSetting('daily_budget_micros', micros)
    return res.end(JSON.stringify({ ok: true, micros }))
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: e.message }))
  }
}

// ---------------------------------------------------------------------------
// Pretty printing
// ---------------------------------------------------------------------------

// Thousands separators for counts, but never for fractional values — rounding
// a cost of 0.041234 down to "0.041" is exactly the kind of quiet precision
// loss this tool exists to avoid.
const num = (n) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n)
  return Number.isInteger(n) ? n.toLocaleString('en-US') : String(n)
}

/**
 * Fields the PRD cares about, pulled to the top of the block so they are easy
 * to eyeball. Everything else still prints below under `attributes:` — nothing
 * is hidden, this is only ordering.
 */
const HIGHLIGHT = [
  'model',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'cost_usd',
  'duration_ms',
  'query_source',
  'pre_tokens',
  'post_tokens',
  'trigger',
  'start_type',
  'session.id',
  'value', // metric data-point value
  'type',  // metric token-usage dimension (input / output / cacheRead / ...)
]

function colorForEvent(name) {
  if (name.includes('api_request')) return green
  if (name.includes('api_error') || name.includes('error')) return red
  if (name.includes('compaction')) return magenta
  if (name.includes('session')) return cyan
  return blue
}

function printEvent({ kind, name, time, attrs, resource, scope, body }) {
  // Record and tee before filtering: --only shapes what you read, never what
  // the run actually observed.
  record(kind, name, attrs)
  tee({ kind, name, ts: time.toISOString(), attrs, resource, scope, body })
  const stored = persist({ kind, name, attrs })
  health.eventCount++
  health.lastEventAt = time.toISOString()
  health.lastEventArrivedAt = new Date().toISOString()
  if (name.includes('api_request')) {
    health.apiRequestCount++
    health.lastApiRequestAt = time.toISOString()
  }
  if (opts.quiet) return

  // Unknown-event alert (Phase 4): first sighting of an event name that ingest
  // does not persist. Keys-only census still records it; this is the loud hint.
  if (!seenEventNames.has(name)) {
    seenEventNames.add(name)
    try {
      const { ALLOW } = require('./src/store.js')
      if (!ALLOW[name]) {
        console.log(yellow(`  ? first sighting of ${bold(name)} — NOT persisted (census + /event-coverage still record its keys)`))
      }
    } catch { /* store unavailable; hint skipped */ }
  }
  if (opts.only && !opts.only.some((f) => name.includes(f))) return

  const paint = colorForEvent(name)
  console.log('')
  console.log(`${dim(hhmmss(time))} ${dim(kind.toUpperCase().padEnd(7))} ${bold(paint(name))}`)

  // Derived context level — the number the whole project is about. Shown here
  // so P0-2's math can be sanity-checked against `/cost` before any UI exists.
  const input = attrs.input_tokens
  const cacheRead = attrs.cache_read_tokens
  const cacheCreate = attrs.cache_creation_tokens
  if ([input, cacheRead, cacheCreate].some((v) => typeof v === 'number')) {
    const ctx = (input || 0) + (cacheRead || 0) + (cacheCreate || 0)
    console.log(
      `  ${dim('context')} ${bold(num(ctx))} ${dim('=')} ${num(input || 0)} fresh ${dim('+')} ` +
        `${num(cacheRead || 0)} cache-read ${dim('+')} ${num(cacheCreate || 0)} cache-write` +
        `   ${dim('out')} ${num(attrs.output_tokens ?? 0)}`
    )
  }

  // What the store did with it — the gauge percentage, or the explicit unknown
  // state when the model is missing from context-windows.json.
  if (stored && stored.action === 'request') {
    const pct = stored.contextWindow
      ? `${((stored.contextTokens / stored.contextWindow) * 100).toFixed(1)}% of ${num(stored.contextWindow)}`
      : yellow('window unknown — no percentage shown')
    const gauge = stored.droveGauge ? green('needle') : dim(`${stored.querySource}, not the needle`)
    console.log(`  ${dim('stored')} ${pct}  ${dim('·')} ${gauge}  ${dim('·')} $${(stored.costMicros / 1e6).toFixed(6)}`)
  } else if (stored && stored.action === 'compaction') {
    console.log(
      `  ${dim('stored')} ${magenta('needle drops')} ${num(stored.preTokens)} ${dim('->')} ${bold(num(stored.postTokens))}` +
        `  ${dim('·')} trigger=${stored.trigger} success=${stored.success}`
    )
  } else if (stored && stored.action === 'duplicate') {
    console.log(`  ${dim('stored')} ${yellow('duplicate ignored')} ${dim('— totals unchanged')}`)
  }

  const shown = new Set()
  const line = []
  for (const k of HIGHLIGHT) {
    if (k in attrs) {
      shown.add(k)
      line.push(`${dim(k + '=')}${yellow(num(attrs[k]))}`)
    }
  }
  if (line.length) console.log('  ' + line.join('  '))

  const rest = Object.keys(attrs).filter((k) => !shown.has(k)).sort()
  if (rest.length) {
    console.log(dim('  attributes:'))
    const pad = Math.max(...rest.map((k) => k.length))
    for (const k of rest) {
      console.log(`    ${dim(k.padEnd(pad))}  ${formatValue(attrs[k])}`)
    }
  }

  if (body !== undefined && body !== null && body !== name) {
    console.log(`  ${dim('body:')} ${formatValue(body)}`)
  }
}

function formatValue(v) {
  if (v === null || v === undefined) return dim('null')
  if (typeof v === 'object') return JSON.stringify(v)
  const s = String(v)
  return s.length > 400 ? s.slice(0, 400) + dim(` …(${s.length} chars)`) : s
}

// ---------------------------------------------------------------------------
// OTLP payload walkers
// ---------------------------------------------------------------------------

function handleLogs(payload) {
  let n = 0
  for (const rl of payload.resourceLogs || []) {
    const resource = attributesToObject(rl.resource?.attributes)
    for (const sl of rl.scopeLogs || []) {
      const scope = sl.scope?.name || null
      for (const lr of sl.logRecords || []) {
        n++
        const attrs = attributesToObject(lr.attributes)
        const body = anyValue(lr.body)
        // Claude Code puts the event name in `event.name`; older/other emitters
        // put it in the body. Fall back through both before giving up.
        const name = attrs['event.name'] || lr.eventName || (typeof body === 'string' ? body : '(unnamed log)')
        delete attrs['event.name']
        printEvent({
          kind: 'log',
          name,
          time: nanosToDate(lr.timeUnixNano || lr.observedTimeUnixNano),
          attrs,
          resource,
          scope,
          body,
        })
      }
    }
  }
  return n
}

function handleMetrics(payload) {
  let n = 0
  for (const rm of payload.resourceMetrics || []) {
    const resource = attributesToObject(rm.resource?.attributes)
    for (const sm of rm.scopeMetrics || []) {
      const scope = sm.scope?.name || null
      for (const m of sm.metrics || []) {
        // A metric is exactly one of sum / gauge / histogram / summary.
        const series = m.sum || m.gauge || m.histogram || m.exponentialHistogram || m.summary
        for (const dp of series?.dataPoints || []) {
          n++
          const attrs = attributesToObject(dp.attributes)
          const value = dp.asInt !== undefined ? Number(dp.asInt)
            : dp.asDouble !== undefined ? Number(dp.asDouble)
            : dp.sum !== undefined ? Number(dp.sum)
            : null
          printEvent({
            kind: 'metric',
            name: m.name,
            time: nanosToDate(dp.timeUnixNano),
            attrs: { value, unit: m.unit || undefined, ...attrs },
            resource,
            scope,
            body: null,
          })
        }
      }
    }
  }
  return n
}

function handleTraces(payload) {
  let n = 0
  for (const rs of payload.resourceSpans || []) {
    const resource = attributesToObject(rs.resource?.attributes)
    for (const ss of rs.scopeSpans || []) {
      const scope = ss.scope?.name || null
      for (const span of ss.spans || []) {
        n++
        const attrs = attributesToObject(span.attributes)
        const durMs = span.endTimeUnixNano && span.startTimeUnixNano
          ? Number((BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1000000n)
          : undefined
        printEvent({
          kind: 'span',
          name: span.name,
          time: nanosToDate(span.startTimeUnixNano),
          attrs: { ...attrs, ...(durMs !== undefined ? { duration_ms: durMs } : {}) },
          resource,
          scope,
          body: null,
        })
      }
    }
  }
  return n
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

let requestCount = 0

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (ch) => chunks.push(ch))
    req.on('error', reject)
    req.on('end', () => {
      let buf = Buffer.concat(chunks)
      const enc = (req.headers['content-encoding'] || '').toLowerCase()
      try {
        if (enc === 'gzip') buf = zlib.gunzipSync(buf)
        else if (enc === 'deflate') buf = zlib.inflateSync(buf)
        else if (enc === 'br') buf = zlib.brotliDecompressSync(buf)
      } catch (e) {
        return reject(new Error(`failed to decompress ${enc} body: ${e.message}`))
      }
      resolve(buf)
    })
  })
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    const url = req.url.split('?')[0]
    if (url === '/state') return serveState(res, req.url)
    if (url === '/widget' || url === '/widget.html') return serveWidget(res)
    if (url === '/dashboard' || url === '/dashboard.html') return serveHtml(res, DASH_PATH)
    if (url === '/dashboard-data') return serveDashboardData(res, req.url)
    if (url === '/healthz') return serveHealthz(res)
    if (url === '/readyz') return serveReadyz(res)
    if (url === '/tracking-status' || url === '/tracking') return serveTrackingStatus(res)
    if (url === '/event-coverage' || url === '/coverage') return serveEventCoverage(res)
    if (url === '/' && store) return serveWidget(res)
    // A plain GET is handy as a liveness check while wiring things up.
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end('TokenBench collector. GET /widget for the dashboard, /state for JSON, /healthz /readyz /tracking-status for health. POST OTLP/HTTP JSON to /v1/logs, /v1/metrics, /v1/traces.\n')
  }

  // Widget mutations (task-type override P1-2, editable daily budget P0-5). Must
  // read the body itself and return before the OTLP path consumes the stream.
  const postPath = req.url.split('?')[0]
  if (postPath === '/task-type' || postPath === '/budget') {
    return handleMutation(postPath, req, res)
  }

  let buf
  try {
    buf = await readBody(req)
  } catch (e) {
    console.error(red(`  ! ${e.message}`))
    res.writeHead(400, { 'content-type': 'application/json' })
    return res.end('{}')
  }

  const ct = (req.headers['content-type'] || '').toLowerCase()
  if (ct.includes('protobuf') || (buf.length && buf[0] !== 0x7b /* '{' */)) {
    health.malformedRequestCount++
    console.error(
      red(`  ! ${req.url} arrived as protobuf, not JSON.`) +
        ` Set ${bold('OTEL_EXPORTER_OTLP_PROTOCOL=http/json')} and restart Claude Code.`
    )
    res.writeHead(415, { 'content-type': 'application/json' })
    return res.end('{}')
  }

  let payload
  try {
    payload = JSON.parse(buf.toString('utf8'))
  } catch (e) {
    health.malformedRequestCount++
    console.error(red(`  ! ${req.url}: body is not valid JSON — ${e.message}`))
    res.writeHead(400, { 'content-type': 'application/json' })
    return res.end('{}')
  }

  requestCount++
  health.otlpRequestCount++
  health.lastRequestAt = new Date().toISOString()
  if (opts.raw) {
    console.log(dim(`\n--- raw ${req.method} ${req.url} (${buf.length} bytes) ---`))
    console.log(JSON.stringify(payload, null, 2))
  }

  try {
    const url = req.url.split('?')[0]
    const apiBefore = health.apiRequestCount
    let events = 0
    if (url === '/v1/logs') events = handleLogs(payload)
    else if (url === '/v1/metrics') events = handleMetrics(payload)
    else if (url === '/v1/traces') events = handleTraces(payload)
    else {
      // Unknown path: still show it rather than dropping it silently.
      console.log(yellow(`\n  ? POST ${url} — unrecognised OTLP path, ${buf.length} bytes`))
      if (!opts.raw) console.log(dim(JSON.stringify(payload).slice(0, 500)))
    }
    health.kinds[url] = (health.kinds[url] || 0) + 1
    if (!opts.quiet) {
      const apiNew = health.apiRequestCount - apiBefore
      console.log(dim(`  ← ${url} · ${events} events${apiNew ? `, ${apiNew} api_request` : ''} · ${(buf.length / 1024).toFixed(1)} KB`))
    }
  } catch (e) {
    console.error(red(`  ! error handling ${req.url}: ${e.stack}`))
  }

  // OTLP requires a success response, otherwise the SDK retries and backs off.
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ partialSuccess: {} }))
})

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(red(`\nPort ${opts.port} is already in use.`))
    console.error(dim(`Find the process with:  lsof -nP -iTCP:${opts.port} -sTCP:LISTEN\n`))
    process.exit(1)
  }
  throw e
})

const STALE_AFTER_MS = (Number.isFinite(opts.staleAfter) && opts.staleAfter > 0 ? opts.staleAfter : 15) * 60000

// Phase 1: a silent pipe is a broken pipe. Warn in-console after --stale-after
// minutes without telemetry. (Skipped in --check mode: runCheck connects to the
// port rather than binding it, so our own listener would answer the probe.)
if (!opts.check) {
  setInterval(checkStale, 30000).unref()

  server.listen(opts.port, opts.host, () => {
    if (!['127.0.0.1', 'localhost', '::1'].includes(opts.host)) {
      console.warn(yellow(`  ! bound to ${opts.host} — this instance serves ANY interface. Anyone who can reach it`))
      console.warn(yellow('    can POST telemetry or relay requests through the proxy. Loopback-only (127.0.0.1) is the default for a reason.'))
    }
    console.log('')
    console.log(bold('  TokenBench') + dim(' — Phase 1 collector'))
    console.log(dim(`  listening on http://${opts.host}:${opts.port}  (/v1/logs, /v1/metrics, /v1/traces)`))
    console.log(dim('  health: /healthz · /readyz · /tracking-status'))
    console.log('')
    console.log(dim('  In another terminal:  tb-claude  (or: source env.sh && claude)'))
    console.log(dim('  Then run any prompt. Ctrl-C here for the schema summary.  node collector.js --check re-verifies the pipe.'))
  })
}

// ---------------------------------------------------------------------------
// Stale warning (Phase 1) — "is the pipe alive?" must be answerable by glance.
// The message never claims "nothing happened"; idle and broken are different.
// ---------------------------------------------------------------------------

function checkStale() {
  const now = Date.now()
  // Re-warn at most every 5 minutes so a long-running collector stays quiet
  // between actual problems.
  const quietIdle = health.lastWarnedAt && now - health.lastWarnedAt < 5 * 60000

  if (!health.lastEventAt) {
    if (now - health.startedAt.getTime() > 90_000 && !quietIdle) {
      health.lastWarnedAt = now
      console.warn('')
      console.warn(yellow(`  ! no telemetry has ever arrived (collector up ${Math.round((now - health.startedAt.getTime()) / 1000)}s).`))
      console.warn(dim('    Either Claude is not running, or it was launched without TokenBench telemetry.'))
      console.warn(dim('    Fix: run claude through  tb-claude   (diagnose with: node collector.js --check)'))
    }
    return
  }

  const idleMs = now - new Date(health.lastEventAt).getTime()
  if (idleMs > STALE_AFTER_MS && !quietIdle) {
    health.lastWarnedAt = now
    console.warn('')
    console.warn(yellow(`  ! no telemetry for ${Math.round(idleMs / 60000)}m.`))
    console.warn(dim('    Claude is idle, or it is running without TokenBench telemetry (use tb-claude).'))
  }
}

// ---------------------------------------------------------------------------
// Pipe check (Phase 1) — `node collector.js --check`. Verifies the four things
// that must line up for a terminal Claude Code session to be measured: a
// collector on the port, the OTLP env vars in THIS shell, the claude binary,
// and end-to-end arrival via a probe POST. Exits non-zero on a broken pipe.
// ---------------------------------------------------------------------------

async function runCheck(opts) {
  const net = require('node:net')
  const { execFileSync } = require('node:child_process')

  let failed = false
  const out = []
  const ok = (name, detail) => out.push(`${green('✓')} ${name}${detail ? dim(` — ${detail}`) : ''}`)
  const bad = (name, detail) => { failed = true; out.push(`${red('x')} ${name}${detail ? dim(` — ${detail}`) : ''}`) }
  const warn_ = (name, detail) => out.push(`${yellow('!')} ${name}${detail ? dim(` — ${detail}`) : ''}`)

  console.log('')
  console.log(bold('  TokenBench pipe check'))

  // 1. Is anything listening on the collector port?
  const listening = await new Promise((resolve) => {
    const sock = net.connect({ host: opts.host, port: opts.port })
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => resolve(false))
  })
  if (listening) ok(`collector on ${opts.host}:${opts.port}`, 'reachable')
  else bad(`no collector on ${opts.host}:${opts.port}`, 'start it with: node collector.js --db tokenbench.db --tokens --proxy')

  // env.sh points at a DIFFERENT port than the one being checked — claude
  // would emit to the env endpoint, not this check.
  const envEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || ''
  const envPort = Number((envEndpoint.match(/:\d+$/) || [])[0]?.slice(1) || 0)
  if (envPort && envPort !== opts.port) {
    warn_('OTEL_EXPORTER_OTLP_ENDPOINT', `points at :${envPort} but this check probed :${opts.port} — they must match`)
  }

  // 2. The telemetry env vars of THIS shell — the shell that will run claude.
  const proto = process.env.OTEL_EXPORTER_OTLP_PROTOCOL
  if (proto && proto !== 'http/json') bad('OTEL_EXPORTER_OTLP_PROTOCOL', `is '${proto}', but the collector only accepts http/json`)
  for (const k of ['CLAUDE_CODE_ENABLE_TELEMETRY', 'OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_LOGS_EXPORTER']) {
    const v = process.env[k]
    if (v === undefined) warn_(k, 'unset — claude will emit nothing unless env.sh is sourced')
    else ok(k, v)
  }

  // 3. The claude binary.
  try {
    const bin = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim()
    ok('claude binary', bin)
  } catch {
    bad('claude binary', 'not found on PATH')
  }

  // 4. End-to-end probe: POST one OTLP log record, confirm HTTP acceptance.
  if (listening) {
    try {
      const probe = await fetch(`http://${opts.host}:${opts.port}/v1/logs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceLogs: [{
            scopeLogs: [{
              logRecords: [{
                timeUnixNano: '0',
                attributes: [{ key: 'event.name', value: { stringValue: 'tokenbench.doctor' } }],
              }],
            }],
          }],
        }),
      })
      if (probe.ok) ok('OTLP probe POST /v1/logs', `HTTP ${probe.status}`)
      else bad('OTLP probe POST /v1/logs', `HTTP ${probe.status}`)
    } catch (e) {
      bad('OTLP probe POST /v1/logs', e.message)
    }
  }

  // 5. Progressive endpoint (feature-flag the arrival confirmation the running
  //    collector may predate).
  if (listening) {
    try {
      const st = await (await fetch(`http://${opts.host}:${opts.port}/tracking-status`)).json()
      ok('tracking-status endpoint', `${st.status}${st.store === false ? ' (store disabled — add --db)' : ''}`)
    } catch {
      warn_('tracking-status endpoint', 'not available — the running collector predates this build; restart it')
    }
  }

  console.log(out.join('\n'))
  console.log('')
  console.log(failed
    ? red('  pipe is NOT fully wired — fix the items above, then launch claude via tb-claude.')
    : green('  pipe looks wired. Launch claude with:  tb-claude'))
  console.log('')
  return failed ? 1 : 0
}

// ---------------------------------------------------------------------------
// Shutdown summary
// ---------------------------------------------------------------------------

let shuttingDown = false
function shutdown() {
  if (shuttingDown) process.exit(0)
  shuttingDown = true

  console.log('\n')
  console.log(bold('  Schema seen this run') + dim(`  (${requestCount} OTLP requests)`))
  if (seen.size === 0) {
    console.log(red('\n  Nothing arrived.'))
    console.log(dim('  Check: env vars exported in the SAME shell that launched claude,'))
    console.log(dim('         OTEL_EXPORTER_OTLP_PROTOCOL=http/json, and that claude was restarted.'))
  } else {
    for (const [id, entry] of [...seen.entries()].sort()) {
      console.log('')
      console.log(`  ${bold(id)} ${dim('×' + entry.count)}`)
      const keys = [...entry.keys].sort()
      console.log(dim('    ' + (keys.length ? keys.join(', ') : '(no attributes)')))
    }
  }
  console.log('')

  if (store) {
    const s = store.stats
    console.log(bold('  Stored'))
    console.log(
      dim(`    ${s.requests} requests, ${s.compactions} compactions, ${s.sessions} session starts` +
          `  ·  ${s.duplicates} duplicates ignored, ${s.skipped} events not persisted`)
    )
    const day = store.getDaily()
    console.log(dim(`    today ${day.local_date}: $${(day.cost_micros / 1e6).toFixed(4)} over ${day.request_count} requests`))
    console.log('')
    if (cliScanner) cliScanner.stop()
    store.close()
  }

  if (jsonlStream) jsonlStream.end()
  if (proxyServer) proxyServer.close()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
