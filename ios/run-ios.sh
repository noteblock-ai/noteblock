#!/bin/bash
# Build and run Noteblock (target and product "Quire", an internal name) for iPhone on a Simulator (default) or a connected iPhone (--device),
# headless: xcodebuild + xcrun simctl/devicectl, no Xcode.app. `harbor run ios` calls this
# with a leased simulator in $HARBOR_UDID.
#
# Usage:
#   ./run-ios.sh                        build & run on a simulator
#   ./run-ios.sh --device               build & run on the first CONNECTED iPhone
#   ./run-ios.sh --sim "iPhone 17 Pro"  build & run on the named simulator
#   ./run-ios.sh --open "Welcome"       open that page at launch (-openPage)
#   ./run-ios.sh --no-logs              return after launching instead of streaming logs
#   ./run-ios.sh --verbose              stream all process logs (simulator)
set -euo pipefail
cd "$(dirname "$0")"

PROJECT="Quire.xcodeproj"
SCHEME="Quire"
BUNDLE_ID="org.harborapps.quire.mobile"
APP_NAME="Quire"
HARBOR_APPS_TEAM="2J4V27W63D"

USE_DEVICE=false
VERBOSE=false
LOGS=true
SIM_NAME_ARG=""
OPEN_PAGE=""
usage() { echo "Usage: $0 [--device] [--sim <name>] [--open <page path>] [--no-logs] [--verbose]"; }
while [ "$#" -gt 0 ]; do
    case "$1" in
        --device)  USE_DEVICE=true; shift ;;
        --verbose) VERBOSE=true; shift ;;
        --no-logs) LOGS=false; shift ;;
        --sim)     SIM_NAME_ARG="${2:-}"; [ -n "$SIM_NAME_ARG" ] || { usage; exit 1; }; shift 2 ;;
        --sim=*)   SIM_NAME_ARG="${1#--sim=}"; shift ;;
        --open)    OPEN_PAGE="${2:-}"; shift 2 ;;
        --open=*)  OPEN_PAGE="${1#--open=}"; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown argument: $1"; usage; exit 1 ;;
    esac
done
LAUNCH_ARGS=()
[ -n "$OPEN_PAGE" ] && LAUNCH_ARGS=(-openPage "$OPEN_PAGE")

# ── Signing team: env, then ios/.env or ../.env, then Harbor Apps LLC ───────
TEAM="${DEVELOPMENT_TEAM:-}"
if [ -z "$TEAM" ]; then
    for ENVF in .env ../.env; do
        [ -f "$ENVF" ] || continue
        TEAM=$(grep -E '^DEVELOPMENT_TEAM=' "$ENVF" | tail -1 | cut -d= -f2- || true)
        [ -n "$TEAM" ] && break
    done
fi
export DEVELOPMENT_TEAM="${TEAM:-$HARBOR_APPS_TEAM}"

# ── Bundled web half (runtime/, host.js, Seed/) — must exist before xcodegen ─
"$(pwd)/scripts/build-mobile-host.sh"

# The xcodeproj is gitignored, so regenerate it every run.
if command -v xcodegen >/dev/null 2>&1; then
    xcodegen generate --quiet
else
    echo "Warning: xcodegen not installed (brew install xcodegen) — xcodeproj may be stale."
fi

