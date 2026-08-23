'use strict'

/**
 * TokenBench — Phase 4 pricing.
 *
 * The proxy path (PRD 4.2) reports no cost, so unlike the Claude Code path it
 * must compute cost from a table. This is also where P1-4 lives: computing cost
 * for a Claude Code request whose cost IS reported, and diffing, validates the
 * table before the proxy has to trust it.
 *
 * The one arithmetic fact that makes this clean: cost is stored in integer
 * micros (millionths of a dollar), and a price of $X per 1,000,000 tokens is
 * exactly X micros per token. So `tokens * dollarsPer1M` is already micros —
 * no division, no float dollars, one rounding at the end per request (the same
 * discipline as the reported cost_usd_micros already in the store).
 */

const fs = require('node:fs')
const path = require('node:path')

const PRICING_PATH = path.join(__dirname, '..', 'pricing.json')

function loadPricing(file = PRICING_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return {
      models: parsed.models || {},
      multipliers: parsed.cache_multipliers || DEFAULT_MULTIPLIERS,
    }
  } catch (e) {
    console.error(`  ! could not read ${file}: ${e.message} — all models will price as unknown`)
    return { models: {}, multipliers: DEFAULT_MULTIPLIERS }
  }
}

// Appendix A. Only used if pricing.json is unreadable.
const DEFAULT_MULTIPLIERS = { input: 1.0, cache_read: 0.1, cache_write_5m: 1.25, cache_write_1h: 2.0 }

/**
 * Resolve a model id to {input, output} dollars-per-1M: exact match, then
 * longest prefix. Returns null for unknown — deliberately, so the caller
 * records an explicit unknown-pricing state instead of a guessed cost.
 */
function resolvePricing(model, models) {
  if (!model) return null
  if (models[model] !== undefined) return models[model]
  let best = null
  let bestLen = -1
  for (const [prefix, price] of Object.entries(models)) {
    if (model.startsWith(prefix) && prefix.length > bestLen) {
      best = price
      bestLen = prefix.length
    }
  }
  return best
}

/**
 * Compute cost in integer micros from a token breakdown.
 *
 *   { micros, known, priceSource }
 *
 * - provider 'local'  -> { micros: 0, known: true, priceSource: 'local' }
 *   Local models are legitimately free; that is a known price, not an unknown.
 * - unknown model     -> { micros: 0, known: false, priceSource: 'unknown' }
 *   Never a guessed number. The caller stores cost_source 'unknown' so the
 *   read side can say "N proxy requests, cost unknown" rather than understating.
 *
 * `cacheTtl` defaults to '1h' because that is what Claude Code actually writes
 * (proven by P1-4 — see pricing.json readme). Pass '5m' for a 5-minute-TTL
 * caller.
 */
function computeCostMicros(rec, pricing, cacheTtl = '1h') {
  const { model, provider } = rec
  const input = Math.max(0, rec.inputTokens || 0)
  const output = Math.max(0, rec.outputTokens || 0)
  const cacheRead = Math.max(0, rec.cacheReadTokens || 0)
  const cacheCreation = Math.max(0, rec.cacheCreationTokens || 0)

  if (provider === 'local') return { micros: 0, known: true, priceSource: 'local' }

  const price = resolvePricing(model, pricing.models)
  if (!price) return { micros: 0, known: false, priceSource: 'unknown' }

  const m = pricing.multipliers
  const writeMult = cacheTtl === '5m' ? m.cache_write_5m : m.cache_write_1h

  // dollars-per-1M * tokens == micros (see header).
  const micros =
    input * price.input * m.input +
    cacheRead * price.input * m.cache_read +
    cacheCreation * price.input * writeMult +
    output * price.output

  return { micros: Math.round(micros), known: true, priceSource: 'computed' }
}

module.exports = { loadPricing, resolvePricing, computeCostMicros, PRICING_PATH, DEFAULT_MULTIPLIERS }
