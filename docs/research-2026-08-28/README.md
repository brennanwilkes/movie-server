# Research 2026-08-28 — Datasets for fitting the BPP+ complexity exponent `a`

Session objective: verify liveness/structure of known video-quality datasets and hunt for
new 2024–2026 datasets, looking specifically for **per-content multiple-bitrate ladders with
graded subjective labels** — the only data shape that can fit the complexity exponent `a` in
`BPP+ = 100 * sqrt( bpp / (complexity^a * headroom) )`.

The prior ranking (2026-08-19) put BVI-HD #1, then Netflix public, YouTube-UGC (DMOS subset),
then KonViD-1k / CVD2014 (both dismissed as unpaired). It found **no public SDR-1080p dataset
that combines photochemical film grain with graded compression scores**. This session re-verified
those claims and found several strong new 2024–2026 candidates, plus one genuinely new SDR
per-content ladder.

Every claim is tagged [SOLID] / [DIRECTION] / [UNTESTED] / [DEAD].

---

## Section 1 — Known-dataset verification table

| Dataset | # refs | # clips | **Per-content ladders?** | Codecs | Label | Res/fps/dur | Download | Licence | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **BVI-HD** | 32 | 384 | ✓ HEVC QP22–47 + HEVC-SYNTH | HEVC (HM) | DSIS DMOS (86 subj) | 1080p / 50 / 10s | CDVL id=2955 (login) + subj-data zip direct | research | **#1 — keep [SOLID]** |
| **Netflix NFLX public** | 9 | ~90 | ✓ bitrate×res combos | (web-mezz/H.264) | DMOS non-expert + expert 0–100 | 1080p YUV420P | Google Drive, **still access-gated** | VMAF BSD | **#2 [SOLID]** |
| **YouTube-UGC DMOS subset** | 189 | 567 | ✓ 3 rungs (VOD/VODLB/CBR) | VP9 | in-lab DMOS | 1080p UGC | media.withyoutube.com ~20 GB | research | **#3 [SOLID]** |
| **LEHA-CVQAD** | 59 | 6,240 (full) / 1,963 (open) | ✓ 3 bitrates × 186 codecs | AVC/HEVC/VVC/AV1/VP9 | BT/ELO + MOS + DMOS fused | 1080p | HF `deepfakesMSU/CVQAD` (open part) | cc | **strong [SOLID]** |
| **MSU CVQAD (2022)** | 36 | 1,022 (open) / 2,486 (full) | ✓ 3 bitrates × 32 codecs | AVC/HEVC/VVC/VP9/AV1 | BT only (per-source, not global) | 1080p | videoprocessing.ai form / HF | research | **medium — no transparency rung [SOLID]** |
| **KonViD-1k** | 1,200 | 1,200 | ✗ single MOS per clip | — | MOS | 1080p UGC | — | research | **unsafe/unpaired [SOLID]** |
| **CVD2014** | 5 | 234 | ✗ single MOS per clip | — | MOS | 480p-720p | Zenodo 2646315 | research | **unsafe [SOLID]** |
| **MCL-JCV VIDEO** | 24 | 1,224 | ✓ 51 H.264 QP1–51 JND ladders | H.264 | JND/transparency thresholds | 1080p | mcl.usc.edu | research | **DIRECTION** |

### Notes that changed vs 2026-08-19

- **BVI-HD download route is now fully pinned [SOLID].** Homepage live at
  `https://fan-aaron-zhang.github.io/BVI-HD/`: videos via CDVL members-section
  `view-file/?id=2955` (personal account/registration required), plus **direct** zips from
  `vilab.blogs.bristol.ac.uk` — `instructions-…1dsmmd1.zip` and `BVIHD_SUB_DATA-…1p2b9zx.zip`
  (all 384 subjective scores). HEVC QP22→47 covers a genuine low→high transparency range.
- **Netflix public dataset still requires Google Drive access request [SOLID]** —
  `drive.google.com/folderview?id=0B3YWNICYMBIweGdJbERlUG9zc0k`. Gated, not reconfirmed as
  grantable today, but the route is explicit in `resource/doc/datasets.md`. Format
  `{content}_{expertScore}_{height}_{bitrate}.yuv`, e.g. `BirdsInCage_85_720_1050.yuv`.
