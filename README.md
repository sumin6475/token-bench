# TokenBench

A local view of what Claude Code is actually costing and how full its context window is. Zero dependencies, Node 22+ (uses the built-in `node:sqlite`).

**Phase 1** — collector on `:4318`, verified against live Claude Code. Done.
**Phase 2** — SQLite store: PII allowlist, context derivation, cost accumulation. Done, no UI.
**Phase 3** — live widget served by the collector: semicircular gauge, cache split, session + daily cost, editable budget, task-type override. Done, verified end-to-end. Native Mac shell (Tauri, always-on-top + collector sidecar) scaffolded in [`desktop/`](desktop/).
**Phase 4** — local proxy for Jan/IDE/local models + own pricing table (cost computed, reported-vs-computed validated). Done, verified end-to-end against fake upstreams.

## The proxy (Phase 4)

Path B (PRD 4.2): a transparent pass-through proxy on `:8787`. Point any tool's
OpenAI- or Anthropic-compatible base URL at it; it forwards each request
upstream **unchanged**, streams the response straight back, and tees a copy to
read the `usage` object out. The proxy path reports no cost, so cost is
**computed** from `pricing.json` and stored as `source='proxy'`,
`cost_source='computed'` — mixing cleanly into the same session/daily totals as
the Claude Code path.

```bash
# Standalone:
node proxy.js --db tokenbench.db
# Or — what the Mac app does — ONE process serving both the OTel listener and
# the proxy, sharing one SQLite store (no cross-process write contention):
node collector.js --db tokenbench.db --tokens --proxy
```

One port, per-provider **path routing** (no custom headers needed, so any tool
that lets you set a base URL works):

| Base URL you configure | Forwards to | Priced as |
| :--- | :--- | :--- |
| `http://localhost:8787/openai/v1` | `api.openai.com` | openai |
| `http://localhost:8787/anthropic/v1` | `api.anthropic.com` | anthropic |
| `http://localhost:8787/local/v1` | Jan desktop app's Local API Server (`127.0.0.1:1337`) | local — **$0**, tok/s shown |
| `http://localhost:8787/jan/v1` | `jan serve` CLI (`127.0.0.1:6767`, jan 0.8.4) | local — **$0**, tok/s shown |

### Using with Jan (jan.ai)

1. **API providers** — Jan → Settings → Model Providers: on your OpenAI
   provider set the base URL to `http://localhost:8787/openai/v1`, on Anthropic
   to `http://localhost:8787/anthropic/v1` (keep your API keys as they are —
   the proxy forwards them untouched). Every chat now lands in the widget's
   "Today by source" panel with live cost.
2. **Local models — the honest caveat**: chatting with a local model inside
   Jan's own UI never crosses the network, so nothing can observe it. To track
   local chats: enable Jan's **Local API Server** (listens on `127.0.0.1:1337`),
   then add a **custom provider** in Jan named e.g. "Local (tracked)" with base
   URL `http://localhost:8787/local/v1`, and chat via that provider. Same
   models, one hop through the proxy — tokens and tok/s recorded, cost $0.
3. If Jan's local server uses a different port, start with
   `--local-upstream http://127.0.0.1:<port>`.
4. **`jan` CLI** (`jan serve` at `:6767`): point the *calling* tool at
   `http://localhost:8787/jan/v1` instead of `:6767` directly. Note the CLI
   reads NONE of the telemetry env vars — those are Claude Code-only; Jan
   usage is visible exactly when its traffic passes through this proxy.

- **Jan / Cursor / IDE** → OpenAI-compatible; usage read from `usage`
  (`prompt_tokens` includes cached, so the proxy splits `cached_tokens` back out).
- **Anthropic tools** (`/v1/messages`) → read `input_tokens` / `output_tokens` /
  `cache_*_input_tokens`, streaming (SSE) included.
