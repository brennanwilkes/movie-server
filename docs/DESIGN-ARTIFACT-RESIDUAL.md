# The artifact-residual correction — a general framework

**Author** Brennan's idea, developed and tested 2026-08-21 · **Status** framework validated;
shape fully measured, ONE free parameter left; NOT deployed
**Tools** `scripts/banding-correction.js`, `scripts/artifact-shift.js`, `scripts/banding-ladder.js`

## The idea

> At its core BPP+ is saying: is your file big enough to look good. And what does looking good mean
> if not that it's free of bad artifacts? And the more free it is, the less bits it really needs.

That is the whole framework in two sentences, and it is a genuinely different move from anything
tried here before. Three steps:

1. **Predict** how much of an artifact a film *ought* to show, from its content and its bitrate.
2. **Measure** how much it actually shows.
3. The **disagreement corrects the score** — up when the file is cleaner than a copy that size
   should be, down when it is worse.

```
BPP+           = what the file HAS (bpp)      /  what its content NEEDS (complexity)
artifact ratio = artifact MEASURED            /  artifact EXPECTED for a copy this good
```

**It is bidirectional, and that is the point.** This is not a penalty term and not a library-wide
re-anchoring. Measured on 85 films: 36 shift up, 46 down, 3 unchanged. A film that *should* show
stepping and doesn't is evidence the copy is better than the score says.

## Why it is not the same as "add a banding penalty"

An earlier pass tested a different thing and rejected it: *banding reveals a bitrate deficiency, add
it to the denominator.* That failed, and the failure is instructive — raw `bpp` predicts banding
better (−0.684) than BPP+ does (−0.416), because banding is quantisation coarseness set by
**absolute** bits per pixel while BPP+ deliberately normalises by content. So banding cannot be
folded in by adjusting BPP+'s denominator: the denominator is the part that is wrong for banding.

The framework here sidesteps that entirely. It does not touch the denominator. It treats the
artifact as an **independent estimator of the same quantity BPP+ estimates**, and corrects the score
by their disagreement. That inverts a methodology rule from the earlier pass: that one forbade the
expected-model from seeing bitrate (a ratio built on bitrate would divide out the signal it hunted).
**Here, seeing bitrate is the entire mechanism** — the disagreement *with* the bitrate prediction is
the signal.

## The magnitude problem, and how Brennan's second idea solves it

The obvious objection to any correction like this is "how many points?" — and an invented
coefficient is exactly the kind of unfitted constant this project keeps retracting.

> You can compare the ratios at different compressions too, to see how it scales / curves, to predict
> how much to shift BPP+ by. A HUGE swing or just a small one.

This dissolves the problem, because **BPP+ is already denominated in bits.** If a film bands like a
copy carrying `bpp'` rather than the `bpp` it actually carries, then its honest score is the score of
`bpp'`. Once the artifact-vs-bitrate slope is known the conversion is pure arithmetic:

```
S = d log(artifact) / d log(bpp)                       ← MEASURED, not chosen
a log-residual r implies a log-bpp error of  −r / |S|
BPP+ ∝ √bpp, so   Δlog(BPP+) = −r / (2|S|)
shift = BPP+ · (exp(−REL·r / (2|S|)) − 1)
```

Currently `S = −1.7792` fitted across 85 films, so a residual of 1.0 in log space would mean the film
behaves like a copy carrying 57% of its actual bits.

> **SUPERSEDED — read the per-film ladder section below before using this form.** The `1/|S|` scaling
> here is statistically backwards, and the ladder is what revealed it. The corrected form is
> `shift ∝ |S| · r`. This block is kept because the reasoning that produced it is the reasoning a
> reader will arrive at independently, and knowing why it is wrong is the point.

### The reliability shrinkage, which is what makes it safe to extend

`REL` is the split-half reliability of the residual, and it is not decoration. A residual is signal
plus noise; feeding the raw value in would act on the noise as confidently as on the signal. Kelley's
correction says the best estimate of the true residual is `reliability × observed`.

