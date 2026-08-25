#!/usr/bin/env bash
# probe-backfill-pairs.sh — reconstruct the BPP+ calibration set from the metrics event log.
#
#   ./scripts/probe-backfill-pairs.sh            # dry run: report what WOULD be written
#   ./scripts/probe-backfill-pairs.sh --apply    # write the priors into probe-cache.json
#
# WHAT WAS LOST, AND WHY IT IS NOT LOST. `complexity` is meant to be a property of the FILM, and is
# not quite: the probe re-encodes the file ON DISK and CRF 20 cannot ask for detail the source does
# not contain, so a starved copy measures as an EASY film and the deficient file then scores close to
# 100. Correcting that needs OLD/NEW pairs of the same film at different source qualities — and
# setEntry() used to OVERWRITE the old measurement on every re-probe, so ~100 upgrades' worth of the
# old halves appeared to be gone.
#
# They were not. Every probe emits a `probe_unit` event carrying `cx` (complexity) and `R`
# (fileBpp / complexity), so BOTH halves of every pair are recoverable, and the file's own bpp comes
# back as R*cx. The event log runs from 2026-07-06 — the entire probe history.
#
# WHY THIS IS A SCRIPT AND NOT A ONE-OFF. Everything here is IaC:
#   * probe-cache.json lives on the bind mount (${CONFIG}/controller:/config), so it already survives
#     image rebuilds, `make deploy` and `make provision` — none of which touch it.
#   * but if it is ever lost, corrupted or hand-edited, this rebuilds the calibration set from the
#     event log, which is the durable source of truth and also on that volume.
#   * it is IDEMPOTENT: priors are matched on timestamp, so re-running adds nothing and changes
#     nothing. Safe in a provisioning path, safe to run twice by accident.
#
# WHAT IT NEVER TOUCHES: `complexity` and every other current field. This only ever APPENDS to
# `priors`. No BPP+ anywhere changes as a result of running it — it is accumulating evidence for a
# correction that has not been made yet. Read it back with ./scripts/probe-pairs.sh
set -uo pipefail
cd "$(dirname "$0")/.."

APPLY=0
case "${1:-}" in
  --apply) APPLY=1 ;;
  -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
  '') ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

EVENTS=/opt/appdata/controller/metrics/events
CACHE=/opt/appdata/controller/probe-cache.json
[[ -d "$EVENTS" ]] || { echo "no event log at $EVENTS" >&2; exit 1; }
[[ -f "$CACHE"  ]] || { echo "no probe cache at $CACHE" >&2; exit 1; }

OUT=$(mktemp /tmp/probe-cache-new.XXXXXX.json)
trap 'rm -f "$OUT"' EXIT

EVENTS="$EVENTS" CACHE="$CACHE" OUT="$OUT" APPLY="$APPLY" python3 - <<'PY'
import json, glob, os, collections

EVENTS, CACHE, OUT = os.environ["EVENTS"], os.environ["CACHE"], os.environ["OUT"]
APPLY = os.environ["APPLY"] == "1"

with open(CACHE) as fh:
    cache = json.load(fh)
entries = cache.get("entries", cache)

# title -> key. The event log records the TITLE (probe_unit has no key), the cache is keyed
# mv:<radarrId> / tv:<sonarrId>:<season>. The cache's own `title` is the join, so this can never
# disagree with what the probe itself believed a unit was called.
by_title = {}
dupes = set()
for key, e in entries.items():
    if not isinstance(e, dict):
        continue
    t = e.get("title")
    if not t:
        continue
    if t in by_title:
        dupes.add(t)          # two units share a title: refuse rather than guess
    by_title[t] = key

# Every probe measurement ever, per title, oldest first.
hist = collections.defaultdict(list)
n_events = 0
for f in sorted(glob.glob(os.path.join(EVENTS, "*.jsonl"))):
    with open(f, errors="ignore") as fh:
        for line in fh:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("e") != "probe_unit":
                continue
            cx, R, ts = e.get("cx"), e.get("R"), e.get("t")
            if not (cx and R and ts):
                continue
            n_events += 1
            hist[e.get("ti")].append({"ts": int(ts) * 1000, "complexity": cx, "R": R})
