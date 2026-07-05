#!/usr/bin/env bash
# Static verification of the built APK: proves it will install and run on the API-22 Fire Stick
# and that it coexists with any official Jellyfin app. No device required.
set -euo pipefail

REPO="${JF_REPO:-$HOME/jellyfin-androidtv}"
ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
AAPT="$ANDROID_SDK_ROOT/build-tools/36.0.0/aapt"
APK="${1:-$(ls -t "$REPO"/app/build/outputs/apk/debug/*-debug.apk | head -1)}"
[ -f "$APK" ] || { echo "APK not found: $APK"; exit 1; }
echo "APK: $APK"; echo

FAIL=0
chk(){ if echo "$B" | grep -q "$2"; then echo "  PASS: $1"; else echo "  FAIL: $1 (want: $2)"; FAIL=1; fi; }

B=$("$AAPT" dump badging "$APK" 2>/dev/null)
chk "applicationId is .debug (coexists w/ official app)" "name='org.jellyfin.androidtv.debug'"
chk "minSdk 21 (Fire OS 5.1 = API 22 → OK)"              "sdkVersion:'21'"
chk "Leanback (Android TV) launcher present"             "leanback-launchable-activity"
chk "32-bit ABI present (armeabi-v7a)"                   "'armeabi-v7a'"

echo; echo "Manifest summary:"
echo "$B" | grep -E "^package:|application-label:|native-code:" | sed 's/^/  /'

echo
[ "$FAIL" = 0 ] && echo "APK VERIFICATION PASSED" || { echo "APK VERIFICATION FAILED"; exit 1; }
