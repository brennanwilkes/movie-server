# Video Compression Artifact Inventory — Combined Report

**Date:** 2026-08-26
**Sources:** Academic/industry taxonomy, community/practitioner knowledge, no-reference metrics survey, ffmpeg/libvmaf tooling inventory, source-quality artifacts
**Scope:** H.264/H.265 Bluray/WEB-DL, 2–8 Mbps, 1080p. No access to original uncompressed masters. No DVDs, no SD, no analog sources.
**Library context:** ~870 movies, ~1700 episodes. Median BPP+ 69 (about half the bits of a CRF-20 transparent encode). 90% of files sit below CRF-20 transparency.

---

## 1. Executive Summary

**29 unique artifacts** were identified across all 5 source reports. After deduplication and filtering for relevance to our library, **19 are concretely applicable** — artifacts that could realistically appear in H.264/H.265 encodes at 2–8 Mbps 1080p. Of these:

- **4 DETECTED** (we have working detectors): banding, blocking, blur, grain/noise loss
- **2 PARTIAL** (something measures them but not well): ringing, quantization noise
- **5 HIGH-PRIORITY GAPS**: mosquito noise, flickering, color bleeding, chroma banding, ghosting
- **5 MEDIUM-PRIORITY GAPS**: floating, texture loss (specific waxy variant), dark-scene shadow crush, HDR/SDR conversion, temporal jitter
- **3 LOW-PRIORITY GAPS**: staircase/aliasing, gradient reversal, SAO over-smoothing attribution

### What we detect today

| Detector | Artifact | Production? |
|----------|----------|:-----------:|
| CAMBI (libvmaf) | Banding/contouring | Yes |
| blockdetect (ffmpeg) | DCT-grid blocking | Yes |
| blurdetect (ffmpeg) | Blur / edge softening | Yes |
| Custom residual analysis | Grain/noise loss | Yes |

### Gaps ranked by priority

1. **Mosquito noise / edge busyness** — HIGH. Visible on moving edges at 2–6 Mbps. No dedicated filter; needs custom edge+temporal pipeline. Affects most content with sharp edges over flat backgrounds.
2. **Temporal flickering / I-frame flicker** — HIGH. Periodic quality jumps at GOP boundaries. Detectable via frame-to-frame variance in static regions using signalstats YDIF. Affects all content with GOP structures.
3. **Chroma banding** — HIGH. Our CAMBI is explicitly luma-only. Color gradients break into visible steps in chroma channels. Common in dark saturated scenes (sunsets, colored lighting).
4. **Color bleeding (4:2:0)** — HIGH. Universal in 4:2:0 subsampled video. Detectable by comparing chroma vs luma edge sharpness. Only clearly visible with saturated color boundaries (text, graphics, animation).
5. **Ghosting / trailing** — HIGH. Official scene nuke reason. Visible as displaced copies behind moving objects. No good open-source detector exists. Hardware encoders worst.
6. **Floating / texture instability** — MEDIUM. Texture that shimmers frame-to-frame due to energy imbalance. Research metric EDI exists but no ffmpeg tool.
7. **Quantization noise in dark scenes** — MEDIUM. Distinct from general banding/blocking; dark areas where quantization errors are proportionally large. Partially covered by banding detector but not specifically targeted.
8. **HDR/SDR conversion artifacts** — MEDIUM. Clipped highlights, washed-out colors, wrong color matrix. Detectable via metadata verification (ffprobe) and histogram analysis.
9. **Temporal jitter / motion inconsistency** — MEDIUM. Encoder's motion estimation fails, objects jitter despite smooth original. Content-dependent (crowds, water, foliage).
10. **Upscale detection** — LOW for our library (mostly native Bluray/WEB-DL) but HIGH for BPP accuracy. Detectable via FFT/resdet but requires external tools.
11. **SAO over-smoothing** — LOW. Manifests as blur/texture loss; already caught by blurdetect but not attributed to cause. HEVC-only.
12. **Skin tone degradation** — LOW. Requires skin detection + quality measurement. No dedicated filter. Combination of blur + chroma + quantization already caught by individual detectors.
13. **Deblocking filter artifacts** — LOW. Over-deblocking loses detail; under-deblocking leaves blocking. The balance tradeoff. No dedicated detector.
14. **Gradient reversal / Mach bands** — LOW. Rare at target bitrates. False edges in smooth gradients from DCT quantization + HVS interaction.
15. **Spatial aliasing / staircase** — LOW. Jagged diagonal lines from block grid. Only visible on thin diagonal features at moderate bitrates.
16. **Frame dropping** — NOT APPLICABLE. Rare at 1080p 2–8 Mbps. More a transport issue than compression.
17. **Judder / stutter** — NOT APPLICABLE. Transport issue, not compression. Requires knowing intended frame timing.
18. **CDEF artifacts (VVC)** — NOT APPLICABLE. VVC/H.266 not in our library.
19. **Chroma color moiré** — LOW. False color fringes on fine periodic patterns. Very content-dependent.

