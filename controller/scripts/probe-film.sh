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
# SAMPLE-GRID PHASE, 0 <= PHASE < 1, in units of the gap between samples.
#
# WHY THIS EXISTS. Offsets are T = start + span*i/N, which is deterministic — the whole point, since
# a ladder or a re-probe must hit the same scenes to be comparable. But x265 is ALSO deterministic,
# so re-probing a film with the same N re-encodes the identical clips and returns byte-identical
# bitrates. Pooling those into the sample set adds rows and no information, and because
# SE = sd/sqrt(n) it makes the error bar SHRINK on evidence that does not exist. Measured 2026-08-18:
# Dunkirk stored n=64 from 16 distinct clips, reporting cxRSE 0.199 against a true 0.407.
# Shifting the grid by a fraction of one gap makes a revisit sample BETWEEN the previous points, so
# pooling genuinely adds information and SE falls for the right reason.
PHASE="${PROBE_PHASE:-0}"
THREADS="${PROBE_THREADS:-3}"     # of 4 cores — a probe must never make the box unresponsive

while [ $# -gt 0 ]; do
  case "$1" in
    --json)    JSON=1 ;;
    --width)   WIDTH="$2"; shift ;;
    --samples) N="$2"; shift ;;
    --seclen)  LEN="$2"; shift ;;
    --crf)     CRF="$2"; shift ;;
    --preset)  PRESET="$2"; shift ;;
    --phase)   PHASE="$2"; shift ;;
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
# WHICH NUMERATOR WE ACTUALLY GOT — recorded, never inferred later. 'video' means SRCBPS is already
# audio-free (the stream carried its own rate); 'container' means every audio track is still inside
# it. Measured 2026-08-20: 537 of 898 movies are 'video', 361 are 'container'.
#
# R is a supply ratio and both sides must be video-only, exactly as the numerator is (§3.2). The
# correction lives in videoR() in probe.js and subtracts the measured audio ONLY on the container
# path. That flag is the whole point: a blanket subtraction would deflate the 60% of the library
# that was already clean by a median 2.1% — a NEW error bigger than the one it repairs.
SRCBASIS=$(echo "${VB:-0} ${TB:-0}" | awk '{ vb=$1+0; tb=$2+0;
  if (vb>0 && (tb<=0 || vb<=tb*1.05)) print "video"; else print "container" }')

# ---- AUDIO, MEASURED RATHER THAN BELIEVED ────────────────────────────────────────────────────────
# *arr reports `audioBitrate` for ONE track. Lawrence of Arabia has audioStreamCount 2 and reports
# only the 448k AC3; the DTS-HD MA track that actually dominates the container reports NOTHING. On the
# ~18% of the library where videoBitrate is absent, bppOf() falls back to size/duration and charges
# ALL of that audio to video — which most flatters multi-dub and lossless-audio releases, exactly the
# releases we least want flattered. arr-inspect's audioToSubtract() can only subtract what *arr
# admits to, so it recovers 1 point of Lawrence's 11.
#
# Packet sizes are ground truth and cost one ffprobe read with NO decoding. `-select_streams a` takes
# every audio stream, so dubs and commentary tracks are counted, which is the entire point.
#
# Sampled from one third in, over a window, rather than the whole file: a full-file packet dump on a
# 26 GB remux is slow and buys nothing, since audio is near-CBR per track. The window is deliberately
# past the opening credits, where a track can be silent and misrepresent a VBR codec.
AUDIO_WIN="${AUDIO_WIN:-120}"
if [ -n "$DUR" ] && [ "$DUR" -gt 0 ] 2>/dev/null; then
  ASTART=$(echo "$DUR" | awk '{printf "%d", $1/3}')
  ABPS=$(ffprobe -v error -read_intervals "${ASTART}%+${AUDIO_WIN}" -select_streams a \
    -show_entries packet=size -of default=nw=1:nk=1 "$FILE" 2>/dev/null \
    | awk -v w="$AUDIO_WIN" '{s+=$1} END{ printf "%.0f", (w>0 ? s*8/w : 0) }')
  ATRACKS=$(ffprobe -v error -select_streams a -show_entries stream=index \
    -of default=nw=1:nk=1 "$FILE" 2>/dev/null | wc -l | tr -d ' ')
fi
ABPS="${ABPS:-0}"; ATRACKS="${ATRACKS:-0}"

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

TOTBITS=0; TOTSEC=0; i=0; KLIST=""; PLIST=""; BLOCKS=""; BLURS=""; OK=0
START=$(date +%s)
while [ "$i" -lt "$N" ]; do
  T=$(echo "$S $SPAN $i $N $PHASE" | awk '{ printf "%d", $1 + $2*($3+$5)/$4 }')
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
    # WHERE the sample was taken, as a fraction of runtime. Without this a per-sample record is a
    # bag of numbers in arbitrary order: you cannot tell scene-to-scene variation (a property of
    # the film) from repeat-measurement noise at the same timestamp (a property of the encoder),
    # and pooled samples from several visits land on the SAME offsets, so plotting them as a
    # sequence invents a trend that is not there.
    PLIST="$PLIST $(echo "$T $DUR" | awk '{printf "%.4f", ($2>0 ? $1/$2 : 0)}')"
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
  # PER-SAMPLE block/blur, not just the means. The means have been stored since the beginning and
  # marked UNTESTED for months, because testing an artifact detector seemed to need a subjective
  # label and this library has none. It does not: SPLIT-HALF RELIABILITY asks whether a detector
  # carries real per-film signal at all, and that needs only repeated readings of the same film.
  # Averaging them away here is exactly what made that test impossible. Costs nothing — the values
  # are already computed per sample.
  printf ',"blockMean":%s,"blurMean":%s,"sampleBlock":[%s],"sampleBlur":[%s],"audioBps":%s,"audioTracks":%s,"srcBasis":"%s","sampleKbps":[%s],"samplePos":[%s],"phase":'"$PHASE"'}\n' \
    "$BM" "$LM" \
    "$(echo "$BLOCKS" | awk '{for(j=1;j<=NF;j++) printf "%s%s", (j>1?",":""), $j}')" \
    "$(echo "$BLURS"  | awk '{for(j=1;j<=NF;j++) printf "%s%s", (j>1?",":""), $j}')" \
    "$ABPS" "$ATRACKS" "$SRCBASIS" \
    "$(echo "$KLIST" | awk '{for(j=1;j<=NF;j++) printf "%s%s", (j>1?",":""), $j}')" \
    "$(echo "$PLIST" | awk '{for(j=1;j<=NF;j++) printf "%s%s", (j>1?",":""), $j}')"
else
  printf '  audio      %.0f kb/s measured across %s track(s)\n' "$(echo "$ABPS" | awk '{print $1/1000}')" "$ATRACKS"
  printf '  srcBasis   %s%s\n' "$SRCBASIS" \
    "$([ "$SRCBASIS" = container ] && echo '  (audio is inside srcBitrate; R gets it subtracted)' || echo '  (already audio-free)')"
  printf '  detectors  block %s  blur %s\n' "$BM" "$LM"
  printf '  file       %s\n' "$(basename "$FILE")"
fi