This gives the framework a property that matters enormously for generalising it: **a detector that
turns out to be junk contributes almost nothing, rather than contributing garbage.** New artifacts
can be added without individually vetting them against a subjective label first — the reliability
term does the vetting.

Measured for banding at 4 clips per film: `r(halfA, halfB) = 0.408`, Spearman-Brown `REL = 0.579`.
So 58% of the disagreement is real and 42% is measurement noise.

## What is measured, and what it says

| quantity | value | source |
|---|---|---|
| `S` cross-film | −1.7792 | OLS on 85 films |
| expected-model R² | 0.488 | content + bits |
| residual sd | 1.215 (log) | — |
| `REL` at 4 clips | 0.579 | split-half |
| `REL` at 8 clips | 0.73 | Spearman-Brown projection |
| clips for REL 0.80 | 12 | " |

**Acted on already:** `BANDING_SAMPLES` raised 4 → 8. Single-clip reliability is 0.256, so 7 clips
reach 0.70 and 8 reach 0.73 at only double the cost — and 8 matches `PROBE_SAMPLES`, so banding and
complexity sample the same grid at the same density, which is what makes a per-film comparison
between them fair. Entries measured at 4 clips are re-queued rather than left at mixed precision.

## Why it is NOT deployed

With the constants above, the correction moves **too much**: median |shift| 10.9 points, 30 of 85 at
the ±15 cap, **29 band flips of 85**. And it penalises films that are demonstrably clean:

| film | cambi | library median | shift |
|---|---|---|---|
| 2001: A Space Odyssey | **0.32** | 1.08 | −15 → 126 |
| Gladiator | **0.29** | 1.08 | −15 → 98 |

Both are *low*-banding films taking the maximum penalty. That is not evidence about the films — it
is the expected-model failing to predict them, and the residual absorbing the failure.

**The binding constraint is the expected-model's R² (0.488), not the calibration.** The reliability
shrinkage handles *noise*; it cannot handle *model misspecification*, and unexplained content
variance is being read as quality error. Improving R² shrinks the residual and therefore shrinks
every shift — the correction gets *gentler* as the model gets better, which is the right direction
for a thing that adjusts a score.

## The per-film ladder — run 2026-08-21, and it changes the arithmetic

Brennan's "compare at different compressions" is not just a refinement; running it exposed a
statistical error in the formula above. `scripts/banding-ladder.js` starves each film's clips to
1.0 / 0.7 / 0.5 / 0.35 / 0.25 with x264 (the library-realistic codec) and measures CAMBI at each.

| film | S | R² | vs cross-film |
|---|---|---|---|
| Skyfall (2012) | −1.534 | 0.962 | ×1.16 |
| Confessions of a Dangerous Mind | −0.910 | 0.987 | ×1.96 |
| Goldfinger (1964) | −0.618 | 0.996 | ×2.88 |
| E.T. the Extra-Terrestrial | −0.554 | 0.990 | ×3.21 |
| El Mariachi (1993) | −0.435 | 0.691 | ×4.09 |

**Per-film curves are real and smooth** — R² 0.96–0.996 on four of five. Banding responds to bitrate
monotonically and predictably *within* a film.

**FINDING 1: every per-film slope is flatter than the cross-film slope** (−0.43 to −1.53, mean ≈
−0.81, against −1.78). The cross-film regression overstates banding's bitrate sensitivity by roughly
2.2×. This is the **between-vs-within confound** — the identical lesson the pinning work learned when
observational upgrade pairs disagreed with the controlled starvation experiment. A cross-film fit
mixes "different bitrates" with "different films"; only a ladder holds content constant.

**FINDING 2: the naive `1/|S|` scaling is statistically backwards, and the flat slopes make that
obvious.** The formula above says a given residual implies a log-bpp error of `−r/|S|`, so a *flatter*
responder earns a *bigger* shift. But if banding barely moves with bitrate, then observed banding is
**uninformative** about bitrate — there is no bitrate that would produce that difference. Treating it
as strong evidence is exactly backwards, and it is why E.T. (the flattest responder measured) took
the maximum penalty in the cross-film version.

