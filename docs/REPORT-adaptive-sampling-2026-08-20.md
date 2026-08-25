# Adaptive sampling — FALSIFIED

**Date** 2026-08-20 · **Task** #48 · **Tool** `scripts/replay-sampling.js` · **Data**
`docs/replay-sampling.json` · **Cost** zero encodes, ~2 min of CPU

## The proposal

From `docs/research-2026-08-19/08-innovations.md` idea C, ranked #2 of the innovation round.
Every unit gets exactly `PROBE_SAMPLES` (8) clips regardless of what the measurement is for. But
the score feeds decisions with known boundaries — the band edges at BPP+ 75 / 100 / 125. A unit
whose 4-sample interval is nowhere near a boundary does not need 8 clips; a unit straddling one
deserves more. Start at n=4, stop when the interval cannot cross an edge, else keep sampling. Wall
time saved on the easy units buys more units per night inside the same thermal budget — the report
estimated roughly a doubling of throughput.

## The pre-registered decision rule

> If a 4-sample estimate lands in a different BAND than the full-sample estimate materially more
> than ~1% of the time, the fixed grid is buying decision safety and the idea dies.

Stated in the source before the run, so it could not be fitted afterwards.

## Method

196 units carry their individual readings (`sampleCx`), so a smaller probe is simulated by drawing
subsets and re-deriving the whole chain: mean → cxEff → target → BPP+ → band. **Every** subset of
each size is enumerated, not sampled (C(8,4)=70 per unit, 443,360 stop-decisions in total at n=4),
so these figures are exact for the readings held.

Duplicates are dropped first, by `samplePos`. Before 2026-08-18 a revisit re-encoded the same
offsets, so pooled entries hold byte-identical repeats and 24 units still do; drawing subsets from
those would understate the spread — the same error the 2026-08-19 cache repair removed.

**The honest limitation.** A real n=4 probe samples at *different offsets* than an n=8 one:
`probe-film.sh` puts clip *i* at `S + SPAN*(i+phase)/N`, so N is in the denominator. A subset of 8
existing readings is therefore not a simulation of a 4-clip probe — it is the sampling error of a
4-clip mean drawn from the same scene distribution. That is the quantity a stopping rule depends
on, so the replay is decision-relevant; it is not a grid simulation and is not claimed as one.

## Result 1 — a blind cut fails, as expected

| subset n | band flips | median worst Δ BPP+ | p90 worst Δ | units never flipping | units flipping >10% |
|---|---|---|---|---|---|
| 2 | 20.2% | 27 | 61 | 54 / 196 | 106 |
| 3 | 15.9% | 22 | 52 | 68 | 91 |
| **4** | **13.2%** | **20** | **46** | **78** | **76** |
| 5 | 11.1% | 17 | 44 | 90 | 70 |
| 6 | 9.5% | 15 | 41 | 101 | 59 |

13.2% at n=4 is **13× the pre-registered threshold**. A median *worst-case* error of 20 BPP+ points
is a band and a half. This much was expected — a blind cut is not the proposal.

The structure the idea predicted is genuinely there, though:

- units within 10 points of a band edge (n=83): flip rate **26.7%**
- units more than 25 points from any edge (n=33): flip rate **exactly 0**

So the information the rule wanted to exploit does exist. The question is whether the rule can see it.

## Result 2 — the rule cannot see it, and this is what kills the idea

The proposal is not a blind cut; it is *stop early only when the interval is clear of every edge*.
So the number that decides it is not the flip rate but

    P(band was wrong | the rule said it was safe to stop)

computed with the **subset's own** standard deviation, because that is all a stopping rule would
have had at the time.

| subset n | rule stops | **wrong when it stopped** |
|---|---|---|
| 2 | 51.7% | **14.2%** |
| 3 | 50.7% | **11.2%** |
| **4** | **52.5%** | **13.3%** |
| 5 | 54.5% | **16.0%** |
| 6 | 55.5% | **17.8%** |

At n=4 the rule stops on 52% of draws and is wrong **13.3%** of those times — against a blind flip
rate of 13.2%. **The rule has no discriminating power whatsoever.** Filtering by "the interval is
clear of the edges" selects a subpopulation no more reliable than the whole.

**And it gets worse with more data, which is the real finding.** From n=2 to n=6 the blind flip rate
falls monotonically (20.2% → 9.5%) while the rule's error rate *rises* (14.2% → 17.8%). The
mechanism: more samples shrink the estimated standard error, so the interval narrows, so the rule
declares itself safe more often (51.7% → 55.5%) — but the underlying variance estimate is still
built from a handful of readings drawn from a distribution with up to 8× within-film scene spread.
The rule grows more confident faster than it grows more correct. **A stopping rule that is
confidently wrong is worse than no rule**, because it removes the samples that would have caught it.

## Verdict — DEAD, and not repairable by tuning n

Both tests fail, and the second fails in a direction that cannot be fixed by choosing a different
n, a wider z, or a different edge margin:

- widening the interval makes the rule stop less often, which removes the throughput gain that was
  the entire point;
- narrowing it makes the error rate worse;
- there is no n in 2–6 where the rule is even *better than chance*.

The root cause is that **a 4-to-6-sample variance estimate is not usable** on this content. Report
09 found the same thing from the other side: `cxRSE` correlates with `spreadRatio` at +0.458 and
with complexity at only −0.129 — precision here is limited by within-film scene variance, not by
film type, and scene variance is exactly what a small sample cannot pin down.

## What survives

1. **The fixed 8-sample grid is doing real work.** It was inherited rather than justified; it is now
   justified. Do not lower `PROBE_SAMPLES`.
2. **The near-edge / far-from-edge asymmetry is real** (26.7% vs 0%). It cannot drive a *stopping*
   rule, but it can drive a *spending* one: units far from every edge could be deprioritised in the
   refine queue in favour of units near one. That is the surviving corner of the idea and it is
   ordering, not truncation — no measurement is skipped, so a bad variance estimate costs nothing.
   Untested; a candidate for `nextUnverified`'s ordering, which today uses `spreadRatio` alone.
3. **The replay harness itself** (`scripts/replay-sampling.js`), which can now answer any
   "what if the probe had done X" question over stored readings for free.

## Reproduce

```sh
node scripts/replay-sampling.js --n 4          # writes docs/replay-sampling.json
for n in 2 3 4 5 6; do node scripts/replay-sampling.js --n $n --out /tmp/r-$n.json; done
```
