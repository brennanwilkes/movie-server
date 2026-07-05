#!/usr/bin/env bash
# Boot a headless Android TV emulator (KVM-accelerated), install the patched APK, launch it,
# and capture a screenshot — no Fire Stick required. Verified working on haleiwa 2026-07-04.
#
# One-time setup already done on haleiwa:
#   sdkmanager "emulator" "system-images;android-36;android-tv;x86_64"
#   AVD "jf_tv" created at ~/.android/avd/jf_tv.avd (Television 1080p, x86_64, 2 GB RAM)
#   (brennan has /dev/kvm access via ACL — no group change needed)
#
# NOTE: login is interactive the first time (see the tap sequence at the bottom). We boot with
# -no-snapshot, so state does not persist between runs; re-do the login taps each boot, OR remove
# -no-snapshot and press Ctrl-C cleanly to let the emulator save a snapshot for instant re-login.
set -euo pipefail

export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export JAVA_HOME="${JAVA_HOME:-$HOME/jdk-21}"
ADB="$ANDROID_SDK_ROOT/platform-tools/adb"
EMU="$ANDROID_SDK_ROOT/emulator/emulator"
SERIAL="emulator-5556"
REPO="${JF_REPO:-$HOME/jellyfin-androidtv}"
APK="${1:-$(ls -t "$REPO"/app/build/outputs/apk/debug/*-debug.apk | head -1)}"
OUT="${OUT:-$HOME/movie-server/jellyfin-tv-client/screenshots}"
mkdir -p "$OUT"

echo "== booting AVD jf_tv (headless, KVM) =="
nohup "$EMU" -avd jf_tv -no-window -no-audio -no-snapshot -no-boot-anim \
  -gpu swiftshader_indirect -accel on -port 5556 >/tmp/jf_emulator.log 2>&1 &
echo "  emulator pid $!  (log: /tmp/jf_emulator.log)"

echo "== waiting for boot =="
"$ADB" -s "$SERIAL" wait-for-device
until [ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 3; done
echo "  booted (API $("$ADB" -s "$SERIAL" shell getprop ro.build.version.sdk | tr -d '\r'))"

echo "== installing patched APK =="
"$ADB" -s "$SERIAL" install -r -g "$APK"
"$ADB" -s "$SERIAL" shell monkey -p org.jellyfin.androidtv.debug -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1

sleep 8
"$ADB" -s "$SERIAL" exec-out screencap -p > "$OUT/emulator-launch.png"
echo "  screenshot: $OUT/emulator-launch.png"

cat <<'EOF'

== Interactive first-run login (tap sequence that worked; coords are 1920x1080) ==
  adb -s emulator-5556 shell input keyevent DPAD_CENTER        # open "Enter server address"
  adb -s emulator-5556 shell input text '192.168.1.74:8096'    # (dots/colon type fine once field is active)
  adb -s emulator-5556 shell input keyevent 66                 # IME done
  adb -s emulator-5556 shell input tap 184 405                 # Connect
  adb -s emulator-5556 shell input tap 618 617                 # Add account
  adb -s emulator-5556 shell input tap 416 991                 # "Use a password"
  adb -s emulator-5556 shell input text 'brennan'              # username
  adb -s emulator-5556 shell input tap 480 510                 # focus password
  adb -s emulator-5556 shell input text 'brennan'              # password
  adb -s emulator-5556 shell input keyevent 66; adb -s emulator-5556 shell input tap 184 617   # Sign in
  # then DPAD_DOWN a few times to scroll into the collection rows, screencap between presses.

To shut down:  adb -s emulator-5556 emu kill
EOF
