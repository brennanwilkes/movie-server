#!/bin/sh
# BANDING PROBE — CAMBI over N sampled clips of one file.
#
#   probe-banding.sh <file> [--json] [--samples N] [--seclen S] [--phase P]
#
# WHAT IT MEASURES. Banding: flat gradients quantised into visible steps. This is the one artifact
# BPP+ is STRUCTURALLY blind to — a file can carry all the bits its content needs on average and
# still band in a sky, and no bitrate-adequacy number can see that. Measured 2026-08-20 over 85
# films: 14% of the files BPP+ calls acceptable band visibly, two of them in the green band with
# supply ABOVE transparency.
#
# WHY IT WORKS WITH NO MASTER, which was the blocker for two years of "get VMAF working". CAMBI is
# genuinely NO-REFERENCE: it keys on flat regions within a single frame. Only libvmaf's plumbing
# insists on two inputs, so both are pointed at the SAME file. VMAF proper is the opposite — a
# same-file comparison scores ~100 by construction — so VMAF is not and never will be usable here.
#
# *** THE ffmpeg IT USES IS NOT THE PROBE'S, AND MUST NEVER BE. *** /tools is a pinned static build
# bind-mounted read-only (see docker-compose). The image's own ffmpeg produced every complexity
# measurement in the cache and is the only ruler for them; a different x265 gives different bitrates
# for identical input. NEVER point this binary at complexity, and never "fix" the image's ffmpeg by
# upgrading it.
#
# SAMPLING mirrors probe-film.sh exactly — same middle-90% window, same T = start + span*(i+phase)/N
# grid, same phase-shift on revisits — so a banding number and a complexity number for one film
# describe the same scenes and can be reasoned about together.
#
# CLIPS ARE EXTRACTED LOSSLESS (ffv1) so CAMBI sees the SOURCE's banding and not an artifact of the
# extraction. A lossy intermediate would add its own quantisation, which is the thing being measured.
#
# SAFETY: reads the source read-only, writes only into a scratch dir under /tmp which it removes on
# exit. Never touches the media file or anything beside it.
set -e

FILE=""; JSON=0
N="${BANDING_SAMPLES:-4}"; LEN="${BANDING_SECLEN:-2}"; PHASE="${BANDING_PHASE:-0}"
FF="${BANDING_FFMPEG:-/tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg}"
FP="${BANDING_FFPROBE:-/tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffprobe}"
THREADS="${BANDING_THREADS:-3}"

while [ $# -gt 0 ]; do
  case "$1" in
    --json)    JSON=1 ;;
    --samples) N="$2"; shift ;;
    --seclen)  LEN="$2"; shift ;;
    --phase)   PHASE="$2"; shift ;;
    --ffmpeg)  FF="$2"; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *)         FILE="$1" ;;
  esac
  shift
done
[ -n "$FILE" ] && [ -r "$FILE" ] || { echo "probe-banding: cannot read '$FILE'" >&2; exit 2; }
[ -x "$FF" ] || { echo "probe-banding: no libvmaf ffmpeg at '$FF' — run scripts/setup-vmaf-tool.sh" >&2; exit 5; }

TMP="/tmp/banding.$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT INT TERM

DUR=$("$FP" -v error -show_entries format=duration -of default=nw=1:nk=1 "$FILE" 2>/dev/null | cut -d. -f1)
[ -n "$DUR" ] && [ "$DUR" -gt 0 ] 2>/dev/null || { echo "probe-banding: no duration" >&2; exit 3; }

S=$(( DUR * 5 / 100 )); SPAN=$(( DUR * 90 / 100 ))
CLIST=""; PLIST=""; YLIST=""; OK=0; i=0
START=$(date +%s)

