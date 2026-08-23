# TokenBench — PRD v1.0
**Status:** Draft, ready for build
**Date:** 2026-08-19
**Owner:** Sumin
**Target:** Local macOS always-on-top widget + local data store

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

---

## 4. Core architecture

Two ingest paths, one local store, one widget.

```
Claude Code CLI ──OTLP/HTTP──┐
                             │
Jan / IDE / direct API ──────┼──> local collector (:4318 + :8787)
   (via local proxy)         │            │
                             │            v
                             │       SQLite store
                             │            │
                             │            v
                             └──────> widget (always-on-top)
```

### 4.1 Path A — Claude Code CLI (native OTel)

Claude Code emits OpenTelemetry natively. No proxy needed. The user sets environment variables; the app listens.

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_LOGS_EXPORT_INTERVAL=1000
```

**Events consumed:**

| Event | Fields used |
|---|---|
| `claude_code.api_request` | `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`, `duration_ms`, `query_source` |
| `claude_code.compaction` | `pre_tokens`, `post_tokens`, `trigger` |
| `claude_code.session.count` | session start, `start_type` |

Notes for the builder:

- Works with subscription (OAuth) auth as well as API key. Token counting is client-side.
- `cost_usd` is Claude Code's own estimate, not billing data. Store it, but compute our own cost independently so the two can be compared.
- `query_source` distinguishes `main` from `subagent` — useful later, store it.

### 4.2 Path B — local proxy (Jan, IDE, direct API)

A pass-through HTTP proxy on `localhost:8787`. Tools point their base URL at it; it forwards to the real provider and reads the `usage` object out of the response.

- Jan: add as a custom OpenAI-compatible provider in Settings
- Cursor / IDE: set the OpenAI base URL
- Local models via Jan's llama.cpp server: also OpenAI-compatible, same code path, cost = $0

Must handle streaming responses (SSE), where `usage` arrives in the final chunk.

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
  project?: string
  inputTokens: number        // fresh, excludes cache
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  contextTokens: number      // derived: input + cacheRead + cacheCreation
  costUsd: number            // computed locally
  costUsdReported?: number   // from claude_code.api_request, for comparison
  durationMs: number
}

type Session = {
  id: string
  startedAt: string
  source: string
  model: string
  taskType: string
  latestContextTokens: number   // overwritten, never summed
  cumulativeCostUsd: number     // summed
  compactionCount: number
}

type ModelSpec = {
  provider: string
  model: string
  contextWindow: number
  inputPricePerMTok: number
  outputPricePerMTok: number
  cacheReadMultiplier: number      // 0.1
  cacheWriteMultiplier: number     // 1.25 for 5-min TTL
}
```

---

## 5. The gauge — exact definition

This is the part most likely to be built wrong. Spelling it out.

### 5.1 Context is a level, not a total

Every request re-sends the whole conversation. Summing token counts across a session produces a number that passes 100% within a few turns and is meaningless.

```
contextTokens = input_tokens + cache_read_tokens + cache_creation_tokens
gaugePercent  = contextTokens / modelSpec.contextWindow
```

`input_tokens` from the Anthropic API already excludes cached tokens, so the three add cleanly with no double-counting.

**On each new request: overwrite, do not add.**

Output tokens are excluded. They did not exist when the request was sent; they enter the window on the next turn as part of the message history.

### 5.2 Cost is a total

```
requestCost = (inputTokens        / 1e6) * inputPrice
            + (cacheReadTokens    / 1e6) * inputPrice * 0.1
            + (cacheCreationTokens/ 1e6) * inputPrice * 1.25
            + (outputTokens       / 1e6) * outputPrice
```

Accumulate per session and per day. Local models: cost = 0, but still record tokens and tokens/sec.

### 5.3 Compaction resets the needle

When `claude_code.compaction` arrives, set `latestContextTokens = post_tokens` and increment `compactionCount`. The needle should visibly drop. Do not smooth this out — the drop is the point.

### 5.4 Color bands

