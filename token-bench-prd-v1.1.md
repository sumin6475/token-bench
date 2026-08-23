# TokenBench — PRD v1.1
**Status:** Phase 1 complete and verified. Phase 2 ready to build.
**Date:** 2026-08-19
**Supersedes:** v1.0
**Owner:** Sumin
**Target:** Local macOS always-on-top widget + local data store

## Changes from v1.0

Phase 1 ran a real Claude Code session against a live collector. The wire did not match the spec in six places. All are corrected below.

| # | Change | Source |
|---|---|---|
| 1 | Event names carry no `claude_code.` prefix on the wire | Phase 1 |
| 2 | `session.count` is a metric, not a log event — env block corrected | v1.0 error |
| 3 | `query_source` has a third value, `sdk` | Phase 1 |
| 4 | Use `cost_usd_micros` (integer) rather than `cost_usd` (float) | v1.0 omission |
| 5 | Records carry PII — must be dropped before storage | Phase 1 |
| 6 | Token counts arrive twice (event + metric) — pick one | Phase 1 |
| 7 | int64 fields arrive as JSON strings | Phase 1 |
| 8 | Q1 resolved: Node sidecar | Decision |
| 9 | Q2 resolved: no pricing table in P0 | Decision |
| 10 | P0-3 (local cost calculation) moved to Phase 4 | Rescope |

---

## 1. Problem

I use several AI tools daily (Claude Code CLI, Jan with local models, IDE with my own API keys), and I have no felt sense of what any of it costs or how much context I am burning. Numbers appear after the fact, in a billing dashboard, disconnected from the moment I made the expensive choice.

I want to become someone who can move a workflow to a local model on judgment, not guesswork. That judgment requires having watched the numbers move in real time, next to the work that caused them.

**Cost of not solving:** I keep making context and model decisions blind, and I cannot evaluate local-model viability because I have no baseline for what my actual workloads look like.

---

## 2. Goals

1. **See context fill in real time.** A needle that moves as I work, showing how full the current session's context window is.
2. **Build intuition about cache.** Make the split between cached and fresh tokens visible, since that is the largest hidden factor in coding-agent cost.
3. **Know today's spend without asking.** Cumulative cost against a self-set budget, always visible.
4. **Cover both paths with one widget.** Claude Code CLI and API-key tools feed the same display.
5. **Establish a local-model baseline.** After two weeks of use, I can say which of my four task types would survive on a local model.

---

## 3. Non-goals

| Not doing | Why |
|---|---|
| Running experiments inside the app | I already have Jan and an IDE. This measures; it does not execute. |
| Manual entry of token counts | Defeats the purpose. If it is not automatic, I will not do it. |
| Response quality scoring | Real, but a separate problem. Adding it now doubles the scope. |
| Multi-user, cloud sync, sharing | Single machine, single user. |
| Capturing Claude desktop app usage | Technically impossible — no API key path, no client-side telemetry. Accepted gap. |
| Historical dashboard (families, task breakdown) | Deferred to v1.1. The widget must collect data before a dashboard means anything. |
| Own pricing table in P0 | Claude Code reports cost directly. Own calculation arrives with the proxy in Phase 4. |
| Storing any user identity fields | The wire carries them. We drop them at ingest. |

---

## 4. Core architecture

Two ingest paths, one local store, one widget.

```
Claude Code CLI ──OTLP/HTTP JSON──┐
                                  │
Jan / IDE / direct API ───────────┼──> Node sidecar (:4318 + :8787)
   (via local proxy, Phase 4)     │            │
                                  │            v
                                  │       SQLite store
                                  │            │
                                  │            v
                                  └──────> Tauri widget (always-on-top)
```

**Process model (Q1, resolved).** The collector runs as a Node sidecar process bundled with the Tauri app, not as native Rust. Rationale: the Phase 1 collector already works with zero dependencies, and rewriting it in Rust buys ~50MB and one fewer process at the cost of a week. This is a tool for building intuition, not a Rust exercise. Revisit after two weeks of daily use — if the tool sticks, the rewrite is cheap by then because the collector will be fully specified by working code.

Tauri manages the sidecar lifecycle via `tauri-plugin-shell`. The sidecar must exit cleanly when the app quits and must not leave :4318 bound.

### 4.1 Path A — Claude Code CLI (native OTel)

