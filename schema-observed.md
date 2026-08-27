# Observed wire schema

Generated from the collector's own schema summary, not from the PRD. This file is the source the SQLite schema in [`src/schema.sql`](src/schema.sql) was written from.

**Captured:** 2026-08-20, Claude Code 2.1.208, macOS. Three headless `api_request` turns across one resumed session, plus one manual `/compact`. 113 records, 14 OTLP requests.

To regenerate:

```bash
node collector.js --jsonl capture.jsonl --quiet
```

Run a session, `Ctrl-C`, and compare the printed summary against this file.

## Events that reach storage

Only three of the thirteen observed event types are persisted. The rest (`mcp_server_connection`, `hook_*`, `plugin_loaded`, `assistant_response`, `user_prompt`, `active_time.total`) carry nothing the gauge or the cost total needs, and `user_prompt` / `assistant_response` carry prompt and response text. They are dropped at ingest.

### `log:api_request` — the row that drives everything

| Field | Wire type | Stored as |
| :--- | :--- | :--- |
| `model` | string | `model` |
| `input_tokens` | **number** | INTEGER |
| `output_tokens` | **number** | INTEGER |
| `cache_read_tokens` | **number** | INTEGER |
| `cache_creation_tokens` | **number** | INTEGER |
| `cost_usd_micros` | **number** | `cost_micros` INTEGER |
| `cost_usd` | number | dropped — float, redundant with micros |
| `duration_ms` | number | INTEGER |
| `query_source` | string | `query_source` — raw, `main`/`subagent`/`sdk` |
| `request_id` | string | `request_id`, UNIQUE — the dedupe key |
| `speed` | string | `speed` — not in the PRD |
| `session.id` | string | `session_id` |
| `prompt.id` | string | `prompt_id` |
| `event.sequence` | number | `event_sequence` — monotonic per session |
| `event.timestamp` | string | `ts` |
| `terminal.type` | string | `terminal_type` |

### `log:compaction` — confirmed 2026-08-20, contradicts the PRD twice

| Field | Wire type | Stored as |
| :--- | :--- | :--- |
| `pre_tokens` | **string** `"3273"` | INTEGER |
| `post_tokens` | **string** `"1403"` | INTEGER |
| `duration_ms` | **string** `"11109"` | INTEGER |
| `success` | **string** `"true"` | INTEGER 0/1 |
| `trigger` | string `"manual"` | `trigger` |
| `precompute_reuse` | string `"miss_not_ready"` | `precompute_reuse` |
| `session.id`, `prompt.id`, `event.sequence`, `event.timestamp` | | as above |

There is **no `model` field on compaction.** The model must be inherited from the session row.

### `metric:claude_code.session.count` — session boundary only

`start_type` (`fresh` / …), `session.id`, `value`. Token counts from `claude_code.token.usage` and `claude_code.cost.usage` are deliberately **not** stored — see PRD 4.1 note 5, they duplicate the `api_request` event and would double-count.

## Where the wire contradicts PRD v1.1

**1. `success` is the string `"true"`, not a boolean.** PRD 5.3 says "a `compaction` event arrives with `success: true`". A `=== true` test never fires. Coerced through a string-aware `bool()`.

**2. The string/number split is per-event, not per-field.** PRD 4.1 note 2 says int64 fields arrive as JSON strings and lists eight fields to coerce. Observed: every `api_request` numeric arrives as a real number, while every `compaction` numeric arrives as a string. The two events encode the same kinds of value differently — `duration_ms` is a number on one and a string on the other. The PRD's defensive coercion is still the right move, but its stated reason is wrong, and coercion cannot be skipped for `api_request` on the assumption that it is "already typed".

**3. There is a fifth identity field.** PRD 4.1 note 4 lists `user.email`, `user.id`, `organization.id`, `user.account_uuid`. The wire also carries **`user.account_id`** (an opaque `user_…` account id), on every record. This is why the PRD is right that the allowlist must be an allowlist — a blocklist written from that list of four would have leaked it.

**4a. Interactive capture (2026-08-23) — the main thread is `repl_main_thread`, not `main`.** The first interactive session observed four MORE `query_source` values: `repl_main_thread` (the interactive main conversation — the one that drives the needle), plus auxiliaries `away_summary`, `generate_session_title`, and `prompt_suggestion`. Note `prompt_suggestion` re-sends nearly the whole context, so context size cannot be the main-thread discriminator — membership in `MAIN_THREAD_SOURCES` (src/store.js) is. `main` has still never been observed on the wire; it is kept in the set for compatibility with the documented value.

**4. `query_source` has a fourth value: `compact`.** PRD 4.1 note 6 corrects v1.0 from two values to three (`main`, `subagent`, `sdk`). Observed 2026-08-20: the model call that performs a compaction is itself billed and emitted as an `api_request` with `query_source: "compact"` — a fourth. It is a real cost (`$0.0061` on the observed run) and belongs in the totals, but it must not drive the needle. This is precisely why PRD 4.1 note 6 is right that the column stays a raw string with no enum constraint; the store only special-cases `main`, so a fifth value would degrade safely.

**5. `project` does not exist on the wire.** The `Request` type in PRD 4.3 has `project?: string`. No observed event carries a project or cwd field. The column exists and stays NULL; populating it needs a source the collector does not currently have.

## Still unconfirmed

- **Automatic compaction.** Only `trigger: "manual"` has been observed. PRD Q5 stands: automatic may carry a different field shape. Ingest treats every field beyond `pre_tokens` / `post_tokens` / `trigger` / `success` as optional, so an automatic event with fewer fields will still store.
- **`api_error`.** Never observed. No table is written for it; PRD lists it as a fault indicator, not gauge input.
- **`query_source: "main"` and `"subagent"`.** Only `sdk` and `compact` have been seen, because every capture so far has been headless. This matters for testing — see the README note on why the needle does not move under `claude -p`.

## Wire-census and pipe-health additions (Phase 1 & 4, supersede nothing above)

- **`event_observations` table.** One row per `(event_kind, event_name)` ever observed, keeping only the sorted union of attribute KEYS (never values, so PII and prompt content cannot reach it). Every event that ingest deliberately drops still appears here, and `stats.js` / `GET /event-coverage` report it. A Claude Code update that changes the wire becomes visible instead of melting silently.
- **`requests.usage_status` / `requests.usage_reason`** (proxy path only). `parsed` / `no_usage` / `empty_response` — a proxy request that reached the proxy but gave back no usage object is STORED with zero tokens and `cost_source = 'unknown'`; it counts in the request totals and carries no cost guess.
- **`deriveTrackingStatus`** — wire-level liveness (`starting / not_configured / partial / healthy / idle / stale`), anchored on when events ARRIVED, not their timestamps. Exposed at `GET /tracking-status` and in the widget's pipe pill.
- **Gemini usage extraction** (`usageMetadata` on the final SSE chunk or root JSON) joins the OpenAI/Anthropic parsers.
