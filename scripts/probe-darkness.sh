#!/usr/bin/env bash
# probe-darkness.sh — is a film DARK, and how much of it is dark AND FLAT?
#
# Brennan's hypothesis, 2026-08-13: darker films need more bitrate. The mechanism is real and it is
# perceptual rather than mathematical. At a given QP the codec's quantisation error is roughly
# constant in absolute terms, but the eye is most sensitive to it in SMOOTH DARK GRADIENTS — banding
# in a sky or a shadow is obvious where the same error inside busy texture is invisible. So dark flat
# content needs MORE bits for the same perceived quality, while being CHEAPER by the encoder's own
# error math. That gap is exactly why x265 ships `aq-mode`: adaptive quantisation exists to push bits
# back into flat/dark regions that pure RD would starve.
#
# Why this matters to us: `aq-mode 0` is one of the eight knobs `-tune grain` switches off, so the
# gShare number we have been calling "grain" has been partly measuring DARKNESS AND FLATNESS all
# along. This script measures that axis on its own so the two can be told apart.
#
#   yavg        mean luma, 0-255. The blunt "is it dark" number.
#   dark_frac   fraction of pixels below DARK_T (default 64) — shadow area, regardless of texture.
#   darkflat    fraction that is dark AND flat. THE ONE THAT SHOULD MATTER: banding needs a smooth
#               gradient to show up in, so dark busy texture is not the problem region.
#
# Flatness is judged on a DENOISED frame for the same reason as probe-flatgrain.sh: grain itself
# would otherwise trigger the edge detector and erase the flat regions we are trying to find.
#
# READ-ONLY: decodes only.
set -uo pipefail
cd "$(dirname "$0")/.."

SAMPLES="${GRAIN_SAMPLES:-5}"
LEN="${GRAIN_SECLEN:-4}"
WIDTH="${GRAIN_WIDTH:-1280}"
PHASE="${GRAIN_PHASE:-0}"
DARK_T="${DARK_T:-64}"
DENOISE="${FLAT_DENOISE:-removegrain=1}"
EDGE="${FLAT_EDGE:-edgedetect=low=0.06:high=0.15}"
TIMEOUT="${GRAIN_TIMEOUT:-120}"
SETFILE="${GRAIN_SET_FILE:-scripts/grain-sets/ablate.txt}"

SC="scale='min(${WIDTH},iw)':-2:flags=lanczos,format=gray"

find_file() {
  local t="$1" cand hit
  for cand in "$t" "${t//: / - }" "${t//:/ -}" "${t//:/}"; do
    hit=$(find /data/media/movies -maxdepth 2 -type f \
      \( -iname '*.mkv' -o -iname '*.mp4' -o -iname '*.avi' -o -iname '*.m4v' \) \
      -path "*${cand}*" 2>/dev/null | sort | head -1)
    [[ -n "$hit" ]] && { echo "$hit"; return 0; }
  done
  return 1
}

yavg() { grep -oP 'YAVG=\K[0-9.]+' | awk '{s+=$1;n++} END {if(n) printf "%.4f", s/n; else printf ""}'; }

run() { # filtergraph -> mean YAVG
  timeout "$TIMEOUT" nice -n 15 ffmpeg -nostdin -hide_banner -loglevel error \
    -ss "$2" -t "$LEN" -i "$1" -vf "$3" -an -f null - 2>/dev/null | yavg
}

echo "# darkness dark_t=$DARK_T width=$WIDTH samples=$SAMPLES phase=$PHASE seclen=$LEN"
echo "film,prior,yavg,dark_frac,darkflat,secs"

while IFS='|' read -r title prior; do
  [[ -z "$title" || "$title" == \#* ]] && continue
  f=$(find_file "$title") || { echo "\"$title\",\"$prior\",FILE NOT FOUND"; continue; }
  dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$f" 2>/dev/null); dur=${dur%.*}
  [[ -z "$dur" || "$dur" -lt 300 ]] && continue
  t0=$SECONDS; sy=0; sd=0; sf=0; ok=0
  for i in $(seq 1 "$SAMPLES"); do
    t=$(awk -v d="$dur" -v i="$i" -v n="$SAMPLES" -v p="$PHASE" \
      'BEGIN{fr=(i-0.5+p)/n; if(fr<0)fr=0; if(fr>1)fr=1; printf "%d", d*0.1 + (d*0.8)*fr}')
    y=$(run "$f" "$t" "${SC},signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-")
    # lut maps every pixel below the threshold to 255, so the frame's mean IS 255 x the dark fraction.
    d=$(run "$f" "$t" "${SC},lut=y='if(lt(val,${DARK_T}),255,0)',signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-")
    # dark AND flat: multiply the dark mask by the flat mask (both 0/255), so the product is 255 only
    # where both hold. Dividing by 255 twice is why the awk below scales by 255 once more.
    df=$(run "$f" "$t" "${SC},split=2[a][b];[b]${DENOISE},${EDGE},dilation,dilation,negate[m];[a]lut=y='if(lt(val,${DARK_T}),255,0)'[dk];[dk][m]blend=all_mode=multiply,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-")
    [[ -z "$y" || -z "$d" || -z "$df" ]] && continue
    ok=$((ok+1))
    sy=$(awk -v a="$sy" -v b="$y"  'BEGIN{printf "%.5f", a+b}')
    sd=$(awk -v a="$sd" -v b="$d"  'BEGIN{printf "%.5f", a+b}')
    sf=$(awk -v a="$sf" -v b="$df" 'BEGIN{printf "%.5f", a+b}')
  done
  secs=$((SECONDS-t0))
  if [[ "$ok" -eq 0 ]]; then echo "\"$title\",\"$prior\",ALL SAMPLES FAILED,,,$secs"; continue; fi
  [[ "$ok" -lt "$SAMPLES" ]] && prior="$prior ${ok}/${SAMPLES}"
  awk -v t="$title" -v p="$prior" -v y="$sy" -v d="$sd" -v f="$sf" -v n="$ok" -v s="$secs" \
    'BEGIN{printf "\"%s\",\"%s\",%.2f,%.4f,%.4f,%d\n", t, p, y/n, (d/n)/255, (f/n)/255, s}'
done <<<"$(grep -v '^[[:space:]]*\(#\|$\)' "$SETFILE")"