---

## 2. Complete Artifact Inventory

### Spatial / Single-frame Artifacts

| Artifact | Category | What causes it | Visible at 2–8 Mbps 1080p? | No-reference detectable? | ffmpeg/libvmaf tool | Current status | Priority |
|----------|----------|----------------|:--------------------------:|:------------------------:|---------------------|:--------------:|:--------:|
| **Blocking** (macroblocking, tiling, mosaic) | Spatial | Independent DCT quantization per block creates visible 8×8/16×16 grid seams | < 4 Mbps on smooth content; > 4 Mbps only in high motion | Easy | `blockdetect` (ffmpeg) | **DETECTED** | CRITICAL |
| **Banding** (contouring, posterization, false contouring) | Spatial | Insufficient bit depth for smooth gradients; quantization creates discrete intensity steps | Persists at ALL bitrates on 8-bit encodes; 10-bit largely solves it | Easy–Medium | CAMBI (libvmaf) | **DETECTED** | CRITICAL |
| **Ringing** (haloing, Gibbs phenomenon, overshoot/undershoot) | Spatial | Truncation of high-frequency DCT coefficients near sharp edges creates oscillation | < 6 Mbps on high-contrast edges; > 8 Mbps mostly invisible | Medium | ADM (libvmaf, FR only); `edgedetect` chain possible | **PARTIAL** | HIGH |
| **Blur / detail loss** (softness, texture smearing, wet patches) | Spatial | Quantization of high-frequency DCT coefficients; aggressive deblocking; denoising | Progressive from 2–8 Mbps; worst on textured content | Medium | `blurdetect` (ffmpeg) | **DETECTED** | CRITICAL |
| **Texture loss / waxy artifacts** (wood grain, plastic look, wet patches) | Spatial | Aggressive quantization of mid-frequency DCT coefficients; SAO in HEVC; denoising pre-filters | < 8 Mbps progressive; < 4 Mbps very noticeable | Medium | VIF scales (FR); no dedicated NR detector | **PARTIAL** | MEDIUM |
| **Quantization noise** (granulation, rounding noise) | Spatial | Rounding errors in inverse DCT; quantization step size visible in flat regions | < 4 Mbps in flat regions; < 6 Mbps in dark regions | Medium | `bitplanenoise`; noise-level estimation research | **PARTIAL** | MEDIUM |
| **Gradient reversal / Mach bands** | Spatial | Interaction between DCT quantization and HVS edge enhancement creates false edges in gradients | Rare at target bitrates; more common at very low bitrates | Hard | None | **GAP** | LOW |
| **Spatial aliasing / staircase** (jaggies) | Spatial | Block grid interacting with diagonal features; insufficient spatial resolution | < 6 Mbps on thin diagonal features | Hard | None (edge analysis possible) | **GAP** | LOW |

### Temporal Artifacts

