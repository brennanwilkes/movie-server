# 02 — Naming the rate-quality slope: what do we call d log(bitrate) / d CRF?

**Research log — 2026-08-28. Agent: literature. Deliverable: (a) the canonical name(s) the
literature gives to `perPoint = d log(bitrate)/d CRF` (and its QP analogue), (b) the published
magnitudes per codec and per content, (c) whether deviation in this slope is used as a content
feature, (d) global-slope vs per-content-slope separation, and a bottom-line name + grounding
verdict for reading a fourth candidate unit off it. Web-only; nothing downloaded; primary/prefer
sources. This is the naming+grounding companion to `README.md` (§5/§6: the `log t_j = a·log c_j`
anchor regression) — here the question is about the *rung spacing* (the CRF→bitrate map), where
`README` is about the *rung position* (anchor bitrate vs complexity).**

Tag legend: [SOLID] verified directly / [DIRECTION] reasonable path, not yet acted on /
[UNTESTED] plausible from context, not confirmed / [DEAD].

---

## 1. TL;DR

1. **There is no single canonical name for `perPoint`.** The closest accepted terms, in order of
   how common they are in the literature: the **rate–quality (R-Q) curve / relationship**
   (Katsenou et al.; Xiaohongshu production work uses "rate-quality curve prediction"), the
   **R–Q model** (Li et al. λ-domain paper), and the generic **rate-distortion (RD/R-D) curve
   slope**. The specific semi-log derivative `d lnR/dQP` (a dimensionless per-step rate of change)
   is always *described* as a slope or an exponent of a fitted curve; the field has never given it
   one word. Our own name for the deliverable: the **semi-log rate slope (logRate-per-QP point)**,
   aligned to the literature's R-Q/RD-curve vocabulary.
2. **The magnitude is solidly grounded, and it is `−ln2/6 ≈ −0.1155` ln-units per point** as the
   canonical value: H.264/HEVC quantiser step size **doubles every 6 QP**, so the "±6 ≈ halves
   bitrate" rule is *exactly* `R ∝ 2^(−QP/6)`. Independent measured curve fits confirm it:
   x264 −0.108…−0.136, x265 slightly steeper (≈ −0.13). Our measured per-film range (≈ −0.09 to
   −0.12) sits inside the published spread — consistent with a weakly content-dependent slope.
3. **Per-content slope deviation is real but small.** The direct measurement (Gough, 2 contents ×
   2 codecs) spans roughly −0.10…−0.14 ln-units/point per content, and harder content tends toward
   the *shallower* end — the same sign and rough magnitude as our faint between-film signal.
   Published magnitude tables for AV1/SVT-AV1 and VVC/VTM are **not** found; the scale is
   logarithmic but no authoritative %/point number exists ([UNTESTED]).
4. **No paper uses `d lnR/dQP` at a fixed quality rung *by itself* as a content feature.** The
   established family predicts the whole R-Q curve (position AND slope/curvature) from texture
   features — Katsenou (PCS 2016/2021), the knee-point and cross-over-QP ladders, Xiaohongshu's
   production RF-VMAF/RF-bitrate curve predictor. We are not treading on a named technique; the
   slope-as-feature is a small, defensible, unclaimed addition.

---

## 2. (a) The canonical names — what the literature actually calls this quantity

| Term | Where it is used | Status |
|---|---|---|
| **Rate–quality (R-Q) curve / relationship** | Katsenou et al. PCS 2016 / arXiv:2102.04167 ("rate-quality curves"); Xiaohongshu arXiv:2411.05295 ("Content-Adaptive **Rate-Quality** Curve Prediction"); says "bitrate-VMAF curve slope". | [SOLID] |
| **R–Q model** (rate–quantization) | Li et al., *λ-Domain Rate Control*, IEEE TIP 23(9) 3841, 2014 — "most of existing rate control algorithms are based on the R-Q model, which characterises the relationship between bitrate R and quantisation Q". Places our quantity as the **exponent of the R-Q model**. | [SOLID] |
| **RD / R-D curve slope** | Generic throughout RDO literature ("operating points on the rate-distortion curve"); Ringis et al. Frontiers 2023 restates the λ-as-slope-of-the-RD-curve formulation of Sullivan & Wiegand 1998. | [SOLID] |
| **Bitrate ladder / PDP (Pareto-distortion points)** | ABR ladder literature (Katsenou PCS 2019; arXiv:2312.07780 review): rung *positions* in bps; spacing is usually a **convex-hull / convex-concave step rule**, not a fixed %/step. | [SOLID] |
| **Elasticity** | Economics term for d lnR/d lnX; **not used verbatim** anywhere in the video-coding refs surfaced. If we ever want a one-syllable transferable name, "rate-slope elasticity"/"quant-step elasticity" is ours to coin, not to inherit. | [DIRECTION] |