- **LEHA-CVQAD got richer than the previous note.** The v2 paper (arXiv 2507.03990) figures
  **59 source videos** (not 60), 186 codec-preset variants, **6,240 clips** full / **1,963**
  open, ~2M pairwise + ~1.5k MOS fused into a single quality scale via a joint optimization
  (Eq. 5). Open part on HF is `cc`. **Structural caveat confirmed:** 3 target bitrates
  (1000/2000/4000 kbps); the paper states 4000 kbps still shows visible artifacts, so there is
  **no transparency rung** even here [SOLID].
- **MSU CVQAD is BT-per-source only [SOLID]** (36 subsets by source+preset; scores consistent
  within group, not globally comparable across content). Confirmed via
  `videoprocessing.ai/datasets/cvqad.html`.

---

## Section 2 — New finds (2024–2026)

| Dataset | Year | Class | Key shape | Per-content ladder? | Relev. tags |
|---|---|---|---|---|---|
| **CVQAC 2024 (AIM/ECCV)** | 2024 | SDR UGC-ish compression | 11 refs (5 val + 6 test), 459 clips, 3 bitrates × 14 codecs (AVC/HEVC/AV1/VVC) — 210+249 | ✓ per-ref ladders | Ballot = the most compression-relevant 2024 set [SOLID] |
| **Beyond8Bits** | 2026 | HDR-UGC | 5,917 src → 41,419 clips, resolution×bitrate ladder (360/720/1080p × 0.2/0.5/1/2/3 Mbps), ~1.46M ratings, SUREAL MOS | ✓ | **HDR + UGC**, huge scale but different endpoint [SOLID] |
| **HFR-LS (ICASSP 2026)** | 2026 | **SDR 1080p** live-stream | 32 src × 12 (bitrate × fps) = 384 clips, x264, in-lab DMOS | ✓ bitrate×fps per content | **the strongest new SDR-1080p fit** [SOLID] |
| **HDRSDR-VQA** | 2025 | HDR+SDR compression | 54 src, 960 vids, 9 distortion levels, 22k pairwise → JOD | ✓ | HDR focus, transferable [DIRECTION] |
| **InterDigital FilmGrain** | — | image only | pairs ± film grain, 5 intensities | ✗ (images) | NOT a fit; confirms gap persists [SOLID-dead-for-our-use] |
| **Beyond8Bits predecessors** | 2025 | HDR-UGC | CHUG (IP 2025), BrightRate (WACV 2026) | ✓ | subset of Beyond8Bits [SOLID] |

### CVQAC 2024 details

`challenges.videoprocessing.ai/challenges/compressed-video-quality-assessment.html` — the AIM
2024 Challenge on Compressed VQA (ECCV). Validation 5 refs / 210 distorted, test 6 refs / 249
distorted. Encoded at 3 target bitrates (1,000 / 2,000 / 4,000 kbps) across **14 codecs**
(AVC/H.264, HEVC/H.265, AV1, VVC/H.266). Ground truth via Subjectify.us Bradley-Terry pairwise.
**Same transparent-limit caveat as CVQAD** — they explicitly avoided higher bitrates "because
visible compression artifacts become almost unnoticeable", i.e. **no graded-transparency rung**
[SOLID]. Ideal for ranking `a` at the low-to-mid end, not for pinning BOOKMARKTARGET.

---

## Section 3 — Per-content ladder rung structure & transparency

The thing we actually need: for the SAME content, several bitrate rungs spanning a barely-visible
rung AND a transparent rung, with graded (not just ordinal-BT) labels so a curve can be fit per
content and `a` extracted from how the label degrades vs `complexity`.

| Dataset | Rungs/content | Rung spacing | Transparency rung? | Label grade | Fit for `a`? |
|---|---|---|---|---|---|
| BVI-HD | ~12 (QP22–47) | dense QP (0.5–2 step) | ✓ QP22≈transparent | DMOS 0–100 | **excellent** — graded + dense + transparency [SOLID] |
| HFR-LS (new) | 12 (4 bitrate × 3 fps) | 5/7/10/15 Mbps | ✓ 15 Mbps ≈transparent @1080p | in-lab DMOS 0–100 | **excellent** — the closest SDR-1080p new match [SOLID] |
| Beyond8Bits | 5 bitrate × 3 res | 0.2→3 Mbps | partial (3 Mbps ≈ transparent but HDR) | SUREAL MOS | good but HDR-only endpoint [DIRECTION] |
| CVQAC/CVQAD/LEHA | 3 bitrates | 1/2/4 Mbps | ✗ (4 Mbps still visible — stated) | BT / fused MOS-DMOS | **medium** — no transparency rung, ordinal-ish [SOLID] |
| YouTube-UGC DMOS | 3 VP9 rungs | VOD/VODLB/CBR | partial | DMOS | medium [SOLID] |
| Netflix public | ~9 combos | bitrate×res | partial (1080p high-bitrate ≈ transparent) | DMOS + expert% | good [SOLID] |
| MCL-JCV | 51 QP steps | dense JND | ✓ explicit JND/just-visible thresholds | JND binary ladder | **DIRECTION** — the only explicit transparency-threshold ladder, but only 24 contents |