| Artifact | Category | What causes it | Visible at 2–8 Mbps 1080p? | No-reference detectable? | ffmpeg/libvmaf tool | Current status | Priority |
|----------|----------|----------------|:--------------------------:|:------------------------:|---------------------|:--------------:|:--------:|
| **Floating / instability** (texture shimmer) | Temporal | Mismatch between spatial and temporal energy; per-frame quality variation | < 6 Mbps on textured content | Medium–Hard | EDI (research only); temporal variance of spatial energy | **GAP** | MEDIUM |
| **Flickering** (temporal fluctuation, I-frame flicker, breathing) | Temporal | Hierarchical B-frame prediction; rate control allocating different bits per frame; I/inter quality discontinuity | < 6 Mbps as periodic quality changes; visible at CRF 20+ in static areas | Medium | `signalstats` YDIF; frame-by-frame quality variance; `photosensitivity` for rapid luminance changes | **GAP** | HIGH |
| **Edge busyness** (mosquito noise, edge shimmer, edge flutter) | Temporal + Spatial | Motion compensation errors at edges; different ringing patterns per frame | < 6 Mbps on moving edges; very common with sharp text/logos over flat backgrounds | Hard | No dedicated filter; custom `edgedetect` → temporal difference chain | **GAP** | HIGH |
| **Ghosting** (motion ghosting, trailing, comet tail) | Temporal | Stale reference frames in motion compensation; aggressive temporal denoising | Any bitrate if encoder motion compensation is poor; hardware encoders worst | Hard | No good open-source detector exists | **GAP** | HIGH |
| **Temporal jitter** (motion inconsistency) | Temporal | Encoder motion estimation fails to maintain consistent vectors; different prediction modes for co-located blocks | Moderate compression; worst with complex/irregular motion (crowds, water, foliage in wind) | Hard | Motion trajectory analysis (no tool) | **GAP** | MEDIUM |

### Chroma Artifacts

| Artifact | Category | What causes it | Visible at 2–8 Mbps 1080p? | No-reference detectable? | ffmpeg/libvmaf tool | Current status | Priority |
|----------|----------|----------------|:--------------------------:|:------------------------:|---------------------|:--------------:|:--------:|
| **Color bleeding** (chroma bleeding, chroma smearing) | Chroma | 4:2:0 chroma subsampling (half horizontal + half vertical resolution); coarse chroma quantization | Always present structurally; visible at < 6 Mbps with sharp color boundaries (animation, graphics, text) | Hard | No dedicated detector; CIEDE2000 (FR only) for global color | **GAP** | HIGH |
| **Chroma banding** (chrominance banding, color posterization) | Chroma | Insufficient chroma bit depth (4:2:0 + 8-bit); aggressive chroma quantization in smooth color gradients | < 6 Mbps on smooth color gradients; visible in sunsets, colored lighting, skin tones | Medium | CAMBI is luminance-only; CBAND metric (research, 2026); chroma-plane CAMBI extension possible | **GAP** | HIGH |
| **Skin tone degradation** | Chroma + Spatial | Combination of blurring + chroma subsampling + quantization; skin is highly sensitive to all three | < 8 Mbps progressive; < 4 Mbps very noticeable on faces | Hard | None; requires skin detection + regional quality measurement | **GAP** | LOW |

### Codec-Specific Artifacts

| Artifact | Category | What causes it | Visible at 2–8 Mbps 1080p? | No-reference detectable? | ffmpeg/libvmaf tool | Current status | Priority |
|----------|----------|----------------|:--------------------------:|:------------------------:|---------------------|:--------------:|:--------:|
| **SAO over-smoothing** (HEVC only) | Codec | Sample Adaptive Offset erases fine texture, skin detail, film grain when too aggressive | Most visible at CRF < 20 (high quality); at lower quality SAO's benefits may outweigh costs | Hard | Manifests as blur — caught by `blurdetect` but not attributed | **PARTIAL** | LOW |
| **Transform boundary / quadtree boundary** (multi-scale blocking) | Codec | Flexible quadtree partitioning in HEVC/VVC; boundaries between different-sized blocks visible | < 6 Mbps on smooth regions; visible at multiple scales (4×4 to 32×32) | Medium | `blockdetect` captures single-scale only; multi-scale needs custom analysis | **PARTIAL** | LOW |
| **Deblocking filter artifacts** | Codec | Deblocking filter strength too strong (loses detail) or too weak (leaves blocking) | < 6 Mbps the balance tradeoff is visible | Hard | None; the filter's effect on legitimate edges is hard to measure | **GAP** | LOW |