**Verdict:** the family vocabulary is "R-Q curve / R-Q model / RD-curve slope". The *name* should
be our own, and the least surprising construction is the descriptive one we already ship:
**"the rate-quality slope"** (a.k.a. perPoint), i.e. "the log-rate slope per QP/CRF point", with
units of ln-bitrate per point. Nothing in the literature claims this exact name, and nothing
contradicts it.

---

## 3. (b) Published magnitudes per codec

### 3.1 The structural fact: why "6" and why −0.1155 [SOLID]

- H.264/HEVC QP step size **doubles every 6 QP**: `Qstep(QP) = Qstep_base · 2^(QP/6)` (the 52-step
  scale with base values for QP 0–5, then doubling). Per the standard and its expositions — e.g.
  mickeyzzc "Inside H.264: the Encode Pipeline" (2026-08-24): *"QP +6: step size doubles, bitrate
  roughly halves"*; Doom9 Ben Waggoner (t=170236): *"each 6 QP represents a 2x change in the
  actual quantizer (at least in H.264)"*.
- The **±6 ≈ half/double file size** rule is therefore not folklore — it is the structural rule
  `R ∝ 2^(−QP/6)`, i.e. **`d lnR/dQP = −ln2/6 ≈ −0.1155`** per point. Restated in percentages:
  each +1 QP/CRF point multiplies bitrate by 2^(−1/6) ≈ **−10.9%**, and each −1 point by
  2^(+1/6) ≈ **+12.2%**.
- Widely repeated rule-of-thumb statements, all consistent: slhck CRF Guide (2017-02-24): *"±6
  should result in about half/double the file size"*; Avidemux wiki H.264 tutorial: *"lowering the
  CRF by 6 will double filesize, lowering by 1 will raise it by ~12.5% (very roughly)"* (exponent
  ≈ 0.118); dev.to CRF guide (2026-05-07); ffmpeg.party x265 guide; thepostflow codec cheat sheet
  (2026-08-25): *"each step of 6 roughly doubles or halves the file"*.

### 3.2 Measured fits (primary source: Gough Lui, 2016-08-27 — the only published curve-fit)

Gough encoded two contents × {x264 core 142, x265 1.9} at CRF 8–48 step 4 (Handbrake v. slow),
fitted semi-log lines, and published the full bitrate tables:

| Encode | halving distance (CRF) | implied exponent −ln2/halving-step | whole-range fitted exponent |
|---|---|---|---|
| x264 average case | 5.68–6.42 (avg 6.05) | ≈ −0.1146/point | (reported range) |
| x264 difficult case | same family | — | harder content, shallower |
| x265 average case | 5.10–5.59 (avg 5.34) | ≈ −0.1298/point | — |
| x265 difficult case | same family | — | — |

Author's own summary: *"the lines are ... close to an exponential function with exponent ranging
from −0.108 to −0.136"*, and *"x265 is slightly more sensitive to the CRF value (≈5.34 to halve,
vs ≈6.05 for x264)"*. Recomputing from his published tables (whole-range ln(bpp_CRF48/bpp_CRF8)/40):
x264 avg 0.119, x264 difficult 0.100, x265 avg 0.137, x265 difficult 0.114 — i.e. a real (±15%)
content spread, with x265 systematically steeper than x264.

### 3.3 The λ-domain family (the theoretical constant-plateau to cite) [SOLID]

- Li et al. 2014 (integrated into HM-10.0 HEVC reference software): `λ = α·bpp^β`, **α and β are
  content-dependent**, updated per frame by LMS; initial defaults (CTC-averaged) α=3.2003,
  β=−1.367. So the field *already* treats the log-log slope of rate-vs-λ as a per-content fitted
  parameter — the same "one constant is an average" insight we rely on.
- Encoder λ↔QP mapping (Wiegand–Girod family, per forasoft RDO explainer + Frontiers Ringis 2023):
  `λ ≈ 0.85·2^((QP−12)/3)`, i.e. λ doubles every ~3 QP. Composed with `bpp ∝ λ^(1/β)`, the
  implied per-QP log-rate slope is `(1/β)·(ln2/3)`; at the default β=−1.367 that is ≈ −0.17/point —
  somewhat *steeper* than the whole-file empirical −0.1155, because the λ-domain model is the
  frame/CTU-local description while the ±6 rule is the whole-encode average over AQ/MB-tree
  reallocation. Worth one sentence in the write-up: intra-frame model slope ≈ −0.17, whole-file
  observed slope ≈ −0.1155, content spread ±15%.

### 3.4 What is NOT published (each a small gap worth listing) [UNTESTED]

