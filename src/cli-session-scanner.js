'use strict'

/**
 * Local CLI discovery + usage-only log ingestion.
 *
 * Supported native logs:
 *   Codex: rollout JSONL files below ~/.codex/sessions (token_count events)
 *   Pi:    JSONL files below ~/.pi/agent/sessions (assistant usage objects)
 *
 * The parser never returns message content. That boundary is intentional: the
 * collector needs model/token/cost/session metadata, not prompts or replies.
 */

const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

function cliFromCommand(command) {
  const c = String(command || '')
  if (/(^|[\s/])claude(?:\s|$)/i.test(c)) return { source: 'claude-code', label: 'Claude Code' }
  if (/(^|[\s/])codex(?:\s|$)/i.test(c)) return { source: 'codex', label: 'Codex' }
  if (/(^|[\s/])pi(?:\s|$)/i.test(c) || /pi-coding-agent/i.test(c)) return { source: 'pi', label: 'Pi' }
  return null
}

function parsePs(output) {
  const rows = []
  for (const line of String(output || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/)
    if (!m) continue
    const found = cliFromCommand(m[5])
    if (!found) continue
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      tty: m[3] === '??' || m[3] === '?' ? null : m[3],
      elapsed: m[4],
      ...found,
    })
  }
  return rows
}

function parseCodexLine(line, state) {
  let row
  try { row = JSON.parse(line) } catch { return null }
  const p = row && row.payload
  if (!p || typeof p !== 'object') return null

  if (row.type === 'session_meta') {
    state.sessionId = String(p.id || p.session_id || state.sessionId || '') || null
    state.startedAt = p.timestamp || row.timestamp || state.startedAt
    state.project = p.cwd || state.project
    return null
  }
  if (row.type === 'turn_context') {
    state.model = p.model || state.model
    state.project = p.cwd || state.project
    return null
  }
  if (row.type !== 'event_msg' || p.type !== 'token_count' || !p.info) return null

  const u = p.info.last_token_usage
  if (!u || !state.sessionId) return null
  const totalInput = Number(u.input_tokens || 0)
  const cached = Number(u.cached_input_tokens || 0)
  const cacheWrite = Number(u.cache_write_input_tokens || 0)
  const ts = row.timestamp || new Date().toISOString()
  return {
    source: 'codex',
    sessionId: state.sessionId,
    requestId: `codex:${state.sessionId}:${ts}`,
    ts,
    startedAt: state.startedAt,
    project: state.project,
    provider: 'openai',
    model: state.model,
    inputTokens: Math.max(0, totalInput - cached),
    cacheReadTokens: cached,
    cacheCreationTokens: cacheWrite,
    outputTokens: Number(u.output_tokens || 0),
    contextTokens: totalInput + cacheWrite,
    contextWindow: Number(p.info.model_context_window || 0) || null,
    costMicros: 0,
    costSource: 'subscription',
  }
}

function parsePiLine(line, state, contextWindows = {}) {
  let row
  try { row = JSON.parse(line) } catch { return null }
  if (!row || typeof row !== 'object') return null

  if (row.type === 'session') {
    state.sessionId = String(row.id || state.sessionId || '') || null
    state.startedAt = row.timestamp || state.startedAt
    state.project = row.cwd || state.project
    return null
  }
  const msg = row.message
  if (row.type !== 'message' || !msg || msg.role !== 'assistant' || !msg.usage) return null
  if (!state.sessionId || !row.id) return null

  const u = msg.usage
  const model = msg.model || state.model
  state.model = model
  const totalCost = Number(u.cost && u.cost.total)
  return {
    source: 'pi',
    sessionId: state.sessionId,
    requestId: `pi:${state.sessionId}:${row.id}`,
    ts: row.timestamp || new Date().toISOString(),
    startedAt: state.startedAt,
    project: state.project,
    provider: msg.provider || 'pi',
    model,
    inputTokens: Number(u.input || 0),
    cacheReadTokens: Number(u.cacheRead || 0),
    cacheCreationTokens: Number(u.cacheWrite || 0),
    outputTokens: Number(u.output || 0),
    contextWindow: Number(contextWindows[model] || 0) || null,
    costMicros: Number.isFinite(totalCost) ? Math.round(totalCost * 1e6) : 0,
    costSource: Number.isFinite(totalCost) ? 'reported' : 'unknown',
  }
}

function recentJsonl(root, cutoffMs, out = []) {
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const p = path.join(root, entry.name)
    if (entry.isDirectory()) recentJsonl(p, cutoffMs, out)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const st = fs.statSync(p)
        if (st.mtimeMs >= cutoffMs) out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs })
      } catch { /* file disappeared between readdir and stat */ }
    }
  }
  return out
}