Claude Code emits OpenTelemetry natively. No proxy needed.

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_LOGS_EXPORT_INTERVAL=1000
export OTEL_METRIC_EXPORT_INTERVAL=5000
```

`OTEL_METRICS_EXPORTER` was missing in v1.0. Without it, `session.count` never arrives, because it is a metric and not a log event.

**Endpoints the collector must serve:**

| Path | Carries |
|---|---|
| `/v1/logs` | events — `api_request`, `compaction`, `api_error`, and others |
| `/v1/metrics` | counters — `claude_code.session.count`, `claude_code.token.usage`, `claude_code.cost.usage` |

#### Wire format notes (verified Phase 1)

These are the traps. Each one fails silently if missed.

1. **No prefix on `event.name`.** The attribute value is `api_request`. The prefixed form `claude_code.api_request` appears only in the record `body`. Match on the unprefixed value.

2. **int64 fields arrive as JSON strings.** OTLP JSON serializes 64-bit integers as strings to survive JavaScript's number range. `cache_read_tokens` arrives as `"61400"`, not `61400`. Adding without coercion produces string concatenation and no error. Every numeric field must go through an explicit parse at the ingest boundary:

   ```js
   const num = v => (typeof v === "string" ? parseInt(v, 10) : v) ?? 0
   ```

   Apply to: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd_micros`, `duration_ms`, `pre_tokens`, `post_tokens`.

3. **Use `cost_usd_micros`, not `cost_usd`.** Same value as an integer in millionths of a dollar (`0.055403` → `55403`). Store as INTEGER. Float dollars accumulate rounding error over thousands of rows and display badly at small magnitudes.

4. **Drop PII at ingest.** Every record carries `user.email`, `user.id`, `organization.id`, and `user.account_uuid`. None reach SQLite. Set the metrics cardinality flags as a second layer of defence:

   ```bash
   export OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false
   ```

   Note this only affects metrics. Log events still carry identity fields, so the ingest-side allowlist is the real protection. Allowlist the fields we want rather than blocklisting the ones we don't.

5. **Token counts arrive twice.** Once as attributes on the `api_request` event, once as four separate `claude_code.token.usage` metric points (`type` = input / output / cacheRead / cacheCreation). **Use the event, ignore the metric for token counts.** The event gives one atomic row per request; the metric is a delta counter that must be reassembled and will double-count if both are stored.

6. **`query_source` has three values**, not two: `main`, `subagent`, `sdk`. The `sdk` value appears for headless and Agent SDK sessions. Store the raw string; do not enum-constrain it.

#### Events consumed

| Event | Fields used |
|---|---|
| `api_request` | `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd_micros`, `duration_ms`, `query_source`, `request_id` |
| `compaction` | `pre_tokens`, `post_tokens`, `trigger`, `success` |
| `api_error` | `model`, `status_code`, `attempt` — for a fault indicator, not the gauge |

Metrics consumed: `claude_code.session.count` only, for session boundary detection.

**Note on auth.** This path works with subscription (OAuth) login as well as API key. Token counting is client-side. `cost_usd_micros` on a subscription session is an estimate of what the same usage would cost on the API — useful as a relative signal, not a bill.

### 4.2 Path B — local proxy (Phase 4)

A pass-through HTTP proxy on `localhost:8787`. Tools point their base URL at it; it forwards to the real provider and reads the `usage` object out of the response.

- Jan: add as a custom OpenAI-compatible provider in Settings
- Cursor / IDE: set the OpenAI base URL
- Local models via Jan's llama.cpp server: also OpenAI-compatible, same code path, cost = 0

Must handle streaming responses (SSE), where `usage` arrives in the final chunk.

This path has no reported cost, so it is where the pricing table (deferred from P0) becomes necessary.

### 4.3 Data model

```ts
type Request = {
  id: string
  ts: string
  source: "claude-code" | "proxy"
  provider: "anthropic" | "openai" | "local"
  model: string
  taskType: "coding-agent" | "product-brainstorm" | "business-brainstorm" | "general" | "unset"
  sessionId: string
  querySource: string          // main | subagent | sdk — raw, not enum
  project?: string
  inputTokens: number          // fresh, excludes cache
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  contextTokens: number        // derived: input + cacheRead + cacheCreation
  costMicros: number           // INTEGER, from cost_usd_micros or computed in Phase 4
  costSource: "reported" | "computed"
  durationMs: number
}

type Session = {
  id: string
  startedAt: string
  lastSeenAt: string
  source: string
  model: string
  taskType: string
  latestContextTokens: number   // overwritten, never summed
  cumulativeCostMicros: number  // summed
  compactionCount: number
}

type ModelWindow = {
  provider: string
  model: string
  contextWindow: number
}
```