### Source-Quality Artifacts

| Artifact | Category | What causes it | Visible at 2–8 Mbps 1080p? | No-reference detectable? | ffmpeg/libvmaf tool | Current status | Priority |
|----------|----------|----------------|:--------------------------:|:------------------------:|---------------------|:--------------:|:--------:|
| **Upscale detection** (fake 1080p from 720p/480p) | Source | Source was scaled from lower resolution; interpolation creates soft image with frequency cutoff | Visible as soft image despite nominal resolution; absent fine detail | Yes (FFT-based) | `resdet` (C), `video-fft` (Python), `getnative` (VapourSynth) | **GAP** | MEDIUM |
| **HDR/SDR conversion artifacts** | Source | Incorrect tone mapping from HDR master; color matrix mis-tagging; clipped highlights; washed-out appearance | Moderate for WEB-DL from HDR masters; wrong color matrix shifts entire image | Yes (metadata + histogram) | `ffprobe` (color tags); `signalstats` (clipping); histogram analysis | **GAP** | MEDIUM |
| **Dark-scene shadow crush / black level clipping** | Source + Spatial | 8-bit quantization in dark range; incorrect signal range (full vs limited); aggressive contrast | Very common — almost every film has dark scenes | Yes (histogram + signalstats) | `signalstats` YMIN; histogram; `colordetect` (range) | **GAP** | MEDIUM |

---

## 3. Coverage Matrix

### What our 4 detectors catch vs. what they miss

| Detector | Artifacts it catches | Artifacts it MISSES |
|----------|---------------------|---------------------|
| **CAMBI** (banding) | Luma banding, contouring, posterization in smooth gradients | **Chroma banding** (luma-only), ringing, mosquito noise, texture loss, any temporal artifact, dark-scene-specific issues |
| **blockdetect** (blocking) | DCT-grid blocking, periodic spatial grid pattern | Multi-scale quadtree blocking (HEVC), texture loss from blocking, mosquito noise around edges, temporal flickering at block level |
| **blurdetect** (blur) | Edge softening, gross detail loss, SAO over-smoothing (as blur) | Texture loss (waxy variant distinct from optical blur), ringing (edges too sharp, not too soft), motion blur, temporal artifacts |
| **Grain/noise residual** | Film grain loss, noise floor changes, frozen grain (partial) | Quantization noise vs original grain distinction, chroma noise, dark-scene noise specifically, temporal noise amplification |

### Combined gap summary

```
Artifacts we detect:          4 / 19  (21%)
Artifacts partially covered:  3 / 19  (16%)
Artifacts with no coverage:  12 / 19  (63%)

CRITICAL gaps (affects many films):
  - Chroma banding (CAMBI blind spot — luma only)
  - Temporal flickering (no temporal detector at all)

HIGH gaps (affects some films):
  - Mosquito noise / edge busyness
  - Color bleeding
  - Ghosting / trailing
```

---

## 4. Detection Feasibility

For each gap artifact, what would it take to detect it with our existing ffmpeg build (n8.1 with libvmaf, no vmaf CLI, no Python tools inside the probe path).

### HIGH Priority Gaps

#### Mosquito noise / edge busyness

