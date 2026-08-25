#!/usr/bin/env bash
# probe-grain.sh — measure how much of a film's faithful bitrate is GRAIN, and test whether a cheap
# encode can measure it as well as an expensive one.
#
#   ./scripts/probe-grain.sh                  # reference: medium preset, 1920 wide  (~50 min/film)
#   ./scripts/probe-grain.sh --fast           # candidate: veryfast, 1280 wide       (~2 min/film)
#   ./scripts/probe-grain.sh --fast --csv     # machine-readable
#
# Env overrides: GRAIN_SAMPLES GRAIN_SECLEN GRAIN_CRF GRAIN_PRESET GRAIN_WIDTH
#
# ── WHAT IS BEING MEASURED, AND WHY IT IS A RATIO ─────────────────────────────────────────────────
# probe-film.sh measures complexity with `libx265 -crf 20` and NO tune. x265's default RD model treats
# film grain as perceptually irrelevant and DISCARDS it — which is why `--tune grain` exists as an
# opt-in. So the probe asks "how many bits does this film need?" and x265 answers "few, I'll drop the
# grain." Grain-heavy films therefore measure EASY, their target sinks, and BPP+ reads HIGH: Lawrence
# of Arabia (65mm, visibly shimmering flat skies) read 134.
#
# Brennan wants the other definition — "I'm happy for there to be grain... the random compression noise
# on the grain is crap" — so the target must be the bits needed to reproduce the film FAITHFULLY
# INCLUDING ITS GRAIN.
#
#   grainShare = 1 - defaultBytes / tunedBytes        on the SAME samples
#   complexity_faithful = complexity / (1 - grainShare)
#
# THE RATIO IS THE POINT. Both passes see identical pixels, identical scaling, identical CRF; the only
# variable is whether grain survives. So motion, fine detail and contrast — all of which cost bits —
# appear in BOTH passes and CANCEL. That is what makes this robust, and it is exactly what the cheap
# `atadenoise`-residual detector could not do: an absolute measurement of a quantity with two sources
# (grain AND motion) cannot separate them. Measured 2026-08-13: jitter vs grainShare was r=+0.988 over
# three similarly-paced films and COLLAPSED to r=-0.050 when Raiders of the Lost Ark was added — the
# most kinetic film in the set, with the second-highest jitter and the LOWEST true grain cost. The
# detector was reading motion. Kept in the output as a column, no longer trusted as a proxy.
#
# ── WHY --fast EXISTS ─────────────────────────────────────────────────────────────────────────────
# The reference measurement is far dearer than first estimated: measured wall times were Lawrence ~20
# min, Blade Runner ~20, Alien ~55, Raiders ~107 — mean ~50 min/film, a 5x spread, and the cost rises
# with grain, so the films most worth measuring are the slowest. Over 1026 probe entries that is ~850
# hours, about 140 nights at 6 h/night.
#
# But NOTHING DOWNSTREAM USES grainShare's ABSOLUTE VALUE. It feeds a target where only the ordering
# and rough magnitude matter. So the measurement does not need to be accurate, only COMPARABLE — and
# comparability survives a cheaper encoder as long as EVERY film is measured the same way. --fast drops
# to veryfast/1280 for a 20-40x saving.
#
# SAMPLE COUNT IS DELIBERATELY NOT REDUCED in --fast. The offsets are a function of duration and
# GRAIN_SAMPLES only, so with the count held equal both modes hit the SAME timestamps and the two runs
# are a controlled comparison of encoder settings alone. Cutting samples would change which scenes are
# measured and confound the very thing being tested. It matters: per-sample grainShare ranged 0.04-0.58
# within Raiders alone.
#
# VALIDATION CRITERION: --fast is usable if it preserves the SEPARATION and the ORDER, not if it
# reproduces the numbers. The reference run put grain films at 0.259-0.454; if --fast still ranks them
# the same way and still separates them from clean digital, it replaces the reference measurement.
#
# ── TRAPS ALREADY HIT HERE, ALL SILENT ────────────────────────────────────────────────────────────
#  * `-x265-params tune=grain` is IGNORED by x265 3.2.1 — BYTE-IDENTICAL output. tune must go through
#    ffmpeg's own `-tune`. Without the equality assertion below, every film would score 0 and "prove"
#    grain does not matter.
#  * `metadata=print` logs at INFO, so under `-loglevel error` the detector emits nothing. Hence file=-
#  * *arr SANITISES path names: ':' becomes ' -', so "2001: A Space Odyssey" is on disk as
#    "2001 - A Space Odyssey (1968)". Matching the probe-cache title literally silently skipped it.
#
# READ-ONLY: encodes into a temp dir, never touches library files.
set -uo pipefail
cd "$(dirname "$0")/.."

