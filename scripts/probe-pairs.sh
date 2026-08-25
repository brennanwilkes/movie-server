#!/usr/bin/env bash
# probe-pairs.sh — the BPP+ calibration set: films measured more than once, from different copies.
#
#   ./scripts/probe-pairs.sh            # the pairs, with the implied saturation exponent
#   ./scripts/probe-pairs.sh --fit      # fit the exponent across all pairs
#   ./scripts/probe-pairs.sh --csv      # machine-readable
#
# WHY THIS EXISTS. `complexity` is meant to be a property of the FILM. It is not, quite: the probe
# re-encodes the file ON DISK, and CRF 20 cannot ask for detail the source does not contain. A starved
# copy therefore measures as an EASY film, the target sinks toward that copy's own bitrate, and the
# deficient file scores close to 100. The worse the copy, the more it flatters itself — BPP+ is
# systematically inflated, and most inflated exactly where it matters.
#
# Measured on Easy Rider, 2026-08-12: BPP+ 78 (61% of its target), direct-played, and visibly full of
# grain-shimmer on flat walls and skies. Brennan put it at "a 60ish, or even lower like a 40" by eye.
# Correcting its target by the factor below gives 51.
#
# THE FIX NEEDS PAIRS. Same film, two measurements, different source quality:
#
#   Paris, Texas — 2.22 GB copy -> 12.73 GB Criterion transfer
#     srcBitrate  x6.02   ->   complexity  0.05982 -> 0.13939   (x2.33)
#     => complexity ~ srcBitrate^0.47
#
# The exponent is BELOW 1, so measured complexity saturates toward a ceiling as the source improves,
# and that ceiling is the film's true complexity. Fit the curve and every under-measured film can be
# corrected from data already on disk — automatically, per film, with no genre or year heuristics
# (which Brennan explicitly does not want: "that's the point of the quality probe").
#
# A two-parameter saturation cannot be fitted from one pair. Three is weak, five is usable. Every
# upgrade generates one for free, which is why setEntry() banks the superseded measurement instead of
# overwriting it — before 2026-08-12 it was thrown away, and 43 stale units were hours from having
# their old halves destroyed.
#
# READ-ONLY. Reports and exits.
set -uo pipefail
cd "$(dirname "$0")/.."

MODE=table
case "${1:-}" in
  --fit) MODE=fit ;;
  --csv) MODE=csv ;;
  -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
  '') ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

TMP=$(mktemp /tmp/probe-cache.XXXXXX.json)
trap 'rm -f "$TMP"' EXIT
docker exec controller cat /config/probe-cache.json > "$TMP" 2>/dev/null \
  || { echo "could not read /config/probe-cache.json (is the controller up?)" >&2; exit 1; }

CACHE="$TMP" MODE="$MODE" python3 - <<'PY'
import json, math, os, sys

MODE = os.environ["MODE"]
with open(os.environ["CACHE"]) as fh:
    cache = json.load(fh)
entries = cache.get("entries", cache)

pairs = []
for key, e in entries.items():
    if not isinstance(e, dict) or e.get("error"):
        continue
    priors = e.get("priors") or []
    # bpp, NOT srcBitrate: R is fileBpp/complexity by definition, so the file's own bits-per-pixel is
    # R*complexity. That is the resolution-normalised form, which is the only one comparable across a
    # 720p->1080p upgrade — and it is available on BOTH natively-banked priors and the ones
    # reconstructed from the event log (which have no srcBitrate at all). One code path for both.
    cx_new, R_new = e.get("complexity"), e.get("R")
    if not (cx_new and R_new):
        continue
    bpp_new = cx_new * R_new
    # Pair each prior with the CURRENT measurement. Consecutive priors are also valid pairs, but the
    # current one is the best-sourced, so it is the most informative partner for every earlier point.
    for pr in priors:
        cx_old, R_old = pr.get("complexity"), pr.get("R")
        if not (cx_old and R_old) or cx_old <= 0:
            continue
        bpp_old = cx_old * R_old
        if bpp_old <= 0 or bpp_new <= 0 or abs(bpp_new - bpp_old) < 1e-12:
            continue
        # exponent k such that cx_new/cx_old == (bpp_new/bpp_old)**k
        k = math.log(cx_new / cx_old) / math.log(bpp_new / bpp_old)
        pairs.append(dict(key=key, title=e.get("title", key), cx_old=cx_old, cx_new=cx_new,
                          sb_old=bpp_old, sb_new=bpp_new, sb_ratio=bpp_new / bpp_old, k=k,
                          R_old=R_old, R_new=R_new, src="events" if pr.get("from") == "events" else "banked"))

pairs.sort(key=lambda x: -x["sb_ratio"])

if MODE == "csv":
    print("key,title,cx_old,cx_new,bpp_old,bpp_new,bpp_ratio,exponent_k,R_old,R_new,source")
    for pr in pairs:
        print("%s,\"%s\",%s,%s,%.6f,%.6f,%.4f,%.4f,%.4f,%.4f,%s" % (pr["key"], pr["title"],
              pr["cx_old"], pr["cx_new"], pr["sb_old"], pr["sb_new"], pr["sb_ratio"], pr["k"],
              pr["R_old"], pr["R_new"], pr["src"]))
    sys.exit(0)

n = len(pairs)
print("\nBPP+ calibration pairs: %d\n" % n)
if not n:
    print("  None yet. Pairs are banked automatically whenever a film is re-probed from a")
    print("  DIFFERENT copy (see setEntry in controller/lib/probe.js). Replace or upgrade a")
    print("  film and its pair appears after the next nightly probe.\n")
    sys.exit(0)

print("  %-34s %21s %10s %7s %6s" % ("film", "complexity", "file bpp", "old R", "k"))
print("  %-34s %21s %10s" % ("", "old -> new", "x"))
print("  " + "-" * 82)
for pr in pairs:
    cx = "%.5f -> %.5f" % (pr["cx_old"], pr["cx_new"])
    print("  %-34s %21s %9.2fx %7.2f %6.3f" % (pr["title"][:34], cx, pr["sb_ratio"], pr["R_old"], pr["k"]))

ks = sorted(x["k"] for x in pairs)
med = ks[len(ks) // 2] if len(ks) % 2 else (ks[len(ks) // 2 - 1] + ks[len(ks) // 2]) / 2
print()
print("  median exponent k = %.3f" % med)
if med >= 1:
    print("  k >= 1 does NOT saturate - the model does not hold; do not extrapolate.")
else:
    print("  k < 1 => saturating, as expected. Measured complexity rises as srcBitrate^%.2f." % med)
print()
if n < 3:
    print("  %d pair(s): NOT ENOUGH TO FIT. A two-parameter saturation needs 3 at minimum," % n)
    print("  5 for real confidence. Do not correct any targets from this yet.")
elif n < 5:
    print("  %d pairs: weakly fittable. Treat any correction as provisional." % n)
else:
    print("  %d pairs: enough to fit the saturation and correct pinned targets." % n)
print()
PY
