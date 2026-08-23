'use strict'

/**
 * TokenBench — proxy core (Phase 4, extracted for the Jan-first pivot).
 *
 * The forwarding + usage-extraction logic, factored out of proxy.js so it can
 * run in TWO places without duplication:
 *   - standalone `node proxy.js`            (its own Store, own process)
 *   - inside the collector via `--proxy`    (SHARED Store, one process — the
 *     mode the Mac app uses, avoiding two processes writing one SQLite file)
 *
 * New here vs the original proxy.js: PATH-PREFIX ROUTING. Jan configures a
 * base URL per provider and cannot send custom headers, so one port serves
 * every provider by prefix:
 *
 *   /openai/v1/...     -> https://api.openai.com/v1/...      provider openai
 *   /anthropic/v1/...  -> https://api.anthropic.com/v1/...   provider anthropic
 *   /local/v1/...      -> localUpstream (Jan's :1337)         provider local ($0)
 *   /v1/...            -> defaultUpstream                     provider inferred
 *
 * The old behaviors are preserved: bare paths go to the default upstream, and
 * the x-tb-upstream / x-tb-provider headers still override everything.
 */

const http = require('node:http')
const https = require('node:https')
const { URL } = require('node:url')

// ---------------------------------------------------------------------------
// Routing — pure, so tests never need a socket.
// ---------------------------------------------------------------------------

const PREFIXES = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  local: null, // resolved from opts.localUpstream (Jan desktop app server, :1337)
  jan: 'http://127.0.0.1:6767', // `jan serve` CLI (verified: jan 0.8.4 serves at localhost:6767/v1)
}

/**
 * Decide where a request goes and which provider prices it.
 * Returns { upstreamBase, forwardPath, provider } — provider null means
 * "infer from the upstream host later" (the pre-prefix behavior).
 * Precedence: x-tb-upstream header > path prefix > defaultUpstream.
 * The x-tb-provider header is applied later (recordUsage) and beats all.
 */
function resolveRoute(pathname, headers, { defaultUpstream, localUpstream }) {
  const headerUpstream = headers && headers['x-tb-upstream']
  if (headerUpstream) {
    return { upstreamBase: headerUpstream, forwardPath: pathname, provider: null }
  }
  const m = pathname.match(/^\/(openai|anthropic|local|jan)(\/.*|$)/)
  if (m) {
    const key = m[1]
    const upstreamBase = key === 'local' ? localUpstream : PREFIXES[key]
    // Both /local (desktop app server) and /jan (jan serve CLI) are local
    // models: cost 0, throughput shown instead.
    const provider = key === 'jan' ? 'local' : key
    return { upstreamBase, forwardPath: m[2] || '/', provider }
  }
  return { upstreamBase: defaultUpstream, forwardPath: pathname, provider: null }
}

// ---------------------------------------------------------------------------
// Usage extraction (moved verbatim from proxy.js)
// ---------------------------------------------------------------------------

/** Pull parsed JSON objects out of `data:` SSE lines (skips `[DONE]`). */
function sseDataObjects(text) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const payload = t.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try { out.push(JSON.parse(payload)) } catch { /* partial/non-JSON keepalive */ }
  }
  return out
}

function parseOpenAI(text) {
  const trimmed = text.trimStart()
  let model = null, id = null, usage = null
  if (trimmed.startsWith('{')) {
    try { const o = JSON.parse(text); model = o.model; id = o.id; usage = o.usage } catch { return null }
  } else {
    for (const o of sseDataObjects(text)) {
      if (o.model && !model) model = o.model
      if (o.id && !id) id = o.id
      if (o.usage) usage = o.usage // the final chunk (with stream_options.include_usage) wins
    }
  }
  if (!usage) return null
  const cached = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0
  const prompt = usage.prompt_tokens || 0
  return {
    model, id,
    inputTokens: Math.max(0, prompt - cached), // OpenAI prompt_tokens INCLUDES cached; split it out
    cacheReadTokens: cached,
    cacheCreationTokens: 0, // OpenAI does not bill cache writes
    outputTokens: usage.completion_tokens || 0,
  }
}

function parseAnthropic(text) {
  const trimmed = text.trimStart()
  if (trimmed.startsWith('{')) {
    try {
      const o = JSON.parse(text); const u = o.usage || {}
      return {
        model: o.model, id: o.id,
        inputTokens: u.input_tokens || 0,
        cacheReadTokens: u.cache_read_input_tokens || 0,
        cacheCreationTokens: u.cache_creation_input_tokens || 0,
        outputTokens: u.output_tokens || 0,
      }
    } catch { return null }
  }
  // SSE: message_start carries input + cache usage and the model/id;
  // message_delta carries the running output_tokens (last one is final).
  let model = null, id = null, input = 0, cacheRead = 0, cacheCreation = 0, output = 0, got = false
  for (const o of sseDataObjects(text)) {
    if (o.type === 'message_start' && o.message) {
      got = true
      model = o.message.model; id = o.message.id
      const u = o.message.usage || {}
      input = u.input_tokens || 0
      cacheRead = u.cache_read_input_tokens || 0
      cacheCreation = u.cache_creation_input_tokens || 0
      output = u.output_tokens || output
    }
    if (o.type === 'message_delta' && o.usage && o.usage.output_tokens != null) {
      got = true
      output = o.usage.output_tokens
    }
  }
  if (!got) return null
  return { model, id, inputTokens: input, cacheReadTokens: cacheRead, cacheCreationTokens: cacheCreation, outputTokens: output }
}

