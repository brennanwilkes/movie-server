#!/bin/sh
# CRF PROBE — measure how many bits a title's CONTENT actually needs.
#
#   probe-film.sh <file> [--json] [--width W] [--samples N] [--seclen S] [--crf C] [--preset P]
#
# Re-encodes N short samples at a FIXED QUALITY (CRF) and reports the bitrate that took.
# That bitrate IS the content's complexity: grain, motion and fine detail cost bits, flat
# animation does not. It replaces the single global BPP_TARGET=0.13 guess with a per-title
# measurement.  Design + evidence: docs/DESIGN-CRF-PROBE.md
#
#   R = sourceBitrate / probeBitrate      (codec-normalised — see CODEC NORMALISATION below)
#
# R is dimensionless: resolution, frame rate and letterboxing affect both sides identically and
# cancel. High R = lots of headroom (over-provisioned, safe to shrink). Low R = the file is
# already near what its content needs.
#
# READ-ONLY. Touches nothing but stdout/stderr and never writes near the source file. Inside the
# controller /data is mounted :ro, so that is enforced by the mount rather than by discipline.
#
# Runs on the host or inside the controller (both have ffmpeg 5.1). For a file under /data the
# paths are identical either way.
set -e

FILE=""; JSON=0
# NEVER change the default width casually: it defines the probe cache. It is a MEASUREMENT
# reference, not a display setting — the projector's resolution is applied at read time in the
# scoring layer, where changing it is free. See DESIGN-CRF-PROBE.md §8.
WIDTH="${PROBE_REFERENCE_WIDTH:-1920}"
N="${PROBE_SAMPLES:-8}"; LEN="${PROBE_SECLEN:-4}"
CRF="${PROBE_CRF:-20}"; PRESET="${PROBE_PRESET:-medium}"
THREADS="${PROBE_THREADS:-3}"     # of 4 cores — a probe must never make the box unresponsive

while [ $# -gt 0 ]; do
  case "$1" in
    --json)    JSON=1 ;;
    --width)   WIDTH="$2"; shift ;;
    --samples) N="$2"; shift ;;
    --seclen)  LEN="$2"; shift ;;
    --crf)     CRF="$2"; shift ;;
    --preset)  PRESET="$2"; shift ;;
    --threads) THREADS="$2"; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *)         FILE="$1" ;;
  esac
  shift
done
[ -n "$FILE" ] && [ -r "$FILE" ] || { echo "probe-film: cannot read '$FILE'" >&2; exit 2; }

# ffprobe one field at a time. The combined `-of csv=p=0:s=' '` form fails to parse inside a
# heredoc and silently yields garbage dimensions (and a -nan result), which cost an afternoon.
pv() { ffprobe -v error -select_streams v:0 -show_entries "stream=$1" -of default=nw=1:nk=1 "$FILE" 2>/dev/null | head -1; }
fv() { ffprobe -v error -show_entries "format=$1" -of default=nw=1:nk=1 "$FILE" 2>/dev/null | head -1; }

W=$(pv width); H=$(pv height); CODEC=$(pv codec_name)
FPS=$(pv avg_frame_rate | awk -F/ '{ if (NF==2 && $2>0) printf "%.4f", $1/$2; else printf "%.4f", $1 }')
DUR=$(fv duration | cut -d. -f1)
SIZE=$(fv size)
# Prefer the video stream's own bitrate; fall back to the container total when it is missing or
# implausible — the same trust rule bppOf() uses in arr-inspect.js, so both agree on the numerator.
VB=$(pv bit_rate); TB=$(fv bit_rate)
SRCBPS=$(echo "${VB:-0} ${TB:-0}" | awk '{ vb=$1+0; tb=$2+0;
  if (vb>0 && (tb<=0 || vb<=tb*1.05)) print vb; else print tb }')

[ -n "$DUR" ] && [ "$DUR" -gt 0 ] 2>/dev/null || { echo "probe-film: no duration for '$FILE'" >&2; exit 3; }
[ -n "$W" ] && [ "$W" -gt 0 ] 2>/dev/null || { echo "probe-film: no video stream in '$FILE'" >&2; exit 3; }