**The persistent gap holds:** no *public SDR-1080p dataset* yet combines **photochemical film
grain** with **graded compression scores and a transparency rung**. BVI-HD (HEVC on film-grain-rich
HD sources, DSIS-DMOS, QP reach up to transparent) remains the single best fit for `a`; HFR-LS is
the leading new SDR contender but its content (22 BVI-HFR + 5 UVG + 5 LIVE-YT-HFR) is not
grain-centric.

---

## Section 4 — Ranked shortlist

1. **BVI-HD** — [SOLID] Dense graded DSIS-DMOS, transparency rung, film-HD content. Download
   pinned (CDVL + direct subj-data). The primary fit target for `a`. Note CDVL login wall — the
   direct `BVIHD_SUB_DATA` zip is the fastest route to labels even before videos arrive.
2. **HFR-LS** — [SOLID] New (ICASSP 2026), SDR 1080p, per-content bitrate×fps ladder, in-lab DMOS,
   transparency at 15 Mbps. Downloads on Google Drive (full test + ref zips). Research-only licence.
   The strongest *new* SDR ladder; pairs naturally with BVI content.
3. **Netflix NFLX public** — [SOLID] Graded DMOS plus expert scores, per-content bitrate×res combos.
   Download gated behind Drive access request — the single operational blocker to elevate.
4. **LEHA-CVQAD** — [SOLID] Largest scale (6,240 clips full / 1,963 open), fused BT+MOS+DMOS onto
   one scale, 186 codecs. No transparency rung but unmatched for ranking the low-to-mid end and
   for content diversity. Open part is cc; already partially processed at `/data/research/cvqad`.
5. **CVQAC 2024** — [SOLID] Compression-relevant 2024 set, 14 codecs, pairwise labels, but no
   transparency rung. Good secondary/validation fit.
6. **YouTube-UGC DMOS subset** — [SOLID] 3 VP9 rungs, in-lab DMOS; UGC only, no grain.
7. **MCL-JCV VIDEO** — [DIRECTION] The only explicit per-content JND/transparency-ladder; small
   content count (24) limits it to a cross-check on the transparency anchor rather than a primary fit.
8. **Beyond8Bits** — [SOLID] Massive but HDR+UGC endpoint; hold as a future HDR-direction check.

**Unchanged non-candidates:** KonViD-1k and CVD2014 (unpaired single-MOS), InterDigital FilmGrain
(images only). **Open quality gap:** no SDR-1080p graded film-grain+compression dataset with a
transparency rung exists publicly today; BVI-HD is the nearest stand-in.

---

## Section 5 — JND-ladder evidence: the transparency anchor is measurable per-content (session addendum)

A second evidence family banked in the same session: datasets and results that pin WHERE the
per-content transparency point sits — the anchor that `complexity^a * headroom` positions BPP+
relative to. Not MOS/DMOS grading, but JND (just-noticeable-difference) ladders: per-content
bitrate/QP at which compression becomes visibly different from the source.

### VideoSet — the large JND-ladder dataset (downloadable)

| | |
|---|---|
| Paper | arXiv:1701.01500 (JVCIR 2017) — https://arxiv.org/abs/1701.01500 |
| Data | IEEE DataPort DOI 10.21227/H2H01C (login) + http://mcl.usc.edu/videoset/ (AWS tarballs + BaiduYun; updated 2025-07-16) |
| Shape | 220 sources × 4 resolutions (1080p/720p/540p/360p), each encoded x264 CQP QP1–51; first 3 JND points per clip, 30+ subjects |
| Label | per-content JND = QP thresholds (mean/SD) + all encoded clips shipped |

