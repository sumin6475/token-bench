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
  const opts = { port: 4318, host: '127.0.0.1', raw: false, jsonl: null, quiet: false, only: null, db: null, proxy: null, localUpstream: 'http://127.0.0.1:1337', upstream: 'https://api.openai.com' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') opts.port = Number(argv[++i])
    else if (a === '--host') opts.host = argv[++i]
    else if (a === '--raw') opts.raw = true
    else if (a === '--quiet') opts.quiet = true
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
  --only a,b        only print events whose name contains one of these substrings
  --tokens          shorthand for the token/cost-relevant events only
  --quiet           suppress the per-event block, keep only the running counters

Filtering affects PRINTING only. The schema summary on Ctrl-C, and --jsonl,
always cover every event received.
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
if (opts.db) {
  const { Store } = require('./src/store.js')
  store = new Store(path.resolve(opts.db))
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
if (opts.proxy) {
  const { createProxyServer } = require('./src/proxy-core.js')
  if (!store) console.log(yellow('  ! --proxy without --db: forwarding works but usage will NOT be stored'))
  proxyServer = createProxyServer({
    store,
    defaultUpstream: opts.upstream,
    localUpstream: opts.localUpstream,
    quiet: opts.quiet,
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

function serveState(res) {
  res.writeHead(200, { 'content-type': 'application/json' })
  if (!store) {
    return res.end(JSON.stringify({
      store: false,
      message: 'collector is running without --db. Restart with --db <file> to see live numbers.',
    }))
  }
  try {
    res.end(JSON.stringify({ store: true, ...store.getWidgetState() }))
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
    const days = Number(new URL(url, 'http://x').searchParams.get('days')) || 14
    res.end(JSON.stringify({ store: true, ...store.getDashboardData(days) }))
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
  if (opts.quiet) return
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
  for (const rl of payload.resourceLogs || []) {
    const resource = attributesToObject(rl.resource?.attributes)
    for (const sl of rl.scopeLogs || []) {
      const scope = sl.scope?.name || null
      for (const lr of sl.logRecords || []) {
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
}

function handleMetrics(payload) {
  for (const rm of payload.resourceMetrics || []) {
    const resource = attributesToObject(rm.resource?.attributes)
    for (const sm of rm.scopeMetrics || []) {
      const scope = sm.scope?.name || null
      for (const m of sm.metrics || []) {
        // A metric is exactly one of sum / gauge / histogram / summary.
        const series = m.sum || m.gauge || m.histogram || m.exponentialHistogram || m.summary
        for (const dp of series?.dataPoints || []) {
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
}

function handleTraces(payload) {
  for (const rs of payload.resourceSpans || []) {
    const resource = attributesToObject(rs.resource?.attributes)
    for (const ss of rs.scopeSpans || []) {
      const scope = ss.scope?.name || null
      for (const span of ss.spans || []) {
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
    if (url === '/state') return serveState(res)
    if (url === '/widget' || url === '/widget.html') return serveWidget(res)
    if (url === '/dashboard' || url === '/dashboard.html') return serveHtml(res, DASH_PATH)
    if (url === '/dashboard-data') return serveDashboardData(res, req.url)
    if (url === '/' && store) return serveWidget(res)
    // A plain GET is handy as a liveness check while wiring things up.
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end('TokenBench collector. GET /widget for the dashboard, /state for JSON. POST OTLP/HTTP JSON to /v1/logs, /v1/metrics, /v1/traces.\n')
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
    console.error(red(`  ! ${req.url}: body is not valid JSON — ${e.message}`))
    res.writeHead(400, { 'content-type': 'application/json' })
    return res.end('{}')
  }

  requestCount++
  if (opts.raw) {
    console.log(dim(`\n--- raw ${req.method} ${req.url} (${buf.length} bytes) ---`))
    console.log(JSON.stringify(payload, null, 2))
  }

  try {
    const url = req.url.split('?')[0]
    if (url === '/v1/logs') handleLogs(payload)
    else if (url === '/v1/metrics') handleMetrics(payload)
    else if (url === '/v1/traces') handleTraces(payload)
    else {
      // Unknown path: still show it rather than dropping it silently.
      console.log(yellow(`\n  ? POST ${url} — unrecognised OTLP path, ${buf.length} bytes`))
      if (!opts.raw) console.log(dim(JSON.stringify(payload).slice(0, 500)))
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

server.listen(opts.port, opts.host, () => {
  console.log('')
  console.log(bold('  TokenBench') + dim(' — Phase 1 collector'))
  console.log(dim(`  listening on http://${opts.host}:${opts.port}  (/v1/logs, /v1/metrics, /v1/traces)`))
  console.log('')
  console.log(dim('  In another terminal:  source env.sh && claude'))
  console.log(dim('  Then run any prompt. Ctrl-C here for the schema summary.'))
})

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
    store.close()
  }

  if (jsonlStream) jsonlStream.end()
  if (proxyServer) proxyServer.close()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