- **Local models via Jan's llama.cpp** → a `localhost` upstream is provider
  `local`: tokens recorded, **cost 0** (a known zero, not an "unknown"). This is
  the comparison the tool exists to surface — the same workload's context and
  token profile, priced vs free.
- Per-request `x-tb-upstream` and `x-tb-provider` headers override the default
  upstream and the provider used for pricing.

**The pricing table & the cache-write finding.** `pricing.json` is
hand-maintained (USD per 1M tokens), same exact-then-longest-prefix matching as
`context-windows.json`, and an unpriced model resolves to an explicit
*unknown* (tokens stored, cost 0, `cost_source='unknown'`) rather than a guess.
Current models are listed with their own keys so a new model never falls back to
an older, cheaper prefix. P1-4 (`node stats.js`, "reported vs computed") checks
the table against the cost Claude Code actually reports — and that check found
that **Claude Code bills cache writes at the 1-hour TTL rate (2.0×), not the
5-minute rate (1.25×) the PRD §5.2 snippet shows.** The reported cost of a real
haiku request (`55312` micros) equals `10×1 + 27541×1×2.0 + 44×5` exactly; the
1.25× form does not. `computeCostMicros` defaults to 1h accordingly. Appendix A
lists both rates — §5.2's example just used the wrong one.

**Known limitation:** OpenAI's cache-read discount differs from Anthropic's 0.1×,
so OpenAI cache-read cost is approximate until a per-provider multiplier is
added. Local (cost 0) and Anthropic (validated by P1-4) are exact.

## The widget (Phase 3)

The collector serves the widget itself — the PRD's architecture diagram already
has the sidecar feeding it, so there is no second server and no build step. Run
the collector **with `--db`**, then open the widget:

```bash
node collector.js --db tokenbench.db --tokens   # terminal 1
./widget.sh                                      # opens a frameless app-window
```

Or just open `http://localhost:4318/widget` in any browser. It polls `/state`
once a second and draws the gauge; the gauge math stays in the store (where the
tests cover it), the widget only renders it.

| Route | Method | Purpose |
| :--- | :--- | :--- |
| `/widget` | GET | the dashboard HTML (`widget.html`, read fresh each request) |
| `/state` | GET | one JSON snapshot: active session, cache split, daily total + budget |
| `/task-type` | POST | `{sessionId, taskType}` — manual override (P1-2), persisted on the session |
| `/budget` | POST | `{micros}` — editable daily budget (P0-5) |
| `/dashboard` | GET | the task-aware dashboard (`dashboard.html`) — daily cost stacked by task type, by-model, by-task table |
| `/dashboard-data` | GET | `?days=N` — one JSON slice all dashboard charts agree on |

**The native shell (P0-7 / P0-10).** OS-level *always-on-top*,
*remembers-position*, and *sidecar-lifecycle* need a native window. That shell
is now scaffolded in [`desktop/`](desktop/) — a Tauri v2 app that opens a
frameless, always-on-top window on `/widget` and runs `collector.js` as a
managed sidecar (spawned on launch, killed on quit, `:4318` released). It wraps
the existing widget and collector unchanged. Build it with `cd desktop && npm
run dev` (needs the Rust toolchain — see `desktop/README.md`). For a quick pin
without building, `widget.sh` still opens a frameless app-window that a window
manager (Rectangle/Amethyst/Stage Manager) can pin. The served web widget stays
the zero-dependency, command-line-verifiable core; the Tauri shell is the native
finish on top of it.

Spec: [token-bench-prd-v1.1.md](token-bench-prd-v1.1.md). Observed wire schema: [schema-observed.md](schema-observed.md).

## Run it

Two terminals.

**Terminal 1 — collector + store:**

```bash
node collector.js --db tokenbench.db --tokens
```

**Terminal 2 — Claude Code with telemetry on:**

```bash
source env.sh && claude
```

**Read the numbers back:**

```bash
node stats.js --db tokenbench.db
```

The env vars are per-shell. A Claude Code session launched from a shell that did not `source env.sh` emits nothing — the most common reason the collector stays silent.

