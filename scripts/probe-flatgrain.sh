#!/usr/bin/env bash
# probe-flatgrain.sh — measure grain the way AV1's own film-grain estimator does: as the source-vs-
# denoised residual, measured ONLY in flat regions.
#
# ── WHY THIS, AND WHY IT IS NOT THE `jitter` DETECTOR THAT ALREADY FAILED ─────────────────────────
# HANDOFF-2026-08-13 §3.7 killed `jitter` (mean luma residual after `atadenoise`) after r collapsed
# from +0.988 (n=3) to -0.050 (n=4). The stated structural reason was correct and it is worth being
# precise about, because THIS metric is also an absolute residual and would fail identically if the
# same two mistakes were repeated:
#
#   FAILURE 1 — a TEMPORAL denoiser removes MOTION as well as grain. Raiders, the most kinetic film in
#     the set, had the second-highest jitter and the lowest grain cost.
#     FIX HERE: the denoiser is SPATIAL-ONLY (removegrain / nlmeans, single-frame). Motion cannot
#     enter a per-frame spatial residual at all, because no other frame is consulted.
#
#   FAILURE 2 — measuring over the WHOLE FRAME conflates grain with edges and texture. This is the
#     same confound that made `-tune grain` read high on sharp digital photography (§3.4).
#     FIX HERE: the residual is masked to FLAT regions only, via edge detection + dilation on the
#     DENOISED frame. This is not an invention — it is what AOMedia's AV1 film-grain estimator does:
#     "estimation of noise model parameters is performed in smooth areas of the input picture... the
#     Canny edge detector is applied to the denoised image... followed by the dilation operation",
#     precisely so that "edges and texture do not affect the film grain estimation".
#
# The mask is built from the DENOISED frame, never the source: building it from the source would let
# the grain itself trigger the edge detector and carve away the very regions we want to measure.
#
# It is also where BRENNAN ACTUALLY SEES THE PROBLEM — "randomly changing pixel noise in flat skies".
# The measurement region and the complaint are the same region.
#
# ── OUTPUT ────────────────────────────────────────────────────────────────────────────────────────
#   flat_frac  fraction of the frame judged flat (sanity: a film with ~0 flat area gives no estimate)
#   raw_res    mean |source - denoised| over the WHOLE frame  (the contaminated version, for contrast)
#   flat_res   mean |source - denoised| over FLAT REGIONS ONLY  <- THE METRIC
#
# flat_res is cheap: decode-only, no encoding. If it correlates with the expensive gShare it replaces
# a ~6 min/film measurement with a ~10 s/film one, which is the difference between 17 nights and one.
#
# READ-ONLY: decodes only, writes nothing but stdout.
set -uo pipefail
cd "$(dirname "$0")/.."

SAMPLES="${GRAIN_SAMPLES:-5}"
LEN="${GRAIN_SECLEN:-4}"
WIDTH="${GRAIN_WIDTH:-1280}"
PHASE="${GRAIN_PHASE:-0}"
DENOISE="${FLAT_DENOISE:-removegrain=1}"   # MUST be spatial-only — see FAILURE 1 above
EDGE="${FLAT_EDGE:-edgedetect=low=0.06:high=0.15}"
TIMEOUT="${GRAIN_TIMEOUT:-300}"
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

# Mean of lavfi.signalstats.YAVG over the sample. metadata=print logs at INFO, so it must go to
# file=- rather than the log, or `-loglevel error` swallows it entirely (a trap already hit once).
yavg() {
  grep -oP 'YAVG=\K[0-9.]+' | awk '{s+=$1;n++} END {if(n) printf "%.5f", s/n; else printf ""}'
}