CSV=0; FAST=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fast) FAST=1 ;;
    --csv)  CSV=1 ;;
    -h|--help) sed -n '2,60p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

SAMPLES="${GRAIN_SAMPLES:-5}"
PHASE="${GRAIN_PHASE:-0}"
LEN="${GRAIN_SECLEN:-4}"
CRF="${GRAIN_CRF:-20}"
if [[ "$FAST" == "1" ]]; then
  PRESET="${GRAIN_PRESET:-veryfast}"; WIDTH="${GRAIN_WIDTH:-1280}"
else
  PRESET="${GRAIN_PRESET:-medium}";   WIDTH="${GRAIN_WIDTH:-1920}"
fi

TMP=$(mktemp -d /tmp/grain.XXXXXX)
trap 'rm -rf "$TMP"' EXIT

# 5 expected-grainy vs 5 expected-clean. PRIOR is the hypothesis under test, never an input.
# R is probe headroom and governs trust: a STARVED GRAINY copy has already lost its grain and would
# read low (false negative), so the grain group must be well-sourced or the test is worthless — all
# five are R >= 1.2. Two clean rows fall below and are marked `weak`; that asymmetry biases TOWARD the
# hypothesis, so the load-bearing clean rows are Skyfall R2.23, BR2049 R4.27, Social Network R1.85.
SET=$(cat <<'EOF'
Lawrence of Arabia (1962)|65mm R1.80
2001: A Space Odyssey (1968)|65mm R2.34
Blade Runner (1982)|35mm dark R2.01
Alien (1979)|35mm dark R2.39
Raiders of the Lost Ark (1981)|35mm warm R1.24
Skyfall (2012)|digital Alexa R2.23
Blade Runner 2049 (2017)|digital Alexa R4.27
The Social Network (2010)|digital RED R1.85
Gone Girl (2014)|digital RED R0.99 weak
Whiplash (2014)|digital R0.88 weak
EOF
)
# GRAIN_SET_FILE swaps in a different film list ("Title (Year)|prior" per line) without touching the
# set above, which is the record of the camera-format experiment and must stay reproducible.
if [[ -n "${GRAIN_SET_FILE:-}" ]]; then
  [[ -r "$GRAIN_SET_FILE" ]] || { echo "GRAIN_SET_FILE not readable: $GRAIN_SET_FILE" >&2; exit 2; }
  SET=$(grep -v '^[[:space:]]*\(#\|$\)' "$GRAIN_SET_FILE")
fi

# *arr rewrites characters that are illegal or awkward in paths. Try the literal title first, then the
# sanitised forms, so a colon or a slash in a title cannot silently drop a film from the set.
find_file() {
  local t="$1" cand
  for cand in "$t" "${t//: / - }" "${t//:/ -}" "${t//:/}"; do
    local hit
    hit=$(find /data/media/movies -maxdepth 2 -type f \
      \( -iname '*.mkv' -o -iname '*.mp4' -o -iname '*.avi' -o -iname '*.m4v' \) \
      -path "*${cand}*" 2>/dev/null | sort | head -1)
    [[ -n "$hit" ]] && { echo "$hit"; return 0; }
  done
  return 1
}