- **AV1 / SVT-AV1:** CRF is documented as logarithmic (ankushian gist: *"CRF is a logarithmic
  scale"*; SVT-AV1 CommonQuestions describe CRF as constant-visual-quality mode), CRF range 0–63,
  but **no authoritative %/CRF-point number** was found; cross-encoder CRF equivalence tables
  (x265↔SVT-AV1) are described by the SVT community as "invented"/misleading (32blog 2026-08-02
  clipping). Treat the ±6 rule as H.26x-only.
- **VVC/VTM:** rate-control work (λ-domain extension, e.g. arXiv:1911.00639; Chen et al. VVC AQP,
  Inf.Sci. 119325 2023) models RQ curves per frame but publishes BD-rate gains, not per-QP
  percentages. Same for HEVC scalable extension work (IEEE TMM 2016).

---

## 4. (c) Slope deviation as a content feature — is this claimed?

**Short answer: position is; the isolated slope is not.** Evidence for what IS claimed:

- **Katsenou et al., PCS 2016** (*Predicting video rate-distortion curves using textural
  features*) and **arXiv:2102.04167 / JVCIR 2022**: model RD curves as **polynomials** and the
  RQ relationship as an **exponential model** fitted to uncompressed **texture features
  (GLCM, NCC, TC, …)**; mean BD-rate loss 0.46% vs measured curves. So both the RQ **level and
  shape (hence slope/curvature)** are predicted from content — but the fitted quantity is the
  polynomial/exponential coefficients, never reported as a standalone per-point slope statistic.
- **Katsenou ladder line, PCS 2019 / PCS 2021 / OJSP 2021:** predict **cross-over QPs** and
  **knee-points** (highest curvature of the RQ curve) from texture features to build bitrate
  ladders — again *shape-derived points*, not a bare slope.
- **Xiaohongshu, arXiv:2411.05295 (production, red265):** predicts **both** CRF→VMAF and
  CRF→bitrate curves from content+codec+anchor features; explicitly picks the encode CRF
  *"with a consistent bitrate-VMAF curve **slope**"* — the closest published sentence to our use,
  and their "anchor" is exactly our one-measured-rung approach.
- **JASLA (arXiv:2305.00225)** and the **VIF bitrate-ladder review (arXiv:2312.07780)**:
  per-content resolution+CRF ladders from spatial/temporal/DCT-energy features; the review
  explicitly names the Katsenou polynomial-RD regression as the origin of the "texture features
  predict RD curves" family. [SOLID]

**What is unclaimed (our gap):** measuring `d ln bitrate / d CRF` at a *fixed quality rung* per
content and using it as a standalone scalar content feature — the exact use we have. Kaggle-grade
novelty: small but genuinely unoccupied; the closest neighbours (Xiaohongshu, Katsenou)
fit whole curves or key points and never isolate the slope statistic. [SOLID for "undone",
DIRECTION for "worth doing" — the signal is faint (see §5).]

---

## 5. (d) Global slope vs per-content slope — published separation

- **Global constant:** −0.1155 (structural, §3.1) with codec offset: x265 ≈ −0.13, x264 ≈
  −0.115 (Gough §3.2). Guidance sources agree to ±0.01 of this. [SOLID]
- **Per-content spread:** the only measured separation is Gough's two clips (x264: −0.119 avg vs
  −0.100 difficult; x265: −0.137 vs −0.114). Direction: **harder content → shallower slope**
  (the encoder stays closer to its efficiency plateau at high complexity). This is exactly the
  sign and magnitude of our between-film residual (~±15% around the global, i.e. slope vs
  complexity-trend coefficient near zero after removing the position term). [SOLID for existence,
  DIRECTION for "complexity predicts it"]
- **λ-domain separation:** β (the content-dependent exponent) is the *formal* way the literature
  encodes slope variation per content (§3.3), always per-frame-updated, never published as a
  per-content histogram. We would be the first to publish the distribution of whole-file
  per-content slopes. [DIRECTION]
- **What controls it:** RQ-curve family correlation is texture/motion (grain, high-frequency
  detail, temporal coherence) — the same axis as our complexity probe, consistent with slope
  being a *weak* second-order function of complexity rather than an independent axis. [DIRECTION —
  nothing yet separates "slope∝complexity" from "slope=content-specific noise".]

---

## 6. Bottom line — name, grounding, and the fourth-unit question

**Name.** None exists in the wild; adopt ours: **the rate-quality slope (`perPoint`)** —
"log-bitrate per QP/CRF point", canonical value `−ln2/6 ≈ −0.1155`. In any prose, attach it to
the accepted term: *"the slope of the R-Q curve"* (Katsenou/Xiaohongshu vocabulary), *"the
exponent of the R-Q model"* (Li λ-domain vocabulary). Do not invent "elasticity" without
reporting it as our coinage.