| Aspect | Detail |
|--------|--------|
| **Available tools** | `edgedetect` (Canny) + `tblend` (temporal difference) + `signalstats` (YDIF) |
| **Estimated CPU cost** | Medium — edge detection + temporal blend per frame; ~2–3× baseline per clip |
| **Single vs multi-frame** | Multi-frame (temporal) — the shimmer only manifests in motion |
| **Concrete approach** | (1) Extract Canny edge map per frame. (2) Compute temporal difference of edge map: `edgedetect → tblend=all_mode=difference`. (3) Measure mean/variance of difference in edge regions. (4) High variance = temporal edge instability = mosquito noise. Alternative: `photosensitivity` filter captures rapid luminance oscillations that correlate with edge busyness, much simpler. |
| **Validation challenge** | No ground truth available; threshold calibration against subjective scores needed |

#### Temporal flickering / I-frame flicker

| Aspect | Detail |
|--------|--------|
| **Available tools** | `signalstats` (YDIF, VDIF per frame); `tblend` for temporal difference; `entropy` for frame-to-frame information variance |
| **Estimated CPU cost** | Low — `signalstats` is already lightweight and per-frame |
| **Single vs multi-frame** | Multi-frame — requires measuring variance of quality metrics across frames |
| **Concrete approach** | (1) Run `signalstats` to get per-frame YDIF (luma frame-to-frame difference). (2) In static/low-motion regions (identified by low YDIF), track brightness/texture variance over time. (3) Sudden periodic quality jumps (at GOP boundaries) appear as variance spikes. (4) Alternative: extract per-frame `entropy` and look for periodic drops aligned with I-frame positions. Even simpler: `photosensitivity` filter already detects rapid luminance changes. |
| **Simpler first step** | Just run `signalstats` YDIF and compute its coefficient of variation across the clip. High CV = temporal instability. |

#### Chroma banding

| Aspect | Detail |
|--------|--------|
| **Available tools** | `extractplanes` to isolate U/V planes; CAMBI can run on any grayscale input |
| **Estimated CPU cost** | Medium — CAMBI must run twice more (once per chroma plane, upscaled to luma-like format) |
| **Single vs multi-frame** | Single-frame (same as luma CAMBI) |
| **Concrete approach** | (1) Extract U and V planes via `extractplanes=planes=u,v`. (2) Convert each to a luma-like 8-bit grayscale representation. (3) Run CAMBI on each chroma plane. (4) Report max(CAMBI_luma, CAMBI_Cb, CAMBI_Cr). This doubles/triples the CAMBI compute but is straightforward. The CBAND paper (arxiv 2508.08700, 2026) proposes a CNN-based alternative but it requires a trained model we don't have. |
| **Risk** | CAMBI may not be well-calibrated for chroma planes (designed for luminance CSF). Needs validation. |

#### Color bleeding (4:2:0 subsampling)

| Aspect | Detail |
|--------|--------|
| **Available tools** | `edgedetect` (Canny) on luma vs chroma planes; `extractplanes` |
| **Estimated CPU cost** | Medium — edge detection on two planes + comparison |
| **Single vs multi-frame** | Single-frame |
| **Concrete approach** | (1) Extract luma edge map. (2) Upsample chroma to luma resolution. (3) Extract chroma edge map. (4) Compare edge sharpness (width of edge spread) between luma and chroma. (5) If chroma edges are significantly softer than luma beyond expected 4:2:0 degradation, flag as color bleeding. Only relevant for content with sharp color boundaries. |
| **Practical concern** | 4:2:0 universally softens chroma edges — need a threshold above "expected" softness |

#### Ghosting / trailing

| Aspect | Detail |
|--------|--------|
| **Available tools** | `tblend` (frame difference); `vidstabdetect` (motion vectors) |
| **Estimated CPU cost** | High — requires motion-compensated frame differencing |
| **Single vs multi-frame** | Multi-frame (temporal) |
| **Concrete approach** | (1) Compute frame-to-frame difference. (2) Shift difference by estimated motion vector. (3) Residual after motion compensation = ghost. Very difficult to do well without proper motion estimation. `vidstabdetect` outputs transforms not per-pixel MVs. |
| **Assessment** | No good open-source NR ghost detector exists. This is a HARD gap. Community and academic sources agree this is difficult. Scene groups flag it as a nuke reason but detect it by eye. |
| **Alternative** | Skip dedicated detection. Rely on the fact that ghosting correlates with high bitrate + poor encode — our BPP/BPP+ already penalizes low bitrate. A very ghosted file will also score poorly on blur and blocking. |

