# Does quality plateau? — Lawrence of Arabia, measured 2026-08-01

Run because the BPP+ scale asserts that 100 is "enough" and 150+ is "more than the
projector can resolve", and **the earlier SSIM test only reached 124 BPP+** — it
never actually tested the range the top of the library occupies (138–394 BPP+).

Method: a 45 s grain-heavy 70 mm stretch (01:12:00), CRF-10 near-lossless
reference, re-encoded at 3/5/8/12/16 Mbps, SSIM measured both at native 1080p and
downscaled to the projector's real 1280x720 panel. Distortion = 1 − SSIM.

| Mbps | BPP+ | SSIM @1080p | SSIM @720p | distortion @720p | gain vs previous |
|---|---|---|---|---|---|
| 3 | 46 | 0.980623 | 0.984630 | 0.01537 | — |
| 5 | 77 | 0.982753 | 0.986987 | 0.01301 | 15% |
| 8 | 123 | 0.984984 | 0.989186 | 0.01081 | 17% |
| 12 | 185 | 0.987626 | 0.991305 | 0.00870 | 20% |
| 16 | 247 | 0.990410 | 0.993249 | 0.00675 | 22% |

## Result: NO PLATEAU. The opposite, in fact.

Each step improves *more* than the last (15% → 17% → 20% → 22%) right up to
247 BPP+. On this content there is no measurable point where extra bitrate stops
buying SSIM.

**Why:** film grain is essentially noise. It is incompressible and consumes bits
close to linearly, so the encoder keeps finding uses for them until it approaches
lossless. This scene's CRF-10 reference is **32.7 Mbps = 507 BPP+**.

## This corrects an earlier claim in this directory

An earlier pass computed a CRF-18 equivalent for Lawrence of **82 BPP+** and
concluded the 253 BPP+ file was "3.1× more than it needs". That came from a single
*easy* scene (00:45:00, CRF-12 reference 10.6 Mbps). This harder scene gives a
CRF-18 equivalent of **~203 BPP+** — making the same file only ~1.25× over.

**Scene complexity varies 2.4× within one film.** Any per-title number derived from
one sample is unreliable, including both of the above. A real per-title figure
needs several samples across the runtime — that is the CRF-18 probe on the TODO.

## The caveat that matters most

**SSIM systematically over-rewards grain preservation.** It scores pixel-level
similarity, so an encode that reproduces the grain *pattern* scores higher than one
that smooths it — even where a viewer would not notice, or would prefer the
smoother image. On grain-heavy film SSIM will therefore always favour more bitrate.

So this table is an **upper bound on how much bitrate could matter**, not evidence
that the difference is visible on a 480-lumen 720p projector. It does not prove
253 BPP+ is justified; it only removes the claim that it is provably wasted.

**Q8 (an A/B viewing test on the actual wall) is now the only thing that can settle
this.** It has moved from "nice to have" to the single highest-value open question,
because the scale's upper boundary rests on it.

## What this does and does not change

- **Does not change** the 100 anchor. It remains bracketed by real CRF-18
  measurements (82 and 203) and is a reasonable global default.
- **Does change** the confidence with which purple can be called waste. On
  grain-heavy pre-1990 film, 150–250 BPP+ may be doing real work.
- **Reinforces** that intent belongs in the quality profile, not in the colour: a
  grainy film you care about belongs on `Beloved`, where purple is the target.


---

## Round 1 (earlier the same day) — 2 / 4 / 8 Mbps, two films

Moved here from `FINDINGS-2026-08-01.md` when that file was trimmed. Different scenes and a
lower range than the run above, so it is separate evidence, not a duplicate. Same caveat
applies and applies harder: SSIM over-rewards grain reproduction.

I encoded 60 s of real library content at 2 / 4 / 8 Mbps and measured SSIM against
a near-lossless reference, **twice**: once at native 1080p, once downscaled to the
projector's actual 1280x720 panel. Distortion = 1 − SSIM, so lower is better.

| | @2 Mbps | @4 Mbps | @8 Mbps | 2M vs 8M |
|---|---|---|---|---|
| Lawrence of Arabia, judged at 1080p | 0.01447 | 0.00959 | 0.00512 | **2.83×** |
| Lawrence of Arabia, judged at 720p | 0.01065 | 0.00699 | 0.00381 | **2.80×** |
| White Chicks, judged at 1080p | 0.03557 | 0.02605 | 0.01774 | 2.00× |
| White Chicks, judged at 720p | 0.03055 | 0.02109 | 0.01339 | 2.28× |

**Downscaling to 720p cuts absolute distortion by ~26%, but leaves the
proportional penalty for low bitrate essentially unchanged.** So the answer to
"is our hardware so bad it doesn't matter" is **no**. The projector lowers the
ceiling — past roughly 8 Mbps at 1080p you are buying very little — but it does
not rescue a 2 Mbps file. Bitrate still matters, right where you're weakest.

Two honest caveats: SSIM is a weak proxy for perceived quality, and the
cross-title comparison is confounded by scene selection (the CRF-12 reference for
White Chicks came out at 24.5 Mbps vs 10.6 for Lawrence — the modern comedy was
the *harder* encode at those scenes, the opposite of my prior). Only the
within-title, across-view result is trustworthy. It is also the one that matters.

**And: bitrate is not dominated by format.** Format decides one binary thing here —
HEVC Main10 forces a transcode, everything else direct-plays. Within the
direct-play set, which is 78.7% of files, codec choice affects *efficiency*
(HEVC needs ~55% of the bits) but bitrate decides *quality*. They are separate
questions and the UI should stop conflating them.
