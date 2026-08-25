# The "grainy and under-provisioned" gate — measured, defined, not yet shipped

**Date** 2026-08-20 · **Task** #52 · **Source** `docs/research-2026-08-19/05-grain-contrast.md` P6 ·
**Data** `/api/probe/dataset`, 898 movies, after the audio fix AND the pinning refit

## Why a gate and not a term

BPP+ is *bitrate adequacy per content*, and on grain it is correct by construction: grain **is**
screen content, it genuinely costs bits, and a grainy 1080p file therefore *should* score lower at
equal bitrate. That was settled in `REPORT-grain-2026-08-13.md` and re-confirmed by the
per-film-denominator sign flip. No grain term belongs in the score — that would be the PSNR error
in reverse, and it has no valid label to fit against.

But there is a real reporting failure that is not a scoring failure. A red band on a grainy
catalogue title reads as *"replace this"*, when for several of these films **no better copy exists
on the market**. The number is right; the implied action is wrong. That is exactly what a gate is
for — annotation beside the score, never inside it.

## The measured population

Rule: `complexity >= 0.30` (grain-heavy — roughly 3× the library median of 0.11) **and** `R <= 1.0`
(below its own transparency target).

**All 26 films at complexity ≥ 0.30 qualify.** The maximum R in the whole group is **1.066**
(Citizen Kane, the single film above 1.0). Bands: **18 bad, 8 warn, zero ok, zero wow.**
Median BPP+ 67.5.

*(Figures below are post-refit — the 2026-08-20 pinning refit lifted this whole group without
moving any of it past warn, which is itself the point: a re-weighting cannot manufacture bits.)*

| BPP+ | band | complexity | R | source | title |
|---|---|---|---|---|---|
| 34 | bad | 0.634 | 0.18 | Bluray-1080p | Killer of Sheep (1978) |
| 36 | bad | 0.310 | 0.21 | WEBDL-1080p | Happy Gilmore 2 (2025) |
| 36 | bad | 0.333 | 0.24 | Bluray-1080p | Sympathy for Mr. Vengeance (2002) |
| 42 | bad | 0.425 | 0.27 | Bluray-1080p | Autumn Sonata (1978) |
| 44 | bad | 0.373 | 0.30 | Bluray-1080p | Detachment (2011) |
| 44 | bad | 0.376 | 0.31 | Bluray-1080p | The World's Fastest Indian (2005) |
| 46 | bad | 0.351 | 0.33 | Bluray-1080p | Schindler's List (1993) |
| 47 | bad | 0.332 | 0.35 | Bluray-1080p | Flow (2024) |
| 48 | bad | 0.677 | 0.35 | Bluray-720p | City of Men (2007) |
| 48 | bad | 0.317 | 0.37 | Bluray-1080p | Following (1999) |
| 57 | bad | 0.436 | 0.49 | Bluray-1080p | The General (1926) |
| 67 | bad | 0.303 | 0.61 | Bluray-1080p | The Bridge on the River Kwai (1957) |
| 67 | bad | 0.343 | 0.61 | Bluray-1080p | Indiana Jones and the Last Crusade (1989) |
| 68 | bad | 0.373 | 0.62 | Bluray-1080p | Taxi Driver (1976) |
| 69 | bad | 0.432 | 0.68 | Bluray-1080p | sex, lies, and videotape (1989) |
| 72 | bad | 0.927 | 0.67 | **Remux-1080p** | **12 Angry Men (1957)** |
| 72 | bad | 0.318 | 0.68 | Bluray-1080p | On the Waterfront (1954) |
| 74 | bad | 0.335 | 0.70 | Bluray-1080p | All Quiet on the Western Front (1930) |
| 75 | warn | 0.315 | 0.72 | Bluray-1080p | Sabrina (1954) |
| 75 | warn | 0.331 | 0.72 | Bluray-1080p | Harakiri (1962) |
| 78 | warn | 0.327 | 0.75 | Bluray-1080p | Mad Max: Fury Road (2015) |
| 80 | warn | 0.450 | 0.78 | SDTV | Beach Party (1963) |
| 85 | warn | 0.356 | 0.86 | Bluray-1080p | Stalag 17 (1953) |
| 87 | warn | 0.365 | 0.89 | Bluray-1080p | Key Largo (1948) |
| 89 | warn | 0.375 | 0.91 | SDTV | Casino Royale (1954) |
| 99 | warn | 0.366 | 1.07 | Bluray-1080p | Citizen Kane (1941) |

## What the table actually says

**1. The score is not malfunctioning — the library is genuinely starved on exactly this class.**
There is no grain-heavy film on the box that is adequately provisioned. This is the strongest
available evidence for open-question-2 reading (a): the median of 64 reflects a starved library, not
an anchor set too high. It also predicts something checkable — the 1080p projector will make these
26 the *most* visibly deficient films in the collection, because they are simultaneously the most
expensive content and the least supplied.

**2. `12 Angry Men` is the case that proves the gate is needed.** Complexity **0.927** — the
library maximum, 8× the median — on a **Criterion Remux**, the best commercially available transfer
of that film, and it still reads BPP+ 72, in the red. Taxi Driver at 68 is the same story.
Without an annotation the Audit tab is telling Brennan to replace discs that cannot be improved.

**3. Mad Max: Fury Road and Flow are the counter-examples worth noticing** — modern, digital,
deliberately textured rather than photochemically grainy, and genuinely upgradeable. So the gate
must **annotate, never suppress**: it says "expensive content, and this is what the market has",
not "ignore this row".

## Proposed rule

```
grainStarved = complexity >= 0.30 && R <= 1.0
```

Both terms already exist per row; nothing new is measured. Rendered as a short annotation beside
the band (`grainy · expensive content`), it changes no score and no ordering.

Thresholds are deliberately round rather than fitted. 0.30 is ~3× the library median and there is a
natural break in the data below it; 1.0 is the definition of transparency, not a tuned value. With
no valid subjective label anywhere in this library, a fitted threshold would be false precision.

## Status: NOT SHIPPED, deliberately

The rule and the population are settled. The **UI** is not mine to decide: the controller tab is
mobile-first by design and Brennan is specific about clutter there — his standing instruction is
that extra numbers belong "behind the scenes, in analysis, in reports", with one corrected number
on the tab. An annotation beside the band is a judgement call about that tab, so it waits for him.

What is shipped: this measurement, and the rule written into `BPP-PLUS.txt §10` as a defined,
computable gate that is not yet rendered.
