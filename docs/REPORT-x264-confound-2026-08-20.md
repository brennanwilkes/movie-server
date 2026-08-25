# The x264 confound check — the assumed floor is too small, and the live curve over-corrects

**Date** 2026-08-20 · **Task** #46 (BPP-PLUS.txt open question 1) · **Data**
`data/starve-experiment-x264.json`, `data/starve-codec-floor.json` · **Tools**
`scripts/starve-compare.js`, `controller/scripts/probe-starve.sh --enc libx264`

## The question

The pinning curve `understatement = 1.337 · R^-0.348` was fitted from a starvation experiment whose
starved copies were made with **x265** — and the probe also encodes x265. Re-encoding an x265 file
with x265 is easier than re-encoding an h264 one, because the artefacts are already x265-shaped and
compress well. So some measured "understatement" could be **codec matching** rather than starvation.

A floor of **×1.06** was subtracted for this, estimated from **one film** (Blade Runner 2049 at
level 0.5, barely starved at R > 5, where almost nothing should be attributable to starvation). This
was the last load-bearing unvalidated parameter in the shipped model, and the check that would settle
it had been started and abandoned twice.

## Method

Re-ran the identical experiment with `--enc libx264`: same 8 films, same clips, same levels, same
CRF ladder, only the starving encoder changed. Now the starved copy's artefacts are h264-shaped
while the probe still encodes x265 — no codec match. Whatever understatement survives is starvation.

Two things had to be fixed in the driver first, and both would have produced a **silently fake
result**:

- `select()` re-picks the film set from live `R` on every run, and `R` changed earlier the same day
  when audio came out of it (§5.2a) — so the second arm would have measured a *different* 8 films.
  Fixed with `STARVE_KEYS`, pinning the set by key.
- `--enc` never reached the script: `docker exec` does not inherit host environment, so
  `STARVE_ENC=libx264` on the host would have run **a second x265 arm wearing an x264 label**. The
  encoder is now passed explicitly and echoed back from the script into each stored record.

**The comparison needs no R axis at all**, which matters here. `under = cx20(untouched) /
cx20(starved)` is a ratio of two measurements of the *same clips*, so R, the codec-efficiency
normalisation, and the anchoring step all divide out. The floor estimate is cleaner than the curve
it corrects.

## Validity check — passed exactly

Level 1.0 is copied, never re-encoded, so its `cx20` must be identical between arms. It is, to the
last digit, on all 8 films (0.00% deviation). The two arms measured the same material.

## Result — all 16 matched points

| film | level | x265 (matched) | x264 (unmatched) | ratio |
|---|---|---|---|---|
| Alien (1979) | 0.5 | 1.372 | 1.111 | 1.235 |
| The Social Network (2010) | 0.25 | 1.491 | 1.222 | 1.219 |
| Blade Runner 2049 (2017) | 0.25 | 1.074 | 0.910 | 1.181 |
| Alien (1979) | 0.25 | 1.628 | 1.388 | 1.173 |
| Blade Runner 2049 (2017) | 0.5 | 1.062 | 0.923 | 1.151 |
| Dune (1984) | 0.5 | 1.453 | 1.263 | 1.150 |
| Dune (1984) | 0.25 | 1.756 | 1.544 | 1.137 |
| Django Unchained (2012) | 0.5 | 1.470 | 1.300 | 1.130 |
| Fargo (1996) | 0.5 | 1.415 | 1.254 | 1.128 |
| Requiem for a Dream (2000) | 0.5 | 1.269 | 1.136 | 1.117 |
| The Social Network (2010) | 0.5 | 1.209 | 1.089 | 1.109 |
| Django Unchained (2012) | 0.25 | 1.794 | 1.648 | 1.089 |
| Quantum of Solace (2008) | 0.25 | 1.787 | 1.653 | 1.081 |
| Quantum of Solace (2008) | 0.5 | 1.444 | 1.371 | 1.053 |
| Fargo (1996) | 0.25 | 1.652 | 1.580 | 1.045 |
| Requiem for a Dream (2000) | 0.25 | 1.426 | 1.382 | 1.032 |

**Median 1.1295**, mean 1.127, range 1.032–1.235, bootstrap 95% CI on the median **1.099–1.151**.

**The assumed ×1.06 sits outside that interval.** The codec-matching effect is roughly **twice**
what was subtracted, and every one of the 16 points is above 1.0 — the direction is unanimous.

## Two things that make the result stronger than the headline

**1. The floor really is a constant, which validates the model's shape.** Level 0.5 gives a median
ratio of 1.1295; level 0.25 gives 1.1131. If codec matching were entangled with starvation depth
these would diverge, and subtracting a single number would have been the wrong shape. They agree to
within 0.017 — and note they agree in the direction *opposite* to starvation depth, so this is not
the two effects tracking each other. Subtracting one constant was right; the constant was wrong.

**2. The x264 arm is not just a control — it is the *library-realistic* condition.** 831 of 898
movies on this box are h264. A real starved file is an h264 encode made by a release group, which we
then probe with x265. That is **exactly** the x264 arm. The x265 arm was the artificial one. So the
x264 understatements are not a confound-free comparison to be corrected — **they are the measurement
that should have been fitted in the first place**, and they need no floor subtraction at all.

Note Blade Runner 2049 lands **below 1.0** in the x264 arm (0.910, 0.923): starving a barely-starved
copy with x264 makes the x265 probe measure it as *harder*, because h264 blocking and ringing are
expensive for x265 to reproduce. That is a real effect at high supply, and the live curve already
clamps at 1.0, so it is handled rather than newly broken.

## What it implies for the live constants

Holding `PIN_B` and correcting only the floor:

    live understatement values are too high by  1.1295 / 1.06 = ×1.066
    PIN_A ≈ 1.337 / 1.066 ≈ 1.255     (PIN_B unchanged at −0.348)

Because BPP+ ∝ 1/√target, this means **BPP+ on the corrected films is currently ~3.2% too LOW**.
Direction of the error: the model is *pessimistic*, not flattering — the safe direction, and about
1.5× the size of the audio fix applied earlier today in the opposite direction.

## NOT APPLIED — and why

This changes a constant that touches 994 films, on an experiment that finished minutes ago, while
Brennan is away. Three specific reasons to wait rather than ship:

1. **The proper fix is a refit, not a rescale.** The right move is to fit `A·R^B` on the x264 arm
   directly, since it needs no floor at all. That requires the **anchoring** step — "anchor R to the
   live probe, take only the ratio from the experiment" (§5.1) — and **that procedure is not
   currently reproducible from what is written down.** I could not recover the documented anchored
   span of 0.59–2.27 from any combination of stored values. That is a documentation gap and it blocks
   an exact refit; the ×1.066 rescale above is a defensible interim, not the answer.
2. ~~The 8th film was still running.~~ **Now complete — all 16 points are in and the median moved
   only from 1.134 to 1.1295**, so nothing about the conclusion depended on the missing pair.
3. **It is a model change, not a bug fix.** Brennan's standing rule is that plan approval is not
   action approval.

## Recommended next steps, in order

1. **Write down the anchoring procedure** so §5.1's fit is reproducible. Until then no refit of this
   curve can be verified by anyone, which is a worse problem than the wrong constant.
2. Refit `A·R^B` on the x264 arm with no floor subtraction, and compare against both the ×1.066
   rescale and the live curve before adopting anything.
3. #49 (re-run at 8 samples) gains value now — it would confirm the constants on the arm that
   actually matters, rather than the artificial one.
