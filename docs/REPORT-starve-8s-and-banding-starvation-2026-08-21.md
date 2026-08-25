# Two failures found by the 11:23 check — one experiment lost, one job starved

**Date** 2026-08-21 · Triggered by the scheduled follow-up on task #49.

## 1. The 8-sample starvation arm did not run as scheduled

`scripts/run-starve-8samples.sh` was armed at 23:23 to wait for 06:00. It ran **immediately**.

```sh
while [ "$(date +%-H)" -lt "$WAIT_UNTIL" ]; do sleep 300; done     # WAIT_UNTIL=6
```

At 23:23 the hour is `23`, and `23 -lt 6` is false, so the loop exited at once. The comparison only
waits if you happen to arm it between midnight and 05:59. It reads like "wait until 6am" and is not.

Consequence: it started in the middle of a session in which the controller was being redeployed for
the banding work, and **7 of 8 films died on "container is not running"** — each failing instantly,
banked as a failure, and the run reporting success with one data point. It also overwrote the derived
`data/starve-codec-floor.json` with a 2-point result, clobbering the 16-point one (regenerated from
the intact primary data — only the derived file was lost).

**Both causes fixed.** The wait now resolves an absolute epoch target so it handles the midnight wrap,
and `starve-experiment.js` retries transient docker failures (12 attempts, escalating backoff) while
still failing fast on a real measurement error — a `probe-starve.sh` failure on a file is a result and
must not be retried into looking fine.

**Not re-armed** pending Brennan's call, since it competes with the banding backfill for the same
night budget.

## 2. What the one completed film says about sample count (task #49's actual question)

The Social Network was measured at both 3 and 8 samples per point, so it answers the question weakly
but directly:

| level | 3-sample | 8-sample | change |
|---|---|---|---|
| 0.5 | 1.0894 | 1.0774 | −1.1% |
| 0.25 | 1.2224 | 1.1902 | −2.6% |
| control cx20 | 1,465,453 | 1,454,240 | −0.8% |

**The understatement moves ~1–3%.** For comparison, the codec-floor finding that drove the refit was
a 1.1295 vs 1.06 discrepancy — about 6%, twice as large. On this single film, 3 samples was adequate
and the live constants (A 1.114 / B −0.392, PIN_R_MIN 0.423) would not move materially.

n=1, so this is an indication and not a result. But it lowers the value of re-running the full arm,
which is worth recording either way — the point of #49 was to find out whether 3 samples was enough,
and the one film available says probably yes.

## 3. THE BANDING JOB MEASURED ZERO UNITS OVERNIGHT — my bug

`/api/banding` after a full night: `measured 85, atFullPrecision 0, pending 1045, last: null`. The
night budget was fully spent (243 of 240 minutes) — all of it by the complexity probe, on optional
refinement.

Cause: `probeHasFreshWork()` in probe.js, which banding calls to decide whether to yield:

```js
us.some((u) => !unitMeasured(u) || unitStale(u))      // WRONG
```

`mv:392` (Air, 2023) fails every sample and always will. A permanently-failed unit keeps an ERROR
entry, so it counts as "unmeasured" forever — making this return true every night, so banding yielded
the whole window, every night, silently, with no error anywhere to show for it.

**This is the exact bug `probePhase()` carries a comment warning about**, which was read the day
before this code was written:

> "'Is there first-measurement work left' is NOT `measured < total`: a unit whose probe failed
> permanently (an unreadable file) has an error entry, counts as unmeasured forever, and is never
> selected by nextUnit()... one corrupt film would hide the audio and refine phases from the card
> permanently."

**Fix: ask `nextUnit()` instead of reimplementing the question.** `nextUnit` is the authority on what
the probe will actually do next — it selects `fresh = units with NO cache entry` (so an error entry is
correctly skipped) plus `stale` (which requires `!e.error`). A duplicated predicate can drift from it;
a direct call cannot.

Verified after deploy: `fresh = 0`, `stale = 1`. One genuinely stale unit is real work, clears in a
single ~4-minute pass, after which the condition goes false and banding gets the remaining ~235
minutes. Before the fix it was permanently true.

## The pattern in all three

Every one is the same failure mode: **a predicate or a control that was written from reasoning instead
of from the thing it was supposed to describe.** The hour comparison read like a wait. The fresh-work
predicate read like the probe's queue. Neither was checked against the real behaviour, and both failed
silently rather than loudly. The fixes in each case were to defer to the authority — an epoch
timestamp, and `nextUnit()` itself.