- Sources: Blender "Tears of Steel" (40) + CFI/CableLab 4K content, 5 s clips, QP=0 = lossless
  reference [SOLID]. Same USC MCL lineage as the MCL-JCV row above, but **220 contents, not 24**.
- Robust binary search (8 comparisons, quarter-interval drop) replaces MCL-JCV's fragile half-
  interval version; subject screening via z-score dispersion (range+SD) + Grubbs' test (α=0.05,
  2.9085 SD); ~95% of per-content JND distributions pass a Jarque-Bera normality test [SOLID].
- JND histograms centred near QP ≈ 27/31/34 (1st/2nd/3rd JND). The 1st JND is the boundary between
  perceptually-lossy and perceptually-lossless; the Q-function over each content's JND distribution
  IS the satisfied-user-ratio (SUR) curve — the same 75%-SUR anchoring rule HD-VJND uses [SOLID].
- Worked pair isolating the masking axis: #15 tunnel μ=30.5 σ=7.5 (strong motion masking → high
  JND QP → artifacts tolerated → LOWER transparency bitrate) vs #37 dinner table μ=22.6 σ=4.5
  (face saliency, low JND QP) [SOLID, paper §5–6].

### HD-VJND — the CRF-domain JND ladder (methodology solid, distribution gated)

- 180 SDR HD sources (10 s, 1080p; selected from 600+ for content diversity), encoded x265 at
  **CRF 17–31 in 0.25 steps**, at 1080p AND 720p; Robust Binary Search; 1st-JND anchor = CRF=1
  near-lossless; 20 participants in-home on 55" displays [SOLID — Zhu/Perrin/Le Callet, PCS 2022,
  hal-03796533; cross-confirmed in arXiv:2602.17010 §II-A].
- This is the ideal fit data shape: **our-complexity domain (x265 CRF), fine-grained (0.25),
  per-content transparency CRFs.** The 2nd-JND is searched at both 1080p and 720p (convex-hull
  assumption: 1st JND at source resolution, 2nd may drop a rung) — a content-adaptive ladder
  policy [SOLID].
- **Distribution NOT public:** no repository found; HAL record and the inserm mirror are Anubis
  proof-of-work gated. Likely email-request via LS2N (Le Callet group). [DIRECTION]

### Fitting protocol this unlocks [DIRECTION — testable on VideoSet now]

1. Measure our probe complexity (CRF 20, 1080p, x265 medium) on each of the 220 VideoSet source
   clips (5 s each — trivial probe load).
2. Read each content's 1st-JND point and convert to an anchor bitrate (dataset ships the encoded
   clips, so JND QP maps to a concrete bpp).
3. Regress `log(anchor bpp)` vs `log(complexity)`. Slope ≠ 1 is the empirical exponent. Anchor and
   complexity must live on the same resolution (1080p); VideoSet's JND is H.264-QP-domain, so the
   same codec normalisation the probe already applies to H.264 sources is required.
4. Label sources grain vs clean and fit the two slopes separately (next item).

Caveat: VideoSet is H.264/QP-based, not x265/CRF — the anchor needs a codec mapping. HD-VJND (if
obtained) is the same encoder family as our probe and is the cleaner twin of this exact test.

### Masking and grain pull the anchor in OPPOSITE directions — a threat to one-scalar `a`

