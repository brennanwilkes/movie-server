#!/usr/bin/env bash
# bpp-recheck.sh — how wrong is each film's BPP+, and in which direction?
#
#   ./scripts/bpp-recheck.sh                 # films whose BPP+ is most overstated
#   ./scripts/bpp-recheck.sh --upgraded      # ONLY films already replaced once (have banked priors)
#   ./scripts/bpp-recheck.sh --top 40        # show N rows (default 25)
#   ./scripts/bpp-recheck.sh --csv           # machine-readable
#
# READ-ONLY, and NOTHING HERE CHANGES ANY DISPLAYED NUMBER. This is the behind-the-scenes error
# estimate: which films' BPP+ is probably wrong, in which direction, and by roughly how much.
#
# ── WHY BPP+ IS BIASED, NOT JUST NOISY ───────────────────────────────────────────────────────
# `complexity` is meant to be a property of the FILM. It is measured by re-encoding the file ON DISK
# at CRF 20 — and CRF 20 cannot ask for detail the source does not contain. A starved copy therefore
# measures as an EASY film, its target sinks toward its own bitrate, and the deficient file scores
# close to 100. The worse the copy, the more it flatters itself. BPP+ is OVERSTATED, and most
# overstated exactly where accuracy matters.
#
# Ground truth, same film / same probe / better source (Paris, Texas, 2026-08-12):
#   srcBitrate x6.02  ->  complexity 0.05982 -> 0.13939  (x2.33)
# And across the 78 monotonic recovered pairs, complexity rose by a median of ~1.4x.
#
# ── TWO INDEPENDENT ERROR TERMS, and they behave differently ──────────────────────────────────
#
# 1. SOURCE-PINNING BIAS — systematic, ONE-DIRECTIONAL (complexity too low => BPP+ too high).
#    Estimated from R (= fileBpp / complexity). R < 1 means the file sits BELOW its own measured
#    target, i.e. the probe ran out of source before it ran out of appetite, so the number is a
#    FLOOR. R > 1 means the probe had headroom and the measurement is trustworthy.
#    HONESTY: R predicts the bias only weakly — correlation(R, log F) is -0.158 across the pairs, and
#    the spread WITHIN each R bucket is about as wide as the trend between buckets. So the factors
#    below are a triage signal, not a precise correction. They are also a LOWER BOUND: the median
#    post-upgrade R was still 0.87, i.e. most "better" copies were themselves still pinned, so the
#    true complexity is higher than one round of correction suggests.
#
# 2. SAMPLING NOISE — random, symmetric, and NOT reducible by better sources.
#    The probe encodes 8 x 4s samples: 32 seconds of a two-hour film, ~0.4% of it. Scene complexity
#    varies up to 8.2x WITHIN one film, so the mean of 8 samples carries real standard error.
#    `spreadRatio` (hardest sampled scene / easiest) is recorded per film, so this is computed
#    per film rather than assumed. This is why 18 of 96 pairs showed complexity FALLING when the
#    source improved — noise, not a broken model.
#
# The two combine as: BPP+_true is probably below BPP+_now, by roughly sqrt(F), give or take the
# sampling band. Films where the band still straddles a band boundary are the ones to re-examine.
set -uo pipefail
cd "$(dirname "$0")/.."

TOP=25
ONLY_UPGRADED=0
CSV=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --upgraded) ONLY_UPGRADED=1 ;;
    --top) TOP="$2"; shift ;;
    --csv) CSV=1 ;;
    -h|--help) sed -n '2,48p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

TMP=$(mktemp /tmp/probe-cache.XXXXXX.json)
trap 'rm -f "$TMP"' EXIT
docker exec controller cat /config/probe-cache.json > "$TMP" 2>/dev/null \
  || { echo "could not read the probe cache (is the controller up?)" >&2; exit 1; }

CACHE="$TMP" TOP="$TOP" ONLY_UPGRADED="$ONLY_UPGRADED" CSV="$CSV" python3 - <<'PY'
import json, math, os, statistics, sys

CACHE = os.environ["CACHE"]
TOP = int(os.environ["TOP"])
ONLY_UPGRADED = os.environ["ONLY_UPGRADED"] == "1"
CSV = os.environ["CSV"] == "1"

with open(CACHE) as fh:
    cache = json.load(fh)
entries = cache.get("entries", cache)

# ---- the bias factor F(R), fitted from the banked pairs in THIS cache ------------------------
# Buckets rather than a regression, deliberately: with correlation -0.158 a fitted line would imply
# far more precision than the data supports, and a median-per-bucket degrades gracefully. Above
# R_TRUST there are NO pairs at all (you only re-download films that were bad), so the factor is
# clamped to 1.0 — never invent a correction in a range nothing was measured in.
R_TRUST = 1.2
BUCKETS = [(0, .30), (.30, .40), (.40, .50), (.50, .70), (.70, 1.00), (1.00, R_TRUST)]
obs = {b: [] for b in BUCKETS}
n_pairs = 0
for key, e in entries.items():
    if not isinstance(e, dict) or e.get("error"):
        continue
    cx_new, R_new = e.get("complexity"), e.get("R")
    if not (cx_new and R_new):
        continue
    for pr in (e.get("priors") or []):
        cx_old, R_old = pr.get("complexity"), pr.get("R")
        if not (cx_old and R_old) or cx_old <= 0:
            continue
        if cx_new < cx_old:            # non-monotonic: sampling noise dominated, not a bias sample
            continue
        n_pairs += 1
        for b in BUCKETS:
            if b[0] <= R_old < b[1]:
                obs[b].append(cx_new / cx_old)
                break

