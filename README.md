<div align="center">

# TokenBench

**A local, always-on view of what your AI coding actually costs — and whether a free local model could hold the work.**

Claude Code, your own OpenAI/Anthropic API keys, and local models (via [Jan](https://jan.ai)) — all in one always-on-top widget and a task-aware dashboard, running entirely on your machine.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) ![Node](https://img.shields.io/badge/Node-22%2B-339933) ![Platform](https://img.shields.io/badge/app-macOS%20(Apple%20Silicon)-black) ![Tests](https://img.shields.io/badge/tests-55%20passing-2dd4bf)

<img src="docs/images/widget.png" width="300" alt="TokenBench widget — a context gauge at 56%, cache split, and today's cost by source"/>

</div>

---

## Why

I use several AI tools every day — Claude Code, an IDE on my own API keys, local models in Jan — and I had no felt sense of what any of it cost or how much context I was burning. The numbers only ever showed up after the fact, in a billing dashboard, disconnected from the moment I made the expensive choice.

Existing tools tell me cost **per day** or **per session**. TokenBench asks the two questions that actually decide local-vs-cloud, measured off my own wire:

> *What fraction of my requests could a local model even **hold** (context size), and where does my spend actually **go** (token anatomy, agentic depth)?*

TokenBench is the instrument for that experiment. It measures my real workload passively — every request's own context size, what its tokens are made of, and how deep its tool loops run — so the local-vs-cloud decision is made from objective data, not a manual label or a generic break-even calculator. (An early version sliced by a manual per-session "task type"; that turned out to be the weakest axis — a single session spans many kinds of work — so it's been demoted to an optional lens in favor of the objective, per-request views below.)

## What it does

- **Context gauge** — a needle showing how full the current session's context window is, live, as you work. Teal → amber → red as compaction approaches; drops when you `/compact`.
- **Context fit** — every *request* bucketed by its own context size (0–32K / 32–128K / 128–200K / 200K–1M / >1M), showing the share of **requests** vs. the share of **cost** in each band. Answers "could a local model even hold it?" objectively, with no labels — the core view.
- **Token anatomy** — what your token bill is actually made of: fresh input vs. cache read vs. cache write vs. output. On real coding-agent usage, cache reads dominate (often >85%) — the largest hidden factor in cost.
- **Agentic intensity** *(proxy)* — model round-trips per user prompt, derived from Claude Code reusing one `prompt.id` across a turn's tool loop. A rough tool-dependency signal, labeled as such.
- **Three sources, one place** — Claude Code (native OpenTelemetry), any OpenAI/Anthropic API tool (via a transparent proxy), and local models in Jan (cost $0, throughput shown in tok/s).
- **Cost you can trust** — reported cost validated to the micro against Claude Code's own `/cost`; proxy cost computed from a hand-maintained, CVD-checked pricing table.
- **Privacy by construction** — an ingest **allowlist** means no identity field ever reaches disk (verified by scanning the DB file, WAL included). Everything runs locally; nothing is sent anywhere.
- **A real Mac app** — frameless, always-on-top Tauri window with the collector bundled as a self-contained sidecar. Or run the zero-dependency Node core from the terminal.

## Screenshots

**Dashboard — context fit & token anatomy** (⌘D in the app, or `/dashboard` in a browser):

<img src="docs/images/dashboard.png" width="820" alt="TokenBench dashboard: KPI tiles, a context-fit chart of requests vs. cost per context band, a token-anatomy bar, cost by model, and agentic-intensity"/>

The **context-fit** chart is the punchline. On real usage, requests cluster small but **cost concentrates in the large-context tail** — most requests fit a 128K window, yet the dollars live at 128K–1M. That's the local-viability signal, straight from the wire: not a label, not a guess, just each request's own size against real local-model windows.

## How it works

Two ingest paths, one local SQLite store, one widget — exactly the shape of the [PRD](token-bench-prd-v1.1.md)'s architecture.

```
Claude Code ──OTLP/HTTP──┐
                         ├──► collector (:4318)  ──►  SQLite  ──►  widget + dashboard
Jan / IDE / API keys ────┘        + proxy (:8787)      (per-request context, cost & anatomy)
   (base URL → the proxy)
```

- **Path A — Claude Code**: emits OpenTelemetry natively; the collector receives it on `:4318`. No integration needed.
- **Path B — the proxy**: point any tool's OpenAI/Anthropic base URL at `:8787`; it forwards the request upstream **unchanged**, streams the response straight back, and reads the `usage` object off the wire. Path routing means no custom headers:

  | Base URL you configure | Forwards to | Priced as |
  | :--- | :--- | :--- |
  | `localhost:8787/openai/v1` | `api.openai.com` | openai |
  | `localhost:8787/anthropic/v1` | `api.anthropic.com` | anthropic |
  | `localhost:8787/local/v1` | Jan desktop app (`:1337`) | local — **$0**, tok/s |
  | `localhost:8787/jan/v1` | `jan serve` CLI (`:6767`) | local — **$0**, tok/s |

## Quickstart

### The core (zero dependencies, any OS)

Node 22+ only — uses the built-in `node:sqlite`.

```bash
git clone https://github.com/sumin6475/token-bench.git
cd token-bench

# collector + store + proxy, all in one process
node collector.js --db tokenbench.db --tokens --proxy
```

Then open **http://localhost:4318/widget** (gauge) or **/dashboard** (task breakdown) in any browser.

To feed it Claude Code usage, launch Claude from a shell that sourced `env.sh`:

```bash
source env.sh && claude
```

Read the numbers back from the terminal any time: `node stats.js --db tokenbench.db`.

### The Mac app

A prebuilt `.dmg` is on the [**Releases**](https://github.com/sumin6475/token-bench/releases/latest) page (Apple Silicon). Or build it yourself:

```bash
# one-time: Rust toolchain + regenerate the bundled Node binary (kept out of git, ~114MB)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cp "$(command -v node)" desktop/src-tauri/binaries/node-aarch64-apple-darwin

cd desktop && npm install && npm run build   # → src-tauri/target/release/bundle/
```

> On an Intel Mac, name the binary `node-x86_64-apple-darwin`. See [`desktop/README.md`](desktop/README.md) for details.

### With Jan (local models)

In Jan → Settings → Model Providers, set the base URL to `http://localhost:8787/openai/v1` (API providers) or add a custom provider at `http://localhost:8787/jan/v1` for local models served by `jan serve`. Their usage then appears in the "Today by source" panel — local models show throughput instead of a meaningless $0.

## How this differs from what's out there

TokenBench isn't the first cost tracker — the honest positioning:

- **[ccusage](https://github.com/ryoppippi/ccusage) & similar** read Claude Code's local logs and slice by **day / session / month**. Excellent at that, but Claude-Code-only and time-based — they can't tell you what *share of your requests would fit a local model* or where the cost concentrates by context size, and don't see your API or local usage.
- **Helicone / Langfuse / Portkey / OpenMeter** are team-grade API observability platforms with rich per-tag / per-agent attribution — but they're server/cloud products that need SDK integration per app, and they don't unify a personal "my Claude Code + my API keys + my local Jan" view or address the local-viability question.
- **Local-vs-cloud TCO calculators** answer the question hypothetically (break-even math on token volume). TokenBench answers it *empirically*, from your own measured workload.

The niche is the **combination**: per-request context-fit as the primary axis, token anatomy and agentic depth alongside it, three personal sources unified, framed around a real local-vs-cloud decision — as a private, always-on desktop instrument.

## Engineering notes

A few things I'd point to (this is a solo project, but the plumbing is real):

- **Wire truth over spec.** The collector's own schema summary is the source of truth, not the PRD — captured in [`schema-observed.md`](schema-observed.md). The wire contradicted the spec in ~7 places, each of which would have produced a *silently wrong number* rather than a crash: `success` arrives as the string `"true"`; the interactive main thread is `repl_main_thread`, not the documented `main`; Claude Code bills cache writes at the 1-hour rate (2.0×), not the 5-minute rate (1.25×) — proven by a request whose reported cost matched `10×1 + 27541×1×2.0 + 44×5` exactly.
- **PII is an allowlist, not a blocklist.** The wire carries five identity fields; the PRD named only four. A blocklist would have leaked the fifth forever. A disk-scan test asserts no identity value ever lands.
- **Integer micros end to end.** Cost is stored as integer millionths of a dollar — float dollars drift over thousands of rows.
- **Measure only what's on the wire.** The redesign around context-fit was gated on reading the wire first: of the three variables that decide local-viability, only **context size** is cleanly measurable per request; **tool-use** has no field on the Claude Code wire (so it's a labeled *proxy* via `prompt.id` reuse, verified against real captures) and **reasoning difficulty** folds into `output_tokens` (not measurable, so not faked). The dashboard builds only on the measurable ones.
- **55 tests** over real captured records, covering coercion, the allowlist, context-as-a-level, compaction, cost accumulation, pricing (incl. the reported-vs-computed check), proxy routing, the context-fit buckets (strict `<`-edge boundaries, sums reconcile with totals), token anatomy, and the agentic-intensity proxy.

## Limitations & open questions

Deliberately a personal instrument, and honest about its edges:

- **Fit ≠ works.** The context-fit view tells you whether a request could be *held* by a local window, not whether a local model would produce *equivalent quality*. Quality-equivalence is a separate, harder problem this doesn't measure — so "could this run locally" is answered as the necessary condition (does it fit, what does it cost, how deep are its tool loops), not the sufficient one.
- **"Task type" was demoted, not deleted.** It's a manual, per-session label — the weakest part of the original problem definition (a single session spans many kinds of work). It survives as an optional collapsed lens; the objective per-request axes (context-fit, token anatomy) are now primary. See [`docs/journal/`](docs/journal/) for how the measurement axis was reworked.
- **Agentic intensity is a proxy, not ground truth.** There is no tool-call field on the Claude Code wire; the round-trips-per-prompt signal infers tool-loop depth from `prompt.id` reuse. It's Claude-Code-only (proxy traffic has no prompt id) and labeled as a proxy throughout.
- **The Mac app is Apple-Silicon-first** and reads `collector.js` from the bundle; the bundled-Node approach trades ~114MB of app size for zero user setup.
- Automatic (non-manual) compaction and `api_error` events are handled defensively but haven't been observed on a real long session yet.

## Project layout

| Path | |
| :--- | :--- |
| `collector.js` | OTLP receiver + in-process proxy + schema summary |
| `src/store.js` | allowlist, coercion, derivation, cost accumulation |
| `src/proxy-core.js` · `src/pricing.js` | proxy forwarding/usage extraction · pricing |
| `widget.html` · `dashboard.html` | the always-on gauge · the task-aware dashboard |
| `stats.js` | read-only terminal report (verifies totals vs `/cost`) |
| `desktop/` | Tauri v2 Mac app (bundled sidecar, native window) |
| `docs/journal/` | dev journal — hypotheses to check against the data |
| `token-bench-prd-v1.1.md` | the spec |

## License

[MIT](LICENSE) © 2026 Sumin
