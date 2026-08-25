#!/bin/sh
# STARVATION LADDER — the controlled test of whether a CRF ladder's SLOPE measures source exhaustion.
#
#   probe-starve.sh <file> [--json] [--crfs "16 20 24 28"] [--samples N] [--seclen S]
#                          [--levels "1.0 0.5 0.25"]
#
# THE QUESTION. The 20-film pilot found the ladder slope tracks supply at rho -0.750: starved copies
# have SHALLOW slopes, well-supplied copies STEEP ones. The story is that a starved source has already
# thrown detail away, so lowering CRF cannot buy anything back. But supply and content are tangled in
# the library — every observational correlation is confounded — so that story is unproven.
#
# THIS REMOVES THE CONFOUND. Take one film, hold the content EXACTLY constant, and vary only how
# starved the copy is. If the slope shallows as we starve it, starvation caused it. Nothing else
# changed. That is the Paris, Texas experiment run deliberately instead of stumbled into.
#
# WHY IT STARVES THE CLIPS AND NOT THE FILM. Re-encoding a 2-hour film at a low bitrate takes hours
# on this box; the ladder only ever looks at N four-second clips. Starving exactly those clips is
# equivalent for every quantity the ladder measures, and costs seconds. The clips are taken at the
# SAME offsets probe-film.sh uses (T = start + span*i/N), so a slope from here is comparable with one
# from there.
#
# WHAT IT OUTPUTS. For each starvation level (1.0 = untouched), the full CRF ladder measured on that
# version. Level 1.0 is the control and should reproduce probe-ladder.sh on the same file.
#
# SAFETY: reads the source read-only, writes only into a scratch dir under /tmp which it removes on
# exit. Never touches the media file or anything beside it.
set -e

FILE=""; JSON=0
CRFS="${STARVE_CRFS:-16 20 24 28}"
LEVELS="${STARVE_LEVELS:-1.0 0.5 0.25}"
N="${STARVE_SAMPLES:-4}"; LEN="${PROBE_SECLEN:-4}"
WIDTH="${PROBE_REFERENCE_WIDTH:-1920}"; PRESET="${PROBE_PRESET:-medium}"
THREADS="${PROBE_THREADS:-3}"
# WHICH ENCODER MAKES THE STARVED COPY. Default x265, which matches the probe — and that match is a
# CONFOUND: re-encoding an x265 file with x265 is easier than re-encoding an h264 one, because the
# artefacts are already x265-shaped and compress well. Some of the measured "starvation" effect could
# therefore be codec-matching. Setting this to libx264 breaks the match and isolates the real effect;
# real starved releases in the library are overwhelmingly h264 anyway.
STARVE_ENC="${STARVE_ENC:-libx265}"

while [ $# -gt 0 ]; do
  case "$1" in
    --json)    JSON=1 ;;
    --crfs)    CRFS="$2"; shift ;;
    --levels)  LEVELS="$2"; shift ;;
    --samples) N="$2"; shift ;;
    --seclen)  LEN="$2"; shift ;;
    --width)   WIDTH="$2"; shift ;;
    --preset)  PRESET="$2"; shift ;;
    --enc)     STARVE_ENC="$2"; shift ;;
    --threads) THREADS="$2"; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *)         FILE="$1" ;;
  esac
  shift
done
[ -n "$FILE" ] && [ -r "$FILE" ] || { echo "probe-starve: cannot read '$FILE'" >&2; exit 2; }

TMP="/tmp/starve.$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT INT TERM

pv() { ffprobe -v error -select_streams v:0 -show_entries "stream=$1" -of default=nw=1:nk=1 "$FILE" 2>/dev/null | head -1; }
fv() { ffprobe -v error -show_entries "format=$1" -of default=nw=1:nk=1 "$FILE" 2>/dev/null | head -1; }
W=$(pv width); DUR=$(fv duration | cut -d. -f1)
VB=$(pv bit_rate); TB=$(fv bit_rate)
SRCBPS=$(echo "${VB:-0} ${TB:-0}" | awk '{ vb=$1+0; tb=$2+0;
  if (vb>0 && (tb<=0 || vb<=tb*1.05)) print vb; else print tb }')
# DO NOT "FIX" THE AUDIO IN SRCBPS HERE. probe-film.sh subtracts measured audio on the container
# path (see srcBasis there) and it is right to; this script must NOT, and the difference is not an
# oversight. All 8 calibration films are container-path files (audio 7.3-25.5%), so the temptation is
# real — but the axis here is already self-consistent:
#
#   the clips are extracted -an -sn, then starved with `-b:v level*SRCBPS`, so the starved clip
#   genuinely CARRIES level*SRCBPS bits of video. The R attributed to it, level*SRCBPS/(cx20*eff),
#   is therefore the true video-only R of the thing measured. Audio inflated how much the level
#   actually starved, but the LABEL moved with it.
#
# Only levels < 1.0 enter the pinning fit (starve-experiment.js skips level >= 1), so the untouched
# control — the one copy that really does carry audio it is not credited for — never lands on the
# x-axis. Subtracting audio here would break that identity and mis-calibrate PIN_A/PIN_B.
[ -n "$DUR" ] && [ "$DUR" -gt 0 ] 2>/dev/null || { echo "probe-starve: no duration" >&2; exit 3; }
[ "$SRCBPS" -gt 0 ] 2>/dev/null || { echo "probe-starve: no source bitrate" >&2; exit 3; }

