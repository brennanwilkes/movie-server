#!/usr/bin/env bash
# Reproducible build of the collection-rows Jellyfin Android TV client.
# Builds the debug variant of our patched v0.19.9 fork → a coexisting "Jellyfin Debug" APK.
#
# Prereqs (already set up on haleiwa 2026-07-04):
#   - JDK 21 at ~/jdk-21            (toolchain-enforced by the build)
#   - Android SDK at ~/android-sdk  (platform-tools, platforms;android-36, build-tools;36.0.0)
#   - Repo cloned at ~/jellyfin-androidtv on branch `collections` (v0.19.9 + our patch)
set -euo pipefail

REPO="${JF_REPO:-$HOME/jellyfin-androidtv}"
export JAVA_HOME="${JAVA_HOME:-$HOME/jdk-21}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
export PATH="$JAVA_HOME/bin:$PATH"

echo "JDK:  $(java -version 2>&1 | head -1)"
echo "REPO: $REPO"
cd "$REPO"

# Ensure the SDK location is known to Gradle (gitignored; safe to rewrite)
grep -q "^sdk.dir=" local.properties 2>/dev/null || echo "sdk.dir=$ANDROID_SDK_ROOT" > local.properties

./gradlew assembleDebug

APK=$(ls -t "$REPO"/app/build/outputs/apk/debug/*-debug.apk | head -1)
echo ""
echo "BUILD OK → $APK"
echo "  size: $(du -h "$APK" | cut -f1)"
echo "Next: ./deploy.sh   (when the Fire Stick is powered on)"
