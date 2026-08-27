#!/bin/bash
# TokenBench Mac App Build Script
#
# Builds the TokenBench desktop app for distribution.
#
# Usage:
#   ./build.sh                    # Build unsigned .app
#   ./build.sh --sign             # Build and sign with Developer ID
#   ./build.sh --notarize         # Sign, notarize, and create a DMG
#   ./build.sh --release 0.3.0    # Bump version, sign, notarize, create a DMG
#
# Prerequisites:
#   - Rust toolchain (cargo)
#   - Node.js 22+
#   - Xcode Command Line Tools
#   - Apple Developer Account (for signing)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[BUILD]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Check prerequisites
check_prereqs() {
    log "Checking prerequisites..."

    if ! command -v cargo &> /dev/null; then
        error "Rust toolchain not found. Install with: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    fi

    if ! command -v node &> /dev/null; then
        error "Node.js not found. Install Node.js 22+ from https://nodejs.org"
    fi

    if ! command -v xcode-select &> /dev/null; then
        error "Xcode Command Line Tools not found. Install with: xcode-select --install"
    fi

    # Check Node.js version
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 22 ]; then
        error "Node.js 22+ required (found $(node -v))"
    fi

    # Check if Node binary is bundled
    if [ ! -f "src-tauri/binaries/node-aarch64-apple-darwin" ]; then
        warn "Node binary not bundled. Copying current Node.js..."
        cp "$(command -v node)" src-tauri/binaries/node-aarch64-apple-darwin
    fi

    log "Prerequisites OK"
}

# Install dependencies
install_deps() {
    log "Installing dependencies..."
    npm install
}

# Build the app
build() {
    log "Building TokenBench..."
    npm run build

    APP_PATH="src-tauri/target/release/bundle/macos/TokenBench.app"
    DMG_PATH="src-tauri/target/release/bundle/dmg"

    if [ ! -d "$APP_PATH" ]; then
        error "Build failed: $APP_PATH not found"
    fi

    log "Build complete: $APP_PATH"
}

# Sign the app
sign() {
    if [ -z "$APPLE_SIGNING_IDENTITY" ]; then
        error "APPLE_SIGNING_IDENTITY not set. Example: export APPLE_SIGNING_IDENTITY='Developer ID Application: Your Name (TEAM_ID)'"
    fi

    log "Signing with identity: $APPLE_SIGNING_IDENTITY"

    APP_PATH="src-tauri/target/release/bundle/macos/TokenBench.app"

    # Sign the bundled sidecar first, then the outer app. Avoid --deep: it can
    # conceal a broken nested signature until Gatekeeper checks the download.
    codesign --force --sign "$APPLE_SIGNING_IDENTITY" \
        --options runtime \
        "$APP_PATH/Contents/MacOS/node"
    codesign --force --sign "$APPLE_SIGNING_IDENTITY" \
        --entitlements src-tauri/entitlements.plist \
        --options runtime \
        "$APP_PATH"

    # Verify signature
    codesign --verify --deep --strict "$APP_PATH"

    log "Signing complete"
}

# Notarize the app (for distribution outside App Store)
notarize() {
    if [ -z "$APPLE_ID" ] || [ -z "$APPLE_TEAM_ID" ] || [ -z "$APPLE_PASSWORD" ]; then
        error "Apple credentials not set. Required: APPLE_ID, APPLE_TEAM_ID, APPLE_PASSWORD"
    fi

    log "Notarizing app..."

    APP_PATH="src-tauri/target/release/bundle/macos/TokenBench.app"

    # Create a zip for notarization
    ZIP_PATH="/tmp/TokenBench-notarize.zip"
    ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"

    # Submit for notarization
    xcrun notarytool submit "$ZIP_PATH" \
        --apple-id "$APPLE_ID" \
        --team-id "$APPLE_TEAM_ID" \
        --password "$APPLE_PASSWORD" \
        --wait

    # Staple the ticket
    xcrun stapler staple "$APP_PATH"

    log "Notarization complete"
}

# Create DMG
create_dmg() {
    log "Creating DMG..."

    APP_PATH="src-tauri/target/release/bundle/macos/TokenBench.app"
    DMG_PATH="src-tauri/target/release/bundle/dmg/TokenBench.dmg"

    # Use hdiutil to create DMG
    hdiutil create -volname "TokenBench" -srcfolder "$APP_PATH" -ov -format UDZO "$DMG_PATH"

    log "DMG created: $DMG_PATH"
}

# Main
main() {
    RELEASE_VERSION="$(node -p "require('./package.json').version")"
    if [ "$1" = "--app-store" ]; then
        error "App Store builds are intentionally disabled: process discovery and ~/.codex / ~/.pi session tracking require an unsandboxed notarized DMG."
    fi
    if [ "$1" = "--release" ]; then
        if [ -z "$2" ]; then
            error "Usage: ./build.sh --release <semver>"
        fi
        node scripts/set-version.mjs "$2"
        RELEASE_VERSION="$2"
    fi

    check_prereqs
    install_deps
    build

    if [ "$1" = "--sign" ]; then
        sign
        create_dmg
    elif [ "$1" = "--notarize" ] || [ "$1" = "--release" ]; then
        sign
        notarize
        create_dmg
        log "Release artifact is ready for GitHub Releases"
        log "Create it with: gh release create v$RELEASE_VERSION src-tauri/target/release/bundle/dmg/TokenBench.dmg --generate-notes"
    else
        log "Build complete (unsigned)"
        log "To sign: ./build.sh --sign"
        log "To sign + notarize: ./build.sh --notarize"
        log "To bump and prepare a release: ./build.sh --release <semver>"
    fi
}

main "$@"