### MEDIUM Priority Gaps

#### Floating / texture instability

| Aspect | Detail |
|--------|--------|
| **Available tools** | `signalstats` (temporal variance); custom variance-of-spatial-energy metric |
| **Estimated CPU cost** | Medium — requires computing spatial energy per frame then temporal variance |
| **Single vs multi-frame** | Multi-frame |
| **Concrete approach** | (1) Per frame, compute local variance (texture energy) in sliding windows. (2) Track the variance of this energy across frames. (3) High temporal variance of spatial energy = floating. Research metric EDI (Wang et al. 2014) implements this but is not available as a tool. |
| **Assessment** | Subtle artifact; lower bang-for-buck than mosquito noise or flickering |

#### Quantization noise in dark scenes

| Aspect | Detail |
|--------|--------|
| **Available tools** | `signalstats` (YMIN for darkness detection); `bitplanenoise` for noise floor; `entropy` |
| **Estimated CPU cost** | Low |
| **Single vs multi-frame** | Both — single-frame noise level + temporal variation |
| **Concrete approach** | (1) Identify dark regions via `signalstats` (YMIN, YAVG). (2) In dark frames, measure noise via `bitplanenoise` or temporal difference. (3) High noise in dark regions = quantization noise amplified by encoder AQ. Partially covered by existing banding detection but not specifically targeted. |

#### HDR/SDR conversion artifacts

| Aspect | Detail |
|--------|--------|
| **Available tools** | `ffprobe` (metadata); `signalstats` (BRNG, clipping); `colordetect` (range) |
| **Estimated CPU cost** | Negligible — ffprobe + signalstats |
| **Single vs multi-frame** | Single-frame |
| **Concrete approach** | (1) `ffprobe` color_space/color_transfer/color_primaries for consistency check. (2) `signalstats` to count clipped highlights (Y >= 235 in limited range). (3) Histogram check for crushed blacks (spike at luma=16). (4) `colordetect` for full/limited range mismatch. |

#### Temporal jitter / motion inconsistency

| Aspect | Detail |
|--------|--------|
| **Available tools** | `vidstabdetect` (motion transforms); frame-to-frame PTS analysis |
| **Estimated CPU cost** | High — motion estimation per frame |
| **Single vs multi-frame** | Multi-frame |
| **Concrete approach** | (1) Extract motion vectors via `vidstabdetect`. (2) Check for sudden changes in motion vector direction/magnitude at co-located blocks. (3) High inter-frame motion inconsistency = jitter. Content-dependent — crowds, water, foliage in wind naturally have high motion variability. |
| **Assessment** | Very hard to distinguish from natural motion. Low practical value. |

#### Upscale detection

| Aspect | Detail |
|--------|--------|
| **Available tools** | `resdet` (external C tool), `video-fft` (external Python tool) |
| **Estimated CPU cost** | Low — single-frame FFT analysis |
| **Single vs multi-frame** | Single-frame (sampled) |
| **Concrete approach** | (1) Extract representative frame as Y4M. (2) Run `resdet` for DCT zero-crossing upscale detection. (3) Reports native resolution guess + confidence. Requires installing `resdet` binary. |
| **Assessment** | HIGH value for BPP accuracy (upscale inflates bpp numerator). LOW practical frequency — most of our content is native. |

### LOW Priority Gaps

