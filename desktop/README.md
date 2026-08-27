# TokenBench — desktop shell (Tauri)

The native Mac window that closes the two Phase 3 gaps the served widget left
open: **P0-7** (optional always-on-top, remembers position and preference) and **P0-10**
(the collector runs as a managed sidecar — started on launch, killed on quit,
`:4318` always released).

Nothing about the widget or the collector changed. This shell just:

- opens a compact fixed-size window pointed at
  `http://localhost:4318/widget` (the page the collector already serves), and
- owns the collector's lifecycle from Rust (`src-tauri/src/main.rs`): spawns
  `node collector.js --db <app-data>/tokenbench.db --tokens --proxy` on launch
  and kills it on exit. `--proxy` means the same sidecar also exposes optional
  OpenAI- and Anthropic-compatible routes on `:8787`.

`tauri-plugin-window-state` persists window position and size across restarts.
Use **Window → Float on Top** to toggle pinning; the choice persists across launches.

The sidecar also discovers running Claude Code, Codex, and Pi processes. Codex
and Pi usage is read directly from their local JSONL session metadata, so every
recent session can be selected as the widget's gauge source. Message content is
never ingested.

## Prerequisites (one-time)

This is the only real setup cost of going native — the Rust toolchain:

```bash
# 1. Rust (installs cargo + rustc)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
#    then restart the shell, or:  source "$HOME/.cargo/env"

# 2. Xcode command-line tools (for the macOS webview + linker), if not present
xcode-select --install
```

Node 22+ is already required by the collector.

## Run it (dev)

From this `desktop/` directory:

```bash
npm install          # pulls @tauri-apps/cli
npm run dev          # cargo builds the Rust shell (first build is slow), then launches
```

The window appears, the collector starts automatically (watch the terminal for
`tokenbench: collector started …`), and the gauge is live. Quit the window and
the terminal prints `tokenbench: collector stopped` — `:4318` is freed.

Codex and Pi require no setup. For Claude Code, launch through `../tb-claude`
or export the OTLP variables documented in the main README before starting
`claude`.

## Build a distributable

```bash
npm run build        # produces src-tauri/target/release/bundle/{macos,dmg}/
```

## Icons

A generated placeholder set lives in `src-tauri/icons/` (a teal gauge ring).
To replace it with your own, drop a 1024×1024 PNG and run:

```bash
npm run tauri icon path/to/your-icon.png
```

## Known caveats (honest list)

1. ~~`node` on PATH~~ — **RESOLVED.** Node is bundled (`externalBin`:
   `binaries/node-aarch64-apple-darwin`, ~114MB) and lands next to the app
   executable; the shell prefers it over PATH/`TOKENBENCH_NODE`. No
   `launchctl setenv`, no nvm dependency, survives reboot.
2. ~~`collector.js` location~~ — **RESOLVED.** The collector and everything it
   reads (`src/`, `schema.sql`, both JSON tables, `widget.html`,
   `dashboard.html`) are bundled as resources into
   `Contents/Resources/sidecar/`; the shell prefers that copy. The repo path
   and `TOKENBENCH_ROOT` remain as dev-time fallbacks only. Verified: the
   installed app runs entirely from its own bundle with the env unset.
   Note: after editing collector/widget/dashboard sources, re-run
   `npm run build` — the bundle carries a copy, not a live link.
3. **Transparency.** The window uses `macOSPrivateApi: true` for the rounded,
   frameless look. If a build ever rejects that, set `"transparent": false` in
   `tauri.conf.json` — the widget still works, just on a square panel.
4. **Applies to any GUI app, but worth one line:** launch via
   `open -a TokenBench` (or Finder/Dock) — running the binary directly from a
   shell ties it to the terminal, and the app dies when that terminal closes.
5. **Built and launched 2026-08-22.** First compile needed exactly one fix
   (the `macos-private-api` Cargo feature to match `macOSPrivateApi` in the
   config — already applied). Verified live: window opens always-on-top, the
   collector sidecar starts (`:4318`), the widget renders, and a real
   `claude -p` run showed its cost in the window within ~2s. The DB lives at
   `~/Library/Application Support/dev.sumin.tokenbench/tokenbench.db`.

## Files

| File | |
| :--- | :--- |
| `src-tauri/src/main.rs` | window + collector sidecar lifecycle + health check |
| `src-tauri/tauri.conf.json` | window flags (always-on-top, frameless, transparent) + macOS bundle config |
| `src-tauri/entitlements.plist` | non-sandboxed Developer ID signing entitlements |
| `src-tauri/Cargo.toml` | Rust deps (tauri, window-state plugin) |
| `src-tauri/capabilities/default.json` | window permissions |
| `src-tauri/icons/` | generated app icon set |
| `frontend/index.html` | fallback shown only if the collector is unreachable |
| `APP_STORE_GUIDE.md` | DMG distribution decision, signing, and notarization guide |

## Pipe health monitoring

The widget now shows a **pipe pill** next to the model name indicating telemetry status:
- `live` — telemetry flowing (healthy)
- `idle` — no recent telemetry (Claude may be idle)
- `not configured` — no telemetry ever received
- `events, no api requests` — events arriving but no API requests seen

The app also includes a **Check Collector Health** menu item (TokenBench → Check Collector Health) that prints the collector status to the console.

For full diagnostics, run:
```bash
node collector.js --check
```

## Distribution decision

TokenBench targets a signed and notarized DMG distributed through GitHub
Releases. The Mac App Store build is intentionally not a product target: App
Sandbox prevents reliable process discovery, `tb-claude` / `tokenbench run`,
and reading Codex/Pi session metadata from the user's home directory.

Prepare a release with:

```bash
cd desktop
./build.sh --release 0.3.0
gh release create v0.3.0 src-tauri/target/release/bundle/dmg/TokenBench.dmg --generate-notes
```

The release command updates the npm, Tauri, and Cargo package versions together,
then signs, notarizes, and builds the DMG. See [APP_STORE_GUIDE.md](APP_STORE_GUIDE.md)
for the rationale and required signing environment variables.