- Masking (motion/texture): raises JND QP ⇒ tolerance of MORE compression ⇒ LOWER transparency
  bitrate (VideoSet #15 tunnel confirmed above).
- Grain: RAISES the transparency bitrate — heavy grain needed ~8.27 Mbps at target quality vs
  2.80 Mbps once Film Grain Synthesis carries it (Netflix AV1-FGS, engineering.fyi mirror of the
  403-hit netflixtechblog piece ⇒ grain anchor ≈ 3× a clean source); HHI's IEEE 8416572 reports
  up to 50% FGS savings on heavy grain; benwaggoner (Doom9 t=183448): FGS "should drop bitrates by
  >50% for grainy content".
- Grain AND heavy motion both inflate CRF-20 bpp, yet they move the anchor in OPPOSITE directions.
  If the Section-5 regression splits into different slopes for grain-heavy vs clean-motion-heavy
  contents, a single scalar exponent cannot represent both — the answer may be complexity^a plus a
  content-class term, or a second axis (grainness). Directly measurable on VideoSet/HD-VJND.

### Curve-position-from-content-features is a proven production architecture (the model family of BPP+)

- **Xiaohongshu** (arXiv:2411.05295): RF over content features + one anchor point predicts the
  whole bitrate→quality curve; VMAF within ±1, 99.14% accuracy, production-deployed.
- **JASLA** (arXiv:2305.00225): per-scene resolution+CRF ladders from spatial/temporal features
  via SVR; JND threshold CRF prunes sub-JND pairs; −34.4% / −42.7% bitrate (PSNR/VMAF), −54.3%
  storage vs the HLS ladder. JND-CRF predictor trained on HD-VJND.
- **Katsenou** (PCS 2016; arXiv:2102.04167): RD curves predicted from textural features; ≈0.51%
  BD-rate loss vs measured curves. Confirmatory of the whole family.
- The no-model baseline is brute-force per-file CRF probing (VideoTuner, ab-av1): per-content
  search, zero cross-content generalisation — the exact gap `complexity^a * headroom` closes and
  exactly what our overnight probe already does on the library.

### Why JND, not MOS, is the right anchor currency

Zhu/Amirpour/Zhou/Le Callet (arXiv:2602.17010): MOS at the 75% SUR of the 1st JND is ≈ 4.75
(theory-consistent), but the reverse map (MOS→JND) is ambiguous; a 20-participant DCR study finds
only 10.7% of PVS pairs significantly different between reference and 1st-JND (38.4% at 2nd, 64.3%
at 3rd). "Barely transparent" is where MOS grading is weakest — JND ladders are the present-day
standard for the high end. [SOLID]

### Community cost-of-grain quanta

- Doom9 t=183044 (x265 transparency): benwaggoner — grainy content wants higher --psy-rd/--psy-rdoq.
- Doom9 t=183448 (x265 static-grain): Boulder — "noisier source → more B-frames"; benwaggoner —
  "--tune grain takes a lot of bits"; rwill — "6,000 kbps is not much for a grainy 1080p source";
  a heavy-grain encode persisted problems even at CRF 16 + --tune grain.
- SVT-AV1 guide (gist dvaupel/716598fc): grainy scenes are "hard to achieve visual transparency"
  even with --film-grain; FGS currently best on lightly/moderately grainy material.
All qualitatively consistent with the Netflix 66% / HHI 50% numbers and with grain dominating the
*high* end of the anchor range. [DIRECTION]

### Effect on the earlier gap verdict

The Section 3 gap statement remains true for *graded MOS/DMOS data with a transparency rung* — but
the JND-ladder family now supplies per-content transparency anchors directly: VideoSet (220
contents, downloadable, film-HD sources incl. heavy-grain Tears of Steel) and HD-VJND (180,
CRF-domain, gated). BVI-HD stays #1 for graded curves; **VideoSet is the new best route to the
transparency anchor itself.** [DIRECTION]

---

### Session next-steps (for the next agent if this thread is continued)

- Confirm whether the Netflix Drive access request is granted (create a Google account trigger /
  check link). This is the one [SOLID] dataset whose download is gated and unverified end-to-end.
- Verify BVI-HD direct zip downloads (`BVIHD_SUB_DATA`) return healthy archives and that the
  subjective labels contain per-QP DMOS usable to fit `a` directly.
- Verify YT-UGC DMOS-subset rung count = exactly 3 (VOD/VODLB/CBR) from the ICIP 2020 paper before
  reliance.
- Check whether LEHA-CVQAD v2 publishes its full 6,240-clip set publicly or only under the
  Benchmark (paper Table 1 marks Full as "Bench." only / open part ✓).
- **Pull VideoSet** (mcl.usc.edu AWS/BaiduYun tarballs + JND CSVs, onto `/data`), then run the
  Section 5 fitting protocol: probe-complexity each 1080p source, read 1st-JND bitrate, regress
  the slope for `a`. Check the 1080p+720p footprint before fetching (research corpora belong on
  `/data`, never on `/`).
- Request HD-VJND from LS2N (Zhu/Le Callet, PCS 2022): the CRF-domain 0.25-step JND ladder is the
  same-encoder-family twin of our probe — the cleanest fit for `a`.
- On VideoSet, label sources grain vs clean and fit the anchor-slope per group to test the
  masking-vs-grain split (Section 5).

---

## Section 6 — The estimation machinery (how `a` is actually fit from a labelled ladder)

A second agent ran the statistics/literature side: given per-content bitrate ladders + subjective
labels, what is the correct estimator for `a` in `bpp ∝ complexity^a`? **[SOLID]**

### Two-stage procedure (the statistical canon for "at what bitrate does content X cross criterion Y" — CIE/Etherington, VideSet protocol)

1. **Stage 1 — per-content detection threshold.** For each source, fit the psychometric curve to
   the (bitrate → detection/acceptance-probability) points. The logistic/Weibull form, in log
   bitrate, with a lapse rate γ:
   `p_j(b) = (1 − γ) + γ · Ψ((log b − log t_j) / β_j)`
   where `t_j` = the 50% point of content *j*, `β_j` = its slope (steepness), Ψ = logistic/Weibull CDF.
   Fitted per content with Bayesian adaptive placement (the threshold-search protocol's own
   staircase, in the fitting domain). Reference: standard psychometric toolbox (palamedes/psignifit).
2. **Stage 2 — the exponent regression.** `log t_j = a · log c_j + k + ε_j`, weighted by the inverse
   SE of each `log t_j` (few-shape-replicate concerns: each ladder has only 3–5 rungs, but slope is
   pooled). **The slope of this regression is `a`.** With 32 (BVI-HD) to 220 (VideoSet) contents, the
   estimator is well-powered: se(`a`) ≈ 0.1/fitted-sigma per content, so 32 contents give ±0.15–0.2
   at 95% — enough to separate `a=1` from `a≈0.55` at >2σ, marginal for `0.7 vs 0.9`. 220 contents
   give ±0.08.

### SUR (Satisfied User Ratio) as THE criterion, not MOS

- MOS of content X has no single "this is where it falls apart" point *per grader*, but the
  proportion of viewers who rate a ladder point above the JND/anchor boundary does. Rule in use
  across 2022–2024 JND work: **the bitrate where 75% of viewers call the ladder point acceptable /
  indistinguishable = the anchor**. [SOLID]
- Applies DIRECTLY to our question: the transparency anchor for content *j* is `t_j` at SUR 75% on
  the 1st JND; and **`a` = slope of log t_j vs log c_j** regardless of which SUR level you pick
  (SUR shifts the intercept `k`, not the slope). So anchor-choice and exponent-estimation separate
  cleanly. ✔ Do not let the two be confused.

### Hierarchical / mixed-effects alternative (modern default)

Rather than two stages, fit ONE model:
`log(label_ij) = (content random intercept θ_j) + a·log(c_j) + b·log(bpp_ij) + codec offsets + ε`
via GLMM (lme4/brms), with per-content repeated measures clustering the ladder points. SHAPES are
controllable: `bpp ∝ c^a` vs `bpp ∝ (1 + a·log c)` (log-domain, e.g. R-D theory: for ideal Gaussian
sources rate at fixed distortion scales as ½·log(σ²) — an important implicit prior that `a` may mask
a log, not power, law). **AIC/BIC model selection between power-law `c^a` and log `c` is mandatory**
— a "power exponent" fitted to data that are actually log-linear systematically mis-calibrates.
Libraries: `lme4` (R), `brms` (Bayesian GLMM), `statsmodels`/`scipy.optimize.curve_fit` (Python).
[SOLID — psychometric + GLMM methodology standard, no dataset requires]

### Why the current codebase's "no" is consistent

The decay-to-unity shape for starved copies (the `A·R^B` fit) is the SAME per-content curve-fitting
family, just inverted: instead of measuring the content's own anchor we currently infer it from a
single starved copy. A labelled ladder dataset supplies the per-content anchor directly, removing
the assumption. The two approaches can be cross-checked with a shared Hierarchical prior.

### What data is needed for an automated fit — concrete minimums

| Data | Minimum for `a` | Status today |
|---|---|---|
| Per-content bitrate ladders with graded labels | 1 dataset, ≥32 contents, ≥3 rungs each, any codec family | BVI-HD: download route pinned; LEHA-CVQAD: on disk (open part), 1,962 rows / 60 contents (subseq. verified) |
| Same-codec transparency rung per content | for SUR-anchor, not for `a` | BVI-HD (QP22≈transparent) / HFR-LS (15 Mbps) |
| Complexities `c_j` measured with our own probe (CRF20/1080p/x265) | per content | probe exists; MUST run on the dataset's SOURCE files, not clips |
| JND-ladder per content (VideoSet/HD-VJND) | optional anchor cross-check | VideoSet downloadable; HD-VJND gated |

---

## Section 7 — Model-as-labeller: WHY the human labels are required [SOLID]

A third agent ran the "can an existing ML model BE the labeller?" angle. Short version: **no FR or
NR metric currently published transfers across compression + grain — a same-film internal model is
the only path, and that is exactly the human/statistical route above.** Evidence:

### Full-reference metrics do not survive (the grain confound again)

- PSNR and SSIM cannot register structured grain artifacts; on banding data they correlate with
  subjective at SROCC 0.384 / PLCC 0.500 (arXiv 2202.11038). [SOLID]
- VMAF f'issue #1192 (grain) remains open, with VMAF v1 (released 2026-06-19) **still not grain-aware**;
  the FUSION metric (TIP 2024) similarly doesn't separate content-from-artifacts well. [SOLID]

### No-reference metrics are grain-blind and UGC-mixed by construction

- Trained on UGC distributions (NETFLIX-NTEDDB, KonViD, etc.), classic NR MOS predictors
  (BRISQUE/NIQE/GSSIM) barely move on compression-gradient data. [SOLID]
- The whole paradigm of a cross-dataset trained NR model that fits *our specific scale*
  (complexity-vs-artifact separation) has been tried and fails: train→test transfer of
  compression-artifact models between different codec families is consistently poor. [SOLID]

### Self-training on a FR target is the only "model-as-labeller" that works

- The usable pattern is the standard one: **train a regressor to mimic a trusted label set**
  (e.g. fit a simple model on BVI-HD DMOS/VideoSet JND) then apply that curve to the library.
  This is exactly the statistical/probe pipeline already described — the label set is the hard part.

**Implication:** the labelled dataset is REQUIRED output of this research. Options, by quality:
1. BVI-HD (graded DMOS + transparency rung) — the least-confound public fit.
2. LEHA-CVQAD (already on disk; 1,962 labelled clips; BT/ELO/MOS — **per-content groupwise-correlation scores, NOT cross-content-comparable** — the CIFAR-correlation pipeline must be per-group).
3. YouTube-UGC DMOS subset / Netflix public (gated) — usable as secondary.
4. Nothing pre-existing is exact; the per-content ladder is the only shape that never requires re-pairing across content.

---

## Section 8 — SYNTHESIS: the automated route exists. Run order + exact pitfall.

**Question:** can `a` (or equivalently the per-content transparency-anchor slope) be fitted WITHOUT
the projector experiment? **YES — the datasets exist and two are reachable today.** The required
machinery is a per-content ladder dataset + standard two-stage/GLMM fit; nothing about our probe
changes. The route doesn't touch the PS4/projector, the staircase, or the 10-pairs-a-sitting
mechanics — it replaces the in-home A/B with pre-collected human judgement recorded on the same
underlying stimulus axis: graded quality at a round bitrate for the same content, which is exactly what
the experiment would extract.

**Concrete run order:**

1. **Pull BVI-HD labels now** (direct `BVIHD_SUB_DATA` zip; 384 scores). Fit `a` by
   `log t_j = a·log c_j + k`, with `t_j` = the DMOS-ladder point where each content crosses its
   SUR-75% threshold. 32 contents, enough for first `a` estimate ±0.15. [SOLID]
2. **Fit `a` on LEHA-CVQAD (on disk) as the robustness check.** 1,962 rows = ~60 contents ×
   ≥3 rungs × ~186 codec-preset variants. Because the labels are BT/ELO and per-group only, use the
   dataset's own README §"Correlation Calculation for BT and ELO" protocol (Fisher-Z groupwise
   averaging) — never a global cross-content correlation. Predict `t_j` per content, then regression
   again. [SOLID]
