# 01 — External published exponent/bound for `a` in `BPP+ = 100·sqrt(bpp / (complexity^a · headroom))`

**Research log — 2026-08-28. Agent: external-evidence angles (a)–(e). Web-only; nothing
downloaded, no files modified. Companion to `README.md` §5/§6 (the `log t_j = a·log c_j + k`
anchor regression and its estimator) and to `02-rd-slope-name.md` — be careful not to conflate
the two slopes:** `02` is the *rung spacing* `d ln(bitrate)/d CRF ≈ −ln2/6 ≈ −0.1155/point`
(how bitrate changes as you move up the ladder of one title); **this file is the *rung
position* trend across titles — the exponent `a` of `t_j ∝ c_j^a`, where `t_j` is the anchor
(transparent/tolerated) bitrate of film *j* and `c_j` its probe complexity (x265 CRF-20 bpp).**

Tag legend: [SOLID] verified directly against source/primary paper / [DIRECTION] reasonable
path, numeric not yet pinned / [UNTESTED] plausible, unconfirmed / [DEAD].

---

## 1. TL;DR — the single most defensible external bound on `a`

**For compression-friendly (digital-capture, low-grain) film content the answer is the only
`a`-value with a real published anchor, and it is SUB-LINEAR: `a ∈ [0.4, 1.0]`, conservative
point estimate `≈ 0.6`, with the strongest number being an UPPER bound, `a ≤ 1`, derivable two
independent ways:**

1. **RD theory (exact, memoryless Gaussian, squared error):** `R(D) = ½·log₂(σ²/D)`, so the rate
   at a fixed perceptual anchor is **additive in rate, not multiplicative**: `t = c + Δ`. The
   local power exponent is `a_local(c) = d ln t / d ln c = c/(c+Δ) ∈ (0,1)`. Over our measured
   8.1× complexity range (0.044–0.351, median 0.124) that yields a single-fitted `a` in roughly
   **0.5–0.8 with residual curvature — strictly below 1.** [SOLID form; DIRECTION numeric]
2. **The encoder's own complexity→rate laws (verified in source today):** x264/x265 embed
   `1−qCompress = 0.4` (default qCompress 0.6) in `rate_factor_constant = pow(baseCplx,
   1−qCompress) / qp2qscale(rf)`, and spread bits within an encode as `∝ complexity^qCompress`,
   i.e. a `0.6` allocation exponent. Both are below 1. [SOLID]

**The one documented upward exception is film grain**, and it is the ONLY class where the
literature shows `a` migrating above 1. The evidence is qualitative-plus-multiplier, never a
published exponent: with Film Grain Synthesis switched on, heavy-grain titles need massively
fewer bits *near transparency*, and the savings are concentrated at low QPs — i.e. the 
near-transparent slope of grainy content is much steeper than a CRF-based proxy implies. Recorded
multipliers: Netflix AV1-FGS (2025-07-02) **8,274 → 2,804 kbps** (~2.95×, i.e. grain ≈ two thirds
of the clean-signal bitrate at that anchor); Norkin, DCC 2018, "up to 50%"; MulticoreWare 2026-02,
"~40% average across UHD sequences, maximum savings at lower QPs".

**Uncertainty and honest limits.** No published paper fits exactly our quantity (anchor bitrate vs
x265-CRF-20-bpp, on a film library). No per-title/ladder paper publishes a closed-form slope at
all — they fit ML curves (RF/forest/SVR) to features and report BD-rate/accuracy (§4). So the
external world constrains `a` as (i) a firm upper bound `a ≤ 1` in the compressible regime, (ii) a
central value ~0.6 with the encoder-law and RD-theory anchors clustering at/below 0.6, and (iii) a
documented upward outlier class (grain) that can push a library-global fit ≥ 1. The leave-one-axis
implication (see `README.md` §5): **fit grain and non-grain contents separately — if the slopes
differ, a single scalar `a` is the wrong model.**

---

## 2. The definitional trap (load-bearing — read before using any number below)

Our `complexity` is itself a **bitrate**: the CRF-20 x265 bpp of the title. So `t_j` vs `c_j` is a
*rate–rate* regression — how far the anchor sits above the CRF-20 point, as a function of how big
that CRF-20 point already is. This is NOT the same axis as the published literature's
"bitrate vs content-feature" (SI/TI/DCT-energy) curves, and it is not the same as the encoder's
"complexity→QP" law. The relationship runs through the **shape of each title's own rate–quality
curve near its CRF-20 anchor**:

