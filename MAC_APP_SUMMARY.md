# TokenBench Mac app status

## Product decision

TokenBench now targets a full-featured, signed and notarized DMG distributed
through GitHub Releases. The Mac App Store is not a target because its sandbox
would remove the process discovery, home-directory session adapters, and CLI
launching that define the product.

## Current feature set

- Claude Code tracking through OTLP, with `tb-claude` for guaranteed setup.
- Codex tracking from usage-only `token_count` metadata in local session logs.
- Pi tracking from assistant usage metadata, including reported cost.
- Live process discovery for Claude Code, Codex, and Pi.
- A session picker that changes which session drives the context gauge.
- CLI chips only when supported tools are detected as running; no default
  `CLAUDE-CODE` chip.
- Window → Float on Top toggle, persisted across launches.
- Managed collector/proxy sidecar with duplicate-collector avoidance and an
  automatic restart watchdog.
- Local SQLite storage; Codex/Pi prompts and replies are never ingested.

## Verification

- Node test suite: 79 passing tests.
- Rust/Tauri: `cargo check` passes.
- Codex/Pi smoke scan populated separate sessions with model, project, tokens,
  exact Codex context window, and Pi cost metadata.
- JavaScript, shell, plist, and widget-script syntax checks pass.

## Release

```bash
cd desktop
./build.sh --release 0.3.0
gh release create v0.3.0 \
  src-tauri/target/release/bundle/dmg/TokenBench.dmg \
  --generate-notes
```

The build requires Developer ID signing and notarization credentials. See
`desktop/APP_STORE_GUIDE.md` for the decision record and release checklist.
