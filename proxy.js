#!/usr/bin/env node
/**
 * TokenBench — Phase 4: local pass-through proxy (PRD 4.2), CLI wrapper.
 *
 * The actual forwarding + usage-extraction logic lives in src/proxy-core.js so
 * the collector can also run it in-process (`node collector.js --proxy`) —
 * which is the mode the Mac app uses. This wrapper exists for standalone use:
 *
 *   node proxy.js --db tokenbench.db
 *   # then, in Jan (Settings -> Model Providers), set base URLs to:
 *   #   OpenAI          http://localhost:8787/openai/v1
 *   #   Anthropic       http://localhost:8787/anthropic/v1
 *   #   Local (tracked) http://localhost:8787/local/v1   (forwards to Jan's :1337)
 *
 * NOTE: if the collector is already running with --proxy, do NOT also run this
 * (two processes writing one SQLite file). One or the other.
 */

'use strict'

const path = require('node:path')
const { createProxyServer } = require('./src/proxy-core.js')

function parseArgs(argv) {
  const opts = {
    port: 8787, host: '127.0.0.1',
    upstream: 'https://api.openai.com',
    localUpstream: 'http://127.0.0.1:1337',
    db: null, quiet: false, allowPrivateUpstream: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') opts.port = Number(argv[++i])
    else if (a === '--host') opts.host = argv[++i]
    else if (a === '--upstream') opts.upstream = argv[++i]
    else if (a === '--local-upstream') opts.localUpstream = argv[++i]
    else if (a === '--db') opts.db = argv[++i]
    else if (a === '--quiet') opts.quiet = true
    else if (a === '--allow-private-upstream') opts.allowPrivateUpstream = true
    else if (a === '--help' || a === '-h') {
      console.log(`TokenBench Phase 4 proxy (standalone)

  --db <file>            store usage to SQLite (cost computed from pricing.json)
  --port <n>             listen port (default 8787)
  --host <addr>          bind address (default 127.0.0.1, loopback only)
  --upstream <url>       upstream for bare /v1 paths (default https://api.openai.com)
  --local-upstream <url> upstream for /local/* (default http://127.0.0.1:1337 — Jan's server)
  --allow-private-upstream  allow x-tb-upstream to target private/loopback hosts
                           (SSRF guard is ON by default: header upstreams are public-only)
  --quiet                suppress the per-request line

Path routing:   /openai/v1/*  /anthropic/v1/*  /local/v1/*  or bare /v1/* -> --upstream
Header override: x-tb-upstream <url>, x-tb-provider <anthropic|openai|local>
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

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const dim = (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : String(s))
const bold = (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : String(s))
const red = (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : String(s))

let store = null
if (opts.db) {
  const { Store } = require('./src/store.js')
  store = new Store(path.resolve(opts.db))
  console.log(dim(`  storing proxy usage to ${path.resolve(opts.db)}`))
}

const server = createProxyServer({
  store,
  defaultUpstream: opts.upstream,
  localUpstream: opts.localUpstream,
  quiet: opts.quiet,
  allowPrivateUpstream: opts.allowPrivateUpstream,
})

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(red(`\nPort ${opts.port} is already in use.`))
    console.error(dim(`Is the collector already running with --proxy? Use one or the other.`))
    console.error(dim(`Find the process with:  lsof -nP -iTCP:${opts.port} -sTCP:LISTEN\n`))
    process.exit(1)
  }
  throw e
})

server.listen(opts.port, opts.host, () => {
  if (!['127.0.0.1', 'localhost', '::1'].includes(opts.host)) {
    console.warn(red(`  ! bound to ${opts.host} — the proxy serves ANY interface. Anyone who can reach it`))
    console.warn(red('    can relay requests through it (SSRF guard only protects the x-tb-upstream header).'))
  }
  console.log('')
  console.log(bold('  TokenBench') + dim(' — Phase 4 proxy'))
  console.log(dim(`  listening on http://${opts.host}:${opts.port}`))
  console.log(dim(`    /openai/v1 -> api.openai.com   /anthropic/v1 -> api.anthropic.com`))
  console.log(dim(`    /local/v1  -> ${opts.localUpstream}   bare /v1 -> ${opts.upstream}`))
  console.log('')
})

function shutdown() {
  if (store) store.close()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 300).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
