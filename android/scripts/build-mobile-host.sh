#!/bin/bash
# Gradle's "buildMobileHost" task: find node (a Gradle daemon's PATH may have none of the usual
# places) and run scripts/build-mobile-host.mjs --platform=android. Offline. If node can't be
# found but a previous build left the generated assets behind, warn and keep them.
set -euo pipefail
ANDROID_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$ANDROID_DIR/.." && pwd)"
OUT="$ANDROID_DIR/app/build/generated/quire/assets"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/share/fnm/aliases/default/bin"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
    NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
    if [ -f "$OUT/host.js" ]; then
        echo "warning: node not found; using the existing generated assets (run pnpm build:mobile to refresh them)"
        exit 0
    fi
    echo "error: node not found, and $OUT is missing. Run pnpm build:mobile in $ROOT."
    exit 1
fi
exec "$NODE" "$ROOT/scripts/build-mobile-host.mjs" --platform=android --quiet