The correct treatment is inverse-variance weighting. Banding's estimate of log-bpp has variance
`σ_c²/S²`, so its weight is `∝ S²`; multiplying weight by the magnitude `r/|S|` gives

```
shift  ∝  |S| · r          (NOT r / |S|)
```

A steeply-responding film's artifact reading is informative and earns a large correction; a flat
responder's is nearly worthless and earns almost none. That is both statistically right and
physically sensible, and it removes the absurd penalties.

**Where that leaves the calibration.** The *shape* of the correction is now fully determined by
measurement — direction, per-film scaling by `|S|`, and reliability shrinkage. What remains is a
single overall **scale**, which needs the ratio of BPP+'s own error variance to banding's, and that
cannot be had without one subjective anchor. So this went from "an invented coefficient per film" to
**one free parameter for the whole model**, which the forced-choice protocol can pin.

## Flat-area fraction: hypothesis FALSIFIED (2026-08-21)

The section below predicted that flat-area fraction would rescue the expected-model. It was measured
on all 85 films (`scripts/flat-area.js`, sobel-then-threshold, 3s per clip) and it does not.

Its direction is right — correlation with log banding is **+0.379**, positive, so more flat area does
mean more banding. But on LOO error, chosen honestly:

| model | R² | LOO rmse |
|---|---|---|
| **bits only** | 0.468 | **1.2679** |
| bits + cx | 0.468 | 1.2872 |
| bits + cx + luma | 0.477 | 1.2852 |
| old, with `year` | 0.488 | 1.2891 |
| **+ flat, no luma** | 0.499 | **1.2592** |

**Almost all the predictive power is `bpp` alone.** Complexity, luma, flat-area and its variances add
~2% between them. The large penalties on demonstrably clean films largely survive.

`year` is also gone from every model on Brennan's instruction — "I only want to use quantifiable data
points which we can mine from the content itself" — and it was the right call: metadata standing in
for a physical property is exactly the kind of proxy that produced a weak model. Notably it was also
the WORST model by LOO error, so dropping it cost nothing.

### The epistemic problem this exposes, which is the real blocker

**Split-half reliability proves the residual is REPEATABLE. It cannot prove the residual is QUALITY.**
A systematically misspecified model produces repeatable errors too, and the two stories — "this copy
is genuinely better/worse than its bits suggest" and "my model is wrong in a consistent way" —
predict *identical internal statistics*. Nothing measurable inside this library separates them, and
the best content predictor available did not.

**More sampling does not help.** Misspecification is a bias, not a variance. Raising clips per film
fixed the reliability problem (0.579 → 0.73); it makes this one more precisely wrong.

## Two ways out, and the second is better

**(a) External labels.** MSU's CVQAD is downloadable without gating (`deepfakesMSU/CVQAD`, 45
sequences, x264 at 9 bitrates each from 433 to 39,381 kbps, 1080p, Bradley-Terry scores from
*pairwise* comparison plus MOS). Bradley-Terry matters: it measures a difference, unlike the unpaired
MOS that invalidated the 2026-08-13 in-house test. `scripts/cvqad-calibrate.js` runs the decisive
test — does the banding residual predict subjective score *after bits are already accounted for*? If
yes, the regression slope IS the calibration constant. Download in progress (~41 GB).

**(b) PER-FILM CURVES INSTEAD OF A CROSS-FILM MODEL — Brennan's idea, and the stronger route.**
"We have the power to downscale/compress and re-measure." So each film can be its own expected-model,
with no cross-film regression and no labels at all:

```
banding(b) = C + A·b^S        C = the irreducible floor baked into the source
measured − C                 = the part more bits would actually fix
S                            = how many bits it would take
```

Tested on the 5-film ladder. The result is a **useful asymmetry** rather than a clean win:

| film | C (floor) | S | R² | fixable share |
|---|---|---|---|---|
| **Skyfall** | **0.123** | −2.80 | **1.000** | **9%** |
| Goldfinger | 0.084 | −0.64 | 0.994 | 93% |
| Confessions | 0.000 | −0.82 | 0.988 | 100% |
| E.T. | 0.000 | −0.52 | 0.989 | 100% |
| El Mariachi | 0.000 | −0.34 | 0.684 | 100% |

**A downward-only ladder cannot constrain an upward asymptote**, so `C` collapses to 0 for films
still on the steep part. But it IS identified where the curve visibly flattens inside the measured
range — Skyfall, R² 1.000, only 9% of its banding fixable by bits.

That asymmetry is in the useful direction: the floor is knowable exactly for the films where the
answer matters ("this banding is baked in, replacing the file will not help"), and unknowable for
starved films, where the answer is already obvious. **Concrete improvement: a ladder DENSER NEAR
LEVEL 1.0** (1.0 / 0.9 / 0.8 / 0.7) constrains local curvature far better than one spanning down to
0.25, which spends its points where the answer is already known.

### Prior art (searched 2026-08-21)

- **Banding detection** is well covered: CAMBI, and BBAND before it, plus a 2025 survey on
  understanding/detecting/removing perceptual banding in compressed video.
- **Per-title rate-quality curve prediction** is a mature field — convex-hull prediction for bitrate
  ladders, content-adaptive rate-quality curve models, per-shot. **This is the transferable
  machinery**: predicting a title's whole rate-quality curve from content features is close to solved,
  and it is exactly what should replace the weak cross-film regression here.
- **What is NOT published**: relating a banding measurement to a rate-distortion curve in order to
  correct the quality estimate of an *already-encoded* file. Both searches returned the gap
  explicitly. Consistent with the research round's finding that "headroom without a master" is
  unpublished territory — this project's own experiment record is the primary literature.

## The one thing that would most improve it

**Predict expected banding from the fraction of frame area that is flat or near-flat gradient**,
instead of the current proxies (`cxEff`, luma, year). Flat-area fraction is the actual physical cause
of banding-proneness: a film that is 40% smooth sky has a completely different expectation from one
that is all texture, and neither year nor luma captures that. CAMBI's internals already segment flat
regions, and `siti` ships in the same static build.

If content R² rose from 0.15 to ~0.5, the residual would shrink, the shifts would become
proportionate, and the 2001/Gladiator failures should disappear.

## Generalising to other artifacts

The framework is artifact-agnostic. Each candidate needs two things, in order:

1. **A reliability check** (split-half over per-clip readings). Needs *no* subjective label — this is
   the key unlock, because "we have no valid label" has blocked every previous detector.
2. **A measured slope** against bitrate, so the shift has units.

| artifact | detector | status |
|---|---|---|
| banding | CAMBI | validated, REL 0.58 → 0.73 at 8 clips; per-film slope measured on 5 films |
| blocking | `blockdetect` | **now vettable** — per-clip readings emitted from 2026-08-21 |
| blur | `blurdetect` | **now vettable** — same |
| grain loss | complexity vs vintage | untested, and interesting: see below |

`blockMean`/`blurMean` have sat marked UNTESTED for months on the assumption that judging a detector
needs a label. It does not — it needs repeated readings, which `probe-film.sh` computed all along and
then averaged away. That is now fixed: `sampleBlock` and `sampleBlur` are stored and exposed, so both
can be graded by exactly the test that graded CAMBI. This costs nothing; the values were already
being computed.

**Grain fits the framework in the direction people forget.** *Less* grain than a 1974 film should
have is not cleanliness — it is a denoised or generation-lossed source, and that is a quality loss
BPP+ structurally cannot see (it would actually *raise* the score, since a denoised copy measures as
easy content). Same machinery, opposite sign.

### Detector grades, measured 2026-08-25

`scripts/grade-detector.js`, split-half over per-clip readings, Spearman-Brown corrected:

| detector | n | clips/film | split-half | Spearman-Brown | vs complexity | vs BPP+ |
|---|---|---|---|---|---|---|
| `blockMean` | 71 | 9.0 | 0.856 | **0.922** | −0.000 | +0.080 |
| `blurMean` | 71 | 9.0 | 0.367 | 0.537 | −0.233 | −0.009 |
| `cambi` | 247 | 8.0 | 0.643 | 0.782 | −0.208 | −0.347 |
| complexity *(control)* | 256 | 17.7 | 0.915 | 0.955 | — | −0.365 |

**`blockMean` is the most reliable artifact detector we have** — more reliable than CAMBI, which
shipped — and it passes every degeneracy test that can currently be run.

Two things stop that being a promotion:

- **The luma test could not be run.** Only 2 of the 71 units carry a luma reading, because the
  block/blur population (recently re-probed) and the banding population (the nightly backfill) are
  still nearly disjoint. Luma is the precise axis `gShare` died on (−0.885). Incomplete until it runs.
- **Reliability is necessary, not sufficient.** A detector of frame structure would grade just as
  well — films differ consistently in edge content. The discriminating question is whether the
  reading *moves* when bits are taken away, which only a ladder answers. `banding-ladder.js` now
  chains `blockdetect`/`blurdetect` ahead of libvmaf so all three come off one decode.

## The caution — and a blending rule that answers it

Once several corrections exist they must not double-count. Reliability screens each detector
individually; **independence has to be checked pairwise**, or one underlying fault gets penalised
three times over. Blocking, blur and banding all rise together under starvation, so they are very
unlikely to be independent.

Brennan, 2026-08-25, agreeing that winner-takes-it is the right shape but leaving the formula open:
> "each of these artifact detectors adjust/scale/dial the bpp+ #, but how they do it, the blending
> formula we use is up for discussion. Cause yeah some will correlate"

**Proposal: do not blend the residuals. Blend their bit-equivalents.**

Each artifact gives, from the film's own ladder, a level `L` at the operating point and a slope `S`.
Ask one question, in bits:

```
m = (T / L)^(1/S)      "how much bitrate would bring this artifact to its visibility threshold"
```

Then combine as **`m = max` over artifacts**, because the bits have to clear *every* one.

Three properties fall out, and they are the reason to prefer this over a weighted sum:

1. **Correlation becomes harmless.** If blocking and banding both demand 1.4×, the answer is 1.4×,
   not 1.96×. Correlated detectors *cannot* double-count under a max. That is the caution above,
   answered structurally rather than by tuning weights.
2. **Bidirectional for free.** All artifacts below threshold → `m < 1` → the file has more bits than
   it needs → BPP+ shifts *up*. No special case, which was Brennan's requirement from the start.
3. **The units already match BPP+.** BPP+ is `sqrt(bpp/target)`, so a bitrate multiplier converts
   directly — no invented constant, which is the thing this whole line of work has been stuck on.

Measured on the six ladder films (banding only — blocking and blur have no calibrated threshold yet):

```
The Man Standing Next   L 6.042  S -1.30   needs 1.80x more bits
Almost Famous           L 3.483  S -0.18   3.33x  <- but see the fragility below
Swingers                L 8.911  S -0.22   175x   <- unreachable
The Big Sleep           L 0.086  S -2.95   could run at 0.31x — banding not binding
```

**KNOWN FRAGILITY: small `|S|` makes `m` explode.** Almost Famous at −0.18 gives 3.33× and Swingers
at −0.22 gives 175×; that gap is slope noise, not signal. So the rule needs a guard — below some
`|S|`, classify as *baked-in / unreachable* rather than computing a number. Which is the honest
reading anyway: a flat slope means bits will not fix it.

## Reproduce

```sh
node scripts/grade-detector.js       # split-half grade for every detector, no labels needed
node scripts/banding-correction.js   # reliability + precision-by-level
node scripts/artifact-shift.js       # the self-calibrating shift, no free parameter
node scripts/banding-ladder.js       # per-film slopes for banding + blocking + blur, one decode
node scripts/cvqad-calibrate.js      # the external test: does the residual predict subjective score
```
