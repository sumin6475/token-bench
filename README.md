<div align="center">

# TokenBench

**A local, always-on view of what AI coding costs—and which requests could fit in a local model's context window.**

One private desktop instrument for Claude Code, OpenAI/Anthropic API usage, and local models via [Jan](https://jan.ai). It runs on your machine and keeps the signal close to the decision.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) ![Node](https://img.shields.io/badge/Node-22%2B-339933) ![Platform](https://img.shields.io/badge/app-macOS%20(Apple%20Silicon)-black) ![Tests](https://img.shields.io/badge/tests-54%20passing-2dd4bf)

<img src="docs/images/widget.png" width="300" alt="TokenBench widget showing context usage, cache split, and today's cost by source"/>

</div>

---

## What you get

- **A live context gauge** that shows how close the current Claude Code session is to compaction.
- **Context fit**: requests and spend grouped by context size, so you can see what a local model could *hold* and where the money actually goes.
- **Token anatomy**: fresh input, cache reads, cache writes, and output—rather than one opaque cost number.
- **One personal view** across Claude Code, compatible OpenAI/Anthropic API tools, and Jan-hosted local models. Local requests show throughput and $0 API cost.

TokenBench answers a necessary condition, not a quality claim: a request that fits in a local context window may still need a stronger cloud model.

## See the decision, not just the bill

<img src="docs/images/dashboard.png" width="820" alt="TokenBench dashboard with context-fit, token anatomy, model cost, and agentic-intensity views"/>

Most cost trackers slice usage by day or session. TokenBench slices each request by the factor that constrains a local alternative: its context size. The dashboard compares the share of requests with the share of cost in each band, revealing whether spend is concentrated in the large-context tail.

It also shows a labeled **agentic-intensity proxy**—model round-trips per user prompt—for Claude Code. This is a useful signal of tool-loop depth, not a claim to measure tool calls directly.

## Quickstart

### Run the core

Requires Node 22+; the core uses the built-in `node:sqlite` and has no package install step.

```bash
git clone https://github.com/sumin6475/token-bench.git
cd token-bench
node collector.js --db tokenbench.db --tokens --proxy
```

Open **http://localhost:4318/widget** for the gauge or **http://localhost:4318/dashboard** for the dashboard. To collect Claude Code usage, launch it from a shell that sourced `env.sh`:

```bash
source env.sh && claude
```

Read totals from the terminal with `node stats.js --db tokenbench.db`.

### Use the Mac app

For Apple Silicon, download the prebuilt `.dmg` from [Releases](https://github.com/sumin6475/token-bench/releases/latest), or build it locally:

```bash
# one-time: Rust toolchain + bundled Node binary (~114 MB, excluded from git)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cp "$(command -v node)" desktop/src-tauri/binaries/node-aarch64-apple-darwin

cd desktop && npm install && npm run build
```

On an Intel Mac, name the binary `node-x86_64-apple-darwin`. See [`desktop/README.md`](desktop/README.md) for details.

### Route API or local-model usage through the proxy

Point a compatible tool's base URL at one of the following local routes. The proxy forwards the request to the selected provider and records the returned usage locally.

| Configure this base URL | Destination | Reported as |
| :--- | :--- | :--- |
| `localhost:8787/openai/v1` | OpenAI | OpenAI API usage |
| `localhost:8787/anthropic/v1` | Anthropic | Anthropic API usage |
| `localhost:8787/local/v1` | Jan desktop app (`:1337`) | local, $0 API cost + tok/s |
| `localhost:8787/jan/v1` | `jan serve` (`:6767`) | local, $0 API cost + tok/s |

For Jan, set the API-provider URL to `http://localhost:8787/openai/v1`, or add `http://localhost:8787/jan/v1` as a custom provider for a model served by `jan serve`.

## How it works

```
Claude Code ──OTLP/HTTP──┐
                         ├──► collector (:4318)  ──► SQLite ──► widget + dashboard
Jan / IDE / API keys ────┘        + proxy (:8787)     (per-request context, cost, anatomy)
   (base URL → the proxy)
```

- **Claude Code** emits OpenTelemetry natively to the collector; no integration code is required.
- **The proxy** forwards OpenAI- or Anthropic-compatible traffic unchanged, streams the upstream response back, and reads its `usage` object.
- **The UI** is either a frameless, always-on-top Tauri window or the same zero-dependency Node core in a browser.

## Engineering decisions that make the numbers credible

- **Observed wire over assumed spec.** The collector schema, captured in [`schema-observed.md`](schema-observed.md), is the source of truth. Real captures exposed coercion and billing differences that would otherwise silently skew totals.
- **PII allowlist, not blocklist.** Only fields needed for measurement are persisted. A disk-scan test covers both the SQLite database and its WAL, preventing observed identity fields from landing on disk.
- **Integer accounting.** Cost is stored in integer millionths of a dollar, avoiding accumulated floating-point drift.
- **Measured scope, stated limits.** Context size is directly observable per request; agentic intensity is explicitly presented as a Claude-Code-only proxy. Unmeasurable reasoning difficulty is not invented as a metric.
- **Captured-data tests.** 54 tests cover parsing, privacy, compaction, pricing, proxy routing, bucket boundaries, reconciliation, token anatomy, and the proxy signal.

The analytics store stays local. When you opt into a cloud API route, the proxy sends that request only to the provider you selected; TokenBench does not send usage analytics to its own service.

## Where it fits

- **[ccusage](https://github.com/ryoppippi/ccusage) and similar tools** are excellent Claude-Code log readers for time-based reporting. TokenBench instead focuses on per-request context fit and combines personal API and local-model traffic.
- **Helicone, Langfuse, Portkey, and OpenMeter** provide rich, team-scale API observability. TokenBench is a local, zero-integration personal view for a mixed coding workflow.
- **Local-vs-cloud TCO calculators** model a hypothetical break-even point. TokenBench starts with the workload actually observed on the wire.

## Limits

- **Fit is not equivalent quality.** Context fit is a necessary condition for a local alternative, not a benchmark of model output quality.
- **Agentic intensity is a proxy.** It infers tool-loop depth from Claude Code's `prompt.id` reuse and is unavailable for generic proxy traffic.
- **The app is Apple-Silicon-first.** Bundling Node removes setup for app users at the cost of roughly 114 MB.

For the measurement redesign and its discarded manual task-type axis, see [`docs/journal/`](docs/journal/). The original architecture is in the [PRD](token-bench-prd-v1.1.md).

## Project layout

| Path | Purpose |
| :--- | :--- |
| `collector.js` | OTLP receiver, in-process proxy, and schema summary |
| `src/store.js` | allowlist, coercion, derivation, and cost accumulation |
| `src/proxy-core.js` · `src/pricing.js` | proxy forwarding, usage extraction, and pricing |
| `widget.html` · `dashboard.html` | always-on gauge and request-aware dashboard |
| `stats.js` | read-only terminal report; checks totals against `/cost` |
| `desktop/` | Tauri v2 Mac app with a bundled sidecar |
| `docs/journal/` | development hypotheses and measurement decisions |

## License

[MIT](LICENSE) © 2026 Sumin
