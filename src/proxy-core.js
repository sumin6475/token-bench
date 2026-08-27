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
const dns = require('node:dns')
const { URL } = require('node:url')
const { promisify } = require('node:util')
const lookup = promisify(dns.lookup)

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
    return { upstreamBase: headerUpstream, forwardPath: pathname, provider: null, headerDriven: true }
  }
  const m = pathname.match(/^\/(openai|anthropic|local|jan)(\/.*|$)/)
  if (m) {
    const key = m[1]
    const upstreamBase = key === 'local' ? localUpstream : PREFIXES[key]
    // Both /local (desktop app server) and /jan (jan serve CLI) are local
    // models: cost 0, throughput shown instead.
    const provider = key === 'jan' ? 'local' : key
    return { upstreamBase, forwardPath: m[2] || '/', provider, headerDriven: false }
  }
  return { upstreamBase: defaultUpstream, forwardPath: pathname, provider: null, headerDriven: false }
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

/**
 * Gemini (generativelanguage.googleapis.com) usage extraction — Phase 5.
 * usageMetadata lives on the FINAL chunk of an SSE stream (and on the root of
 * a non-stream response), in the same position OpenAI puts `usage`.
 *
 *   usageMetadata: {
 *     promptTokenCount,          // may include cached content tokens
 *     candidatesTokenCount,
 *     cachedContentTokenCount,   // the cache-read portion of promptTokenCount
 *     thoughtsTokenCount
 *   }
 *
 * Mirror of parseOpenAI: split cached out of the prompt count, treat cache
 * writes as 0 (Gemini does not bill distinct cache writes).
 */
function parseGemini(text) {
  const trimmed = text.trimStart()
  let o = null
  if (trimmed.startsWith('{')) {
    try { o = JSON.parse(text) } catch { return null }
  } else {
    const parts = sseDataObjects(text)
    if (!parts.length) return null
    o = parts[parts.length - 1]
  }
  const u = o && o.usageMetadata ? o.usageMetadata : null
  if (!u) return null
  const cached = u.cachedContentTokenCount || 0
  return {
    model: (o.modelVersion && o.modelVersion.replace(/^models\//, '')) || o.model || null,
    id: null,
    inputTokens: Math.max(0, (u.promptTokenCount || 0) - cached),
    cacheReadTokens: cached,
    cacheCreationTokens: 0,
    outputTokens: u.candidatesTokenCount || 0,
  }
}

function inferProvider(upstreamHref, override) {
  if (override) return String(override).toLowerCase()
  let host = ''
  try { host = new URL(upstreamHref).hostname } catch { /* fall through */ }
  if (/(^|\.)anthropic\.com$/.test(host)) return 'anthropic'
  if (/(^|\.)openai\.com$/.test(host)) return 'openai'
  if (/(^|\.)generativelanguage\.(googleapis\.)?com$/.test(host) || /(^|\.)gemini\.google\.com$/.test(host)) return 'gemini'
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host)) return 'local'
  return 'openai' // most OpenAI-compatible third parties speak the OpenAI shape
}

// ---------------------------------------------------------------------------
// Upstream safety (Phase 7 — SSRF guard)
//
// x-tb-upstream lets a caller choose the upstream for one request. That is a
// localhost convenience feature, but if the proxy were ever reachable from
// another machine it becomes an open relay into the caller's network.
// Private/loopback/link-local targets are refused by default; --allow-private-
// upstream turns the guard off for the fleet's own /local and /jan routes
// (which ARE loopback by design and never pass the header).
// ---------------------------------------------------------------------------

const PRIVATE_V4 = /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/

function isPrivateIp(ip) {
  if (!ip) return false
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : null
  const host = v4 || ip
  const lower = host.toLowerCase()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return PRIVATE_V4.test(host)
  return lower === '::1' || lower === '::' || /^(fc|fd|fe[89ab])/.test(lower)
}

/**
 * Validate a target the x-tb-upstream header pointed at. Returns an error
 * string when refused, null when allowed. Resolves DNS to catch a public
 * hostname that points back at a private address.
 */
