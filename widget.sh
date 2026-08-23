#!/usr/bin/env bash
# TokenBench — open the widget as a standalone frameless window (Phase 3).
#
# The widget is served by the collector, so the collector must be running WITH a
# store:  node collector.js --db tokenbench.db --tokens
#
# This opens it in a Chromium app-window (frameless, its own window, draggable via
# the widget's own titlebar). Falls back to your default browser if no Chromium
# browser is found.
#
# HONEST LIMITATION (P0-7): true OS-level "always-on-top" and "remembers position
# across restarts" need a native window shell. An app-window is standalone and
# frameless but is not pinned above other apps. To pin it now: right-click the
# macOS window / use a window manager (e.g. Rectangle, Amethyst) or macOS
# Stage Manager. The native pin is the one thing left for a later Tauri wrapper —
# everything it would display is already live at /state.

set -euo pipefail

URL="${1:-http://127.0.0.1:4318/widget}"
SIZE="--window-size=344,470"
FLAGS="--app=$URL $SIZE --disable-features=Translate --no-first-run"

open_with() {
  local app="$1"
  if [ -d "$app" ]; then
    open -na "$app" --args $FLAGS >/dev/null 2>&1 && return 0
  fi
  return 1
}

# Is the collector actually up and serving the widget?
if ! curl -sf -o /dev/null "$URL"; then
  echo "The collector isn't serving the widget at $URL."
  echo "Start it first, in another terminal:"
  echo "    node collector.js --db tokenbench.db --tokens"
  exit 1
fi

for app in \
  "/Applications/Google Chrome.app" \
  "/Applications/Brave Browser.app" \
  "/Applications/Microsoft Edge.app" \
  "/Applications/Chromium.app"; do
  if open_with "$app"; then
    echo "Opened TokenBench widget → $URL"
    exit 0
  fi
done

echo "No Chromium browser found; opening in your default browser (windowed, not frameless)."
open "$URL"