`ModelWindow` replaces v1.0's `ModelSpec` in P0. Pricing fields return in Phase 4.

---

## 5. The gauge — exact definition

This is the part most likely to be built wrong. Spelling it out.

### 5.1 Context is a level, not a total

Every request re-sends the whole conversation. Summing token counts across a session produces a number that passes 100% within a few turns and is meaningless.

```
contextTokens = input_tokens + cache_read_tokens + cache_creation_tokens
gaugePercent  = contextTokens / modelWindow.contextWindow
```

`input_tokens` from the Anthropic API already excludes cached tokens, so the three add cleanly with no double-counting.

**On each new request: overwrite, do not add.**

Output tokens are excluded. They did not exist when the request was sent; they enter the window on the next turn as part of the message history.

**Which request drives the needle:** the most recent `api_request` where `query_source` is `main`. Subagent and SDK requests have their own context that is not the main thread's, and letting them drive the gauge makes it jump. Store them; do not display them in v1.

### 5.2 Cost is a total

P0: accumulate `cost_usd_micros` per session and per day. Nothing to compute.

Phase 4 (proxy path only, where no cost is reported):

```
requestCost = (inputTokens        / 1e6) * inputPrice
            + (cacheReadTokens    / 1e6) * inputPrice * 0.1
            + (cacheCreationTokens/ 1e6) * inputPrice * 1.25
            + (outputTokens       / 1e6) * outputPrice
```

Local models: cost = 0, but still record tokens and tokens/sec.

### 5.3 Compaction resets the needle

When a `compaction` event arrives with `success: true`, set `latestContextTokens = post_tokens` and increment `compactionCount`. The needle drops visibly. Do not smooth this — the drop is the point.

**Verification (open in v1.0, now actionable).** Do not wait for a long session. Running `/compact` in Claude Code triggers a manual compaction and emits the event immediately with `trigger: "manual"`. Confirm the field shapes this way before building the gauge. Manual events additionally carry `precompute_reuse`, which automatic ones do not; treat any field beyond `pre_tokens` / `post_tokens` / `trigger` / `success` as optional. Automatic compaction still needs one real long session to confirm, but it should not block the build.

### 5.4 Color bands

| Fill | Color | Meaning |
|---|---|---|
| 0–60% | teal | room to work |
| 60–85% | amber | compaction approaching |
| 85–100% | red | imminent |

### 5.5 Model context windows

A lookup table is required; the window varies by model. Hand-maintained JSON, roughly ten entries. Local models in Jan default to far smaller windows than API models, which is exactly the comparison this tool exists to surface.

Unknown model: show an explicit unknown state — token count with no percentage, gray gauge — rather than guessing a window and displaying a wrong percentage.

---

## 6. Widget spec

Always-on-top, ~320px wide, frameless, draggable, low opacity when idle.

**Contents, top to bottom:**

1. Task type selector (4 types + unset). Defaults by source: Claude Code → coding-agent.
2. Source badge (Claude Code / Jan / Cursor / local)
3. Model name + project name, small
4. Semicircular gauge with needle, percent in the center
5. `84,312 / 200,000` in mono
6. `61,400 cached · 22,912 fresh` in small muted text
7. Divider
8. Session cost
9. Today cost / budget, with a thin progress bar

Mockup approved 2026-08-19.

---

## 7. Requirements

### Phase 1 — complete

| # | Requirement | Status |
|---|---|---|
| P0-1a | OTLP/HTTP JSON listener on :4318, logs and metrics | Done, verified against a live Claude Code session |

### P0 — must ship