| Artifact | Best approach | Assessment |
|----------|--------------|------------|
| **SAO over-smoothing** | Already caught by `blurdetect` as blur | No need for separate detector; attribution to SAO requires codec metadata |
| **Gradient reversal / Mach bands** | Local gradient monotonicity analysis; no tool exists | Very rare at our bitrates; skip |
| **Spatial aliasing / staircase** | Edge orientation analysis on diagonals | Low visibility; skip |
| **Deblocking filter artifacts** | Measure filter effect on legitimate edges | Hard to distinguish from encoding blur; skip |
| **Skin tone degradation** | Skin detection + regional quality | Need face detection; low standalone value |
| **Chroma color moiré** | Color pattern vs luminance pattern mismatch | Very content-specific; skip |

---

## 5. Recommended Next Steps

Ranked by: (1) how many films it affects, (2) how noticeable the artifact is, (3) how feasible detection is, (4) whether it fills a real gap vs redundant with existing detectors.

### Tier 1 — Deploy now (low effort, high value)

1. **Temporal flickering via signalstats YDIF** — Near zero additional CPU. Run `signalstats` on every clip (already planned for other uses). Compute coefficient of variation of YDIF across frames. High CV = temporal instability. This is free and catches I-frame flicker and quality pumping. **Fills the biggest gap: zero temporal detection today.**

2. **Chroma banding via CAMBI on chroma planes** — Run CAMBI on `extractplanes=u` and `extractplanes=v` (upscaled to grayscale). Doubles/triples CAMBI compute but piggybacks on existing infrastructure. **Fills the second-biggest gap: CAMBI is explicitly luma-only.**

3. **Dark-scene shadow crush via signalstats + colordetect** — Negligible CPU. Check `signalstats` YMIN for black floor, `colordetect` for range mismatch, histogram spike at luma=16. Already have the tools. **Common complaint, easy detection.**

4. **HDR/SDR metadata verification via ffprobe** — Negligible CPU. Check color_space/color_transfer/color_primaries consistency. Flag mismatches. **Trivial to add, catches a real class of global color errors.**

### Tier 2 — Build next (moderate effort, fills real gaps)

5. **Mosquito noise via edgedetect + temporal analysis** — Medium CPU. Extract Canny edges, compute temporal variance of edge regions. Or simpler: run `photosensitivity` as a fast proxy for rapid luminance oscillations. **Fills the biggest spatial+temporal gap with no existing coverage.**

6. **Chroma color bleeding via chroma/luma edge comparison** — Medium CPU. Compare edge sharpness between luma and chroma planes. Only meaningful for content with sharp color boundaries. **Fills a real gap for animation and graphic-heavy content.**

7. **Upscale detection via resdet** — Low CPU, single-frame. Install `resdet` binary. Run on sampled frames. **High value for BPP accuracy; upscaled content has inflated bpp numerator.**

### Tier 3 — Research/defer (hard, low bang-for-buck)

8. **Ghosting** — No good open-source detector. Scene groups detect by eye. Our BPP scoring already penalizes low bitrate which correlates with ghosting. Defer.

9. **Floating / texture instability** — Requires custom spatial-energy temporal variance metric. Research only (EDI). Defer until Tier 1–2 are deployed.

10. **Temporal jitter** — Nearly impossible to distinguish from natural motion content. Defer.

### What NOT to add

- **BRISQUE/NIQE via pyiqa** — Non-commercial license. Per-image, not per-video. NTIA found Pearson correlations of only 0.0–0.63 against ground truth. The "completely blind" claim is overpromising. Use as a general health signal only if license is acceptable.
- **Deep-learning NR metrics (MUSIQ, MANIQA)** — Need GPU, non-commercial license, no ffmpeg integration. Not practical for our pipeline.
- **SAO attribution** — Already caught by blurdetect. No need to know it's SAO specifically.
- **Skin tone degradation** — Would require face detection. The constituent artifacts (blur + chroma + quantization) are already caught individually.
- **Gradient reversal / Mach bands / spatial aliasing** — Too rare at 2–8 Mbps to justify detector development.
- **Deblocking filter artifacts** — The balance tradeoff is inherent to encoding. No actionable insight from detecting it.

