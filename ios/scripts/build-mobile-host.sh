#!/bin/bash
# Xcode's "Build mobile host" phase: find node (Xcode's PATH has none of the usual places)
# and run scripts/build-mobile-host.mjs. Offline. If node can't be found but a previous
# build left ios/Generated behind, warn and keep it rather than failing the build.
set -euo pipefail
IOS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$IOS_DIR/.." && pwd)"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/share/fnm/aliases/default/bin"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
    NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
    if [ -f "$IOS_DIR/Generated/host.js" ]; then
        echo "warning: node not found; using the existing ios/Generated (run pnpm build:mobile to refresh it)"
        exit 0
    fi
    echo "error: node not found, and ios/Generated is missing. Run pnpm build:mobile in $ROOT."
    exit 1
fi
exec "$NODE" "$ROOT/scripts/build-mobile-host.mjs" --quiet