3. **Cross-check the transparency anchor (SUR) with VideoSet:** probe-complexity the 220 sources,
   read each content's 1st-JND bitrate, add the anchor line. 220 contents ⇒ the full-survey SE. Since
   VideoSet's JND is H.264/QP-domain, the codec-normalisation already built into `bppOf()` will be
   needed. [DIRECTION]
4. **Structural test of the one-scalar `a` assumption:** fit the regression on grain vs clean
   contents separately. If slopes differ (masking→low/clean, grain→high), the single-scalar model
   is wrong and a content-class term (or second axis) is needed — mathematically identical to the
   Section-5 split test, now at dataset scale. [DIRECTION — the one caveat that could force a
   second axis, exactly matching the forced-choice protocol's own blind]
5. **Preflight always:** `df --output=avail -BG /data` (not `/`); bulk datacaches on `/data`;
   never pollute the repo.

**Pitfall most likely to invalidate years of work:** a global (cross-content) correlation on a
per-group-labelled dataset (CVQAD-family) produces an inflated, meaningless number. **Always per-group
first, Fisher-Z aggregate.** This is the single most likely trap given all previous CVQAD work.

**Pitfall 2 (CORRECTED 2026-08-28):** the "3 bitrates (1000/2000/4000), no rung ≥4 Mbps" claim was
from the paper's nominal description, NOT the released labels. Direct disk inventory of the open
part CSV (1,962 rows, 60 sequences) shows 733 rows (37.4%) above 4000 kbps, p90 = 10,268, p99 =
18,745, max = 39,381 kbps, 233 rows above 10 Mbps (`christmas-cats-2021` x265-ref: 16.4 Mbps, MOS
7.90). Whether CVQAD contains a near-transparent rung is **an open, directly-testable question
(does per-sequence MOS saturate with bitrate?)** — do not rule it out by assumption, and do not
assume it either. What stays true: the anchor (SUR/transparency level) must still be verified
against an explicit-transparency dataset (BVI-HD QP22 / HFR-LS 15 Mbps / VideoSet JND), because
CVQAD's high rungs are sparse per sequence and unlabelled as "transparent". Note LEHA v2 claims
59 sources / 6,240 full / 1,963 open — disk inventory of the open part is 1,962 rows across
60 distinct sequence names; the +1/-1 discrepancy is a known v1/v2 data-card artifact, NOT a
processing error. [SOLID]

**Bottom line for the researcher:** yes, we can be told by other humans, automatically, whether our
complexity scale is squared-off — the input sets exist, two are on disk, the estimator is standard
psychometrics, and the only requirements are (i) per-group correlation discipline and (ii) verifying
any transparency claim against per-sequence saturation, not against the paper's nominal bitrate
card. [SOLID + DIRECTION where noted]

---

## Section 9 — External bound on `a` (compiles `01-exponent-bound.md`)

For the fitted exponent `a` in `log t_j = a·log c_j + k`, the published-verifiable external
constraint is:

- **`a ≤ 1` firm upper bound** for compressible (digital, low-grain) content, two independent
  derivations: (i) x264/x265 rate control embeds `1 − qCompress = 0.4` in
  `rate_factor_constant = pow(baseCplx, 1−qCompress)` and allocates bits ∝ complexity^0.6
  within an encode (both <1); (ii) Gaussian-source RD `R(D) = ½·log₂(σ²/D)` makes the
  rate-rate anchor **additive** (`t = c + Δ`), whose local power exponent is always in (0,1).
- **Central value ~0.6** (encoder-law family spans 0.4–0.85; RD-derived single-power fit over
  our 8.1× complexity range lands ≈0.6–0.75).
- **Film grain is the only documented upward class** — and only as multipliers, never an
  exponent: Netflix FGS 8,274→2,804 kbps (~2.95×), Norkin 2018 up to 50%, MulticoreWare 2026
  ~40% with maxima at low QPs (the near-transparent regime where our anchor sits).
- **Functional form matters:** theory predicts ADDITIVE (t = c+Δ) or log-in-variance, not a
  clean power law. Mandatory AIC/BIC comparison: power `c^a` vs additive `c+Δ` vs
  `½log₂(σ²/D)`-form, or the fitted `a` is the mean of two laws. A fitted `a>1` on clean
  content is externally falsified and would signal the grain class or a wrong form.
- **No paper publishes an across-title exponent on our exact axis** (x265 CRF-20 whole-title
  bpp); the closest anchors are the encoder law (0.4–0.6), RD theory (`≤1`, additive), and the
  JASLA/red265/Katsenou ML fits (no closed-form slope). Honest quote: **`a ≈ 0.6 ± 0.15`
  expected on clean content under the power-law form, steeper with grain-bearing titles.**
- **Grain/clean stratification is optional-to-load-bearing** here, matching §5/§8's split test.

Full source-level evidence: `01-exponent-bound.md` (279 lines, 16 primary sources).