VF="scale='min(${WIDTH},iw)':-2:flags=lanczos"

# EVERY ENCODE IS WRAPPED IN `timeout`, because one pathological file can otherwise stall a whole run
# indefinitely. Observed 2026-08-13 on "2001 - A Space Odyssey (1968)" (REMASTERED, 1920x872): a single
# 4s veryfast/1280 encode ran past 1050 s — roughly 250x Lawrence's rate for the same operation — while
# burning 233% CPU across 16 threads, so it was genuinely encoding, not deadlocked. Seek and decode
# were ruled out: `-ss 1607 -t 4 -f null -` on that file took 1.91 s versus 2.02 s for Lawrence, so the
# cost is inside x265, cause unknown. A stale d.mkv/g.mkv from the PREVIOUS sample would silently
# produce a fabricated ratio, so the files are removed before each pass and a missing output reports 0,
# which the caller treats as a failed sample rather than a measurement.
GRAIN_TIMEOUT="${GRAIN_TIMEOUT:-300}"
encode_pair() {
  local f="$1" t="$2"
  rm -f "$TMP/d.mkv" "$TMP/g.mkv"
  timeout "$GRAIN_TIMEOUT" nice -n 15 ffmpeg -nostdin -hide_banner -loglevel error -ss "$t" -t "$LEN" -i "$f" \
      -vf "$VF" -c:v libx265 -crf "$CRF" -preset "$PRESET" -an -y "$TMP/d.mkv" 2>/dev/null
  timeout "$GRAIN_TIMEOUT" nice -n 15 ffmpeg -nostdin -hide_banner -loglevel error -ss "$t" -t "$LEN" -i "$f" \
      -vf "$VF" -c:v libx265 -crf "$CRF" -preset "$PRESET" -tune grain -an -y "$TMP/g.mkv" 2>/dev/null
  echo "$(stat -c '%s' "$TMP/d.mkv" 2>/dev/null || echo 0) $(stat -c '%s' "$TMP/g.mkv" 2>/dev/null || echo 0)"
}

# Retained for the record, NOT as a proxy — see the header. Cheap: decode only.
jitter_of() {
  local f="$1" t="$2"
  timeout "$GRAIN_TIMEOUT" nice -n 15 ffmpeg -nostdin -hide_banner -loglevel error -ss "$t" -t "$LEN" -i "$f" \
    -vf "${VF},format=yuv420p,split[a][b];[a]atadenoise[dn];[b][dn]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" \
    -an -f null - 2>/dev/null | grep -oP 'YAVG=\K[0-9.]+' \
    | awk '{s+=$1;n++} END {if(n) printf "%.4f", s/n; else printf "0"}'
}

# Self-labelling: two runs are only comparable if you know what settings produced each.
LABEL="preset=$PRESET width=$WIDTH samples=$SAMPLES phase=$PHASE seclen=$LEN crf=$CRF"
if [[ "$CSV" == "1" ]]; then
  echo "# $LABEL"
  # per_sample carries EVERY sample's share, not just min/max: the whole offset-stability question is
  # about the within-film distribution, and a range hides whether it is one outlier or genuine spread.
  echo "film,prior,default_bytes,tuned_bytes,ratio,grain_share,share_min,share_max,jitter,secs,per_sample"
else
  echo; echo "  $LABEL"; echo
  printf "  %-30s %-22s %6s %7s %11s %8s %6s\n" "film" "prior" "ratio" "gShare" "per-sample" "jitter" "secs"
  printf "  %s\n" "$(printf '%.0s-' $(seq 1 100))"
fi

