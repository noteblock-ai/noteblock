#!/usr/bin/env bash
# Build, install and launch Noteblock for Android (internal name Quire, application id
# org.harborapps.quire.mobile) on the emulator `harbor run android` leased, or a connected phone.
#
#   harbor run android                    the normal way to type this (leases an emulator)
#   ./android/run-android.sh --open "Welcome"        open that page at launch
#   ./android/run-android.sh --edit "Welcome"        open it in edit mode
#   ./android/run-android.sh --settings              open Settings
#   ./android/run-android.sh --device                the first USB/Wi-Fi phone adb sees
#   ./android/run-android.sh --no-logs               return after launching instead of streaming logcat
#   ./android/run-android.sh -- --es search kyoto    anything after -- goes to `am start` as is
#
# $HARBOR_UDID (or $ANDROID_SERIAL) is the emulator harbor leased. Honouring it matters:
# installDebug with no serial installs on EVERY attached device.
set -euo pipefail
cd "$(dirname "$0")"

APP_ID="org.harborapps.quire.mobile"
ACTIVITY="$APP_ID/org.harborapps.quire.app.MainActivity"

USE_DEVICE=false
LOGS=true
EXTRAS=()
usage() { echo "Usage: $0 [--device] [--open <page>] [--edit <page>] [--settings] [--no-logs] [-- <am start args>]"; }
while [ "$#" -gt 0 ]; do
    case "$1" in
        --device)   USE_DEVICE=true; shift ;;
        --no-logs)  LOGS=false; shift ;;
        --open)     EXTRAS+=(--es openPage "${2:?}"); shift 2 ;;
        --edit)     EXTRAS+=(--es openPage "${2:?}" --es editPage "${2:?}"); shift 2 ;;
        --settings) EXTRAS+=(--ez openSettings true); shift ;;
        --)         shift; EXTRAS+=("$@"); break ;;
        -h|--help)  usage; exit 0 ;;
        *) echo "Unknown argument: $1"; usage; exit 1 ;;
    esac
done

# AGP 8.x runs on JDK 17-21; Homebrew's default java is often newer.
if [ -z "${JAVA_HOME:-}" ] || ! "$JAVA_HOME/bin/java" -version 2>&1 | grep -qE '"(17|21)'; then
    for v in 21 17; do
        if home=$(/usr/libexec/java_home -v "$v" 2>/dev/null); then export JAVA_HOME="$home"; break; fi
    done
fi
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="$ANDROID_HOME/platform-tools/adb"
command -v adb >/dev/null 2>&1 && ADB="$(command -v adb)"

SERIAL="${ANDROID_SERIAL:-${HARBOR_UDID:-}}"
if [ "$USE_DEVICE" = true ]; then
    # A physical phone: not an emulator-NNNN serial.
    SERIAL=$("$ADB" devices | awk 'NR>1 && $2=="device" && $1 !~ /^emulator-/ {print $1; exit}')
    [ -n "$SERIAL" ] || { echo "Error: adb sees no phone. Plug it in or pair it over Wi-Fi (harbor phone)." >&2; exit 1; }
fi
if [ -z "$SERIAL" ]; then
    echo "Error: no device. Use \`harbor run android\` (it leases an emulator), or --device for a phone." >&2
    exit 1
fi
export ANDROID_SERIAL="$SERIAL"

echo "▸ gradle :app:installDebug → $SERIAL"
./gradlew :app:installDebug "-Pandroid.injected.device.serial=$SERIAL" --console=plain -q

echo "▸ launching $ACTIVITY"
"$ADB" -s "$SERIAL" shell am start -S -n "$ACTIVITY" ${EXTRAS[@]+"${EXTRAS[@]}"}
echo "✓ $APP_ID is running on $SERIAL"
[ "$LOGS" = true ] || exit 0
PID=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
    PID=$("$ADB" -s "$SERIAL" shell pidof "$APP_ID" 2>/dev/null | tr -d '\r' || true)
    [ -n "$PID" ] && break
    sleep 0.5
done
[ -n "$PID" ] || { echo "warning: no pid for $APP_ID; not streaming logs"; exit 0; }
echo "Running — streaming logcat for pid $PID (Ctrl-C to stop)"
exec "$ADB" -s "$SERIAL" logcat --pid="$PID" -v brief
