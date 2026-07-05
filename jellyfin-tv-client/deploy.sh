#!/usr/bin/env bash
# Sideload the patched "Jellyfin Debug" APK to the Fire TV Stick over ADB (Ethernet).
# STAGED — run this only when the stick is powered on. See FIRESTICK_KODI.md §2/§5 for ADB wiring.
#
#   applicationId : org.jellyfin.androidtv.debug   (coexists with Kodi / any official Jellyfin app)
#   first launch  : connect to http://192.168.1.74:8096  as brennan/brennan  (one-time)
#   updates       : re-run this (same debug key; -r keeps login/data)
#   rollback      : adb -s "$FIRE" uninstall org.jellyfin.androidtv.debug
set -euo pipefail

FIRE="${FIRE:-192.168.1.77:5555}"
REPO="${JF_REPO:-$HOME/jellyfin-androidtv}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
ADB="${ADB:-$(command -v adb || echo "$ANDROID_SDK_ROOT/platform-tools/adb")}"
PKG=org.jellyfin.androidtv.debug

APK="${1:-$(ls -t "$REPO"/app/build/outputs/apk/debug/*-debug.apk | head -1)}"
[ -f "$APK" ] || { echo "APK not found: $APK  (run ./build.sh first)"; exit 1; }
echo "APK: $APK"

echo "== connecting to $FIRE =="
"$ADB" connect "$FIRE"
# If the stick's DHCP lease moved, find it by its Ethernet MAC (see FIRESTICK_KODI.md §5):
#   ip neigh | grep -i 8c:2a:85:cd:7b:a6

echo "== installing (-r keeps data) =="
# NOTE: no -g — that flag needs API 23+, and the Fire Stick is API 22. The app requests the
# few runtime perms it needs at first launch instead.
"$ADB" -s "$FIRE" install -r "$APK"

echo "== launching =="
"$ADB" -s "$FIRE" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true

echo "DONE. On first launch: add server http://192.168.1.74:8096 and sign in brennan/brennan."