# ── Physical device (--device) ──────────────────────────────────────────────
if [ "$USE_DEVICE" = true ]; then
    # -showdestinations is the authority on which phones a build will accept (devicectl's
    # "paired" is a memory; a phone in a drawer still says paired).
    DEST=$(xcodebuild -project "$PROJECT" -scheme "$SCHEME" -showdestinations 2>/dev/null | python3 -c '
import sys
for line in sys.stdin:
    line = line.strip()
    if not (line.startswith("{") and line.endswith("}")):
        continue
    f = {}
    for part in line[1:-1].split(", "):
        if ":" in part:
            k, v = part.split(":", 1)
            f[k.strip()] = v.strip()
    if f.get("platform") != "iOS":
        continue
    ident = f.get("id", "")
    if not ident or ident.startswith("dvtdevice-"):
        continue
    print(ident + "\t" + f.get("name", "iPhone"))
    break
')
    if [ -z "$DEST" ]; then
        echo "Error: xcodebuild sees no connected iOS device. Put the phone on this Mac's Wi-Fi"
        echo "       and unlock it, or plug it in over USB. Check: xcrun devicectl list devices"
        exit 1
    fi
    DEVICE_UDID="${DEST%%$'\t'*}"
    DEVICE_NAME="${DEST#*$'\t'}"
    echo "Using device: $DEVICE_NAME ($DEVICE_UDID), team $DEVELOPMENT_TEAM"
    SIGN=(CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=YES CODE_SIGN_STYLE=Automatic
          "CODE_SIGN_IDENTITY=Apple Development" "DEVELOPMENT_TEAM=$DEVELOPMENT_TEAM")
    xcodebuild build -project "$PROJECT" -scheme "$SCHEME" -destination "id=$DEVICE_UDID" -allowProvisioningUpdates "${SIGN[@]}" -quiet 2>&1
    BUILD_DIR=$(xcodebuild -project "$PROJECT" -scheme "$SCHEME" -destination "id=$DEVICE_UDID" "${SIGN[@]}" -showBuildSettings 2>/dev/null | grep " BUILT_PRODUCTS_DIR" | awk '{print $3}')
    APP_PATH="$BUILD_DIR/${APP_NAME}.app"
    [ -d "$APP_PATH" ] || { echo "Error: build ok but $APP_PATH missing"; exit 1; }
    xcrun devicectl device install app --device "$DEVICE_UDID" "$APP_PATH" 2>/dev/null
    if [ "$LOGS" = true ]; then
        xcrun devicectl device process launch --console --terminate-existing --device "$DEVICE_UDID" -- "$BUNDLE_ID" ${LAUNCH_ARGS[@]+"${LAUNCH_ARGS[@]}"} 2>/dev/null
    else
        xcrun devicectl device process launch --terminate-existing --device "$DEVICE_UDID" -- "$BUNDLE_ID" ${LAUNCH_ARGS[@]+"${LAUNCH_ARGS[@]}"} 2>/dev/null
    fi
    exit 0
fi

# ── Simulator (default) ─────────────────────────────────────────────────────
pick_named() { xcrun simctl list devices -j | python3 -c "
import json,sys
t=sys.argv[1]
for ds in json.load(sys.stdin).get('devices',{}).values():
    for d in ds:
        if d.get('name')==t: print(d.get('udid','')); sys.exit(0)
" "$1" 2>/dev/null || true; }

# A simulator leased by `harbor run` comes in $HARBOR_UDID; an explicit --sim wins. With
# neither, lease one ourselves so two sessions never drive the same simulator.
UDID="${HARBOR_UDID:-}"
if [ -n "$SIM_NAME_ARG" ]; then
    UDID=$(pick_named "$SIM_NAME_ARG")
    [ -n "$UDID" ] || { echo "Error: no simulator named '$SIM_NAME_ARG' (xcrun simctl list devices)"; exit 1; }
    xcrun simctl boot "$UDID" 2>/dev/null || true
fi
if [ -z "$UDID" ]; then
    if command -v simlease >/dev/null 2>&1; then
        UDID=$(simlease acquire --label "quire run-ios.sh")
    else
        echo "Error: no simulator given. Use \`harbor run ios\`, or --sim <name>."
        exit 1
    fi
fi

echo "Building for iOS Simulator ($UDID)..."
xcodebuild build -project "$PROJECT" -scheme "$SCHEME" -destination "id=$UDID" -quiet 2>&1
BUILD_DIR=$(xcodebuild -project "$PROJECT" -scheme "$SCHEME" -destination "id=$UDID" -showBuildSettings 2>/dev/null | grep " BUILT_PRODUCTS_DIR" | awk '{print $3}')
APP_PATH="$BUILD_DIR/${APP_NAME}.app"
[ -d "$APP_PATH" ] || { echo "Error: build ok but $APP_PATH missing"; exit 1; }

xcrun simctl install "$UDID" "$APP_PATH"
xcrun simctl launch --terminate-running-process "$UDID" "$BUNDLE_ID" ${LAUNCH_ARGS[@]+"${LAUNCH_ARGS[@]}"}
[ "$LOGS" = true ] || exit 0
echo "Running — streaming logs (Ctrl-C to stop)"
PRED="process == \"$APP_NAME\""
[ "$VERBOSE" = true ] || PRED="$PRED AND subsystem == \"\""
xcrun simctl spawn "$UDID" log stream --predicate "$PRED" --level debug --style compact
