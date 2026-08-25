#!/usr/bin/env bash
# probe-grain-ablate.sh — decompose gShare into the individual encoder knobs that produce it.
#
# ── WHY THIS EXPERIMENT EXISTS ────────────────────────────────────────────────────────────────────
# HANDOFF-2026-08-13 §3.4 measured `gShare = 1 - defaultBytes/tunedBytes` and found it did NOT track
# capture format. §3.4 concluded it measures "the cost of preserving high-frequency detail". The x265
# documentation says something sharper, and it explains the null result mechanically:
#
#   "The purpose of --tune grain is neither to retain nor eliminate grain, but to prevent noticeable
#    artifacts caused by uneven distribution of grain."
#
# and it is not one knob, it is EIGHT:
#
#     --aq-mode 0        adaptive quantisation OFF   <- redistributes bits by local contrast
#     --cutree 0         CU-tree OFF                 <- lookahead QP modulation by future reference
#     --psy-rd 4.0       psycho-visual RD            <- THE high-frequency-energy knob
#     --psy-rdoq 10.0    psycho-visual RDOQ          <- THE high-frequency-energy knob
#     --sao 0            sample adaptive offset OFF  <- a deblocking-class filter
#     --recursion-skip 0 exhaustive CU search
#     --ipratio 1.1 --pbratio 1.0 --qpstep 1  + --rc-grain   flatten QP across frame types
#
# Only psy-rd/psy-rdoq have anything to do with preserving grain. `aq-mode 0` alone is a large,
# strongly CONTENT-DEPENDENT bitrate change: AQ moves bits toward flat and dark regions, so switching
# it off costs the most on films that are mostly flat and dark — which describes 2001 and Lawrence,
# the two films that topped the table and drove the (now dead) 65mm hypothesis. That is a confound
# that would MIMIC the result we got, so it has to be measured, not argued about.
#
# THE QUESTION: does the psy-only ratio rank films DIFFERENTLY from the full bundle? If it does, the
# bundle is contaminated and psy-only is the better faithfulness signal. If every knob ranks films the
# same way, then gShare really is close to a single per-film scale factor and §3 is a rescale.
#
# ── READING THE OUTPUT ────────────────────────────────────────────────────────────────────────────
# Each cell is `bytes(condition) / bytes(base)` on IDENTICAL samples, so >1 means the knob cost bits.
# The ratio is differential in exactly the way §3.7 requires: both encodes see the same pixels, so
# motion and detail appear in both and cancel.
#
# READ-ONLY: encodes into a temp dir, never touches library files.
set -uo pipefail
cd "$(dirname "$0")/.."

SAMPLES="${GRAIN_SAMPLES:-3}"
LEN="${GRAIN_SECLEN:-4}"
CRF="${GRAIN_CRF:-20}"
PRESET="${GRAIN_PRESET:-veryfast}"
WIDTH="${GRAIN_WIDTH:-1280}"
PHASE="${GRAIN_PHASE:-0}"
GRAIN_TIMEOUT="${GRAIN_TIMEOUT:-300}"
SETFILE="${GRAIN_SET_FILE:-scripts/grain-sets/ablate.txt}"

TMP=$(mktemp -d /tmp/ablate.XXXXXX)
trap 'rm -rf "$TMP"' EXIT
VF="scale='min(${WIDTH},iw)':-2:flags=lanczos"

# name|extra ffmpeg args. `base` MUST be first — every ratio is against it.
# Knobs are applied INDIVIDUALLY to base (isolation), not removed from the bundle, so each number is
# that knob's own cost rather than its cost net of interactions with seven others.
CONDS=$(cat <<'EOF'
base|
psy|-x265-params psy-rd=4.0:psy-rdoq=10.0
aq0|-x265-params aq-mode=0
cutree0|-x265-params cutree=0
sao0|-x265-params sao=0
recskip0|-x265-params recursion-skip=0
qpflat|-x265-params ipratio=1.1:pbratio=1.0:qpstep=1
full|-tune grain
EOF
)

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

encode() { # file offset outfile extra-args...
  local f="$1" t="$2" out="$3"; shift 3
  rm -f "$out"
  timeout "$GRAIN_TIMEOUT" nice -n 15 ffmpeg -nostdin -hide_banner -loglevel error \
    -ss "$t" -t "$LEN" -i "$f" -vf "$VF" -c:v libx265 -crf "$CRF" -preset "$PRESET" \
    "$@" -an -y "$out" 2>/dev/null
  stat -c '%s' "$out" 2>/dev/null || echo 0
}

echo "# ablation preset=$PRESET width=$WIDTH samples=$SAMPLES phase=$PHASE crf=$CRF"
printf 'film,prior,'
while IFS='|' read -r cn _; do [[ "$cn" == "base" ]] || printf '%s,' "$cn"; done <<<"$CONDS"
echo "secs"

while IFS='|' read -r title prior; do
  [[ -z "$title" || "$title" == \#* ]] && continue
  f=$(find_file "$title") || { echo "\"$title\",\"$prior\",FILE NOT FOUND"; continue; }
  dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$f" 2>/dev/null)
  dur=${dur%.*}
  [[ -z "$dur" || "$dur" -lt 300 ]] && continue

  t0=$SECONDS
  declare -A TOT=()
  for i in $(seq 1 "$SAMPLES"); do
    t=$(awk -v d="$dur" -v i="$i" -v n="$SAMPLES" -v p="$PHASE" \
      'BEGIN{fr=(i-0.5+p)/n; if(fr<0)fr=0; if(fr>1)fr=1; printf "%d", d*0.1 + (d*0.8)*fr}')
    while IFS='|' read -r cn cargs; do
      # shellcheck disable=SC2086 -- cargs is a deliberate multi-token argument list
      sz=$(encode "$f" "$t" "$TMP/$cn.mkv" $cargs)
      TOT[$cn]=$(( ${TOT[$cn]:-0} + sz ))
    done <<<"$CONDS"
  done
  secs=$((SECONDS - t0))

  base=${TOT[base]:-0}
  if [[ "$base" -le 0 ]]; then echo "\"$title\",\"$prior\",ALL BASE SAMPLES FAILED"; continue; fi
  line="\"$title\",\"$prior\","
  while IFS='|' read -r cn _; do
    [[ "$cn" == "base" ]] && continue
    v=${TOT[$cn]:-0}
    # A knob that produced BYTE-IDENTICAL output was silently ignored by this x265 build — the exact
    # trap that made `-x265-params tune=grain` score every film 0. Say so rather than printing 1.000.
    if [[ "$v" -eq "$base" ]]; then line+="IGNORED,"
    else line+="$(awk -v a="$v" -v b="$base" 'BEGIN{printf "%.4f", a/b}'),"; fi
  done <<<"$CONDS"
  echo "${line}${secs}"
  unset TOT
done <<<"$(grep -v '^[[:space:]]*\(#\|$\)' "$SETFILE")"