while IFS='|' read -r title prior; do
  [[ -z "$title" ]] && continue
  f=$(find_file "$title") || {
    [[ "$CSV" == "0" ]] && printf "  %-30s %-22s %s\n" "${title:0:30}" "$prior" "FILE NOT FOUND"
    continue
  }
  dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$f" 2>/dev/null)
  dur=${dur%.*}
  [[ -z "$dur" || "$dur" -lt 300 ]] && continue

  t0=$SECONDS
  totd=0; totg=0; jsum=0; shares=""; ok=0
  for i in $(seq 1 "$SAMPLES"); do
    # Evenly spaced across the middle 80% — titles and credits are not representative content.
    # Offsets depend only on duration and SAMPLES, so every mode hits the same timestamps.
    # GRAIN_PHASE shifts every offset by a fraction of one sample spacing. This is the OFFSET-STABILITY
    # control: changing GRAIN_SAMPLES also changes the sample COUNT, so it varies scene selection and
    # averaging depth together and cannot separate them. Phase holds n fixed and moves only WHICH
    # scenes are hit, which is the thing actually under test.
    t=$(awk -v d="$dur" -v i="$i" -v n="$SAMPLES" -v p="$PHASE" \
      'BEGIN{f=(i-0.5+p)/n; if(f<0)f=0; if(f>1)f=1; printf "%d", d*0.1 + (d*0.8)*f}')
    read -r db gb <<<"$(encode_pair "$f" "$t")"
    totd=$((totd + db)); totg=$((totg + gb))
    if [[ "$db" -gt 0 && "$gb" -gt 0 ]]; then
      ok=$((ok + 1))
      shares="$shares $(awk -v d="$db" -v g="$gb" 'BEGIN{printf "%.3f", 1-(d/g)}')"
    fi
    jsum=$(awk -v a="$jsum" -v b="$(jitter_of "$f" "$t")" 'BEGIN{printf "%.4f", a+b}')
  done
  secs=$((SECONDS - t0))
  if [[ "$ok" -eq 0 ]]; then
    # Silence here would look like the film was never in the set. Say so instead.
    if [[ "$CSV" == "1" ]]; then printf '"%s","%s",0,0,,,,,,%d\n' "$title" "$prior" "$secs"
    else printf "  %-30s %-22s %s\n" "${title:0:30}" "$prior" "ALL $SAMPLES SAMPLES TIMED OUT (>${GRAIN_TIMEOUT}s each)"; fi
    continue
  fi
  # ASSERT the tune flag did something. Byte-identical totals mean it was ignored (see traps).
  if [[ "$totd" == "$totg" ]]; then
    echo "  !! $title: tuned == default byte-for-byte — the -tune flag was IGNORED. Aborting." >&2
    exit 1
  fi
  read -r smin smax <<<"$(echo "$shares" | awk '{lo=$1;hi=$1; for(i=1;i<=NF;i++){if($i<lo)lo=$i; if($i>hi)hi=$i}} END{printf "%.2f %.2f", lo, hi}')"
  read -r ratio share jit <<<"$(awk -v d="$totd" -v g="$totg" -v j="$jsum" -v n="$ok" \
    'BEGIN{printf "%.3f %.3f %.4f", g/d, 1-(d/g), j/n}')"
  # Flag partial coverage: a 2-of-5 film is not comparable to a 5-of-5 one.
  [[ "$ok" -lt "$SAMPLES" ]] && prior="$prior ${ok}/${SAMPLES}"
  if [[ "$CSV" == "1" ]]; then
    printf '"%s","%s",%d,%d,%s,%s,%s,%s,%s,%d,"%s"\n' \
      "$title" "$prior" "$totd" "$totg" "$ratio" "$share" "$smin" "$smax" "$jit" "$secs" \
      "$(echo "$shares" | tr -s ' ' | sed 's/^ //;s/ /;/g')"
  else
    printf "  %-30s %-22s %6s %7s %11s %8s %5dm\n" \
      "${title:0:30}" "$prior" "$ratio" "$share" "$smin-$smax" "$jit" "$((secs/60))"
  fi
done <<<"$SET"
echo