async function validateUpstream(target, { allowPrivate = false } = {}) {
  const url = target instanceof URL ? target : new URL(String(target))
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `unsupported scheme ${url.protocol}`
  }
  if (allowPrivate) return null
  try {
    const { address } = await lookup(url.hostname)
    if (isPrivateIp(address)) return `upstream ${url.hostname} resolves to private address ${address}`
  } catch { /* DNS failure surfaces as an upstream error later, not here */ }
  return null
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
function createProxyServer({ store = null, defaultUpstream = 'https://api.openai.com', localUpstream = 'http://127.0.0.1:1337', quiet = false, allowPrivateUpstream = false } = {}) {
  let requestCounter = 0

  function recordUsage({ method, target, provider, reqBody, respBody, durationMs }) {
    const pathname = target.pathname
    const respText = respBody.toString('utf8')

    const isGemini =
      provider === 'gemini' || pathname.includes('generateContent') ||
      /(^|\.)generativelanguage\.(googleapis\.)?com$/.test(target.hostname)
    const isAnthropic = pathname.includes('/messages') || provider === 'anthropic'
    const parsed = isGemini ? parseGemini(respText) : (isAnthropic ? parseAnthropic : parseOpenAI)(respText)

    // Capture truth (Phase 3): a request that reached the proxy but gave us no
    // usage is STORED as usage_status 'no_usage'/'empty_response' with zero
    // tokens and cost_source 'unknown'. Never silently dropped, never guessed.
    const u = parsed || {}
    const usageStatus = parsed ? 'parsed' : (respBody.length ? 'no_usage' : 'empty_response')
    const usageReason = parsed
      ? null
      : `response has no ${isGemini ? 'usageMetadata' : 'usage'} object` +
        (respBody.length ? '' : ' (empty body)')

    let model = u.model
    if (!model) { try { model = JSON.parse(reqBody.toString('utf8')).model } catch { /* leave null */ } }
    const requestId = u.id || `proxy-${provider}-${++requestCounter}-${Date.now()}`

    if (!store) {
      if (!quiet) {
        const tok = parsed ? `${u.inputTokens}+${u.outputTokens} tok` : yellow(`no usage (${usageStatus})`)
        console.log(dim(`  ${method} ${pathname} ${model || '?'} — ${tok} (no store)`))
      }
      return
    }

    const r = store.ingestProxyRequest({
      requestId, provider, model, durationMs, usageStatus, usageReason, ...u,
    })
    if (quiet) return
    if (r.action === 'duplicate') {
      console.log(dim(`  ${method} ${pathname} — duplicate ${requestId}, totals unchanged`))
      return
    }
    if (r.usageStatus && r.usageStatus !== 'parsed') {
      console.log(`  ${yellow(provider)} ${bold(model || '?')} ${dim('·')} ${yellow(`usage unavailable (${r.usageStatus})`)} — request counted, cost unknown`)
      return
    }
    const cost = r.costKnown ? `$${(r.costMicros / 1e6).toFixed(6)}` : yellow('cost unknown — model not in pricing.json')
    const cached = u.cacheReadTokens ? ` ${dim('·')} ${u.cacheReadTokens} cached` : ''
    console.log(
      `  ${green(provider)} ${bold(model || '?')} ${dim('·')} ` +
        `${u.inputTokens} fresh + ${u.outputTokens} out${cached} ${dim('·')} ${cost}`
    )
  }

  return http.createServer((req, res) => {
    const chunks = []
    req.on('data', (ch) => chunks.push(ch))
    req.on('error', () => { /* client hung up */ })
    req.on('end', async () => {
      const reqBody = Buffer.concat(chunks)

      if (req.method === 'GET' && req.url.split('?')[0] === '/') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        return res.end(
          'TokenBench proxy. Base-URL routes: /openai/v1, /anthropic/v1, /local/v1 (Jan local server), ' +
          'bare /v1 -> default upstream. Headers x-tb-upstream / x-tb-provider override. ' +
          'x-tb-upstream is restricted to public hosts by default.\n'
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

      // SSRF guard: header-driven upstreams default to public hosts only.
      if (route.headerDriven) {
        const refused = await validateUpstream(target, { allowPrivate: allowPrivateUpstream })
        if (refused) {
          if (!quiet) console.error(red(`  ! refused x-tb-upstream: ${refused}`))
          res.writeHead(400, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: { message: `TokenBench proxy refused upstream: ${refused}` } }))
        }
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
        // A request that never reached an upstream answered nothing — count it
        // so "calls happened but nothing was recorded" is visible, not silent.
        try { if (store) store.stats.proxyUpstreamErrors++ } catch { /* non-fatal */ }
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
  sseDataObjects, parseOpenAI, parseAnthropic, parseGemini, inferProvider, validateUpstream, isPrivateIp, PREFIXES,
}