---

## 6. References

### Standards

1. ITU-T P.10 (09/2022) — "Vocabulary for performance, quality, and service definitions"
2. ITU-T P.910 (04/2022) — "Subjective assessment methods for multimedia quality"
3. ITU-T P.930 — "Reference impairment system definitions" (artifact definitions including mosquito noise)
4. ITU-R BT.500 (01/2023) — "Methodology for subjective assessment of television picture quality"
5. VCEG-M33/M35/M52 — MPEG/VCEG artifact taxonomy (spatial and temporal distortions)

### Key Papers

6. Wang et al. (2014) — "Characterizing Perceptual Artifacts in Compressed Video Streams" (HVEI) — floating, edge busyness, temporal artifacts
7. Mumedyan et al. (2020) — "CAMBI: A No-Reference Banding Artifact Detector" (Netflix, PCS 2021)
8. Li et al. (2016) — "VMAF: A Perceptual Video Quality Model Based on Visual Signal Fidelity and Spatiotemporal Effects"
9. Mittal et al. (2012) — "No-Reference Image Quality Assessment in the Spatial Domain" (BRISQUE, IEEE TIP)
10. Mittal et al. (2013) — "Making a Completely Blind Image Quality Analyzer" (NIQE, IEEE SPL)
11. Marziliano et al. (2002) — "A No-Reference Perceptual Blur Metric" (blurdetect)
12. Muijs & Kirenko (2005) — "A No-Reference Blocking Metric for Coded Video" (blockdetect)
13. Zhang et al. (2018) — "SpatioTemporal Feature Integration and Model Fusion for Full Reference Video Quality Assessment" (ST-VMAF, T-VIF, T-SpEED)
14. Uzair et al. (2020) — "Comprehensive Overview of Classical and New Perceivable Artifacts in Compressed Video Streams"
15. CBAND metric (arxiv 2508.08700, 2026) — CNN-based banding detection including chroma channels
16. NTIA/ITS — "No Reference Video Quality Metrics — Overview" (26 independent evaluations, Pearson 0.0–0.63)

### Tools & Software

17. **CAMBI** — github.com/Netflix/vmaf (libvmaf feature, BSD)
18. **blockdetect / blurdetect** — ffmpeg built-in filters (LGPL/GPL)
19. **resdet** — github.com/0x09/resdet (upscale detection via DCT zero-crossings)
20. **video-fft** — github.com/slhck/video-fft (upscale detection via FFT magnitude spectrum)
21. **getnative** — github.com/Infiziert90/getnative (native resolution finder, VapourSynth)
22. **pyiqa** — github.com/chaofengc/IQA-PyTorch (30+ NR metrics, non-commercial license)
23. **scikit-video** — scikit-video.org (V-BLIINDS, VIIDEO, NIQE, BRISQUE — unmaintained)
24. **viser-quality** — docs.rs/crate/viser-quality (Rust NR: sharpness, blockiness, noise, NIQE, BRISQUE)
25. **oximedia_quality** — github.com/oximedia/oximedia-quality (Rust: mosquito noise, ringing, block boundary detection)
26. **ntsc-rs** — github.com/valadaptive/ntsc-rs (analog artifact simulator for reference)

### Community Sources

27. Doom9 forums — "Compression Artifacts" thread, "Visually lossless encoding" thread, x264 vs x265 grain comparison
28. JET Encoding Guide — x265 parameters (jaded-encoding-thaumaturgy.github.io)
29. Codec Wiki — x265 encoder guide, spotting video artifacts (wiki.x266.mov, codecs.wiki)
30. Fora Soft — Compression Artifact Field Guide (forasoft.com)
31. Scene Rules — 2007/2008/2011/2014/2020 x264/x265/Blu-ray standards (scenerules.org)
32. AVNetwork — "Compression Artifacts: Why Video Looks Bad" (2017)

---

*Document version: 1.0 | Created: 2026-08-26 | Sources: 5 research reports merged and deduplicated*
