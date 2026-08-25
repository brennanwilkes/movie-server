#!/bin/sh
# CRF LADDER — measure a film's RATE curve: how its bitrate responds to quality, not just what it
# costs at one point.
#
#   probe-ladder.sh <file> [--json] [--crfs "16 20 24 28"] [--samples N] [--seclen S] [--width W]
#
# WHY THIS EXISTS. The nightly probe measures each film at CRF 20 and nothing else. One point is not
# a curve, so the model has no slope — and the slope is the interesting quantity. Netflix's per-title
# work is built on exactly this: not "what is the right bitrate" but "how much more quality does
# another Mbps buy", which is what tells you whether a file is undersized (still climbing) or
# oversized (flat). See docs/BPP-PLUS.txt section 14.
#
# WHAT IT MEASURES, AND WHAT IT DELIBERATELY DOES NOT.
# This is the RATE half only: bitrate as a function of CRF, per film. It needs no quality metric,
# which is the whole reason it can ship today — the box's ffmpeg has no libvmaf, and SSIM is
# disqualified here for a specific reason: it over-rewards grain reproduction, so on exactly the
# grainy catalogue titles that matter most it keeps climbing and never shows a knee. That failure is
# already on record (RESEARCH-quality-metrics-2026-08-01.md: "your SSIM-keeps-improving-at-247-BPP+
# result"). Adding a quality axis is Stage B and needs libvmaf; do not substitute SSIM for it.
#
# WHAT THE RATE HALF ALONE IS GOOD FOR:
#   1. Testing the -15%-per-CRF-point rule of thumb that BPP+ leans on to move HEADROOM_TARGET at
#      read time. If that slope is wrong, or varies by content, the read-time conversion is wrong.
#   2. Curvature. A straight line in log(bitrate) vs CRF means the rule holds; a bend means the
#      content saturates, which is the rate-side shadow of a quality knee.
#   3. Per-film comparison: does grain change the slope, or only the intercept?
#
# SAME SCENES ACROSS THE LADDER, WHICH IS THE ONE THING THAT MUST NOT DRIFT. probe-film.sh picks
# sample offsets deterministically (T = start + span*i/N), so the same file with the same --samples
# and --seclen lands on the identical timestamps at every CRF. That is why this wraps the existing
# script rather than reimplementing sampling: a ladder measured on different scenes at each rung is
# noise wearing the shape of a curve. Do NOT vary --samples between rungs for the same reason.
#
# COST. samples x rungs encodes. The default 4x4 is ~16 encodes, about twice one nightly probe.
# Fewer samples than the nightly 8 is deliberate and safe here: a SLOPE is far more robust to
# per-scene variation than an absolute level, because the scene mix is held constant across rungs.
#
# READ-ONLY. Encodes to /dev/null, never writes near the source.
set -e

HERE=$(dirname "$0")
FILE=""; JSON=0
CRFS="${LADDER_CRFS:-16 20 24 28}"
N="${LADDER_SAMPLES:-4}"; LEN="${PROBE_SECLEN:-4}"
WIDTH="${PROBE_REFERENCE_WIDTH:-1920}"; PRESET="${PROBE_PRESET:-medium}"
THREADS="${PROBE_THREADS:-3}"

while [ $# -gt 0 ]; do
  case "$1" in
    --json)    JSON=1 ;;
    --crfs)    CRFS="$2"; shift ;;
    --samples) N="$2"; shift ;;
    --seclen)  LEN="$2"; shift ;;
    --width)   WIDTH="$2"; shift ;;
    --preset)  PRESET="$2"; shift ;;
    --threads) THREADS="$2"; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *)         FILE="$1" ;;
  esac
  shift
done
[ -n "$FILE" ] && [ -r "$FILE" ] || { echo "probe-ladder: cannot read '$FILE'" >&2; exit 2; }

TITLE=$(basename "$FILE")
POINTS=""; FIRST=1; SRC=0; CODEC=""; FAILED=0
START=$(date +%s)

for C in $CRFS; do
  [ "$JSON" -eq 1 ] || printf 'crf %-3s ' "$C" >&2
  OUT=$("$HERE/probe-film.sh" "$FILE" --json --crf "$C" --samples "$N" --seclen "$LEN" \
        --width "$WIDTH" --preset "$PRESET" --threads "$THREADS" 2>/dev/null) || OUT=""
  # Parse without jq — the controller image has node but this must also run standalone on the host.
  PB=$(echo "$OUT" | sed -n 's/.*"probeBitrate":\([0-9]*\).*/\1/p')
  SB=$(echo "$OUT" | sed -n 's/.*"srcBitrate":\([0-9]*\).*/\1/p')
  CD=$(echo "$OUT" | sed -n 's/.*"codec":"\([^"]*\)".*/\1/p')
  SP=$(echo "$OUT" | sed -n 's/.*"spreadRatio":\([0-9.]*\).*/\1/p')
  if [ -z "$PB" ] || [ "$PB" -le 0 ] 2>/dev/null; then
    FAILED=$(( FAILED + 1 ))
    [ "$JSON" -eq 1 ] || echo "FAILED" >&2
    continue
  fi
  [ "$SRC" -gt 0 ] 2>/dev/null || SRC="$SB"
  [ -n "$CODEC" ] || CODEC="$CD"
  [ "$FIRST" -eq 1 ] || POINTS="$POINTS,"
  POINTS="$POINTS{\"crf\":$C,\"probeBitrate\":$PB,\"spreadRatio\":${SP:-0}}"
  FIRST=0
  [ "$JSON" -eq 1 ] || printf '%8.3f Mb/s\n' "$(echo "$PB" | awk '{print $1/1e6}')" >&2
done
WALL=$(( $(date +%s) - START ))

[ "$FIRST" -eq 0 ] || { echo "probe-ladder: every rung failed for '$FILE'" >&2; exit 4; }

if [ "$JSON" -eq 1 ]; then
  printf '{"file":"%s","title":"%s","codec":"%s","srcBitrate":%s,"samples":%d,"seclen":%d,"refWidth":%d,"preset":"%s","failed":%d,"wallMs":%d,"points":[%s]}\n' \
    "$FILE" "$TITLE" "$CODEC" "$SRC" "$N" "$LEN" "$WIDTH" "$PRESET" "$FAILED" "$(( WALL * 1000 ))" "$POINTS"
else
  echo "  source     $(echo "$SRC" | awk '{printf "%.2f", $1/1e6}') Mb/s  ($CODEC)"
  echo "  ladder     $N samples x $LEN s at each of: $CRFS"
  echo "  cost       ${WALL}s"
fi