fitted = {}
for b in BUCKETS:
    fitted[b] = statistics.median(obs[b]) if obs[b] else None
# Fill empty buckets from the nearest populated one so the function is total.
known = [(b, v) for b, v in fitted.items() if v]
def bias_for(R):
    if R is None or R >= R_TRUST or not known:
        return 1.0, "trusted"
    for b, v in fitted.items():
        if v and b[0] <= R < b[1]:
            return v, "fitted"
    # nearest populated bucket by midpoint distance
    b, v = min(known, key=lambda kv: abs((kv[0][0] + kv[0][1]) / 2 - R))
    return v, "nearest"

# ---- sampling standard error from spreadRatio -------------------------------------------------
# spreadRatio is max/min across PROBE_SAMPLES samples. For n=8 the expected range of a normal sample
# is ~2.85 sigma, so sigma(log) ~ ln(spread)/2.85 and the standard error of the mean is that over
# sqrt(n). Approximate by construction — it is an error BAR, not a p-value.
N_SAMPLES = 8
RANGE_TO_SIGMA = 2.85
def sampling_se(spread):
    if not spread or spread <= 1:
        return None
    sigma = math.log(spread) / RANGE_TO_SIGMA
    return sigma / math.sqrt(N_SAMPLES)

rows = []
for key, e in entries.items():
    if not isinstance(e, dict) or e.get("error"):
        continue
    cx, R = e.get("complexity"), e.get("R")
    if not (cx and R) or cx <= 0:
        continue
    upgraded = bool(e.get("priors"))
    if ONLY_UPGRADED and not upgraded:
        continue
    bpp = cx * R
    now = 100 * math.sqrt(bpp / cx)                  # == 100*sqrt(R), the number the app shows
    F, how = bias_for(R)
    corrected = 100 * math.sqrt(bpp / (cx * F))
    se = sampling_se(e.get("spreadRatio"))
    # +-1 SE on complexity -> band on BPP+ (sqrt, so it compresses)
    lo = 100 * math.sqrt(bpp / (cx * F * (1 + se))) if se else None
    hi = 100 * math.sqrt(bpp / (cx * F * max(1e-6, 1 - se))) if se else None
    rows.append(dict(key=key, title=e.get("title", key), R=R, cx=cx, now=now, F=F, how=how,
                     corrected=corrected, drop=now - corrected, se=se, lo=lo, hi=hi,
                     spread=e.get("spreadRatio"), upgraded=upgraded,
                     pinned=R < 1.0, source=e.get("source")))

rows.sort(key=lambda r: -r["drop"])

if CSV:
    print("key,title,source,R,complexity,bpp_plus_now,bias_F,bpp_plus_corrected,drop,"
          "sampling_se,band_lo,band_hi,spreadRatio,upgraded,still_pinned,bias_basis")
    for r in rows:
        print("%s,\"%s\",%s,%.4f,%.5f,%.0f,%.3f,%.0f,%.0f,%s,%s,%s,%s,%d,%d,%s" % (
            r["key"], r["title"], r["source"] or "", r["R"], r["cx"], r["now"], r["F"],
            r["corrected"], r["drop"],
            ("%.4f" % r["se"]) if r["se"] else "", ("%.0f" % r["lo"]) if r["lo"] else "",
            ("%.0f" % r["hi"]) if r["hi"] else "", r["spread"] or "",
            1 if r["upgraded"] else 0, 1 if r["pinned"] else 0, r["how"]))
    sys.exit(0)

print()
print("  bias factors fitted from %d monotonic banked pairs in this cache:" % n_pairs)
for b in BUCKETS:
    v = fitted[b]
    tag = ("x%.2f  (n=%d)" % (v, len(obs[b]))) if v else "no pairs -> nearest bucket"
    print("    R %.2f-%.2f   %s" % (b[0], b[1], tag))
print("    R >= %.2f     x1.00  (trusted: the probe had headroom)" % R_TRUST)
print()
scope = "ALREADY-UPGRADED films (have a banked prior)" if ONLY_UPGRADED else "all measured films"
print("  %s — worst BPP+ overstatement first\n" % scope)
print("  %-32s %6s %6s %6s %13s %6s" % ("film", "R", "now", "true?", "band", "drop"))
print("  " + "-" * 78)
for r in rows[:TOP]:
    band = ("%.0f-%.0f" % (r["lo"], r["hi"])) if r["lo"] else "n/a"
    flag = "" if not r["pinned"] else " *"
    print("  %-32s %6.2f %6.0f %6.0f %13s %5.0f%s" % (
        r["title"][:32], r["R"], r["now"], r["corrected"], band, r["drop"], flag))
print()
pinned = [r for r in rows if r["pinned"]]
print("  %d of %d shown-scope films still have R < 1 (*) — their corrected figure is itself a" % (len(pinned), len(rows)))
print("  FLOOR, because the copy on disk is still below its own target and the probe is still")
print("  source-limited. Those need another, better copy before the number can settle.")
if rows:
    med_drop = statistics.median(r["drop"] for r in rows)
    print("  median BPP+ overstatement across this scope: %.0f points" % med_drop)
print()
PY