for v in hist.values():
    v.sort(key=lambda x: x["ts"])

added = 0
touched = 0
skipped_dupe = 0
skipped_nokey = 0
report = []
for title, measurements in hist.items():
    if len(measurements) < 2:
        continue
    if title in dupes:
        skipped_dupe += 1
        continue
    key = by_title.get(title)
    if not key:
        skipped_nokey += 1
        continue
    e = entries.get(key)
    if not isinstance(e, dict) or e.get("error") or not e.get("complexity"):
        continue
    cur_cx = e["complexity"]
    # The CURRENT cached measurement is the newest; every earlier DISTINCT measurement is a prior.
    # Distinctness is on complexity: re-probing the same file yields the same number and is not a
    # data point. Timestamps are matched against anything already banked so this is idempotent.
    have_ts = {p.get("ts") for p in (e.get("priors") or [])}
    fresh = []
    for m in measurements:
        if abs(m["complexity"] - cur_cx) < 1e-9:
            continue                      # this IS the current measurement
        if m["ts"] in have_ts:
            continue                      # already banked
        fresh.append({"ts": m["ts"], "complexity": m["complexity"], "R": m["R"],
                      "from": "events"})  # marks a reconstruction: no probeBitrate/measuredFrom
    if not fresh:
        continue
    priors = sorted((e.get("priors") or []) + fresh, key=lambda p: p.get("ts") or 0)[-6:]
    e["priors"] = priors
    touched += 1
    added += len(fresh)
    oldest = priors[0]
    report.append((title, oldest["complexity"], cur_cx, cur_cx / oldest["complexity"]))

report.sort(key=lambda r: -r[3])
print()
print(f"  {n_events} probe_unit events read; {len(hist)} titles; "
      f"{sum(1 for v in hist.values() if len(v) > 1)} probed more than once")
print(f"  films gaining priors: {touched}    prior measurements recovered: {added}")
if skipped_dupe:
    print(f"  skipped {skipped_dupe} title(s) shared by more than one unit (ambiguous, never guessed)")
if skipped_nokey:
    print(f"  skipped {skipped_nokey} title(s) with no matching cache entry (film since removed)")
print()
if report:
    print(f"  {'film':36s} {'oldest cx':>10s} {'current cx':>11s} {'risen':>7s}")
    print("  " + "-" * 70)
    for t, o, c, r in report[:15]:
        print(f"  {t[:36]:36s} {o:>10.5f} {c:>11.5f} {r:>6.2f}x")
    if len(report) > 15:
        print(f"  ... and {len(report) - 15} more")
    print()

if not APPLY:
    print("  DRY RUN — nothing written. Re-run with --apply to persist.")
    print()
else:
    with open(OUT, "w") as fh:
        json.dump(cache, fh)
    print(f"  staged {OUT}")
PY
rc=$?
[[ $rc -eq 0 ]] || exit $rc

if [[ "$APPLY" == "1" ]]; then
  [[ -s "$OUT" ]] || { echo "nothing staged — aborting" >&2; exit 1; }
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$OUT" \
    || { echo "staged cache is not valid JSON — refusing to install" >&2; exit 1; }
  # The cache is root-owned inside the container's bind mount, and the controller REWRITES it from
  # memory every 5 minutes (setInterval(saveProbeCache)). So stop the controller first, or the
  # in-memory copy — which has no priors — would overwrite this within minutes.
  echo "  stopping controller so its in-memory cache cannot overwrite the backfill..."
  docker compose stop controller >/dev/null 2>&1
  cp "$CACHE" "${CACHE}.bak-$(date +%Y%m%d-%H%M%S)"
  docker run --rm -v /opt/appdata/controller:/c -v "$OUT":/new.json:ro \
    movie-server-controller:latest sh -c 'cp /new.json /c/probe-cache.json && chown root:root /c/probe-cache.json' \
    || { echo "install failed; controller is stopped — start it with: docker compose start controller" >&2; exit 1; }
  docker compose start controller >/dev/null 2>&1
  echo "  installed, controller restarted. Verify with: ./scripts/probe-pairs.sh"
fi