function loadPiContextWindows(homeDir) {
  const out = {}
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(homeDir, '.pi', 'agent', 'models-store.json'), 'utf8'))
  } catch { return out }
  const visit = (value) => {
    if (!value || typeof value !== 'object') return
    if (!Array.isArray(value) && typeof value.id === 'string' && Number(value.contextWindow) > 0) {
      out[value.id] = Number(value.contextWindow)
    }
    for (const child of Object.values(value)) visit(child)
  }
  visit(parsed)
  return out
}

class CliSessionScanner {
  constructor({ store, homeDir = os.homedir(), intervalMs = 1000, execFile = childProcess.execFile } = {}) {
    this.store = store
    this.homeDir = homeDir
    this.intervalMs = intervalMs
    this.execFile = execFile
    this.piContextWindows = loadPiContextWindows(homeDir)
    this.files = new Map()
    this.running = []
    this.lastProcessError = null
    this.timer = null
    this.scanning = false
  }

  start() {
    if (this.timer) return
    this.scan()
    this.timer = setInterval(() => this.scan(), this.intervalMs)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  snapshot() {
    return {
      runningClis: this.running,
      processDetection: this.lastProcessError ? 'unavailable' : 'available',
      processDetectionReason: this.lastProcessError,
    }
  }

  scan() {
    if (this.scanning) return
    this.scanning = true
    try { this.#scanLogs() } catch (e) { console.error(`  ! CLI log scan: ${e.message}`) }
    this.#scanProcesses(() => { this.scanning = false })
  }

  #scanProcesses(done) {
    try {
      this.execFile('/bin/ps', ['-axo', 'pid=,ppid=,tty=,etime=,command='], { encoding: 'utf8' }, (err, stdout) => {
        if (err) {
          this.running = []
          this.lastProcessError = err.code || err.message
        } else {
          this.running = parsePs(stdout).filter((p) => p.pid !== process.pid)
          this.lastProcessError = null
        }
        done()
      })
    } catch (err) {
      this.running = []
      this.lastProcessError = err.code || err.message
      done()
    }
  }

  #scanLogs() {
    if (!this.store) return
    // A terminal session can sit idle for hours and still be open. Keep one
    // day of local log candidates available; the widget narrows them using
    // actual running process sources plus the normal 30-minute activity rule.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    const specs = [
      { source: 'codex', root: path.join(this.homeDir, '.codex', 'sessions') },
      { source: 'pi', root: path.join(this.homeDir, '.pi', 'agent', 'sessions') },
    ]
    for (const spec of specs) {
      for (const file of recentJsonl(spec.root, cutoff)) this.#scanFile(spec.source, file)
    }
  }

  #scanFile(source, file) {
    let tracked = this.files.get(file.path)
    if (!tracked) {
      const fallbackId = (path.basename(file.path).match(UUID) || [])[1] || `${source}:${file.path}`
      tracked = { offset: 0, remainder: '', state: { sessionId: fallbackId } }
      this.files.set(file.path, tracked)
    }
    if (file.size < tracked.offset) { tracked.offset = 0; tracked.remainder = '' }
    if (file.size === tracked.offset) return

    // On first sight, cap the backfill to the last 2 MiB. Read a small head as
    // well so session id/cwd survive even when a long transcript pushed the
    // metadata out of the tail. Subsequent scans consume every appended byte.
    if (tracked.offset === 0 && file.size > 2 * 1024 * 1024) {
      this.#readRange(source, file.path, tracked, 0, Math.min(file.size, 512 * 1024), false)
      tracked.offset = file.size - 2 * 1024 * 1024
      tracked.remainder = ''
    }
    this.#readRange(source, file.path, tracked, tracked.offset, file.size - tracked.offset, true)
    tracked.offset = file.size
  }

  #readRange(source, file, tracked, start, length, mayStartMidLine) {
    if (length <= 0) return
    const fd = fs.openSync(file, 'r')
    let text
    try {
      const buf = Buffer.alloc(length)
      const n = fs.readSync(fd, buf, 0, length, start)
      text = buf.subarray(0, n).toString('utf8')
    } finally { fs.closeSync(fd) }

    if (mayStartMidLine && start > 0 && !tracked.remainder) {
      const nl = text.indexOf('\n')
      text = nl === -1 ? '' : text.slice(nl + 1)
    }
    const parts = (tracked.remainder + text).split('\n')
    tracked.remainder = parts.pop() || ''
    for (const line of parts) {
      const rec = source === 'codex'
        ? parseCodexLine(line, tracked.state)
        : parsePiLine(line, tracked.state, { ...this.store.windows, ...this.piContextWindows })
      if (rec) this.store.ingestCliRequest(rec)
    }
  }
}

module.exports = {
  CliSessionScanner, cliFromCommand, parsePs, parseCodexLine, parsePiLine,
  recentJsonl, loadPiContextWindows,
}
