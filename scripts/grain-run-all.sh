#!/usr/bin/env bash
# grain-run-all.sh — the whole §3 continuation, run STRICTLY SEQUENTIALLY on 4 cores.
#
# ORDERED BY WHAT EACH STAGE CAN DECIDE, not by cost, because the box may be interrupted at any point
# and whatever finished first should be the most useful thing to have.
#
#   B  EXTREMES    can FALSIFY the metric outright (CGI has no grain to preserve). Highest value.
#   A2 OFFSET      the noise floor. Without it neither B nor C can be interpreted.
#   C  ABLATION    the mechanism — which of `-tune grain`'s eight knobs actually drives gShare.
#   D  FLATGRAIN   the cheap replacement candidate, on both sets.
#
# GRAIN_TIMEOUT is 120 s, not the 300 s default: at veryfast/1280 a normal sample encodes in ~35 s, so
# 120 s is >3x headroom for a healthy film while capping a pathological one at 1/3 the cost. 2001 is
# excluded from every set for that reason (see grain-sets/ablate.txt).
set -uo pipefail
cd "$(dirname "$0")/.."
OUT="${GRAIN_OUT:-docs/audit-2026-07-31/raw}"
mkdir -p "$OUT"
export GRAIN_TIMEOUT=120

say() { echo "=== $* — $(date +%H:%M:%S) ==="; }

say "B: extremes (falsification set)"
GRAIN_SET_FILE=scripts/grain-sets/extremes.txt \
  ./scripts/probe-grain.sh --fast --csv > "$OUT/grain-extremes.csv" 2> "$OUT/grain-extremes.err"
say "B done"

say "A2: offset stability, phase=0.33, 8 remaining films"
GRAIN_PHASE=0.33 GRAIN_SET_FILE=scripts/grain-sets/offset-remaining.txt \
  ./scripts/probe-grain.sh --fast --csv > "$OUT/grain-phase033-rest.csv" 2> "$OUT/grain-phase033-rest.err"
say "A2 done"

say "C: tune-grain ablation"
GRAIN_SAMPLES=2 ./scripts/probe-grain-ablate.sh > "$OUT/grain-ablation.csv" 2> "$OUT/grain-ablation.err"
say "C done"

say "D1: flat-region detector, ablate set"
GRAIN_SAMPLES=3 ./scripts/probe-flatgrain.sh > "$OUT/grain-flatgrain-ablateset.csv" 2>&1
say "D1 done"

say "D2: flat-region detector, extremes set"
GRAIN_SET_FILE=scripts/grain-sets/extremes.txt GRAIN_SAMPLES=3 \
  ./scripts/probe-flatgrain.sh > "$OUT/grain-flatgrain-extremes.csv" 2>&1
say "D2 done — ALL STAGES COMPLETE"
