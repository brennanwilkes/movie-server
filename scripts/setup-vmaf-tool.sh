#!/bin/sh
# FETCH A libvmaf-CAPABLE ffmpeg — for CAMBI banding measurement, and for nothing else.
#
# WHY A SEPARATE BINARY AND NOT AN UPGRADE. Nothing on this box has libvmaf: the controller is
# ffmpeg 5.1 (Debian, no --enable-libvmaf), jellyfin ships 7.1.4 with `vmafmotion` only (a different
# filter), and the host is 4.2. The obvious move — upgrade the controller's ffmpeg — is the WRONG one:
# that ffmpeg's x265 produced all 1044 complexity measurements in the probe cache, and it is the only
# ruler for them. Different x265 builds give different bitrates for the same input, so swapping it
# would silently make every stored measurement incomparable with every future one.
#
# So this is a standalone, pinned, static binary that lives beside the repo and is called explicitly.
# It CANNOT contaminate the probe because nothing in the probe path references it.
#
#   *** NEVER USE THIS BINARY TO MEASURE COMPLEXITY. *** CAMBI only.
#
# WHY PINNED (n8.1) AND NOT master-latest: a measurement tool whose version floats produces numbers
# that cannot be compared across runs. Same reason PROBE_PRESET and PROBE_CRF are fixed.
#
# WHAT IT UNLOCKS. CAMBI is genuinely no-reference — it keys on flat regions in one frame — so
# banding can be measured in production forever with no master. Only libvmaf's plumbing wants two
# inputs, so scripts/cambi-probe.js points both at the same file. VMAF proper is NOT usable that way
# (a same-file comparison scores ~100 by construction); it needs a real reference, so it is only ever
# a calibration-dataset tool here.
#
# Idempotent: re-running with the binary already present verifies and exits.
set -e

VER="${VMAF_FFMPEG_VER:-n8.1}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/tools"
NAME="ffmpeg-${VER}-latest-linux64-gpl-${VER#n}"
BIN="$DIR/$NAME/bin/ffmpeg"
URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${NAME}.tar.xz"

verify() {
  [ -x "$1" ] || return 1
  "$1" -hide_banner -filters 2>/dev/null | grep -q ' libvmaf ' || return 1
  return 0
}

if verify "$BIN"; then
  echo "ok: $BIN"
  "$BIN" -hide_banner -version | head -1
  exit 0
fi

mkdir -p "$DIR"
echo "fetching $NAME ..."
curl -fsSL -o "$DIR/ff.tar.xz" "$URL"
tar xf "$DIR/ff.tar.xz" -C "$DIR"
rm -f "$DIR/ff.tar.xz"

if verify "$BIN"; then
  echo "ok: $BIN"
  "$BIN" -hide_banner -version | head -1
  echo "filters:"
  "$BIN" -hide_banner -filters 2>/dev/null | grep -E ' (libvmaf|blockdetect|blurdetect|siti) '
else
  echo "FAILED: $BIN has no libvmaf filter" >&2
  exit 1
fi