| Fill | Color | Meaning |
|---|---|---|
| 0–60% | teal | room to work |
| 60–85% | amber | compaction approaching |
| 85–100% | red | imminent |

### 5.5 Model context windows

A lookup table is required; the window varies by model. Local models in Jan default to far smaller windows than API models, which is exactly the comparison this tool exists to surface. Ship with a JSON file the user can edit, and fall back to a conservative default with a visible "unknown window" state rather than guessing.

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

### P0 — must ship

| # | Requirement | Acceptance criteria |
|---|---|---|
| P0-1 | OTLP/HTTP JSON listener on :4318 | Given telemetry env vars are set, when a Claude Code session runs a prompt, then an `api_request` row appears in SQLite within 2 seconds |
| P0-2 | Context gauge with correct math | Given 5 consecutive turns in one session, when each completes, then the gauge shows the latest request's context, never a running sum, and never exceeds 100% before compaction |
| P0-3 | Local cost calculation | Given a request with cache reads, when cost is computed, then cache reads are billed at 0.1x and cache writes at 1.25x of base input price |
| P0-4 | Cache split display | Cached and fresh token counts are shown separately below the gauge |
| P0-5 | Session and daily cost accumulation | Daily total resets at local midnight; budget is user-configurable |
| P0-6 | Compaction handling | Given a compaction event, when it is received, then the gauge drops to `post_tokens` within one refresh |
| P0-7 | Always-on-top window | Stays above other apps, draggable, remembers position across restarts |
| P0-8 | Model spec table | Editable JSON; unknown model shows an explicit unknown state, not a wrong number |

### P1 — soon after

| # | Requirement |
|---|---|
| P1-1 | Local proxy on :8787 for Jan and IDE, including SSE streaming |
| P1-2 | Manual task-type override that persists for the session |
| P1-3 | tokens/sec display, meaningful for local models |
| P1-4 | Reported-vs-computed cost delta, to validate the pricing table |

### P2 — designed for, not built

- Historical dashboard: model family × task type
- CSV / JSON export
- Per-project budgets
- Local model RAM and GPU pressure

---

## 8. Success criteria

Not adoption metrics — this is a tool for one person. Success is:

1. Within one week, I can predict roughly where the needle will sit before starting a task.
2. Within two weeks, I have data to answer: which of my four task types has a context profile a local model could handle.
3. I notice at least one habit I want to change (a context I let grow too long, a model I over-reach for).
4. The widget runs for a full working day without me thinking about it.

---

## 9. Open questions

**Blocking:**

- **Q1 (build):** Tauri vs Electron. Tauri is the working assumption — smaller memory footprint, native always-on-top. Confirm the OTLP listener works cleanly from the Rust side, or run the collector as a sidecar Node process.
- **Q2 (data):** Where does the model spec table come from? Hand-maintained JSON to start. Revisit if it drifts.

**Non-blocking:**

- **Q3:** How to detect the end of a session cleanly. Claude Code emits a session start; the end is inferred from idle time. What idle threshold?
- **Q4:** Should the widget distinguish main-thread requests from subagent requests in the gauge? `query_source` is available. Probably a v1.1 dashboard concern.
- **Q5:** Multiple concurrent Claude Code sessions — which one does the needle show? Proposal: the most recently active, with a session count indicator.

---

## 10. Phasing

**Phase 1 — prove the pipe (half day).**
A script that sets the env vars, listens on :4318, and prints every event to the console. No UI. This de-risks the entire project. If the events do not arrive, everything else is moot.

**Phase 2 — store and compute (1 day).**
SQLite schema, model spec table, cost calculation, context derivation. Verify against `/cost` in Claude Code.

**Phase 3 — widget (1–2 days).**
Tauri shell, gauge, always-on-top, live update.

**Phase 4 — proxy (1 day).**
Jan and IDE paths, including local models.

Stop after Phase 4. Use it for two weeks before building the dashboard.

---

## Appendix A — cost multipliers

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