# Aspect-PRESERVING downscale. A fixed WxH squashes every scope film to 16:9 and invents detail
# that is not there — measured worth 22% on Pulp Fiction, on the number the whole model rests on.
SCALE="scale='min(${WIDTH},iw)':-2:flags=lanczos"
# blockdetect/blurdetect chained into the SAME pass: they share one decode, so all three cost
# ~6s/sample on top of the encode instead of doubling it. Never run them as separate passes.
#
# Both filters need ffmpeg >= 5.0. The controller image has 5.1; the NUC host still has 4.2, where
# they are missing and the whole command fails with "No such filter". Drop them rather than fail —
# they are pass-through analysis filters, so R is IDENTICAL with or without them; only the
# detector means are lost. THE CONTROLLER IS THE CANONICAL RUNNER (`docker exec controller ...`):
# x265 builds differ between the two ffmpeg versions, so mixing them into one calibration set
# would compare measurements taken with different rulers.
VF="$SCALE"
if ffmpeg -hide_banner -filters 2>/dev/null | grep -q blockdetect; then
  VF="${VF},blockdetect,blurdetect"
else
  echo "probe-film: ffmpeg has no blockdetect/blurdetect (needs >= 5.0) — R is unaffected, detector means will be 0." >&2
  echo "probe-film: for calibration runs use: docker exec controller /config/probe-film.sh ..." >&2
fi

# Sample window: skip the first and last 5% (logos, credits — unrepresentative and often black).
S=$(( DUR * 5 / 100 )); SPAN=$(( DUR * 90 / 100 ))

TOTBITS=0; TOTSEC=0; i=0; KLIST=""; BLOCKS=""; BLURS=""; OK=0
START=$(date +%s)
while [ "$i" -lt "$N" ]; do
  T=$(( S + SPAN * i / N ))
  OUT=$(ffmpeg -nostdin -hide_banner -loglevel info -ss "$T" -t "$LEN" -i "$FILE" \
        -vf "$VF" -c:v libx265 -crf "$CRF" -preset "$PRESET" -threads "$THREADS" \
        -an -sn -f null - 2>&1) || true
  KBPS=$(echo "$OUT"   | sed -n 's/.*encoded [0-9]* frames in [0-9.]*s ([0-9.]* fps), \([0-9.]*\) kb\/s.*/\1/p' | tail -1)
  FRAMES=$(echo "$OUT" | sed -n 's/.*encoded \([0-9]*\) frames in.*/\1/p' | tail -1)
  BLK=$(echo "$OUT"    | sed -n 's/.*block mean: \([0-9.]*\).*/\1/p' | tail -1)
  BLR=$(echo "$OUT"    | sed -n 's/.*blur mean: \([0-9.]*\).*/\1/p'  | tail -1)
  if [ -n "$KBPS" ] && [ -n "$FRAMES" ] && [ "$FRAMES" -gt 0 ] 2>/dev/null; then
    # Weight each sample by its ACTUAL decoded length. A sample landing near the end of the file,
    # or on a sparse-keyframe stretch, can come up short; averaging the kb/s figures directly
    # would then over-weight it.
    TOTBITS=$(echo "$TOTBITS $KBPS $FRAMES $FPS" | awk '{printf "%.0f", $1 + $2*1000*($3/$4)}')
    TOTSEC=$(echo "$TOTSEC $FRAMES $FPS"        | awk '{printf "%.3f", $1 + $2/$3}')
    OK=$(( OK + 1 ))
    KLIST="$KLIST $KBPS"; BLOCKS="$BLOCKS ${BLK:-0}"; BLURS="$BLURS ${BLR:-0}"
  fi
  [ "$JSON" -eq 1 ] || printf '  sample %d @%-6ds %8s kb/s   block=%-10s blur=%s\n' \
      "$i" "$T" "${KBPS:-FAIL}" "${BLK:-?}" "${BLR:-?}" >&2
  i=$(( i + 1 ))