# 1) masked residual: mean(|src-denoised| * mask/255) over the whole frame
# 2) mask coverage:   mean(mask)/255 = the flat fraction
# flat_res = (1) / (2) — i.e. the mean residual per flat PIXEL rather than per frame pixel. Without
# this normalisation a film with little flat area would score low purely for lacking sky.
measure() {
  local f="$1" t="$2" masked cover
  # -vf is an OUTPUT option and MUST precede the output URL. Placed after `-f null -` ffmpeg silently
  # emits nothing and every sample reads as failed — which is exactly how this script failed first run.
  masked=$(timeout "$TIMEOUT" nice -n 15 ffmpeg -nostdin -hide_banner -loglevel error \
    -ss "$t" -t "$LEN" -i "$f" \
    -vf "${SC},split=2[a][b];[b]${DENOISE},split=2[d1][d2];[a][d1]blend=all_mode=difference[r];[d2]${EDGE},dilation,dilation,negate[m];[r][m]blend=all_mode=multiply,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" \
    -an -f null - 2>/dev/null | yavg)
  cover=$(timeout "$TIMEOUT" nice -n 15 ffmpeg -nostdin -hide_banner -loglevel error \
    -ss "$t" -t "$LEN" -i "$f" \
    -vf "${SC},${DENOISE},${EDGE},dilation,dilation,negate,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" \
    -an -f null - 2>/dev/null | yavg)
  local raw
  raw=$(timeout "$TIMEOUT" nice -n 15 ffmpeg -nostdin -hide_banner -loglevel error \
    -ss "$t" -t "$LEN" -i "$f" \
    -vf "${SC},split=2[a][b];[b]${DENOISE}[d];[a][d]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" \
    -an -f null - 2>/dev/null | yavg)
  echo "${masked:-} ${cover:-} ${raw:-}"
}

echo "# flatgrain denoise=$DENOISE edge=$EDGE width=$WIDTH samples=$SAMPLES phase=$PHASE seclen=$LEN"
echo "film,prior,flat_frac,raw_res,flat_res,secs"

while IFS='|' read -r title prior; do
  [[ -z "$title" || "$title" == \#* ]] && continue
  f=$(find_file "$title") || { echo "\"$title\",\"$prior\",FILE NOT FOUND"; continue; }
  dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$f" 2>/dev/null)
  dur=${dur%.*}
  [[ -z "$dur" || "$dur" -lt 300 ]] && continue

  t0=$SECONDS; sm=0; sc=0; sr=0; ok=0
  for i in $(seq 1 "$SAMPLES"); do
    t=$(awk -v d="$dur" -v i="$i" -v n="$SAMPLES" -v p="$PHASE" \
      'BEGIN{fr=(i-0.5+p)/n; if(fr<0)fr=0; if(fr>1)fr=1; printf "%d", d*0.1 + (d*0.8)*fr}')
    read -r m c r <<<"$(measure "$f" "$t")"
    [[ -z "$m" || -z "$c" || -z "$r" ]] && continue
    ok=$((ok+1))
    sm=$(awk -v a="$sm" -v b="$m" 'BEGIN{printf "%.6f", a+b}')
    sc=$(awk -v a="$sc" -v b="$c" 'BEGIN{printf "%.6f", a+b}')
    sr=$(awk -v a="$sr" -v b="$r" 'BEGIN{printf "%.6f", a+b}')
  done
  secs=$((SECONDS - t0))
  if [[ "$ok" -eq 0 ]]; then echo "\"$title\",\"$prior\",ALL $SAMPLES SAMPLES FAILED,,,$secs"; continue; fi
  # Guard the division: a frame with no flat area at all would otherwise divide by zero and print inf.
  read -r ff rr fr <<<"$(awk -v m="$sm" -v c="$sc" -v r="$sr" -v n="$ok" \
    'BEGIN{cov=(c/n)/255; printf "%.4f %.4f %s", cov, r/n, (cov>0.001 ? sprintf("%.4f",(m/n)/cov) : "NO_FLAT_AREA")}')"
  [[ "$ok" -lt "$SAMPLES" ]] && prior="$prior ${ok}/${SAMPLES}"
  echo "\"$title\",\"$prior\",$ff,$rr,$fr,$secs"
done <<<"$(grep -v '^[[:space:]]*\(#\|$\)' "$SETFILE")"
