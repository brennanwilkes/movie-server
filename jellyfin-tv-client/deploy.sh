#!/usr/bin/env bash
# Sideload the patched "Jellyfin Debug" APK to the Fire TV Stick over ADB (Ethernet).
# STAGED — run this only when the stick is powered on. See FIRESTICK_KODI.md §2/§5 for ADB wiring.
#
#   applicationId : org.jellyfin.androidtv.debug   (coexists with Kodi / any official Jellyfin app)
#   first launch  : connect to http://192.168.1.74:8096  as brennan/brennan  (one-time)
#   updates       : re-run this (same debug key; -r keeps login/data)
#   rollback      : adb -s "$FIRE" uninstall org.jellyfin.androidtv.debug
set -euo pipefail

REPO="${JF_REPO:-$HOME/jellyfin-androidtv}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
ADB="${ADB:-$(command -v adb || echo "$ANDROID_SDK_ROOT/platform-tools/adb")}"
PKG=org.jellyfin.androidtv.debug
FIRE_MAC="${FIRE_MAC:-8c:2a:85:cd:7b:a6}"   # the stick's Ethernet MAC — stable, unlike its lease
LAST_KNOWN="192.168.1.72 192.168.1.77"      # newest first

# The stick's DHCP lease MOVES (.77 → .72 so far), and a hardcoded default here just means the
# script confidently deploys nowhere. Resolve it instead, cheapest source first. Override with
# FIRE=<ip:port> to skip all of this.
detect_fire() {
  local d ip c
  # 1. Already connected over TCP — the most reliable answer there is.
  d=$("$ADB" devices 2>/dev/null | awk '/:5555[[:space:]]+device$/ {print $1; exit}')
  [ -n "$d" ] && { echo "$d"; return; }
  # 2. The ARP cache, by MAC. Works whenever anything has talked to it recently.
  ip=$(ip neigh 2>/dev/null | grep -i "$FIRE_MAC" | awk '{print $1; exit}')
  [ -n "$ip" ] && { echo "$ip:5555"; return; }
  # 3. Try the addresses it has actually had.
  for c in $LAST_KNOWN; do
    "$ADB" connect "$c:5555" 2>/dev/null | grep -q connected && { echo "$c:5555"; return; }
  done
}

FIRE="${FIRE:-$(detect_fire)}"
[ -n "$FIRE" ] || {
  echo "Fire Stick not found. It may be powered off, or its lease moved again." >&2
  echo "Find it and re-run with FIRE=<ip>:5555   —   ip neigh | grep -i $FIRE_MAC" >&2
  exit 1
}

APK="${1:-$(ls -t "$REPO"/app/build/outputs/apk/debug/*-debug.apk | head -1)}"
[ -f "$APK" ] || { echo "APK not found: $APK  (run ./build.sh first)"; exit 1; }
echo "APK: $APK"

echo "== connecting to $FIRE =="
"$ADB" connect "$FIRE"

echo "== installing (-r keeps data) =="
# NOTE: no -g — that flag needs API 23+, and the Fire Stick is API 22. The app requests the
# few runtime perms it needs at first launch instead.
"$ADB" -s "$FIRE" install -r "$APK"

echo "== launching =="
"$ADB" -s "$FIRE" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true

echo "DONE. On first launch: add server http://192.168.1.74:8096 and sign in brennan/brennan."