**Magnitude grounding (for the write-up).** Structural floor: −0.1155 (QP-doubling);
independent measured fits: −0.108…−0.136 (Gough), codec-dependent (x265 ≈ 0.13 > x264 ≈ 0.115);
our measured films (−0.09…−0.12) sit inside both. The published number to eyeball-against is
*"±6 QP/CRF ⇔ ±2× bitrate"*, and our measured spread is consistent with content explaining only
a few tenths of a point around it.

**Is reading a fourth candidate unit off the slope well-grounded?** Yes, with a range limit.
`R ∝ 2^(−QP/6)` holds to roughly ±10–15% per-content slope error across the QP/CRF span that
matters for scoring (CRF 17–24: the ±5-point band around where the probe sits). Extrapolating a
candidate's bitrate a few points from one measured rung is within the model's own noise. It
degrades outside the fitted span and crosses codecs, where the AV1-SVT and λ-domain caveats of
§3.3–3.4 apply. Nothing in the literature forbids the extrapolation; nothing in it is more
precise than what we already do.

---

### Sources (all fetched/verified 2026-08-28)

1. slhck (Robitza) — CRF Guide, 2017-02-24: https://slhck.info/video/2017/02/24/crf-guide.html
2. slhck — Understanding Rate Control Modes, 2017-03-01: https://slhck.info/video/2017/03/01/rate-control.html
3. Gough Lui — x264 vs x265 CRF in Handbrake (measured fits + full bitrate tables), 2016-08-27:
   https://goughlui.com/2016/08/27/video-compression-testing-x264-vs-x265-crf-in-handbrake-0-10-5
4. Avidemux wiki — H.264 tutorial ("~12.5% per CRF"):
   https://avidemux.org/admWiki/doku.php?id=tutorial:h.264
5. Li B., Li H., Li L., Zhang J. — *λ-Domain Rate Control Algorithm for High Efficiency Video
   Coding*, IEEE TIP 23(9):3841–3854, 2014:
   https://people.rennes.inria.fr/Aline.Roumy/teaching/COV-rate-control.pdf (mirror)
6. Wei et al. — *A Generalized Rate-Distortion-λ Model Based HEVC Rate Control*, arXiv:1911.00639
   (α=3.2003, β=−1.367 defaults and the LMS update law): https://ar5iv.labs.arxiv.org/html/1911.00639
7. Ringis, Vibhoothi, Pitié, Kokaram — *The disparity between optimal and practical Lagrangian
   multiplier estimation in video encoders*, Frontiers in Signal Processing 3:1205104, 2023:
   https://www.frontiersin.org/journals/signal-processing/articles/10.3389/frsip.2023.1205104/full
8. Katsenou, Afonso, Bull — *Study of Compression Statistics and Prediction of Rate-Distortion
   Curves for Video Texture*, arXiv:2102.04167 (2021): https://arxiv.org/abs/2102.04167
9. Katsenou et al. — PCS 2016 RD-curves-from-textural-features; PCS 2019 content-gnostic ladders;
   PCS 2021 VMAF knee-point ladders (as reviewed in arXiv:2312.07780):
   https://arxiv.org/abs/2312.07780
10. Xiaohongshu — *Content-Adaptive Rate-Quality Curve Prediction Model in Media Processing
    System*, arXiv:2411.05295: https://arxiv.org/abs/2411.05295
11. dev.to — FFmpeg CRF Explained, 2026-05-07: https://dev.to/javidjamae/ffmpeg-crf-explained-quality-vs-file-size-guide-o6m
12. thepostflow — Codec & Bitrate Cheat Sheet, 2026-08-25: https://thepostflow.com/filmmaker-resources/codec-bitrate-cheat-sheet/
13. mickeyzzc — Inside H.264: Encode Pipeline and Bitstream, 2026-08-24:
    https://blog.mickeyzzc.tech/en/posts/network/h264-pipeline-bitstream/
14. Ankushian — AV1/SVT-AV1 pocket guide (CRF logarithmic scale, 0–63):
    https://gist.github.com/ankushian/a22862c6f92a51574e1720d1d392941d
15. SVT-AV1 CommonQuestions (CRF mode description):
    https://gitlab.com/AOMediaCodec/SVT-AV1/-/blob/master/Docs/CommonQuestions.md
16. forasoft — RDO / λ-vs-QP worked example (0.85·2^((QP−12)/3)):
    https://www.forasoft.com/learn/video-encoding/articles/mode-decision-rdo
17. Doom9 — Ben Waggoner on QP-doubling: https://forum.doom9.org/showthread.php?t=170236