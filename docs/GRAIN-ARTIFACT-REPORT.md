# Grain as Artifact — Validation Report

**Date:** 2026-08-25
**Purpose:** Adversarial validation of the grain measurement model for BPP+ blending
**Method:** Four parallel research sweeps (academic/technical, detector validation, community, metric inventory) plus adversarial follow-up

---

## What is being validated

The BPP+ model blends banding (CAMBI) and blocking (blockMean) into quality scores. Grainy films don't exhibit these artifacts, so the detectors go silent. The proposal is to add grain-specific artifacts (grain retention, gridRatio, iRatio) as a fourth axis to fill this coverage gap.

Three grain metrics are under consideration:

- **`grainOf()`**: `mean |frame - hqdn3d(frame)|` — the denoising residual
- **gridRatio**: DCT 8×8 block-grid correlation (compression artifacts correlate with grid, grain doesn't)
- **iRatio**: temporal independence (grain is fresh per-frame, compression error is frozen in GOP)

---

## Verdict: grain loss IS a real artifact — but the current measurement is flawed

**The direction is right. The implementation is not.**

---

## PART 1 — WHAT THE RESEARCH CONFIRMS

### 1.1 Grain loss is a real, visible, industry-recognized artifact

| Evidence | Source |
|----------|--------|
| Grain content costs 2× more bitrate to encode directly | Sonnati, 2026 ([source](https://sonnati.wordpress.com/2026/06/30/film-grain-synthesis-the-most-disruptive-yet-underrated-encoding-technique/)) |
| Netflix: 31.6% avg bitrate savings from grain synthesis across ~300 titles | Netflix tech blog, 2025 |
| x265 `--tune grain` exists because default encoding smooths grain away | [x265 docs](https://x265.readthedocs.io/en/stable/presets.html) |
| Community consensus: grain loss produces "waxy," "plastic" appearance | Doom9, AVS Forum, r/4kbluray (multiple threads) |
| "Gain of Grain" (ACM MHV 2024): VVC FGS at low bitrates shows visible grain loss | [ACM DL](https://dl.acm.org/doi/10.1145/3638036.3640805) |
| AV1 spec mandates decoder support for grain synthesis — industry consensus that grain matters | [AV1 spec](https://aomediacodec.github.io/av1-spec/av1-spec.pdf) |

### 1.2 Grain masks banding — but weaker than claimed

Norkin (DCC 2026, Netflix): *"The synthesized grain does not completely conceal the banding artifacts in the background area... banding artifacts are usually more visible during the video playback since the grain is temporally uncorrelated, while the banding artifacts are often somewhat static."* ([source](https://norkin.org/pdf/DCC_2026_FGS_with_debanding.pdf))

The masking is real but partial, and degrades during playback. The AV2/AVM spec added debanding to the grain synthesis step *because* grain removal exposes banding ([Norkin, DCC 2026](https://norkin.org/pdf/DCC_2026_FGS_with_debanding.pdf)). Sonnati confirms grain is a "high-frequency masking mechanism" for blocking, banding, ringing, contouring.

### 1.3 The covering-set principle is sound in theory

12-film ladder test: zero films where nothing moved at 0.7× bits. Something always fires (HANDOFF-2026-08-25 §3.8). The Man Who Knew Too Much (grainiest film in the set) sits at 19% of the banding threshold after a 30% bit cut — banding is structurally silent, and a grain-specific detector never fires because none exists.

### 1.4 19 existing grain quality metrics exist

The claim "no standard grain-quality metric" is wrong. Key findings:

| Metric | What it measures | Properties | Source |
|--------|-----------------|------------|--------|
| **GPQA** | Repetitive grain pattern detection in FGS | SRCC 0.853, outperforms avg human observer (0.780) | SMPTE 2024 ([source](https://assets.swoogo.com/uploads/4658000-674097026d986.pdf)) |
| **JVET-AF0209** | Frequency-domain grain quality, masking-weighted | Standards-track (JVET), higher subjective correlation than VMAF/PSNR | InterDigital, 2023 ([arXiv:2407.12465](https://arxiv.org/abs/2407.12465)) |
| **NR-XVS** (IMAX) | No-reference perceptual quality (DNN) | 0-100 scale; Netflix measured 5-6pt improvement (above JND) for FGS | Streaming Media Global, 2024 |
| **TSIM** (SSIMWAVE/IMAX) | Texture similarity, grain-position-invariant | VMAF collapses to 8.55 with shifted grain; TSIM = 92/100 | SMPTE 2024 |
| **Lisson JND** (Kodak/RIT) | Perceptual granularity threshold | 6-7% granularity change = 1 JND | RIT thesis ([source](https://repository.rit.edu/cgi/viewcontent.cgi?article=5205&context=theses)) |
| **SFGA** (Dolby/InterDigital patent) | Frequency-domain grain measurement via steerable pyramid | Patent-protected; explicitly addresses PSNR/SSIM failure on grain | US Patent 16/859,830 |

**Critical caveat:** All 19 evaluate **grain synthesis quality** (is the re-grained output faithful?), not **grain loss under compression** (has the encoder destroyed grain?). These are different questions. No published metric specifically measures grain loss visibility.

---

## PART 2 — WHAT THE ADVERSARIAL ANALYSIS INVALIDATES

### 2.1 `grainOf()` is fundamentally flawed — flat-region masking is mandatory

The metric computes `mean |frame - hqdn3d(frame)|` across the **entire frame**. Every published grain estimation system requires flat-region masking first:

- Norkin (AV1, 2018): *"Estimation should be based on smooth regions since high frequency components from edges and textures adversely affect estimation"*
- Style-FG (ACM TOMM, 2025): *"Poor edge detection results in biased scaling. Undetected edges cause textured blocks to be considered flat. Thus the high frequency of undetected edges is confounded with that of grain"*
- FGA-NN (InterDigital, ICIP 2025): *"Accuracy of conventional methods is highly dependent on denoising and edge detection processing"*
- MPEG-2 patent (Gomila, US8213500): uses multi-layer edge detector, denoises only non-edge regions

**hqdn3d is a low-pass filter, not edge-preserving.** The spatial filter smears edges (causal left-to-right, top-to-bottom recursion creates asymmetric impulse response). The residual contains:

```
residual = grain + fine_texture_removed + edge_smearing + temporal_misalignment
```

**Severity: Fatal for absolute grain measurement.** Without flat-region masking, you cannot separate these components. For the bitrate ladder (same scenes, same clips, different bitrates), texture/edge contamination cancels in the ratio — so the *slope* may still be valid. But the *level* is meaningless across films.

### 2.2 The relevance gate's premise is partially wrong

Three compounding attacks:

**CAMBI handles dithering by design.** CAMBI's 2×2 LPF was specifically added because "dithering has been shown to significantly affect banding visibility" (Tandon et al., PCS 2021). CAMBI checks low-contrast steps (k=1,2) where dithered banding appears. A grainy film reading zero CAMBI may genuinely have no banding — not "banding masked by grain."

**CAMBI's texture mask may exclude grainy regions entirely.** CAMBI has a gradient threshold `τ_g` that excludes textured regions. Grain IS texture. CAMBI=0 on a grainy region could mean "we didn't look" (mechanical zero), not "no banding" and not "banding masked."

**Grain is often absent in the compressed domain.** CAMBI analyzes the decoded frame. If the encoder quantized away grain (typical above CRF 25+), CAMBI sees a grain-reduced signal where masking doesn't apply. The gate confuses two different grain states: (1) grain present in source but absent in compressed version (no masking happens), and (2) grain present in final playback (synthesis adds it back).

### 2.3 The covering set argument is oversold

- Only **1-2 named films** are demonstrably affected by the gap (Easy Rider is the strong case)
- Easy Rider's problem may be **grain boiling** (blockMean at 96th percentile), not grain loss — blocking already detects boiling
- The grain gate (`complexity ≥ 0.30 && R ≤ 1.0`) already addresses the scoring gap using existing measurements
- A grain detector would tell you the same thing the grain gate already tells you, more expensively

### 2.4 Grain cannot have a universal threshold

CAMBI's threshold (2.817) works across all films because zero banding means "no banding" regardless of content. Grain retention is inherently content-dependent:

- A grainless CGI film has near-zero `grainOf` at all bitrates
- A grainy 35mm film has high `grainOf` at full bitrate, dropping under starvation
- The same value means "no grain to begin with" on one film and "grain destroyed" on another

No single threshold works across films. Unlike banding (where the artifact is the signal), grain retention measures the *presence of content* — a fundamentally different quantity.

### 2.5 The directionality is inverted

Banding/blocking go UP as bits come off (more artifact). Grain retention goes DOWN (less grain). The blending formula `(T/L)^(1/S)` assumes "above T = bad." For grain, "below T = bad." This requires either inverting the formula or redefining the threshold — neither has been done.

---

## PART 3 — WHAT REMAINS VALID

| Component | Status | Evidence |
|-----------|--------|----------|
| **GridRatio** (DCT grid correlation) | Sound, at n=2 | Published blocking detection via DCT harmonics is well-established (Qadri & Ghanbari 2014, Kodak patent). Easy Rider reads 1.087 against baselines of 1.165 (artifacts) and 0.995 (clean). |
| **iRatio** (temporal independence) | Sound in principle | Frame-difference noise estimation is standard (MPEG TMIV proposal, Samsung patent US 7,714,939, Li et al. 2023). Key requirement: restrict to static regions (`find-static-bright.js` already does this). |
| **Ladder slopes for grain** | Potentially valid | Same-scenes-same-clips different-bitrates: texture/edge contamination cancels in the ratio. The *slope* may survive even if the *level* doesn't. |
| **The coverage gap exists** | True but narrow | Grainy films DO have fewer detectors firing. But only 1-2 films demonstrably suffer, and the grain gate already annotates them. |
| **GridRatio + iRatio as discriminators** | The strongest path | Both are spatially/temporally principled. GridRatio distinguishes grain from compression artifacts; iRatio distinguishes grain (fresh per-frame) from compression error (frozen in GOP). Both are complementary to grainOf(). |

---

## PART 4 — RECOMMENDATIONS

1. **Add flat-region masking to `grainOf()`** before any other change. Use covariance eigenvalue analysis or Canny edge detection to exclude edges/texture. This is universal in the literature and is the single highest-value fix.

2. **Prioritize gridRatio and iRatio over `grainOf()`** as the grain artifact detectors. Both are more principled (spatial/temporal discriminators rather than denoising residuals), both are complementary to each other, and both have published support.

3. **Use per-film normalization** (grainOf at lossless ÷ grainOf at current bitrate) rather than a universal threshold. This sidesteps the content-dependence problem.

4. **The grain gate is the right tool for the immediate gap.** Before grain-specific detectors are calibrated, the existing gate (`complexity ≥ 0.30 && R ≤ 1.0`) annotates grainy starved content using measurements that already exist.

5. **Calibrate blocking threshold from CVQAD first.** Blocking is the stronger detector (grades 0.922, responds on every film, R² 0.86), has a calibration path (CVQAD), and covers more of the library than grain will. The covering-set gap is narrower than framed.

6. **Do not add grain to the blending formula until a visibility threshold exists.** The formula needs `T`; for grain, `T` is content-dependent and has no published calibration. GridRatio and iRatio at n=2 are directions, not results.

---

## KEY CITATIONS

| Paper | Key finding | URL |
|-------|-------------|-----|
| Norkin & Birkbeck, DCC 2018 | AV1 grain synthesis: 3.8× bitrate savings | [PDF](https://norkin.org/pdf/DCC_2018_AV1_film_grain.pdf) |
| Norkin, DCC 2026 | Grain only partially masks banding; debanding needed | [PDF](https://norkin.org/pdf/DCC_2026_FGS_with_debanding.pdf) |
| Menon et al., MHV 2024 | "Gain of Grain": FGS at low bitrates, PSNR/SSIM unsuitable for grain | [ACM DL](https://dl.acm.org/doi/10.1145/3638036.3640805) |
| Zeng et al., ACM TOMM 2022 | Grain-aware quality framework; different viewer groups perceive grain differently | [DOI](https://doi.org/10.1145/3510450.3517293) |
| Davidovic et al., SMPTE 2024 | GPQA: grain pattern quality, SRCC 0.853 | [PDF](https://assets.swoogo.com/uploads/4658000-674097026d986.pdf) |
| Meng et al., JVET-AF0209 | Frequency-domain grain metrics, standards-track | [arXiv](https://arxiv.org/abs/2407.12465) |
| Ameur et al., ICIP 2025 | FGA-NN: neural grain analysis; denoising residual is unreliable | [DOI](https://doi.org/10.1109/icip55913.2025.11084309) |
| Style-FG, ACM TOMM 2025 | Flat-region masking mandatory; edge contamination is fatal | [ACM DL](https://doi.org/10.1145/3712592) |
| Tandon et al., PCS 2021 | CAMBI: dithering accounted for via 2×2 LPF | [arXiv](https://ar5iv.labs.arxiv.org/html/2102.00079) |
| Sonnati, 2026 | Grain as high-frequency masking; FGS workflow | [Blog](https://sonnati.wordpress.com/2026/06/30/film-grain-synthesis-the-most-disruptive-yet-underrated-encoding-technique/) |
| Qadri & Ghanbari, 2014 | Blocking detection via DCT harmonics | Published (IEEE) |
| Lisson, RIT/Kodak | 6-7% granularity change = 1 JND | [Thesis](https://repository.rit.edu/cgi/viewcontent.cgi?article=5205&context=theses) |