| # | Requirement | Acceptance criteria |
|---|---|---|
| P0-1b | Persist events to SQLite | Given a Claude Code session runs a prompt, when the event arrives, then a row exists in SQLite within 2 seconds with all numeric fields stored as integers |
| P0-2 | Context gauge with correct math | Given 5 consecutive turns in one session, when each completes, then the gauge shows the latest main-thread request's context, never a running sum, and never exceeds 100% before compaction |
| P0-3 | Cost accumulation from reported values | `cost_usd_micros` summed per session and per day, stored as INTEGER. No local pricing calculation in this phase |
| P0-4 | Cache split display | Cached and fresh token counts shown separately below the gauge |
| P0-5 | Daily budget | Daily total resets at local midnight; budget is user-configurable |
| P0-6 | Compaction handling | Given `/compact` is run, when the event is received, then the gauge drops to `post_tokens` within one refresh |
| P0-7 | Always-on-top window | Stays above other apps, draggable, remembers position across restarts |
| P0-8 | Context window table | Editable JSON; unknown model shows an explicit unknown state, not a wrong number |
| P0-9 | PII allowlist at ingest | Given a record carrying `user.email`, when it is written to SQLite, then no identity field is present in any column |
| P0-10 | Sidecar lifecycle | Given the app quits, when it exits, then the Node sidecar terminates and :4318 is released |

### P1 — soon after

| # | Requirement |
|---|---|
| P1-1 | Local proxy on :8787 for Jan and IDE, including SSE streaming |
| P1-2 | Manual task-type override that persists for the session |
| P1-3 | tokens/sec display — the meaningful metric for local models, where the constraint is memory and speed rather than price |
| P1-4 | Own cost calculation run alongside the reported figure, with the delta shown. Validates the pricing table before the proxy path has to rely on it |
| P1-5 | Subagent and SDK request visibility, separate from the main-thread gauge |

### P2 — designed for, not built

- Historical dashboard: model family × task type
- CSV / JSON export
- Per-project budgets
- Local model RAM and GPU pressure
- Automatic compaction confirmation from a long real session

---

## 8. Success criteria

Not adoption metrics — this is a tool for one person. Success is:

1. Within one week, I can predict roughly where the needle will sit before starting a task.
2. Within two weeks, I have data to answer: which of my four task types has a context profile a local model could handle.
3. I notice at least one habit I want to change (a context I let grow too long, a model I over-reach for).
4. The widget runs for a full working day without me thinking about it.

---

## 9. Open questions

**Resolved since v1.0:**

- ~~Q1: Tauri vs Electron, Rust vs sidecar~~ → Tauri shell, Node sidecar for the collector. Revisit after two weeks of use.
- ~~Q2: model spec table source~~ → Hand-maintained JSON, context windows only. Pricing deferred to Phase 4.

**Still open, non-blocking:**

- **Q3:** Session end detection. Claude Code emits a session start; the end is inferred from idle time. What threshold? Proposal: 30 minutes with no `api_request`, tunable.
- **Q4:** Multiple concurrent Claude Code sessions — which drives the needle? Proposal: the most recently active, with a session count indicator in the header.
- **Q5:** Does automatic compaction carry the same field shape as manual? Manual is confirmable now; automatic needs one long real session. Build against the manual shape and treat extra fields as optional.

---

## 10. Phasing

**Phase 1 — prove the pipe. Complete.**
Collector verified end-to-end against a real Claude Code session. Six wire-level corrections folded into section 4.1.

**Phase 2 — store and compute (1 day).**
SQLite schema, PII allowlist, context window table, context derivation, cost accumulation. Write the schema from the collector's own schema summary, not from this document. Verify totals against `/cost` in Claude Code.

**Phase 3 — widget (1–2 days).**
Tauri shell, sidecar wiring, gauge, always-on-top, live update. Confirm compaction with `/compact` before building the gauge drop.

**Phase 4 — proxy (1 day).**
Jan and IDE paths, including local models. The pricing table arrives here, along with P1-4's reported-vs-computed comparison.

Stop after Phase 4. Use it for two weeks before building the dashboard or considering the Rust rewrite.

---

## Appendix A — cost multipliers (Phase 4)

| Token type | Multiplier on base input price |
|---|---|
| Fresh input | 1.0x |
| Cache read (hit) | 0.1x |
| Cache write, 5-min TTL | 1.25x |
| Cache write, 1-hour TTL | 2.0x |

Output tokens are priced separately at the model's output rate.

Source: https://platform.claude.com/docs/en/about-claude/pricing

## Appendix B — reference docs

- Claude Code monitoring and OTel event schema: https://code.claude.com/docs/en/monitoring-usage
- Prompt caching mechanics: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
