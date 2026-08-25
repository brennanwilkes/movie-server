#!/bin/sh
# THE 8-SAMPLE STARVATION RE-RUN (task #49), launched after the nightly probe window closes.
#
# WHY IT WAITS FOR 06:00. The probe owns 01:00-06:00 and this is ~5 hours of x265 on four cores.
# Running both would make each slower and stack two encode loads into one thermal window — and the
# 2026-07-09 trickplay runaway is why that window has a cap at all. So this sleeps until the window
# closes, then takes the box while nothing else wants it.
#
# WHY 8 SAMPLES. The original experiment used 3 samples per point where the probe uses 8-16, so its
# ABSOLUTE complexity did not reproduce the live measurement on high-scene-variance titles (Blade
# Runner 2049 was 2.29x off). The RATIO was clean, which is why the anchoring works — but the ratio
# still carries sampling noise from 3 clips. At 8 it is measured on the probe's own grid.
#
# WHY IT MATTERS MORE NOW. The x264 arm turned out to be the LIBRARY-REALISTIC condition (831 of 898
# movies are h264 probed with x265), and the curve was refitted on it: 1.114 * R^-0.392. So this
# confirms the constants that are actually live, on the arm that actually matters.
#
# SAFETY. probe-starve.sh reads sources read-only and writes only to /tmp. It re-encodes CLIPS, never
# media. The driver refuses to start while a probe session is active. Nothing here grabs, replaces or
# deletes anything.
#
# LOCKFILE, because this may be launched twice — once by the detached waiter and once by hand.
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="/tmp/starve-8samples.lock"
LOG="${STARVE8_LOG:-$REPO/data/starve-8samples.log}"
# The same 8 films as both existing arms. PINNED BY KEY because starve-experiment.js re-picks its
# sample from live R on every run, and R moved on 2026-08-20 — an unpinned re-run would measure
# different films and answer nothing.
KEYS="${STARVE8_KEYS:-mv:148,mv:66,mv:679,mv:38,mv:235,mv:282,mv:264,mv:178}"
ENC="${STARVE8_ENC:-libx264}"
OUT="${STARVE8_OUT:-$REPO/data/starve-experiment-8s.json}"
WAIT_UNTIL="${STARVE8_HOUR:-6}"

if [ -e "$LOCK" ]; then
  echo "$(date -Is) already running or stale lock at $LOCK — refusing" >> "$LOG"
  exit 0
fi

# WAIT FOR THE PROBE WINDOW TO CLOSE — against an absolute target, not an hour comparison.
#
# THE BUG THIS REPLACES, because it is an easy one to write twice. The first version was
#     while [ "$(date +%-H)" -lt "$WAIT_UNTIL" ]; do sleep 300; done
# which reads as "wait until 6am" and is not. Armed at 23:23 the current hour is 23, `23 -lt 6` is
# FALSE, and the loop exits instantly — so it ran at once, in the middle of the night, straight into
# the controller redeploys that were happening at the time. 7 of 8 films died on "container is not
# running". An hour comparison only works if you happen to arm it between midnight and 05:59.
#
# Resolving a target epoch handles the midnight wrap. Still polls rather than one long sleep, so a
# suspend or a clock change cannot overshoot: the loop re-reads the clock every 5 minutes.
TARGET=$(date -d "today ${WAIT_UNTIL}:00" +%s 2>/dev/null || echo 0)
if [ "$TARGET" = 0 ]; then echo "cannot resolve target time" >&2; exit 6; fi
[ "$(date +%s)" -ge "$TARGET" ] && TARGET=$(date -d "tomorrow ${WAIT_UNTIL}:00" +%s)
echo "$(date -Is) armed; waiting until $(date -d "@$TARGET" -Is)" >> "$LOG"
while [ "$(date +%s)" -lt "$TARGET" ]; do sleep 300; done

trap 'rm -f "$LOCK"' EXIT INT TERM
echo "$$" > "$LOCK"

{
  echo "=== $(date -Is) starting 8-sample starvation arm (enc=$ENC) ==="
  cd "$REPO"
  # If a manual probe session is somehow open, stand down rather than compete: the driver checks
  # this too, but failing here keeps the reason in this log.
  if curl -s -m 20 localhost:8088/api/probe | grep -q '"session":{'; then
    echo "a probe session is active — standing down, will not compete for the cores"
    exit 0
  fi
  STARVE_KEYS="$KEYS" STARVE_ENC="$ENC" STARVE_SAMPLES=8 STARVE_OUT="$OUT" \
    node scripts/starve-experiment.js --run
  echo "=== $(date -Is) done ==="
  # Compare against the 3-sample arm of the same encoder. If the constants move materially, the
  # refit needs revisiting; if they do not, 3 samples was good enough and that is worth knowing.
  node scripts/starve-compare.js --x265 data/starve-experiment.json --x264 "$OUT" || true
} >> "$LOG" 2>&1
