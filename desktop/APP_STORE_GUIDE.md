# TokenBench macOS distribution decision

TokenBench is distributed as a signed and notarized DMG through GitHub Releases.
The Mac App Store is intentionally not a target for the full product.

## Why the App Store build was dropped

The three non-negotiable product requirements are:

1. Track supported AI CLI work, not only traffic from one manually configured shell.
2. Detect live Claude Code, Codex, and Pi processes and let the user choose a session-specific gauge.
3. Keep collection reliable through a managed, automatically restarted sidecar.

Mac App Store apps must use App Sandbox. That prevents the app from reliably
enumerating the user's terminal processes, reading usage metadata below
`~/.codex/sessions` and `~/.pi/agent/sessions`, and launching external CLI tools
through `tb-claude` or `tokenbench run`. Shipping a sandboxed App Store edition
would therefore be a different, view-only product with a misleading feature set.

The Developer ID DMG stays local-first but is not sandboxed. It can:

- receive Claude Code OTLP telemetry;
- read usage-only Codex and Pi session metadata (never prompts or responses);
- detect currently running supported CLI processes;
- run the local collector/proxy and its watchdog;
- access project/session files needed by those adapters.

## Prerequisites

- macOS and Xcode Command Line Tools
- Rust toolchain
- Node.js 22+
- Apple Developer Program membership
- a `Developer ID Application` certificate
- `gh` authenticated to the destination GitHub repository for publishing

Install dependencies once:

```bash
cd desktop
npm install
```

## Local and unsigned builds

```bash
cd desktop
npm run dev
npm run build
```

The release app and DMG land below
`desktop/src-tauri/target/release/bundle/`.

## Signed and notarized release

Set the signing and notarization credentials:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAM_ID)"
export APPLE_ID="you@example.com"
export APPLE_TEAM_ID="TEAM_ID"
export APPLE_PASSWORD="app-specific-password"
```

Then bump every package version and prepare the DMG in one command:

```bash
cd desktop
./build.sh --release 0.3.0
```

This updates:

- `desktop/package.json`
- `desktop/package-lock.json`
- `desktop/src-tauri/tauri.conf.json`
- `desktop/src-tauri/Cargo.toml` (Cargo updates the lockfile during build)

After reviewing and committing the version change, publish the exact artifact:

```bash
git tag v0.3.0
git push origin main v0.3.0
gh release create v0.3.0 \
  src-tauri/target/release/bundle/dmg/TokenBench.dmg \
  --generate-notes
```

`./build.sh --app-store` exits with an explanation instead of silently creating
a crippled sandbox build.

## Release verification

Before publishing, test the downloaded DMG on a second macOS account or clean VM:

- Gatekeeper accepts the app without a security override.
- `spctl --assess --type execute --verbose TokenBench.app` succeeds.
- the collector starts and recovers after a forced sidecar exit;
- Window → Float on Top toggles and persists;
- no CLI chip appears when no supported CLI is running;
- running Claude Code, Codex, and Pi appear as detected chips;
- choosing each recent session changes the gauge;
- Codex/Pi prompt and response text never appears in `tokenbench.db`.
