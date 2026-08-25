# Banding excess as a BPP+ adjustment — right idea, does not survive this data yet

**Date** 2026-08-21 · **Origin** Brennan's proposal · **Tool** `scripts/banding-expected.js` ·
**Data** 85 films with banding + full content context

## The proposal

> "Ideally the amount of banding is a pure number, and we also through characteristics of the film
> come up with the expected amount of banding, then we can see the ratio of measured to expected
> which should indicate where a higher bitrate is needed and as such can be folded into bpp as an
> adjustment factor."

This is structurally the **same move BPP+ already makes**, which is why it deserved a real test:

```
BPP+    = what the file HAS (bpp)  /  what its content NEEDS (complexity)
excess  = banding MEASURED         /  banding EXPECTED from its content
```

Raw CAMBI is not directly actionable — smooth content bands more regardless of bitrate, grain
suppresses banding regardless of starvation. A ratio to expectation would isolate the part bitrate
can fix from the part that is simply what the film looks like.

## Method, and the one rule that makes or breaks it

**The expected model must not see bitrate.** If `expected` is predicted using bpp or R, then
measured/expected has the bitrate signal divided out — it would go quiet exactly where it should
shout, and look like a clean null rather than a circular one. Predictors are content-only: `cxEff`
(pinning-corrected content cost), mean luma, and year as a proxy for capture medium (film grain
dithers, digital sensors do not).

Fitted in **log space** (cambi spans 0.002–7.2, most mass under 1) with **leave-one-out** prediction,
so no film's own reading informs its own expectation.

**Pre-registered test:** does excess correlate with supply *more strongly* than raw banding does?

## Result 1 — the decomposition works, directionally

| against | raw log(cambi) | excess | |
|---|---|---|---|
| supply R | −0.412 | **−0.542** | sharper by 0.130 |
| BPP+ | −0.416 | **−0.528** | sharper by 0.112 |
| bpp | −0.684 | −0.544 | *weaker by 0.140* |

Removing content variance sharpens the supply signal, as predicted. Residuals are clean — excess is
independent of the content it was regressed out of (cxEff −0.004, luma −0.055, year +0.003).

## Result 2 — the finding hiding in that table

**Raw `bpp` predicts banding far better (−0.684) than BPP+ does (−0.416).**

That is not a detail, it is the mechanism. Banding is *quantisation coarseness*, which is set by
**absolute bits per pixel** — not by bits relative to how hard the content is. And the two pull
apart: a grainy film needs many bits to look right (high complexity, so BPP+ normalises them away)
but its grain also **dithers banding away**. So the per-film normalisation that makes BPP+ correct
for adequacy actively works *against* it for banding.

The `cxEff` coefficient flipping sign between the two models says the same thing. Content-only it is
**−0.50** (complex films band less — grain dithers). Holding bpp fixed it is **+0.27** (at equal bits
per pixel, harder content bands *more* — it is more starved). Both are true and they are different
questions.

**Consequence: banding cannot be folded into BPP+ by adjusting BPP+'s existing denominator, because
the denominator is the part that is wrong for banding.**

## Result 3 — why the ratio itself misbehaves

Adding bits to the model raises R² from 0.149 to 0.488 — but the residual standard deviation is
**1.297 in log space**, i.e. a typical film sits within a factor of **3.66** of its prediction.

And a ratio of small numbers is not a signal. At high bpp, expected banding → ~0, so *any* reading
produces a huge ratio. The illustrative adjustment did this:

| film | cambi | vs library median 1.08 | ratio penalty would do |
|---|---|---|---|
| 2001: A Space Odyssey | **0.32** | **below** | BPP+ 141 → 111 |
| Kill Bill: Vol. 1 | **0.67** | **below** | BPP+ 92 → 73 |
| E.T. | 1.91 | above | BPP+ 123 → 97 |
| Fargo | 3.06 | above | BPP+ 109 → 86 |

**2001 has objectively low banding and would take the maximum penalty.** That is the model failing,
not the film. Folding this in today would make scores worse.

## Result 4 — the obvious repair adds nothing

Require *both* high absolute banding **and** positive excess:

- films with cambi ≥ 2.817 **and** positive excess: **16**
- films with cambi ≥ 2.817 alone: **16**
- **the excess guard removes 0 of 16**

Every heavily-banding film in this sample already bands more than expected. So on 85 films, the
expected-model machinery adds **nothing** over the plain absolute threshold that is already shipped.

## What IS confirmed: there is a real gap to close

The equalisation test — a denominator's job is making scores comparable across films, so among films
at similar BPP+, banding should not vary much:

| BPP+ band | n | cambi p10 | median | p90 | spread |
|---|---|---|---|---|---|
| 0–60 | 17 | 0.18 | 1.78 | 4.69 | **25×** |
| 60–75 | 10 | 0.08 | 2.36 | 7.17 | **92×** |
| 75–95 | 31 | 0.12 | 0.92 | 3.01 | **26×** |
| 95–250 | 27 | 0.03 | 0.34 | 2.84 | **101×** |

BPP+ genuinely does not capture banding — which justifies keeping it as a separate axis, and is
exactly why the shipped design reports it beside the score. The gap is real; the residual is just too
noisy to drive an adjustment from 85 films and three proxy features.

## Verdict and the concrete next step

**Keep banding as a separate reported axis. Do not fold it into BPP+ yet.** The blocker is not the
idea — the idea is sound and the decomposition demonstrably sharpens the supply signal. The blocker
is that "expected banding from characteristics" is a **weak model** (R² 0.149 on content alone), so
the ratio inherits noise it cannot afford.

**What would fix it, specifically:** predict expected banding from the thing that physically causes
banding-proneness — **the fraction of frame area that is flat or near-flat gradient** — instead of
proxies like year and luma. CAMBI's own internals already segment flat regions, and ffmpeg has
`siti` (spatial information) in the same static build. A film that is 40% smooth sky has a genuinely
different banding expectation from one that is all texture, and neither `year` nor `luma` captures
that. If R² on the content model rose from 0.15 to ~0.5, the ratio would stabilise and this
conclusion should be revisited.

Two cheaper contributors, both already in motion: the banding job is backfilling 960 more units
(85 → ~1045, a 12× larger sample), and a subjective label from the forced-choice protocol would let
the adjustment coefficient be *calibrated* rather than invented — the illustrative `exp(0.35·excess)`
above is fitted to nothing.

## Reproduce

```sh
node scripts/banding-expected.js      # both models, LOO, the pre-registered test
```