### Flags

| Flag | Effect |
| :--- | :--- |
| `--db <file>` | persist `api_request` / `compaction` / `session.count` to SQLite |
| `--tokens` | print only token/cost-relevant events — cuts the MCP connection noise |
| `--only a,b` | print only events whose name contains one of these substrings |
| `--raw` | dump the full OTLP JSON body of each request |
| `--jsonl <f>` | append each flattened record as one JSON line, for replay |
| `--quiet` | counters only |

Filtering affects printing only. The schema summary, `--jsonl`, and `--db` always see everything.

### Tests

```bash
node --no-warnings src/test.js fixtures/capture-2026-08-20.jsonl
```

47 tests over real captured records, covering coercion, the PII allowlist, context derivation, compaction, cost accumulation, the context window table, the raw compaction-events capture, the pricing table (incl. the P1-4 reported-vs-computed check), and proxy ingest.

## Why the needle does not move when you test headlessly

The gauge follows main-thread requests only (PRD 5.1) — on the wire that is `repl_main_thread` for interactive sessions (observed 2026-08-23; the PRD's documented `main` has never actually been seen). Every `claude -p` request reports `sdk`, the compaction model call reports `compact`, and interactive sessions also carry auxiliary calls (`away_summary`, `generate_session_title`, `prompt_suggestion`) that are billed but must not move the needle. A headless test session therefore stores rows and accumulates cost correctly while `latest_context_tokens` stays NULL.

This is correct behaviour, not a bug, but it makes headless testing misleading. To see the needle move, run interactive `claude` from a shell that sourced `env.sh`.

## Phase 2 result

The schema was written from the collector's own summary, captured from three headless turns plus one manual `/compact`. That capture contradicted PRD v1.1 in five places — see [schema-observed.md](schema-observed.md) for all of them. The two that would have caused silent wrong numbers:

**`success` on compaction is the string `"true"`, not a boolean.** PRD 5.3 says to drop the needle when `success: true`. A strict equality check never fires, and the gauge would simply never reset — the single most visible feature of the tool, silently dead.

**The string/number split is per-event, not per-field.** PRD 4.1 note 2 says int64 fields arrive as strings and lists eight to coerce. In reality every `api_request` numeric arrives as a real number and every `compaction` numeric arrives as a string — `duration_ms` is a number on one event and `"11109"` on the other. The defensive coercion the PRD asks for is right; its stated reason is not, and you cannot skip it for `api_request`.

Also found: a fifth identity field (`user.account_id`) that the PRD's list of four omits — which is exactly why the allowlist is an allowlist — and a fourth `query_source` value (`compact`) beyond the three v1.1 documents.

### Verified

- **P0-1b** — rows land within the export interval. Verified live: 4 requests, 1 compaction, 139 events correctly not persisted.
- **P0-2** — context is a level. Five consecutive turns leave `latest_context_tokens` at the latest value, not the sum. Out-of-order events cannot rewind it.
- **P0-3** — `cost_usd_micros` summed as INTEGER per session and per local day. Exact over 1,000 rows. Replayed events do not inflate totals (`request_id` is the idempotency key).
- **P0-5** — daily totals bucket by *local* date, so the reset lands at local midnight rather than UTC.
- **P0-6** — needle drops to `post_tokens` on a real `/compact` (3,274 → 1,213). A failed compaction leaves the level standing.
- **P0-8** — unknown model yields `gaugePercent: null`, never a guess. There is deliberately no catch-all default in `context-windows.json`.
- **P0-9** — verified by scanning the raw SQLite file, WAL included, for the five real identity values after a live session. None present.

### Not done in Phase 2

P0-4, P0-7, and P0-10 are UI and Tauri lifecycle — Phase 3. P0-3's *local pricing calculation* is Phase 4 by design; this phase only accumulates the reported figure.

**Totals checked against Claude's own cost — exactly.** Verified live via the CLI
path: `claude -p "…" --output-format json` returns `total_cost_usd` and a
`session_id` that equals the OTel `session.id`, so a run matches its telemetry
with no ambiguity. On a real Opus 4.8 request (input 2, output 407, cache_read
15,171, cache_creation 16,629), all three numbers agreed to the micro:

| Source | micros |
| :--- | ---: |
| Claude `total_cost_usd` (0.1840605) | 184,061 |
| TokenBench stored (`cumulative_cost_micros`) | 184,061 |
| Computed from `pricing.json` (P1-4) | 184,061 |

To repeat it: run the collector with `--db`, then in a shell that sourced
`env.sh` run `claude -p "…" --output-format json`, grab its `session_id`, and
compare `node stats.js --db … --session <id>` (and `computedVsStored`) against
`total_cost_usd`. Interactive `/cost` works too — same number, `query_source`
`main` so the needle also moves.

### Still unconfirmed

- **Automatic compaction.** Only `trigger: "manual"` observed. Ingest treats every field beyond `pre_tokens` / `post_tokens` / `trigger` / `success` as optional, so a differently-shaped automatic event should still store — but that is a design allowance, not evidence. To let Phase 3 confirm the shape from real data, every compaction is also captured verbatim (un-coerced, but still PII-allowlisted) into a `compaction_events` table alongside the parsed `compactions` row — see `src/schema.sql`. Fields the parsed table has no column for survive there. Note this is still bounded by the compaction allowlist in `src/store.js`: a genuinely new automatic-compaction field must be added there before it reaches disk — deliberately, so the raw table can never become a PII backdoor.
- **`api_error`.** Never observed, so nothing is written for it.
- **Context window values.** `context-windows.json` ships the standard 200k windows for the families listed. Models newer than the file are deliberately absent rather than guessed, and resolve to the unknown state. Confirm any number you add from the docs.

## Files

| File | |
| :--- | :--- |
| `collector.js` | OTLP receiver, decoding, printer, schema summary |
| `src/store.js` | allowlist, coercion, derivation, accumulation |
| `src/schema.sql` | the SQLite schema |
| `src/test.js` | 47 tests over real captured records |
| `stats.js` | read-only report — how to verify against `/cost` |
| `widget.html` | the Phase 3 widget — self-contained, polls `/state` |
| `dashboard.html` | the task-aware dashboard (palette CVD-validated, dark-only) |
| `widget.sh` | opens the widget as a frameless app-window |
| `proxy.js` | Phase 4 proxy, standalone CLI (logic in `src/proxy-core.js`) |
| `src/proxy-core.js` | proxy forwarding + usage extraction + path routing (shared with `collector.js --proxy`) |
| `src/pricing.js` | pricing resolution + `computeCostMicros` (integer micros) |
| `pricing.json` | hand-maintained model → price table + cache multipliers |
| `context-windows.json` | hand-maintained model → window table |
| `env.sh` | telemetry env vars |
| `schema-observed.md` | the wire schema the SQL was written from |
| `fixtures/` | a real capture, identity values redacted |

## Notes on the code

Traps handled, each of which produces silent wrong numbers rather than a crash:

- **Every attribute is an OTLP `AnyValue` union** — `{stringValue}`, `{intValue}`, and so on. `anyValue()` unwraps them.
- **Types vary per event.** Everything numeric goes through `int()`; `success` goes through a string-aware `bool()`.
- **Context is overwritten, cost is summed.** Both live on the `sessions` row so the distinction is hard to lose.
- **Cost is integer micros end to end.** Float dollars drift over thousands of rows.
- **`request_id` is UNIQUE**, and the accumulators only advance when a row was actually inserted, so a retry or a replay cannot inflate a total.
- **Local date, not UTC date**, for daily bucketing.

The store is loaded lazily and every ingest is wrapped: a store failure logs and continues rather than taking the collector down. Dropping a row is bad; dropping live telemetry that cannot be replayed is worse.