while [ "$i" -lt "$N" ]; do
  T=$(echo "$S $SPAN $i $N $PHASE" | awk '{ printf "%d", $1 + $2*($3+$5)/$4 }')
  CLIP="$TMP/c.mkv"
  # ffv1 lossless: CAMBI must see the source's own quantisation, not ours.
  "$FF" -nostdin -hide_banner -loglevel error -ss "$T" -t "$LEN" -i "$FILE" \
    -an -sn -c:v ffv1 -threads "$THREADS" -y "$CLIP" 2>/dev/null || { i=$(( i + 1 )); continue; }

  LOG="$TMP/c.csv"
  rm -f "$LOG"
  # CSV, NOT JSON. libvmaf's JSON is emitted as one long line, so a line-oriented shell parse picks
  # up whichever "mean" it meets first — which is integer_adm2's, and on a same-file comparison that
  # is 1.000001. The first version of this script duly reported every film's banding as 1.00000.
  # CSV has a header row, so the column can be found BY NAME and cannot silently become a different
  # metric if libvmaf's feature list changes.
  #
  # Both inputs are the same clip — CAMBI is no-reference; this only satisfies libvmaf's arity.
  "$FF" -nostdin -hide_banner -loglevel error -i "$CLIP" -i "$CLIP" \
    -lavfi "[0:v][1:v]libvmaf=feature=name=cambi:n_threads=${THREADS}:log_path=${LOG}:log_fmt=csv" \
    -f null - 2>/dev/null || true

  if [ -s "$LOG" ]; then
    CV=$(awk -F, 'NR==1{ for(j=1;j<=NF;j++) if($j=="cambi") c=j; next }
                  c && NF>=c && $c != "" { s+=$c+0; n++ }
                  END{ if(n>0) printf "%.5f", s/n }' "$LOG" 2>/dev/null)
    if [ -n "$CV" ]; then
      # Mean luma, for the darkness degeneracy check. Banding is most visible in dark gradients, so
      # a banding metric that turns out to be a brightness metric is the failure mode that killed
      # gShare — this is captured so the check can always be re-run, not assumed away.
      YV=$("$FF" -nostdin -hide_banner -loglevel error -i "$CLIP" \
        -vf "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" -f null - 2>/dev/null \
        | awk -F= '/YAVG/{s+=$2; n++} END{ if(n) printf "%.2f", s/n; else print 0 }')
      CLIST="$CLIST $CV"
      YLIST="$YLIST ${YV:-0}"
      PLIST="$PLIST $(echo "$T $DUR" | awk '{printf "%.4f", ($2>0 ? $1/$2 : 0)}')"
      OK=$(( OK + 1 ))
    fi
  fi
  [ "$JSON" -eq 1 ] || printf '  sample %d @%-6ds cambi=%s luma=%s\n' "$i" "$T" "${CV:-FAIL}" "${YV:-?}" >&2
  rm -f "$CLIP" "$LOG"
  i=$(( i + 1 ))
done
WALL=$(( $(date +%s) - START ))

[ "$OK" -gt 0 ] || { echo "probe-banding: every sample failed for '$FILE'" >&2; exit 4; }

echo "$CLIST" | awk -v ok="$OK" -v wall="$WALL" -v js="$JSON" -v yl="$YLIST" -v pl="$PLIST" -v n="$N" -v len="$LEN" -v ph="$PHASE" '
{
  s=0; hi=0; lo=-1;
  for (j=1; j<=NF; j++) { v=$j+0; s+=v; if (v>hi) hi=v; if (lo<0 || v<lo) lo=v }
  mean = (NF>0) ? s/NF : 0;
  ny=split(yl, ya, " "); ys=0; yn=0;
  for (j=1; j<=ny; j++) if (ya[j] != "") { ys+=ya[j]+0; yn++ }
  ymean = (yn>0) ? ys/yn : 0;
  if (js == 1) {
    printf "{\"cambiMean\":%.5f,\"cambiMax\":%.5f,\"cambiMin\":%.5f,\"yavg\":%.2f,\"samplesOk\":%d,\"samples\":%d,\"seclen\":%d,\"phase\":%s,\"wallMs\":%d,\"sampleCambi\":[",
      mean, hi, lo, ymean, ok, n, len, ph, wall*1000;
    for (j=1; j<=NF; j++) printf "%s%s", (j>1?",":""), $j;
    printf "],\"samplePos\":[";
    np=split(pl, pa, " "); c=0;
    for (j=1; j<=np; j++) if (pa[j] != "") { printf "%s%s", (c>0?",":""), pa[j]; c++ }
    printf "]}\n";
  } else {
    printf "  cambi      mean %.4f  max %.4f  min %.4f  over %d samples\n", mean, hi, lo, ok;
    printf "  luma       %.1f mean\n", ymean;
    printf "  cost       %ds\n", wall;
  }
}'