- If a title's R-Q curve is shallow near CRF-20 (bits buy less quality just above it — clean,
  compressible content), the anchor `t` is only slightly above `c`, so `t/c` is small and the
  across-title slope `a < 1` is preferred. This is the RD-theory additive prediction (§3).
- If a title's R-Q curve is steep near CRF-20 (bits become dramatically more expensive as you
  approach lossless — noise-like grain), the anchor is *proportionally* further above `c` for the
  already-high-`c` grainy titles, which pulls the regression's slope up — the legitimate `a > 1`
  mechanism, and the one the film-grain literature documents (§4).

So the correct reading of the external evidence is not "here is a number to copy" but **"theory and
encoder law bound `a` below 1 for compressible content; every upward deviation has a grain-shaped
signature; therefore the fit must (1) compare power vs additive/log functional forms and (2) be
run on grain/clean strata separately."** A pure power fit on grain-mixed data will produce an `a`
that is an average of two different laws.

---

## 3. (a) Encoder rate-control laws — the embedded exponents [SOLID]

Verified 2026-08-28 directly in source:

```
x264  encoder/ratecontrol.c :
      rate_factor_constant = pow( baseCplx, 1 - qCompress ) / qp2qscale( rfConstant + mbtree_offset )
x265  source/encoder/ratecontrol.cpp : same equation, mbtree_offset absent
```

- Default `qCompress = 0.6` ⇒ the **QP/rate-factor normalisation exponent is `1 − qCompress =
  0.4`**. Base complexity is measured by the encoder's own per-frame complexity estimator (itself a
  bitrate-at-base-QP proxy — the same "encode bits as complexity" family our probe uses, §5).
- Within an encode, bit allocation across sections at roughly-constant quality scales as
  `∝ complexity^qCompress = complexity^0.6` (the documented meaning of qcomp: 1.0 = complexity-
  blind CBR allocation, 0.0 = constant-quality). This is the de-facto production exponent for "how
  many more bits does harder content need at the same quality": **0.6.**
- x265 forces `m_qCompress = 1` when `cuTree && !hevcAq` (MB-tree + explicit adaptive quant off),
  i.e. exponent 0 in the rate-factor term — the near-constant-quality/allocation-reallocated-by-
  cutree branch; community CRF tuning uses `--qcomp 0.6–0.85` (e.g. Doom9 t=182544 `--qcomp
  0.65`). So the encoder's own family of complexity exponents spans **0.4–0.85**, centred ~0.6.
- URLs: `github.com/videolan/x265/blob/master/source/encoder/ratecontrol.cpp`,
  `github.com/corecodec/x264/blob/master/encoder/ratecontrol.c` (fetched 2026-08-28).

**Note on scope.** This is the encoder's *structure→bits* law at a fixed quantizer setting. It is
not itself the `a` of `t_j ∝ c_j^a` but it is the strongest external slope on the same "bits vs
content cost" axis, and it lands sub-linearly.

---

## 4. (b) RD-theoretic bounds — the theory anchor [SOLID]