function inferProvider(upstreamHref, override) {
  if (override) return String(override).toLowerCase()
  let host = ''
  try { host = new URL(upstreamHref).hostname } catch { /* fall through */ }
  if (/(^|\.)anthropic\.com$/.test(host)) return 'anthropic'
  if (/(^|\.)openai\.com$/.test(host)) return 'openai'
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host)) return 'local'
  return 'openai' // most OpenAI-compatible third parties speak the OpenAI shape
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s))
const dim = c('2')
const bold = c('1')
const red = c('31')
const green = c('32')
const yellow = c('33')

/**
 * Create the proxy http.Server. `store` may be null (forward-only, warn once).
 * Caller owns listen()/close().
 */
function createProxyServer({ store = null, defaultUpstream = 'https://api.openai.com', localUpstream = 'http://127.0.0.1:1337', quiet = false } = {}) {
  let requestCounter = 0

  function recordUsage({ method, target, provider, reqBody, respBody, durationMs }) {
    const pathname = target.pathname
    const respText = respBody.toString('utf8')
    const isAnthropic = pathname.includes('/messages') || provider === 'anthropic'
    const parsed = (isAnthropic ? parseAnthropic : parseOpenAI)(respText)

    if (!parsed) {
      if (!quiet) console.log(dim(`  ${method} ${pathname} — no usage in response, nothing stored`))
      return
    }

    let model = parsed.model
    if (!model) { try { model = JSON.parse(reqBody.toString('utf8')).model } catch { /* leave null */ } }
    const requestId = parsed.id || `proxy-${provider}-${++requestCounter}-${Date.now()}`

    if (!store) {
      if (!quiet) console.log(dim(`  ${method} ${pathname} ${model || '?'} — ${parsed.inputTokens}+${parsed.outputTokens} tok (no store)`))
      return
    }

    const r = store.ingestProxyRequest({ requestId, provider, model, durationMs, ...parsed })
    if (quiet) return
    if (r.action === 'duplicate') {
      console.log(dim(`  ${method} ${pathname} — duplicate ${requestId}, totals unchanged`))
      return
    }
    const cost = r.costKnown ? `$${(r.costMicros / 1e6).toFixed(6)}` : yellow('cost unknown — model not in pricing.json')
    const cached = parsed.cacheReadTokens ? ` ${dim('·')} ${parsed.cacheReadTokens} cached` : ''
    console.log(
      `  ${green(provider)} ${bold(model || '?')} ${dim('·')} ` +
        `${parsed.inputTokens} fresh + ${parsed.outputTokens} out${cached} ${dim('·')} ${cost}`
    )
  }

  return http.createServer((req, res) => {
    const chunks = []
    req.on('data', (ch) => chunks.push(ch))
    req.on('error', () => { /* client hung up */ })
    req.on('end', () => {
      const reqBody = Buffer.concat(chunks)

      if (req.method === 'GET' && req.url.split('?')[0] === '/') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        return res.end(
          'TokenBench proxy. Base-URL routes: /openai/v1, /anthropic/v1, /local/v1 (Jan local server), ' +
          'bare /v1 -> default upstream. Headers x-tb-upstream / x-tb-provider override.\n'
        )
      }

      const pathname = req.url.split('?')[0]
      const query = req.url.slice(pathname.length)
      const route = resolveRoute(pathname, req.headers, { defaultUpstream, localUpstream })

      let target
      try { target = new URL(route.forwardPath + query, route.upstreamBase) } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: `bad upstream: ${route.upstreamBase}` } }))
      }

      // x-tb-provider header > route prefix > host inference.
      const provider = inferProvider(target.href, req.headers['x-tb-provider'] || route.provider)

      const headers = { ...req.headers }
      // Strip hop-by-hop and our own control headers; content-length is recomputed.
      delete headers.host
      delete headers['x-tb-upstream']
      delete headers['x-tb-provider']
      delete headers['content-length']

      const lib = target.protocol === 'https:' ? https : http
      const startedAt = Date.now()

      const upReq = lib.request(target, { method: req.method, headers }, (upRes) => {
        // Pass status + headers through verbatim, then stream the body to the
        // client while teeing a copy for usage extraction.
        res.writeHead(upRes.statusCode, upRes.headers)
        const respChunks = []
        upRes.on('data', (d) => { res.write(d); respChunks.push(d) })
        upRes.on('error', () => res.end())
        upRes.on('end', () => {
          res.end()
          try {
            recordUsage({
              method: req.method,
              target,
              provider,
              reqBody,
              respBody: Buffer.concat(respChunks),
              durationMs: Date.now() - startedAt,
            })
          } catch (e) {
            if (!quiet) console.error(red(`  ! usage extraction failed: ${e.message}`))
          }
        })
      })

      upReq.on('error', (e) => {
        console.error(red(`  ! upstream error: ${e.message}`))
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `proxy upstream error: ${e.message}` } }))
      })

      if (reqBody.length) upReq.write(reqBody)
      upReq.end()
    })
  })
}

module.exports = {
  createProxyServer, resolveRoute,
  // exported for tests
  sseDataObjects, parseOpenAI, parseAnthropic, inferProvider, PREFIXES,
}
