#!/usr/bin/env bash
# probe-noise-origin.sh — is the visible noise in a file FILM GRAIN, or COMPRESSION DAMAGE?
#
# ── WHY A CRF-14 A/B CANNOT ANSWER THIS ───────────────────────────────────────────────────────────
# The obvious test — re-encode near-losslessly and see if the noise goes away — is worthless here.
# Jellyfin serves these files with `-codec:v:0 copy` (DirectStream, confirmed in the logs), so the
# noise is already IN the file on disk. A near-lossless re-encode reproduces it faithfully whatever
# its origin, so "CRF 14 looks identical" is the outcome under BOTH hypotheses. It tests our encoder,
# not the file.
#
# ── WHAT ACTUALLY SEPARATES THEM: TIME ────────────────────────────────────────────────────────────
# Photochemical grain is a fresh random pattern on every single frame — the film physically moved.
# Compression noise is FROZEN inside a GOP: for a near-static region a P/B frame codes the block as
# skipped or as a tiny residual, so the quantisation error is COPIED FORWARD unchanged, then jumps
# when the next I-frame re-quantises from scratch. So, measuring frame-to-frame difference in a
# static bright region:
#
#   GRAIN        high and FLAT across every frame; I-frames are unremarkable.
#   COMPRESSION  low on P/B frames (the error is copied, so nothing changes) with a SPIKE at each
#                I-frame. The ratio of I-frame difference to P/B difference is the discriminator.
#
# This is measured on the file we already have, needs no second copy of the film, and needs no grab.
#
# ── SECOND, INDEPENDENT DISCRIMINATOR: THE DCT GRID ───────────────────────────────────────────────
# Compression error is generated per transform block, so its energy correlates with the 8x8 grid:
# differences ACROSS a block boundary exceed differences INSIDE a block. Grain knows nothing about
# the grid and shows no such preference. Reported as gridRatio; ~1.00 is grain, >1.15 is coding.
#
# Both are decode-only. No encoding, no writes to source. READ-ONLY.
set -uo pipefail
FILE="${1:?usage: probe-noise-origin.sh <file> <timestamp> [label]}"
TS="${2:?timestamp e.g. 00:09:19}"
LABEL="${3:-$(basename "$FILE")}"
NFRAMES="${NFRAMES:-48}"
# The bright-region threshold is the whole point: Brennan's report is that the noise appears ONLY in
# light areas (skies, dunes), because that is where grain lives and where no picture detail masks it.
# Averaging over the whole frame is what made the earlier gShare work fail — it diluted the signal
# with dark pixels that never showed the artifact.
BRIGHT="${BRIGHT:-140}"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Frame types, so the analyser knows which differences straddle an I-frame.
#
# THE INTERVAL MUST COVER EVERY FRAME WE DECODE. A fixed 4 s window silently truncated the type list
# once NFRAMES went past ~96, and every frame past the end then read as type '?' — which the analyser
# counts as P/B, so a keyframe inside the window would have been averaged into the P/B floor and the
# discriminator would have quietly reported "no I-frame" forever. Derive it from the real frame rate.
FPS=$(docker exec controller ffprobe -v error -select_streams v -show_entries stream=r_frame_rate \
  -of csv=p=0 "$FILE" 2>/dev/null | head -1 | tr -d ',' | awk -F/ '{ if ($2) printf "%.3f", $1/$2; else printf "%s", $1 }')
[ -z "$FPS" ] && FPS=24
SECS=$(awk -v n="$NFRAMES" -v f="$FPS" 'BEGIN{ printf "%d", (n/f) + 3 }')
docker exec controller ffprobe -v error -read_intervals "${TS}%+${SECS}" \
  -select_streams v -show_entries frame=pict_type -of csv=p=0 "$FILE" 2>/dev/null \
  | tr -d ',' | head -n "$NFRAMES" > "$WORK/types.txt"
TYPES_N=$(wc -l < "$WORK/types.txt")
if [ "$TYPES_N" -lt "$NFRAMES" ]; then
  echo "  note: only $TYPES_N frame types for $NFRAMES frames — analysis truncated to $TYPES_N" >&2
  NFRAMES="$TYPES_N"
fi

# Raw luma, one plane per frame. gray8 keeps the analyser trivial and exact — no colour conversion
# guesswork, no PNG round-trip.
W=$(docker exec controller ffprobe -v error -select_streams v -show_entries stream=width -of csv=p=0 "$FILE" 2>/dev/null | head -1 | tr -d ',')
H=$(docker exec controller ffprobe -v error -select_streams v -show_entries stream=height -of csv=p=0 "$FILE" 2>/dev/null | head -1 | tr -d ',')
docker exec controller ffmpeg -v error -ss "$TS" -i "$FILE" -frames:v "$NFRAMES" \
  -pix_fmt gray -f rawvideo - 2>/dev/null > "$WORK/frames.gray"

node "$(dirname "$0")/analyze-noise-origin.js" "$WORK/frames.gray" "$W" "$H" "$NFRAMES" "$BRIGHT" "$WORK/types.txt" "$LABEL"