done
WALL=$(( $(date +%s) - START ))

[ "$OK" -gt 0 ] || { echo "probe-film: every sample failed for '$FILE'" >&2; exit 4; }

# CODEC NORMALISATION. The probe always encodes x265, so probeBitrate is in HEVC units. An H.264
# source needs ~1.6x the bits for the same quality (X265_EFFICIENCY in arr-inspect.js), so its
# bitrate is divided by 1.6 to land in the same units. Same convention as bppOf(), reached from
# the other side — verified to reproduce the R values in DESIGN-CRF-PROBE.md §2.
echo "$TOTBITS $TOTSEC $SRCBPS $CODEC $W $H $FPS $WIDTH $WALL $OK $N $LEN $CRF $PRESET $SIZE $DUR $JSON $KLIST" | awk '
{
  probe = $1/$2;
  src   = $3+0;
  hevc  = ($4 ~ /hevc|h265/) ? 1 : 0;
  eff   = hevc ? 1.0 : 1.6;
  R     = (probe>0) ? src/(probe*eff) : 0;
  pw    = ($5 > $8) ? $8 : $5;
  ph    = int(pw*$6/$5/2)*2;
  # Sample spread: the ratio of the hardest sampled scene to the easiest. Scene complexity varies
  # up to 8.2x WITHIN one film, so a high spread means this single number deserves less trust.
  lo=0; hi=0;
  for (j=18; j<=NF; j++) { v=$j+0; if (lo==0 || v<lo) lo=v; if (v>hi) hi=v }
  spread = (lo>0) ? hi/lo : 0;
  if ($17 == 1)
    printf "{\"probeBitrate\":%.0f,\"srcBitrate\":%.0f,\"R\":%.4f,\"codec\":\"%s\",\"srcW\":%d,\"srcH\":%d,\"fps\":%.4f,\"probeW\":%d,\"probeH\":%d,\"refWidth\":%d,\"spreadRatio\":%.3f,\"samplesOk\":%d,\"samples\":%d,\"seclen\":%d,\"crf\":%d,\"preset\":\"%s\",\"size\":%d,\"duration\":%d,\"wallMs\":%d",
      probe, src, R, $4, $5, $6, $7, pw, ph, $8, spread, $10, $11, $12, $13, $14, $15, $16, $9*1000;
  else {
    printf "  src        %dx%d %s %.3f fps  %.2f Mbps\n", $5,$6,$4,$7, src/1e6;
    printf "  probe      %dx%d (ref width %d)  %.2f Mbps\n", pw,ph,$8, probe/1e6;
    printf "  R          %.2f   (source / probe, codec-normalised x%.1f)\n", R, eff;
    printf "  spread     %.2fx across %d samples (hardest scene / easiest)\n", spread, $10;
    printf "  cost       %ds for %d x %ds @ crf%d %s (%.1f s/sample)\n", $9,$11,$12,$13,$14,$9/$11;
  }
}'

# Detector means, averaged over the samples that succeeded. Weak signals, NOT the safety net —
# across a 14x degradation ladder they moved only +2% to +17% (DESIGN-CRF-PROBE.md §10). Recorded
# because they are nearly free and may yet separate the source-type ceilings.
BM=$(echo "$BLOCKS" | awk '{s=0;n=0;for(j=1;j<=NF;j++){s+=$j;n++} printf "%.4f", n?s/n:0}')
LM=$(echo "$BLURS"  | awk '{s=0;n=0;for(j=1;j<=NF;j++){s+=$j;n++} printf "%.4f", n?s/n:0}')
if [ "$JSON" -eq 1 ]; then
  printf ',"blockMean":%s,"blurMean":%s,"sampleKbps":[%s]}\n' "$BM" "$LM" \
    "$(echo "$KLIST" | awk '{for(j=1;j<=NF;j++) printf "%s%s", (j>1?",":""), $j}')"
else
  printf '  detectors  block %s  blur %s\n' "$BM" "$LM"
  printf '  file       %s\n' "$(basename "$FILE")"
fi