SCALE="scale='min(${WIDTH},iw)':-2:flags=lanczos"
S=$(( DUR * 5 / 100 )); SPAN=$(( DUR * 90 / 100 ))

# 1. EXTRACT THE CLIPS ONCE, losslessly-ish, at the reference width. Every level and every rung then
#    works from the same decoded material, so the only thing that varies between levels is the
#    starvation encode. Re-extracting per level would re-seek and could land a frame differently.
i=0
while [ "$i" -lt "$N" ]; do
  T=$(( S + SPAN * i / N ))
  ffmpeg -nostdin -hide_banner -loglevel error -ss "$T" -t "$LEN" -i "$FILE" \
    -vf "$SCALE" -c:v libx265 -x265-params lossless=1 -preset ultrafast -threads "$THREADS" \
    -an -sn -y "$TMP/clip$i.mkv" 2>/dev/null || true
  i=$(( i + 1 ))
done

POINTS=""; FIRST=1
for LV in $LEVELS; do
  # 2. MAKE THE STARVED VERSION of each clip at LV x the source bitrate. Level 1.0 is the control and
  #    is used untouched, so the control is genuinely the same material, not a re-encode of it.
  TARGET=$(echo "$SRCBPS $LV" | awk '{printf "%d", $1*$2/1000}')
  i=0
  while [ "$i" -lt "$N" ]; do
    if [ "$LV" = "1.0" ]; then
      cp "$TMP/clip$i.mkv" "$TMP/lv$i.mkv"
    else
      ffmpeg -nostdin -hide_banner -loglevel error -i "$TMP/clip$i.mkv" \
        -c:v "$STARVE_ENC" -b:v "${TARGET}k" -preset "$PRESET" -threads "$THREADS" \
        -an -sn -y "$TMP/lv$i.mkv" 2>/dev/null || true
    fi
    i=$(( i + 1 ))
  done

  # 3. LADDER IT. Same measurement probe-film.sh makes, on the starved material.
  for C in $CRFS; do
    TOT=0; SEC=0; OK=0; i=0
    while [ "$i" -lt "$N" ]; do
      OUT=$(ffmpeg -nostdin -hide_banner -loglevel info -i "$TMP/lv$i.mkv" \
            -c:v libx265 -crf "$C" -preset "$PRESET" -threads "$THREADS" \
            -an -sn -f null - 2>&1) || true
      KB=$(echo "$OUT" | sed -n 's/.*encoded [0-9]* frames in [0-9.]*s ([0-9.]* fps), \([0-9.]*\) kb\/s.*/\1/p' | tail -1)
      FR=$(echo "$OUT" | sed -n 's/.*encoded \([0-9]*\) frames in.*/\1/p' | tail -1)
      if [ -n "$KB" ] && [ -n "$FR" ] && [ "$FR" -gt 0 ] 2>/dev/null; then
        TOT=$(echo "$TOT $KB $FR" | awk '{printf "%.0f", $1 + $2*1000*($3/24)}')
        SEC=$(echo "$SEC $FR" | awk '{printf "%.3f", $1 + $2/24}')
        OK=$(( OK + 1 ))
      fi
      i=$(( i + 1 ))
    done
    [ "$OK" -gt 0 ] || continue
    BPS=$(echo "$TOT $SEC" | awk '{printf "%.0f", $1/$2}')
    [ "$FIRST" -eq 0 ] && POINTS="$POINTS,"
    POINTS="$POINTS{\"level\":$LV,\"crf\":$C,\"probeBitrate\":$BPS,\"samplesOk\":$OK}"
    FIRST=0
    [ "$JSON" -eq 1 ] || printf '  level %-5s crf %-3s %8.3f Mb/s\n' "$LV" "$C" \
      "$(echo "$BPS" | awk '{print $1/1e6}')" >&2
  done
done

if [ "$JSON" -eq 1 ]; then
  printf '{"file":"%s","srcBitrate":%s,"samples":%d,"seclen":%d,"levels":"%s","crfs":"%s","enc":"'"$STARVE_ENC"'","points":[%s]}\n' \
    "$FILE" "$SRCBPS" "$N" "$LEN" "$LEVELS" "$CRFS" "$POINTS"
fi
