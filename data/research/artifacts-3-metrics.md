# No-Reference Quality Metrics & Artifact Detection — Complete Survey

**Date:** 2026-08-26
**Context:** Building a no-reference artifact detection system for 1080p Bluray/WEB-DL encodes (H.264/H.265, 2–8 Mbps). No access to original uncompressed masters. Current detectors: CAMBI (banding), blockdetect, blurdetect, custom residual/grain analysis.

---

## Table of Contents

1. [libvmaf Feature Extractors](#1-libvmaf-feature-extractors)
2. [FFmpeg Built-in No-Reference Filters](#2-ffmpeg-built-in-no-reference-filters)
3. [BRISQUE](#3-brisque)
4. [NIQE](#4-niqe)
5. [Custom FFmpeg Filter Chains](#5-custom-ffmpeg-filter-chains)
6. [External / Open-Source Tools](#6-external--open-source-tools)
7. [Temporal Metrics](#7-temporal-metrics)
8. [Summary & Recommendations](#8-summary--recommendations)
9. [References](#9-references)

---

## 1. libvmaf Feature Extractors

Source: https://github.com/Netflix/vmaf/blob/master/resource/doc/features.md

libvmaf is Netflix's full-reference VQA library. It ships as a C library (`libvmaf`), an FFmpeg filter (`libvmaf`/`libvmaf_cuda`), and a standalone CLI tool (`vmaf`). Most features require a reference+distorted pair, but **CAMBI is fully no-reference**. Several features are usable as no-reference *signals* when you compare a file against itself or use `--no_prediction` mode.

### 1.1 Complete Feature List

| Feature | Identifier | Core in VMAF? | Individual Metrics | No-Reference? |
|---------|-----------|:---:|---|:---:|
| **VIF** | `vif` | Yes | `vif_scale0`, `vif_scale1`, `vif_scale2`, `vif_scale3` | No (FR) |
| **Motion2** | `motion` | Yes | `motion`, `motion2` | Partial (needs ref for real VMAF) |
| **ADM** | `adm` | Yes | `adm2`, `adm_scale0`–`adm_scale3` | No (FR) |
| **CAMBI** | `cambi` | No | `cambi` | **YES** |
| **CIEDE2000** | `ciede` | No | `ciede2000` | No (FR) |
| **MS-SSIM** | `float_ms_ssim` | No | — | No (FR) |
| **PSNR** | `psnr` | No | `psnr_y`, `psnr_cb`, `psnr_cr` | No (FR) |
| **PSNR-HVS** | `psnr_hvs` | No | `psnr_hvs`, `psnr_hvs_y`, `psnr_hvs_cb`, `psnr_hvs_cr` | No (FR) |
| **SSIM** | `float_ssim` | No | — | No (FR) |

### 1.2 Key Features Explained

#### CAMBI (Contrast Aware Multiscale Banding Index)
- **What it measures:** Visibility of banding artifacts in smooth gradients
- **No-reference:** YES — the only fully NR feature in libvmaf
- **How it works:** Multiscale analysis of contrast between adjacent pixels, weighted by a human contrast sensitivity function (CSF). Measures how likely a human observer is to perceive contouring/banding in flat or smooth regions.
- **Score:** 0 = no banding, rising to ~24 = unwatchable. Netflix's own: ~5 = "slightly annoying"
- **Invocation:**
  ```bash
  ffmpeg -i input.mkv -lavfi libvmaf='feature=name=cambi' -f null -
  # Standalone tool:
  vmaf --feature cambi --no_prediction -d distorted.yuv -r reference.yuv ...
  ```
- **Parameters:** `window_size=63` (≈1° at 4K), `topk=0.2`, `max_log_contrast=2`, `eotf=bt1886`, `full_ref=false` (NR mode), `tvi_threshold=0.75`
- **Limitations:** Banding only; says nothing about other artifacts. At 1080p, the default window of 63 is appropriate.
- **References:** Netflix, PCS 2021. Netflix CAMBI documentation, 2026.

#### ADM (Additive Detail Measure / Detail Loss Metric)
- **What it measures:** Detail preservation at multiple scales via wavelet decomposition
- **No-reference:** No — requires reference+distorted pair
- **How it works:** Discrete wavelet transform (DWT) decomposition into horizontal/vertical/diagonal bands at 4 scales. Applies contrast sensitivity function weighting. Separates detail loss (DLM) from additive impairment (AIM). In VMAF, only the DLM part is used.
- **Sub-metrics:** `adm2` (main score), `adm_scale0`–`adm_scale3` (per-scale detail loss)
- **Limitations:** Strictly FR. Cannot be used for self-comparison.

#### VIF (Visual Information Fidelity)
- **What it measures:** Information preservation between reference and distorted
- **No-reference:** No — FR only
- **How it works:** Measures mutual information between wavelet coefficients of reference and distorted at 4 scales. Based on natural scene statistics and the Gaussian Scale Mixture (GSM) model.
- **Sub-metrics:** `vif_scale0`–`vif_scale3`
- **Key parameter:** `vif_enhn_gain_limit=100.0`, `vif_kernelscale=1.0`
- **Limitations:** FR only. VIF on frame-difference signals (T-VIF) is a temporal quality metric but still needs a reference.

#### Motion / Motion2
- **What it measures:** Temporal activity / motion magnitude
- **No-reference:** Partially — measures motion in distorted video, but in VMAF context it's used to weight spatial features
- **How it works:** `motion` = absolute difference between consecutive frames (in the distorted signal). `motion2` is a variant.
- **Limitations:** Not an artifact detector per se — it measures content dynamics, which modulates artifact visibility. High motion masks artifacts.

#### PSNR-HVS (Human Visual System)
- **What it measures:** PSNR weighted by contrast sensitivity and spatial masking
- **No-reference:** No — FR only
- **Sub-metrics:** `psnr_hvs`, `psnr_hvs_y`, `psnr_hvs_cb`, `psnr_hvs_cr`
- **Limitations:** FR only. Better than raw PSNR but still limited.

#### CIEDE2000
- **What it measures:** Perceptual color difference
- **No-reference:** No — FR only
- **Limitations:** FR only. Useful for color accuracy assessment.

### 1.3 How to Use libvmaf Features as NR Signals

The trick: **compare the file against itself** with `--no_prediction`. This gives you frame-level values for every registered feature — the values reflect the file's internal characteristics. CAMBI is inherently NR. ADM, VIF, etc. will produce degenerate scores (1.0 or NaN) when comparing identical inputs, but the feature extraction code still runs and can reveal structural properties.

A better approach for NR: use libvmaf as a **feature engine** only, then use those features in your own analysis:
```bash
vmaf --no_prediction \
  --feature cambi \
  --feature psnr \
  --feature float_ssim \
  -d input.yuv -r input.yuv \
  -w 1920 -h 1080 -p 420 -b 8 \
  --output features.json --json
```

---

## 2. FFmpeg Built-in No-Reference Filters

All of these are metadata-only filters (they pass frames through unchanged) and emit per-frame quality signals.

### 2.1 blockdetect

- **What it measures:** Blocking artifacts (visible DCT grid boundaries)
- **No-reference:** YES
- **Reference:** Muijs & Kirenko, "A no-reference blocking artifact measure for adaptive video processing," 2005
- **How it works:** Computes horizontal and vertical "blockiness" by measuring discontinuities at regular intervals (searching for periodic patterns corresponding to the DCT grid). The period is configurable to match the block structure of the codec.
- **Parameters:**
  - `period_min` (default 3): Minimum block period to search
  - `period_max` (default 24): Maximum block period to search
  - `planes` (default 1): Which planes to analyze (1=Y only)
- **Recommended for 1080p:** `period_min=8:period_max=16` (matches H.264/H.265 8×8/16×16 block structure) or keep defaults for generality.
- **Invocation:**
  ```bash
  ffmpeg -i input.mkv -vf "blockdetect=period_min=8:period_max=32:planes=1,metadata=mode=print" -f null /dev/null 2>&1 | grep "lavfi.blockdetect"
  ```
- **Output:** `lavfi.blockdetect.PACKET_Y` (blockiness score for Y plane). Higher = worse.
- **Limitations:** Only detects DCT-grid-aligned blocking. Misses non-periodic artifacts. Does not quantify severity in perceptual terms. No temporal component.

### 2.2 blurdetect

- **What it measures:** Perceptual blur (edge sharpness loss)
- **No-reference:** YES
- **Reference:** Marziliano et al., "A no-reference perceptual blur metric," 2002
- **How it works:** Canny edge detection → local maxima search around each edge → measures the width of the blur spread. Block-based version for speed.
- **Parameters:**
  - `low` / `high` (defaults 20/255, 50/255): Canny hysteresis thresholds
  - `radius` (default 50): Search radius for local maxima around edges
  - `block_pct` (default 80): Analyze only the top N% most significant blocks
  - `block_width` / `block_height`: Block size for block-based mode (-1 = whole image)
  - `planes` (default 1): Analyze Y plane only
- **Recommended for 1080p:** `block_width=32:block_height=32:block_pct=80`
- **Invocation:**
  ```bash
  ffmpeg -i input.mkv -vf "blurdetect=block_width=32:block_height=32:block_pct=80,metadata=mode=print" -f null /dev/null 2>&1 | grep "lavfi.blurdetect"
  ```
- **Output:** `lavfi.blurdetect.PACKET_Y` (blur metric). Higher = more blurry.
- **Limitations:** Edge-based, so it can confuse noise/texture with blur. Block-based mode trades accuracy for speed. No temporal component.

### 2.3 freezedetect

- **What it measures:** Frozen/duplicated frames
- **No-reference:** YES
- **How it works:** Computes mean absolute frame difference (MAFD) between consecutive frames. When MAFD stays below a noise threshold for a configurable duration, a freeze is detected.
- **Parameters:**
  - `noise` / `n` (default 0.001 or -60dB): Noise tolerance threshold
  - `duration` / `d` (default 2s): Minimum duration before reporting a freeze
- **Invocation:**
  ```bash
  ffmpeg -i input.mkv -vf "freezedetect=n=-50dB:d=1" -f null /dev/null 2>&1 | grep -i "freeze"
  ```
- **Output:** Metadata keys `lavfi.freezedetect.freeze_start`, `freeze_duration`, `freeze_end`
- **Limitations:** Detects only frozen frames, not general stuttering or judder. A very static scene may false-trigger.

### 2.4 signalstats

- **What it measures:** Broadcast signal statistics (luma/chroma ranges, temporal outliers)
- **No-reference:** YES
- **Output fields:**
  - `YMIN`, `YMAX`, `YAVG`, `YRMS` — luma statistics
  - `UMIN`, `UMAX`, `UAVG` — Cb statistics
  - `VMIN`, `VMAX`, `VAVG` — Cr statistics
  - `SATMIN`, `SATMAX`, `SATAVG` — saturation
  - `HUEMED`, `HUEAVG` — hue
  - `TOUT` — temporal outliers (dropouts, head clogs, tracking issues)
  - `VREP` — vertical line repetition (concealment artifacts from analog dropout compensators)
  - `BRNG` — broadcast range violations (out of 16-235 legal range)
- **Invocation:**
  ```bash
  ffmpeg -i input.mkv -vf "signalstats=stat=tout+vrep+brng,metadata=mode=print" -f null /dev/null 2>&1
  ```
- **Limitations:** Primarily designed for analog digitization QC. `TOUT` and `VREP` are less relevant for digital encodes but `BRNG` catches broadcast-range issues.

### 2.5 blackdetect

- **What it measures:** Black/flash frames
- **No-reference:** YES
- **Parameters:** `d` (minimum duration), `pix_th` (luma threshold)
- **Use case:** Detecting encoding errors that produce blank frames

### 2.6 edgedetect (Canny)

- **What it measures:** Edge structure (useful for constructing custom detectors)
- **No-reference:** Depends on how you use it
- **Modes:** `wires` (white/gray edges on black), `colormix` (edge-enhanced blend), `canny` (binary edge map)
- **Use case:** Building custom mosquito-noise or ringing detectors via edge-map differencing

---

## 3. BRISQUE

### 3.1 What It Is

**Blind/Referenceless Image Spatial Quality Evaluator** — a no-reference image quality metric based on natural scene statistics (NSS).

- **Reference:** Mittal, Moorthy & Bovik, "No-reference image quality assessment in the spatial domain," IEEE TIP 2012
- **No-reference:** YES
- **Scale:** 0–100 (lower = better quality)

### 3.2 How It Works

1. Compute Mean Subtracted Contrast Normalized (MSCN) coefficients (locally normalized luminance)
2. Fit an Asymmetric Generalized Gaussian Distribution (AGGD) to the MSCN coefficients → 2 parameters
3. Compute pairwise products of adjacent MSCN coefficients (horizontal, vertical, diagonal) → fit AGGD to each → 2 more parameters per direction
4. Repeat at 2 scales (original + half-scale) → **18 features per scale × 2 scales = 36 features total**
5. Map features to quality via a pre-trained SVM regression model

### 3.3 Available in FFmpeg?

**NO.** BRISQUE is not a built-in FFmpeg filter. However:
- Available via `pyiqa` (Python): `pip install pyiqa` → `pyiqa brisque -t frame.png`
- Available in OpenCV (cv::quality::brisque)
- Available in scikit-video: `skvideo.measure.brisque_features(videoData)`
- The Rust crate `viser-quality` implements it
- The `oximedia_quality` Rust crate also provides it
- **Requires a pre-trained model file** (the SVM weights trained on LIVE IQA database)

### 3.4 What It Detects

- General "unnaturalness" — quantifies loss of natural scene statistics
- Effective against: JPEG/JPEG2000 compression artifacts, Gaussian blur, white noise, channel distortion
- **Does NOT detect specific artifacts** — it's a holistic quality measure
- Can be used for distortion classification (its features also feed an SVM classifier that identifies the distortion type)

### 3.5 Limitations for Our Use Case

- **Per-image, not per-video** — must be run on extracted frames
- Trained on specific distortion types (JPEG, JPEG2000, blur, noise, fast fading). May not generalize well to HEVC/H.264 at moderate bitrates
- Requires a pre-trained model file
- Performance on compressed video at typical streaming bitrates (2-8 Mbps) is unvalidated — the original dataset was mostly lower-quality distortions
- Scores tend to cluster for content with similar complexity — may not differentiate between good and excellent encodes

### 3.6 Recommended Parameters for 1080p

Run on sampled luma frames (every Nth frame). Block size should scale with resolution — the default 96×96 blocks from the original paper work for most resolutions.

### 3.7 Reference

- Mittal et al., "Blind/Referenceless Image Spatial Quality Evaluator," ACSSC 2011
- Mittal et al., "No-reference image quality assessment in the spatial domain," IEEE TIP 2012
- Software: http://live.ece.utexas.edu/research/quality/BRISQUE_release.zip

---

## 4. NIQE

### 4.1 What It Is

**Naturalness Image Quality Evaluator** — a "completely blind" image quality metric that requires NO training on human opinion scores.

- **Reference:** Mittal, Soundararajan & Bovik, "Making a Completely Blind Image Quality Analyzer," IEEE SPL 2013
- **No-reference:** YES
- **Scale:** 0 → ∞ (lower = better). Normal range: ~3–20

### 4.2 How It Works

1. Same MSCN coefficient extraction as BRISQUE
2. Compute 36 quality-aware features from patches (96×96 blocks)
3. Fit a multivariate Gaussian (MVG) model to the features
4. Measure the Mahalanobis distance between the test image's MVG and a pre-computed model of natural pristine images
5. **Key difference from BRISQUE:** Uses ONLY natural image statistics (no distorted training data, no human opinion scores)

### 4.3 Available in FFmpeg?

**NO.** Not a built-in FFmpeg filter. Available via:
- `pyiqa` (Python): `pip install pyiqa` → `pyiqa niqe -t frame.png`
- MATLAB Image Processing Toolbox: `score = niqe(image)`
- scikit-video: `skvideo.measure.niqe(videoData)`
- Rust `viser-quality` crate

### 4.4 What It Detects

- Quantifies how "unnatural" an image looks
- Effective against: any distortion that perturbs natural scene statistics
- Slightly less accurate than BRISQUE on known distortions but more generalizable (not tied to specific distortion types)

### 4.5 Limitations

- Per-image metric — must run on sampled frames
- Can give bad results on rendered graphics, credits, subtitles (not natural scenes)
- Sensitive to scenes with naturally noisy objects (sand, grass) or large constant areas (sky)
- Does not distinguish between artifact types
- Normal range is 3–20; values of 0 or NaN are abnormal

### 4.6 Recommended Parameters for 1080p

Standard 96×96 patch size works. Run on sampled luma-only frames. Exclude credits/subtitle frames.

### 4.7 Reference

- Mittal et al., "Making a Completely Blind Image Quality Analyzer," IEEE SPL 2013
- Software: http://live.ece.utexas.edu/research/quality/niqe.zip

---

## 5. Custom FFmpeg Filter Chains

FFmpeg's filter graph system allows building custom artifact detectors by combining existing filters.

### 5.1 Mosquito Noise / Ringing Detector (Edge + Difference)

**Concept:** Mosquito noise manifests as high-frequency oscillations around object edges. Detect by:
1. Extract edges with `edgedetect`
2. Compute frame difference in edge regions
3. Measure the variance of the difference signal near edges

```bash
# Extract edge map
ffmpeg -i input.mkv -vf "edgedetect=mode=canny:low=0.1:high=0.3" -f rawvideo edges.yuv

# Compute temporal variance of edge regions
ffmpeg -i input.mkv -vf \
  "edgedetect=mode=canny:low=0.1:high=0.3,split[orig][edge];
   [edge]setpts=N/TB,frameblur=radius=0[shifted];
   [orig][shifted]blend=all_mode=difference:all_opacity=1.0,metadata=mode=print" \
  -f null /dev/null
```

A more practical approach:
```bash
# High-pass filter to isolate ringing/high-freq noise
ffmpeg -i input.mkv -vf "highpass=f=1000,showinfo" -f null /dev/null 2>&1 | grep "n:"
```

### 5.2 Frequency Analysis for Artifact Detection

**Concept:** Compression artifacts often concentrate energy in specific frequency bands. A highpass filter isolates residual high-frequency content; a bandpass at the DCT block frequency (for 8×8 blocks: 8 cycles/frame width) reveals blocking grid energy.

```bash
# Extract high-frequency residual (everything above 2kHz)
# Low output = fewer high-freq artifacts
ffmpeg -i input.mkv -af "highpass=f=2000" -f null - 2>&1 | grep "mean_volume"

# Visual: average brightness of high-freq residual per frame
ffmpeg -i input.mkv -vf \
  "highpass=f=1000,format=gray,signalstats=stat=YAVG,metadata=mode=print" \
  -f null /dev/null 2>&1 | grep "lavfi.signalstats.YAVG"
```

### 5.3 Temporal Noise Estimation

**Concept:** Measure frame-to-frame differences in flat regions to estimate temporal noise.

```bash
# Compute PSNR between consecutive frames (no-reference: self-comparison)
ffmpeg -i input.mkv -vf \
  "select='gt(scene,0)',signalstats,metadata=mode=print" \
  -f null /dev/null 2>&1

# Temporal difference as noise proxy
ffmpeg -i input.mkv -vf \
  "tblend=all_mode=difference:all_opacity=1.0,signalstats=stat=YAVG+YRMS,metadata=mode=print" \
  -f null /dev/null 2>&1
```

### 5.4 Laplacian Variance (Sharpness Proxy)

The Laplacian variance is a classic no-reference sharpness metric. Not built into FFmpeg as a named filter, but implementable via:
```bash
# Using the gradient-based approach via signalstats
ffmpeg -i input.mkv -vf \
  "format=gray,lut=cbrt,signalstats=stat=YRMS,metadata=mode=print" \
  -f null /dev/null
```

The `viser-quality` Rust crate computes this as `sharpness = variance_of_laplacian(frame)`. For FFmpeg integration, use a custom filter or pipe frames to an external tool.

### 5.5 8×8 Block Boundary Discontinuity (Manual)

For explicit macroblock-boundary scoring:
```bash
# Split into two paths, shift one by 8 pixels, blend as difference
# This amplifies 8×8 grid artifacts
ffmpeg -i input.mkv -vf \
  "split[main][shifted];
   [shifted]crop=iw-8:ih:8:0[cropped];
   [main]crop=iw-8:ih:0:0[original];
   [original][cropped]blend=all_mode=difference:all_opacity=1.0,
   format=gray,signalstats=stat=YAVG+YRMS,metadata=mode=print" \
  -f null /dev/null 2>&1
```

### 5.6 Color Channel Analysis (Chroma Artifacts)

```bash
# Check chroma-only artifacts (color bleeding, chroma aliasing)
ffmpeg -i input.mkv -vf \
  "format=yuv444p,split[croma_a][croma_b];
   [croma_b]vrep,crop=iw:ih/2:0:ih/2[cb_b];
   [croma_a]crop=iw:ih/2:0:ih/2[cb_a];
   [cb_a][cb_b]blend=all_mode=difference,signalstats,metadata=mode=print" \
  -f null /dev/null 2>&1
```

### 5.7 Combined Pipeline (Practical)

A single pipeline that extracts multiple NR signals simultaneously:
```bash
ffmpeg -i input.mkv -vf \
  "split[a][b][c][d];
   [a]blockdetect=period_min=8:period_max=32,metadata=mode=print[block];
   [b]blurdetect=block_width=32:block_height=32,metadata=mode=print[blur];
   [c]freezedetect=n=-50dB:d=1,metadata=mode=print[freeze];
   [d]signalstats=stat=tout+vrep+brng,metadata=mode=print[stats]" \
  -f null /dev/null 2>&1
```

**Note:** This runs 4 filters in parallel via `split`. For CAMBI, add `libvmaf='feature=name=cambi'` as another branch (but note it requires the libvmaf build).

---

## 6. External / Open-Source Tools

### 6.1 pyiqa (IQA-PyTorch) — The Modern NR Toolbox

- **URL:** https://github.com/chaofengc/IQA-PyTorch
- **Install:** `pip install pyiqa`
- **License:** PolyForm Noncommercial + NTU S-Lab — **NOT for commercial use**
- **What it provides:** Reimplementations of 30+ image quality metrics, GPU-accelerated, calibrated against MATLAB

**Key NR metrics available:**

| Metric | Type | What It Measures |
|--------|------|-----------------|
| `niqe` | NR, training-free | Naturalness deviation from pristine statistics |
| `niqe_matlab` | NR, training-free | MATLAB-compatible NIQE |
| `brisque` | NR, trained | Spatial naturalness loss (SVM on NSS features) |
| `brisque_matlab` | NR, trained | MATLAB-compatible BRISQUE |
| `musiq` | NR, deep learning | Multi-scale image quality transformer |
| `maniqa` | NR, deep learning | Multi-dimension attention network |
| `topiq_nr` | NR, deep learning | Top-down semantics-to-distortions approach |
| `dbcnn` | NR, deep learning | Blind CNN with distortion binary classification |
| `hyperiqa` | NR, deep learning | Hyper network for content-adaptive quality |
| `cnniqa` | NR, deep learning | CNN trained on LIVE database |
| `nima` | NR, deep learning | Neural Image Assessment (aesthetic + quality) |
| `clipscore` | NR, multimodal | CLIP-based image-text alignment |
| `nrqm` | NR | No-Reference Quality Metric (Ma et al.) |
| `pi` | NR | Natural image statistics quality metric |
| `wadiqam_nr` | NR | Weighted average of features for NR |
| `uranker` | NR | Unsupervised quality ranking |
| `afine` | NR | AFINE (2025) |
| `qualiclip` / `qualiclip+` | NR | CLIP-based quality (2025) |
| `qalign_8bit` / `qalign_4bit` | NR | Quality-aligned features |
| `ilniqe` | NR | Improved Local NIQE |
| `piqe` | NR | Perception Inspired Quality Evaluator |

**Usage for video:**
```bash
# Extract frames, score each, aggregate
ffmpeg -i input.mkv -vf "fps=1" -q:v 2 /tmp/frames/%04d.jpg
pyiqa niqe /tmp/frames/  # batch directory
pyiqa musiq /tmp/frames/frame_0001.jpg  # single frame
```

**Limitation:** Per-image only. Non-commercial license.

### 6.2 scikit-video

- **URL:** https://scikit-video.org
- **Install:** `pip install scikit-video`
- **License:** BSD (commercial-friendly)

**Key NR metrics:**

| Function | What It Does |
|----------|-------------|
| `skvideo.measure.niqe(videoData)` | NIQE per-frame, averaged over video |
| `skvideo.measure.brisque_features(videoData)` | BRISQUE features per-frame |
| `skvideo.measure.videobliinds_features(videoData)` | Video BLIINDS: 46-feature vector combining spatial NSS, temporal DC variation, spectral ratios, motion coherence |
| `skvideo.measure.viideo_score(videoData)` | VIIDEO: temporal prediction of quality using sub-band excited blind features |
| `skvideo.measure.mscn_features(videoData)` | MSCN coefficient statistics |

**V-BLIINDS (Video BLIINDS):**
- Combines spatial NIQE features with temporal features (DC variation between frames, spectral ratios, motion coherence, global motion)
- No-reference, produces a quality prediction
- Features: 36 spatial NIQE + 1 NIQE score + 2 DC + 5 spectral + 1 motion coherence + 1 global motion = 46 features

**VIIDEO:**
- Temporal quality prediction using sub-band statistics
- Per-frame quality curve that captures temporal quality variation
- Higher score = lower quality

**Limitation:** scikit-video is effectively unmaintained; requires pinning old NumPy/SciPy versions.

### 6.3 viser-quality (Rust)

- **URL:** https://docs.rs/crate/viser-quality/
- **License:** Check crate

**Key NR signals:**
```rust
pub struct NoRefResult {
    pub sharpness: f64,      // variance of Laplacian (higher = sharper)
    pub blockiness: f64,     // 8×8 boundary discontinuity (lower = better)
    pub noise: f64,          // Immerkær's fast noise-σ estimate (lower = cleaner)
    pub niqe: f64,           // NIQE score
    pub brisque: f64,        // BRISQUE score
}
```

This is the cleanest integration of multiple NR metrics into one tool. It decodes frames via ffmpeg and computes:
- **Sharpness:** `variance_of_laplacian(frame)` — simple, fast, effective
- **Blockiness:** Extra gradient at 8×8 block boundaries vs interior
- **Noise:** Immerkær's noise standard deviation estimate
- **NIQE/BRISQUE:** As described above

### 6.4 MSU VQMT (Video Quality Measurement Tool)

- **URL:** https://videoprocessing.ai/vqmt/
- **License:** Commercial (free for research)

NR metrics include: blurring, blocking, noise estimation, scene change detection, NIQE. Supports per-block visualization.

### 6.5 NRMetricFramework (NTIA/ITS)

- **URL:** https://its.ntia.gov/research/qoe/video-quality-research/no-reference-metrics/overview
- **License:** Open source (MATLAB)

Their NR metric **Sawatch** is designed for broad-range content. Key finding from their analysis: published NR metrics achieve Pearson correlations of 0.0–0.63 against ground truth, not the 0.66–0.99 claimed by developers. Industry-grade NR remains an open problem.

### 6.6 oximedia_quality (Rust)

Specialized compression artifact detectors:
- **MosquitoNoiseDetector:** High-frequency oscillation detection around object edges
- **RingingScoreDetector:** Gibbs-phenomenon ringing near sharp edges, macro-block-aligned
- **MacroblockBoundaryScorer:** Visible 16×16 (or configurable) boundary discontinuities in luma

---

## 7. Temporal Metrics

### 7.1 FFmpeg Temporal Filters

#### tblend (Temporal Blend / Frame Difference)
```bash
# Frame-to-frame absolute difference (temporal noise proxy)
ffmpeg -i input.mkv -vf \
  "tblend=all_mode=difference:all_opacity=1.0,
   signalstats=stat=YAVG+YRMS,metadata=mode=print" \
  -f null /dev/null
```
- YAVG of the difference = average temporal change
- YRMS of the difference = temporal noise level

#### idet (Interlace Detection)
- Detects interlaced content, field order, and duplicate/missing fields
- Useful for detecting telecine artifacts or improper deinterlacing
- `lavfi.idet.prob` and `lavfi.idet.single.bff/tff/prog` metadata

### 7.2 Scene Change Detection

```bash
# Per-frame scene change score
ffmpeg -i input.mkv -vf "select='showinfo',metadata=mode=print" -f null /dev/null 2>&1 | grep "lavfi.select.n"

# Or with scene score:
ffmpeg -i input.mkv -vf \
  "select=gt(scene\,0.3),showinfo,metadata=mode=print" \
  -f null /dev/null
```

### 7.3 Judder Detection

- **FFmpeg `dejudder` filter:** Removes judder (its inverse detects it)
- **How to detect:** Compute inter-frame PTS differences. Judder manifests as alternating short/long frame intervals
- **Implementation:** Extract PTS from each frame, compute variance of frame intervals. High variance = judder or VFR

```bash
# Extract frame timestamps for judder analysis
ffprobe -v quiet -select_streams v -show_entries frame=pts_time \
  -of csv=p=0 input.mkv > /tmp/pts.txt
# Then compute variance in Python/shell
```

### 7.4 Frame Drop / Duplication Detection

```bash
# Count frames and compare with expected duration
ffprobe -v error -count_frames -select_streams v:0 \
  -show_entries stream=nb_read_frames,duration,r_frame_rate \
  -of default=noprint_wrappers=1 input.mkv
```

### 7.5 Motion Coherence (via libvmaf)

The `motion` feature in libvmaf (`integer_motion`, `integer_motion2`) measures temporal activity. Inconsistencies in motion across frames can indicate encoding artifacts (e.g., B-frame prediction errors causing sudden motion discontinuities).

### 7.6 T-VIF and T-SpEED (Research)

From the ST-VMAF paper (Zhang et al., 2018):
- **T-VIF:** VIF computed on frame-difference signals (temporal information fidelity)
- **T-SpEED:** Spatio-Temporal Entropy of frame Differences
- Both capture temporal quality degradations like ghosting, flickering, and motion estimation errors
- These require a reference signal — cannot be used NR directly

---

## 8. Summary & Recommendations

### 8.1 The NR Metric Landscape

| Metric | NR? | FFmpeg Built-in? | Detects | Score Range | Speed |
|--------|:---:|:---:|---------|-------------|-------|
| **CAMBI** | YES | libvmaf | Banding | 0–24+ | Fast |
| **blockdetect** | YES | YES | Blocking | Higher=worse | Fast |
| **blurdetect** | YES | YES | Blur | Higher=worse | Medium |
| **freezedetect** | YES | YES | Frozen frames | Binary | Fast |
| **signalstats** | YES | YES | Broadcast QC | Per-stat | Fast |
| **BRISQUE** | YES | NO (pyiqa) | General quality | 0–100 (lower=better) | Medium |
| **NIQE** | YES | NO (pyiqa) | Naturalness | 3–20 (lower=better) | Medium |
| **V-BLIINDS** | YES | NO (scikit-video) | Video quality | Higher=worse | Slow |
| **VIIDEO** | YES | NO (scikit-video) | Temporal quality | Higher=worse | Slow |
| **Laplacian var** | YES | Custom | Sharpness | Higher=sharper | Fast |
| **Noise σ** | YES | Custom | Noise | Lower=cleaner | Fast |
| **Blockiness (8×8)** | YES | Custom | Blocking | Lower=better | Fast |

### 8.2 What We're Already Using

| Detector | What It Catches | Status |
|----------|----------------|--------|
| CAMBI (banding) | Contouring in gradients | ✅ Deployed |
| blockdetect | DCT-grid blocking | ✅ Deployed |
| blurdetect | Edge softening / blur | ✅ Deployed |
| Custom residual analysis | Grain/noise loss | ✅ Deployed |

### 8.3 What We Should Add

**Tier 1 — Easy wins, FFmpeg ecosystem, no new dependencies:**

1. **Laplacian Variance (sharpness proxy)** — can be implemented as a custom ffmpeg filter or via piping to a tiny C/Python script. `variance_of_laplacian(frame)`. Already proven in `viser-quality`.
2. **Temporal noise σ (Immerkær's estimator)** — same approach. Quantifies sensor noise vs compression noise.
3. **8×8 block boundary scorer** — the manual shift-and-diff approach from Section 5.5. More sensitive than `blockdetect` for specific block sizes.
4. **Frame-interval variance** — PTS analysis for VFR detection and judder.

**Tier 2 — Moderate effort, external dependencies:**

5. **NIQE via pyiqa** — the most generalizable NR metric. No training required. Good for detecting "something is wrong" without specifying what. Non-commercial license warning.
6. **BRISQUE via pyiqa** — more accurate than NIQE for known distortions. Same license concern.
7. **Musiq/MANIQA via pyiqa** — deep-learning NR metrics. Best correlation with human perception but need GPU and have licensing restrictions.

**Tier 3 — Advanced / research:**

8. **Mosquito noise detector** — custom pipeline using edge detection + temporal variance of edge regions (Section 5.1).
9. **Ringing detector** — edge-aligned frequency analysis (Section 5.2).
10. **Chroma artifact analysis** — inter-plane correlation loss (Section 5.6).

### 8.4 Recommended Architecture

```
Per-film sampling (8–16 clips, 2–4s each)
  │
  ├── CAMBI ──────────────────────────────── banding score
  ├── blockdetect (period 8-32) ──────────── blocking score
  ├── blurdetect (32×32 blocks) ──────────── blur score
  ├── laplacian_variance ─────────────────── sharpness
  ├── temporal_noise_sigma ───────────────── noise floor
  ├── 8x8_boundary_score ─────────────────── grid visibility
  ├── freezedetect ───────────────────────── freeze detection
  └── (optional) NIQE ────────────────────── naturalness
```

Pool across clips with **max** (for bursty artifacts like banding/blocking) or **percentile-95** (for rare-but-severe issues). Mean is appropriate for smooth metrics like blur and noise.

### 8.5 Key Pitfalls

1. **BRISQUE/NIQE scores are content-dependent** — a "good" score for a film grain movie differs from a clean digital encode. Always compare within the same content type.
2. **No NR metric is a perfect proxy for human perception** — NTIA found correlations of 0.0–0.63, not the claimed 0.99. Use as signals, not verdicts.
3. **Licensing matters** — pyiqa is noncommercial. libvmaf/CAMBI/FFmpeg filters are BSD/LGPL/GPL (commercial-safe).
4. **Per-frame vs per-film** — all image-level metrics need temporal pooling strategy. Bursty artifacts (banding in one scene) need max-pooling. Consistent issues (slight blur everywhere) need mean-pooling.
5. **Content adaptive thresholds** — flat gradient scenes naturally show more banding; textured scenes mask it. A scene-aware threshold is important.

---

## 9. References

### libvmaf / VMAF
- https://github.com/Netflix/vmaf — main repository
- https://github.com/Netflix/vmaf/blob/master/resource/doc/features.md — complete feature list
- https://github.com/Netflix/vmaf/blob/master/resource/doc/cambi.md — CAMBI documentation
- Netflix Tech Blog, "Toward a Better Quality Metric for the Video Community," 2020-12-07
- Zhang et al., "SpatioTemporal Feature Integration and Model Fusion for Full Reference Video Quality Assessment," IEEE TCSVT 2018 (ST-VMAF)

### BRISQUE
- Mittal et al., "No-reference image quality assessment in the spatial domain," IEEE TIP 2012
- http://live.ece.utexas.edu/research/quality/BRISQUE_release.zip

### NIQE
- Mittal et al., "Making a Completely Blind Image Quality Analyzer," IEEE SPL 2013
- http://live.ece.utexas.edu/research/quality/niqe.zip

### FFmpeg Filters
- https://ffmpeg.org/ffmpeg-filters.html — complete filter documentation
- https://ayosec.github.io/ffmpeg-filters-docs/ — filter documentation mirror
- Muijs & Kirenko, "A no-reference blocking artifact measure," 2005 (blockdetect)
- Marziliano et al., "A no-reference perceptual blur metric," 2002 (blurdetect)

### Open-Source Tools
- https://github.com/chaofengc/IQA-PyTorch — pyiqa (30+ metrics)
- https://scikit-video.org — scikit-video (V-BLIINDS, VIIDEO, NIQE, BRISQUE)
- https://docs.rs/crate/viser-quality/ — Rust NR quality signals
- https://github.com/oximedia/oximedia-quality — Rust compression artifact detectors

### NR Metric Accuracy Studies
- NTIA/ITS, "No Reference Video Quality Metrics — Overview" (26 independent evaluations, Pearson 0.0–0.63)
- https://its.ntia.gov/research/qoe/video-quality-research/no-reference-metrics/overview
- MSU VQMT benchmark: https://videoprocessing.ai/benchmarks/no-reference-video-quality-metrics.html

### Ringing / Mosquito Noise Detection
- Yoo et al., "Blind Post-Processing for Ringing and Mosquito Artifact Reduction in Coded Videos," IEEE TCSVT 2013
- Eerenberg et al., "Block-based detection systems for visual artifact location," IEEE ICCE 2013
- Kong et al., "Edge map guided adaptive post-filter for blocking and ringing artifacts removal," 2004