**Gaussian source, squared-error distortion (Shannon's exact solution):** `R(D) = ½·log₂(σ²_x / D)`.
Consequences for the two ways the bound touches `a`:

1. **Constant-SNR anchor** (distortion scaling with source variance, `D ∝ σ²` ⇒ equal PSNR across
   content): `R = ½·log₂(1/γ) = const` ⇒ **`a = 0`.**
2. **Constant-absolute-D anchor**: `R = ½·log₂(σ²/D)`, local power exponent
   `a_local(σ²) = 1 / ln(σ²/D)` ≈ **0.13–0.29** across the 30–50 dB anchor range.
3. **Rate–rate form (our actual shape):** two quality points of the same source,
   `R₂ = R₁ + ½·log₂(D₁/D₂)`, i.e. **`t = c + Δ` — an additive constant in bitrate, not a
   multiplier.** The local power-law exponent is `a_local(c) = c/(c+Δ) ∈ (0,1)`, increasing towards
   1 as `c → ∞` and drooping towards 0 as `c → 0`.

Sources: Wikipedia *Rate–distortion theory* and Stanford EE368b rate-distortion handout (Girod),
both fetched 2026-08-28.

**Sanity range for the fit** (derived here from the published bound + our measured complexity
distribution — labelled as ours, not external): taking `Δ ≈ (0.3–0.7)·c_median` (i.e. an anchor
10–40% above CRF-20 at the median title), `a_local` sweeps ≈ 0.35→0.9 across our 8.1× range, and a
single power fit would land ≈ **0.6–0.75 with the residuals bowing (concave in log-c) if the true
law is additive.** A fitted `a > 1` on clean content is *not* producible by any Gaussian-source
law — its presence would be evidence of either the grain class dominating or a wrong functional
form. This is the cleanest externally-supplied falsification test the fit has.

**Corroborating curve-shape work (log-rate / linear-metric):** the λ-domain rate-control family adopts
power laws in the Lagrange multiplier rather than in content: `R = α·λ^β`, α/β content-dependent,
per-frame LMS-updated, β default `−1.367` (Li et al., IEEE TIP 23(9):3841, 2014, integrated into the
HM reference software; α=3.2003/β=−1.367 defaults confirmed via the generalized R-D-λ follow-up,
arXiv:1911.00639). Katsenou et al. (arXiv:2102.04167 / JVCIR 2022) find an **exponential model**
best fits log(R)–PSNR curves of video textures (mean BD-rate 0.46%) — i.e. quality-metric linear in
log-rate, the same shape the Gaussian law produces. JASLA (arXiv:2305.00225) feeds `log(bitrate)`
itself as a regression feature. None of this is an exponent for `a`, but all of it independently
says the rate dimension is log-additive, which is the RD-theory prediction (§1, error 2).

---

## 5. (c) "CRF is perceptually uniform" — the claim the deviation ships on [DIRECTION]

Every source consulted says the opposite of uniformity:

- **MainConcept, "Constant Target Quality…" (2025-12-08):** CRF quality *"strongly depends on the
  video content"*; *"no setup in which one single CRF value rules all potential video sequences."*
- **Netflix, "Per-Title Encode Optimization" (2015-12-14):** fixed-ladder/CRF encodings
  systematically starve *film-grain / high-noise* content and over-provision *clean* content — the
  original motivation for per-title ladders.
- **Community (Doom9 threads; slhck CRF guide 2017):** CRF is *"not an absolute quality measure"*;
  grain is repeatedly reported as the worst offender ("--tune grain takes a lot of bits", a
  heavy-grain encode still visibly short of transparency at CRF 16; "6,000 kbps is not much for a
  grainy 1080p source").

**The production-quantified grain penalty (the only class where the direction of `a>1` is
measured, as multipliers):**
- Norkin, *Film Grain Synthesis for AV1 Video Codec*, DCC 2018: **up to 50%** bitrate savings on
  sequences with heavy film grain.
- Netflix, *AV1 @ Scale: Film Grain Synthesis* (netflixtechblog, 2025-07-02): *They Cloned Tyrone*
  at target quality **8,274 kbps (no FGS) → 2,804 kbps (FGS)** — grain alone ≈ 2.95× the clean-signal
  bitrate at that anchor.
- MulticoreWare (x265 vendor, 2026-02-13): **~40% average bitrate savings** across UHD test
  sequences, *"maximum savings occurred at lower QPs"* — i.e. concentrated exactly in the
  near-transparent regime where our anchor sits.

What these do NOT supply: any exponent. They bound the grain class's deviation only qualitatively
("large, steep near transparency") and via multipliers, which is why the grain-vs-clean stratum
split (§8) is mandatory rather than optional. Direction corroborates the same mechanism the sibling
README §5 logs (grain and motion-masking pull the anchor in opposite directions; a one-scalar `a`
is threatened).

---

## 6. (d) Per-title / ladder papers with explicit slopes — none publish one [DIRECTION]

The family of closest work (production and academic) confirms the premise — required bitrate is a
strong, predictable function of content complexity — but fits curves with ML, never a closed-form
exponent:

- **De Cock, Li, Manohara, Aaron, "Complexity-based consistent-quality encoding in the cloud",
  ICIP 2016 (Netflix):** per-title complexity analysis → bitrate/resolution selection, plus
  per-chunk bitrate control for consistent quality. This is *the* production descendant of the same
  question as `a`; no slope reported. [SOLID existence / DIRECTION number]
- **JASLA (Menon et al., arXiv:2305.00225, ICME 2023):** Random Forest predicts per-scene VMAF and
  the x265 CRF from `[E_Y, h, L_Y, log(b_t)]`; R² = 0.93 (VMAF) / 0.97 (CRF), MAE(CRF) = 1.86;
  JND-threshold CRF prunes sub-JND rungs; 34.4% / 42.7% bitrate savings at equal PSNR/VMAF vs the
  HLS CBR ladder. Failure: not usable to seed predictions across titles; no slope exposed.
- **red265 / Xiaohongshu (Yin et al., arXiv:2411.05295, VCIP 2024 oral):** predicts both
  RF→bitrate and RF→quality curves from content + codec + anchor features (their "anchor" IS our
  one-measured-rung trick); VMAF ±1 at 99.14% accuracy; production A/B. **The closest philosophical
  twin to BPP+**, still ML-shaped.
- **Katsenou et al., "VMAF-based Bitrate Ladder Estimation" (arXiv:2103.07564, PCS 2021):**
  content-driven interpolation of Rate-VMAF curvature points; 74.3% of ladder points identical to
  exhaustive encoding, 77.4% fewer encodes, 1.12% BD-rate.
- **Katsenou et al., "Study of Compression Statistics…" (arXiv:2102.04167):** exponential
  model for log(R)-PSNR of video textures, BD-rate 0.46% — counted under §3's curve-shape family.

Takeaway: no paper lets us read `a` off a number. Their shared implicit belief (complexity→bitrate
is strongly predictive) is exactly the premise the probe quantifies with the film's own CRF-20 bpp.

---

## 7. (e) Complexity definitions matching ours [SOLID on the mapping, empty on the number]

The field's complexity-of-video definitions have converged on *"bits needed to encode it,"* the
same axis as our CRF-20 probe:

- The ICIP-2024 "Video Complexity" Grand Challenge (cd-athena.github.io/GCVC) states the premise
  plainly: *"videos with higher complexity require a greater bitrate to maintain a specific quality
  level"* — the whole competition exists because SI/TI *"often exhibit low correlation with actual
  video coding performance."*
- VCA (Menon et al., vca.itec.aau.at; Green VCA, arXiv:2304.12384) and DeepVCA use DCT-energy
  features; **DeepVCA's supervised labels are literally the intra-/inter-mode encode bit counts**
  — the "encode-bits-as-complexity" definition, the same family as our CRF-20 bpp.
- Frame-level bitrate prediction from VCA features at fixed QP hits R² 0.93/0.88/0.77 (I/P/B)
  (arXiv:2602.06242, VVenC rate control, 2026-02-05) — complexity features → bitrate is
  well-modeled, further confirming the axis without an exponent.

**Consequence:** no external work uses *our exact* ruler (x265 CRF-20 bpp of whole titles), so no
external exponent exists *on our axis*. The external anchors that DO exist — encoder law (0.4–0.6,
§3), RD theory (`a ≤ 1`, additive form, §4), grain multipliers (§5) — are the totality of the 
published constraint. That is the honest state of the world: the literature bounds `a` far more
narrowly than "unknown" but does not fix it; the fit against BVI-HD / VideoSet / LEHA-CVQAD (sibling
README §8) remains the only way to *measure* it.

---

## 8. Bottom line — what the fit must be tested against

**Numeric target.** The single most defensible external bound: **`a ∈ [0.4, 1.0]`, central ~0.6 for
compression-friendly content, firm upper bound `a ≤ 1` from information theory and from the encoder
laws.** Any fitted `a` on clean content above ~1.0 is externally falsified by the RD bound and by
the encoder's own exponent family; a fitted `a` dramatically below ~0.4 would contradict the
production claim (Netflix/JASLA/red265) that content complexity is a strong driver of required
bitrate.

**Functional-form competition (mandatory, mirrors README §6's AIC/BIC requirement).** Theory says
the underlying law is **additive in rate** (`t = c + Δ`, from `R(D) = ½log₂(σ²/D)`), not a clean
power law. The regression `log t_j = a·log c_j + k` must therefore ALSO fit:
1. `t = c + Δ` (additive; one extra parameter, predicts convex residual curvature in log-c);
2. `R ∝ ½·log₂(σ²/D)` (log-in-variance; zero slope at constant SNR);
and report which wins by AIC/BIC. A power-law `a` fitted to log-linear data systematically
mis-calibrates — that is the single most likely trap in interpreting whatever slope the fit returns.

**Grain/clean stratification (moved from optional to load-bearing).** Masking and grain pull the
anchor in opposite directions at equal CRF-20 bpp (README §5). The external record documents an
upward slope deviation only for grain. Fit `a` separately on grain-heavy and clean strata; if the
slopes differ beyond noise, the model needs a content-class term or a second (grainness) axis, and
the "single `a`" framing is retired.

**Correct number to quote out loud:** "the external, published-verifiable constraint on `a` is an
upper bound of 1, a central value around 0.6 for compressible content, log-additive rather than
power-law in form, with film grain the only class documented to exceed the bound — the fit is
expected to find `a ≈ 0.6±0.15` on clean content and steeper with grain-bearing titles included."

---

### Sources fetched 2026-08-28 (this thread)

1. x264 `encoder/ratecontrol.c` (corecodec mirror): `github.com/corecodec/x264/blob/master/encoder/ratecontrol.c` — verified `rate_factor_constant = pow(baseCplx,1-qCompress)/qp2qscale(rf())`, mbtree offset `(1-f_qcompress)*13.5`, qCompress default 0.6. [SOLID]
2. x265 `source/encoder/ratecontrol.cpp`: `github.com/videolan/x265/blob/master/source/encoder/ratecontrol.cpp` — same equation; `m_qCompress = 1` forced when `cuTree && !hevcAq`. [SOLID]
3. Wikipedia "Rate–distortion theory" (`en.wikipedia.org/wiki/Rate–distortion_theory`) and Stanford EE368b handout (Girod) — `R(D) = ½log₂(σ²/D)`. [SOLID]
4. Li, Li, Li, Zhang, *λ-Domain Rate Control Algorithm for HEVC*, IEEE TIP 23(9):3841, 2014 (`ieeexplore.ieee.org/document/6849994`) — `R = α·λ^β`, content-dependent α/β; defaults α=3.2003, β=−1.367 via arXiv:1911.00639 (Tang/Wen/Han 2019). [SOLID]
5. Katsenou, Afonso, Bull, arXiv:2102.04167 (JVCIR 2022) — exponential model for log(R)-PSNR of video textures, BD-rate 0.46%. [SOLID]
6. Katsenou, Zhang, Swanson, Afonso, Sole, Bull, arXiv:2103.07564 (PCS 2021) — VMAF-based ladder estimation. [SOLID]
7. Menon et al., JASLA, arXiv:2305.00225 (ICME 2023) — full text fetched; `[E_Y,h,L_Y,log b_t]` features, R² 0.93/0.97. [SOLID]
8. Yin et al., *Content-Adaptive Rate-Quality Curve Prediction*, arXiv:2411.05295 (VCIP 2024 oral) — RF-quality+RF-bitrate curve prediction, VMAF ±1 / 99.14%. [SOLID]
9. De Cock, Li, Manohara, Aaron, *Complexity-based consistent-quality encoding in the cloud*, ICIP 2016 (DOI 10.1109/ICIP.2016.7532605). [SOLID]
10. Netflix, *Per-Title Encode Optimization*, netflixtechblog.com, 2015-12-14. [SOLID]
11. Norkin, *Film Grain Synthesis for AV1 Video Codec*, DCC 2018 (`ieeexplore.ieee.org/document/8416572`) — up to 50% savings heavy grain. [SOLID]
12. Netflix, *AV1 @ Scale: Film Grain Synthesis, The Awakening*, netflixtechblog.com, 2025-07-02 — 8,274 → 2,804 kbps. [SOLID]
13. MulticoreWare, *…Film Grain Analysis & Synthesis*, multicorewareinc.com, 2026-02-13 — ~40% average, max at lower QPs. [SOLID]
14. MainConcept, *Constant Target Quality: Encoding Driven by Perceptual Fidelity*, blog.mainconcept.com, 2025-12-08. [SOLID]
15. ICIP 2024 Video Complexity Grand Challenge, `cd-athena.github.io/GCVC/`. [SOLID]
16. VCA / DeepVCA (arXiv:2304.12384); arXiv:2602.06242 (VVenC VCA frame-bit prediction, 2026-02-05) — encode-bits-as-complexity lineage. [SOLID]