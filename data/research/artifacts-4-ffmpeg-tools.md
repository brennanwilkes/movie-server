# FFmpeg & libvmaf Artifact Detection Tools — Complete Inventory

**Date:** 2026-08-26
**Build:** ffmpeg n8.1.2-44-g7c533d0f86 (2026-08-20), static GPL with libvmaf
**Binary:** `tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`
**No standalone `vmaf` CLI** — must use ffmpeg filter interface or build from source.

## Summary: What We Can Actually Use

| Tool | No-Ref? | Artifact | Speed | Our Build |
|------|---------|----------|-------|-----------|
| libvmaf CAMBI | Yes | Banding | Fast | Yes |
| libvmaf (VIF/ADM/motion) | No* | Quality fusion | Slow | Yes |
| libvmaf PSNR/SSIM/MS-SSIM | No | Quality (needs ref) | Fast | Yes |
| libvmaf CIEDE2000 | No | Color diff (needs ref) | Fast | Yes |
| libvmaf PSNR-HVS | No | Perceptual PSNR | Fast | Yes |
| blockdetect | Yes | Blocking/DCT grid | Fast | Yes |
| blurdetect | Yes | Blur/sharpness | Fast | Yes |
| freezedetect | Yes | Frozen frames | Fast | Yes |
| signalstats | Yes | Luma/chroma stats | Fast | Yes |
| bitplanenoise | Yes | Bit-plane noise | Fast | Yes |
| entropy | Yes | Information content | Fast | Yes |
| siti | Yes | Spatial/temporal info | Fast | Yes |
| colordetect | Yes | Color range/alpha | Fast | Yes |
| showinfo | Yes | Frame metadata | Fast | Yes |
| edgedetect | Yes | Edge detection | Fast | Yes |
| photosensitivity | Yes | Flash/flicker | Fast | Yes |
| bbox | Yes | Bounding box | Fast | Yes |
| idet | Yes | Interlacing | Fast | Yes |
| metadata (filter) | Yes | Metadata pipeline | Fast | Yes |
| drawgraph | Yes | Visualize metadata | Fast | Yes |
| cropdetect | Yes | Crop boundaries | Fast | Yes |
| psnr/ssim (filter) | No | Needs reference | Fast | Yes |
| identity (filter) | No | Needs reference | Fast | Yes |
| xpsnr | No | Needs reference | Fast | Yes |
| ebur128 | Yes | Loudness (audio) | Fast | Yes |
| aspectralstats | Yes | Freq domain (audio) | Fast | Yes |
| astats | Yes | Time domain (audio) | Fast | Yes |

*VIF/ADM/motion are "no-reference" features but require a reference stream in the ffmpeg filter API.

---

## 1. libvmaf Features — Complete List

libvmaf bundles these feature extractors, all accessible via ffmpeg's `feature` parameter:

### Core Features (used in v0.6.1 model)
| Feature | Identifier | Sub-metrics | Reference? | What it measures |
|---------|-----------|-------------|------------|------------------|
| VIF | `vif` | `vif_scale0`, `vif_scale1`, `vif_scale2`, `vif_scale3` | Yes (2 inputs) | Visual Information Fidelity — loss of info across 4 scales |
| ADM | `adm` | `adm2`, `adm_scale0`..`adm_scale3` | Yes (2 inputs) | Detail Loss Metric — separately measures detail loss and additive impairment |
| Motion2 | `motion` | `motion`, `motion2` | No (temporal) | Average absolute pixel difference between adjacent frames |

### Additional Features
| Feature | Identifier | Sub-metrics | Reference? | What it measures |
|---------|-----------|-------------|------------|------------------|
| CAMBI | `cambi` | `cambi` | **No** | Banding/contouring visibility (0–24 scale) |
| CIEDE2000 | `ciede` | `ciede2000` | Yes (2 inputs) | Perceptual color difference |
| MS-SSIM | `float_ms_ssim` | (multi-scale SSIM) | Yes (2 inputs) | Structural similarity at multiple scales |
| PSNR | `psnr` | `psnr_y`, `psnr_cb`, `psnr_cr` | Yes (2 inputs) | Peak signal-to-noise ratio per plane |
| PSNR-HVS | `psnr_hvs` | `psnr_hvs`, `psnr_hvs_y`, `psnr_hvs_cb`, `psnr_hvs_cr` | Yes (2 inputs) | PSNR weighted by human visual system sensitivity |
| SSIM | `float_ssim` | (structural similarity) | Yes (2 inputs) | Structural similarity |

### VMAF v1 Additions (2026-06, may not be in our build)
| Feature | Notes |
|---------|-------|
| motion_v2 | Improved motion with hard threshold and larger temporal window |
| chroma feature (SpEED-QA based) | Chroma-channel quality (catches chroma artifacts) |
| CAMBI as core feature | Integrated into v1 model by default |
| VIF removed from core | Dropped for speed; ADM retained |
| NEG mode default | No Enhancement Gain enabled by default |

### How to Extract Individual Features via ffmpeg

**No-reference CAMBI (the key one for us):**
```bash
# Same file as both inputs — CAMBI ignores the reference
ffmpeg -i input.mp4 -i input.mp4 \
  -lavfi "libvmaf=feature=name=cambi:log_fmt=json:log_path=cambi.json" \
  -f null -
```

**Extract multiple features:**
```bash
ffmpeg -i distorted.mp4 -i reference.mp4 \
  -lavfi "libvmaf=feature=name=cambi|name=psnr|name=ciede:log_fmt=json:log_path=output.json" \
  -f null -
```

**CAMBI parameters (via feature syntax):**
```bash
# Full-ref CAMBI (subtracts source banding)
feature=name=cambi:cambi_full_ref=true

# Adjust max_log_contrast (default 2, range 0-5)
feature=name=cambi:cambi_max_log_contrast=3

# Speed optimization for ≥1080p
feature=name=cambi:cambi_high_res_speedup=1080

# Heatmap output (writes .gray files to directory)
feature=name=cambi:cambi_heatmaps_path=/tmp/cambi_hm
```

**CAMBI score interpretation:**
- 0 = no banding
- ~5 = slightly annoying (threshold for attention)
- ~24 = unwatchable

### Feature-Extractor Options (advanced)

Each feature has tunable parameters via the `feature=` syntax:

**VIF options:**
- `vif.vif_enhn_gain_limit` — clip enhancement gain (for NEG mode)
- `vif.vif_scale0`..`vif_scale3` — enable/disable individual scales

**ADM options:**
- `adm.adm_enhn_gain_limit` — clip enhancement gain (for NEG mode)
- `adm.adm_ref_width` / `adm.adm_ref_height` — reference dimensions

**Motion options:**
- `motion.motion2` — use motion v2 algorithm
- `motion.motion_max_val` — hard cap on motion score
- `motion.motion_moving_average` — temporal smoothing

---

## 2. FFmpeg Built-in Quality Filters (No-Reference)

### 2.1 blockdetect — Blocking Artifact Detector
**What it measures:** DCT-grid blockiness from over-compression.
**Reference:** None (no-reference).
**Paper:** Remco Muijs and Ihor Kirenko, "A no-reference blocking artifact measure for adaptive video processing," 2005.

```bash
ffmpeg -i input.mp4 -vf "blockdetect=period_min=8:period_max=32:planes=1,metadata=mode=print:file=block.log" -f null -
```

**Parameters:**
- `period_min` / `period_max` — range to search for pixel grids (default 3–24). For H.264, 8–32 covers macroblock sizes (16px default, 8–32 for various profiles).
- `planes` — which plane to analyze (default: luma only).

**Output:** Per-frame `lavfi.blockdetect.blockiness` as metadata. Values increase with more blocking.

### 2.2 blurdetect — Blur/Sharpness Detector
**What it measures:** Perceptual blur based on edge spread.
**Reference:** None (no-reference).
**Paper:** Marziliano, Pina, et al., "A no-reference perceptual blur metric."

```bash
ffmpeg -i input.mp4 -vf "blurdetect=low=0.05:high=0.1:radius=2:block_width=32:block_height=32:block_pct=80,metadata=mode=print:file=blur.log" -f null -
```

**Parameters:**
- `low` / `high` — Canny edge thresholds (default 20/255, 50/255). Higher = stricter.
- `radius` — search radius around edge pixels for local maxima.
- `block_width` / `block_height` — block size for spatial analysis.
- `block_pct` — analyze only top N% most significant blocks.

**Output:** Per-frame `lavfi.blurdetect.blurriness` as metadata. Higher = more blurry.

### 2.3 freezedetect — Frozen Frame Detector
**What it measures:** Identifies intervals where video has no significant change.
**Reference:** None (no-reference).
**Since:** FFmpeg 4.2

```bash
ffmpeg -i input.mp4 -vf "freezedetect=n=-60dB:d=2,metadata=mode=print:file=freeze.log" -f null -
```

**Parameters:**
- `noise` / `n` — noise tolerance in dB or ratio (default -60dB / 0.001). Lower = more sensitive.
- `duration` / `d` — minimum freeze duration before flagging (default 2s).

**Output:**
- `lavfi.freezedetect.freeze_start` — timestamp where freeze begins
- `lavfi.freezedetect.freeze_duration` — how long it lasts
- `lavfi.freezedetect.freeze_end` — timestamp where freeze ends
- Logs at INFO level when freeze detected.

### 2.4 signalstats — Video Signal Statistics
**What it measures:** Luma/chroma range, temporal outliers, vertical line repetition, broadcast range violations.
**Reference:** None (no-reference, but designed for analog capture QA).

```bash
ffmpeg -i input.mp4 -vf "signalstats=stat=tout+vrep+brng,metadata=mode=print:file=signal.log" -f null -
```

**Metadata output (per-frame):**
- `YMIN/YLOW/YAVG/YHIGH/YMAX` — luma distribution [0-255]
- `UMIN/ULOW/UAVG/UHIGH/UMAX` — Cb distribution
- `VMIN/VLOW/VAVG/VHIGH/VMAX` — Cr distribution
- `SATMIN/SATLOW/SATAVG/SATHIGH/SATMAX` — saturation [0-181]
- `HUEMED/HUEAVG` — hue [0-360]
- `YDIF/UDIF/VDIF` — temporal difference (frame-to-frame)
- `YBITDEPTH/UBITDEPTH/VBITDEPTH` — detected bit depth

**Stat modes:**
- `tout` — temporal outlier detection (dropouts, tracking issues)
- `vrep` — vertical line repetition (concealment artifacts)
- `brng` — broadcast range violations

### 2.5 bitplanenoise — Bit-Plane Noise Analyzer
**What it measures:** Noise level in individual bit planes.
**Reference:** None (no-reference).

```bash
ffmpeg -i input.mp4 -vf "bitplanenoise=bitplane=4:filter=false,metadata=mode=print:file=bpn.log" -f null -
```

**Parameters:**
- `bitplane` — which bit plane (1=LSB, 8=MSB for 8-bit). Default: 1.
- `filter` — if true, shows filtered (noise-removed) view.

**Output:** `lavfi.bitplanenoise.{plane}.{bitplane}` for each of Y/U/V.

**Use case:** Detects 10-bit source material masquerading as 8-bit (noise concentrated in upper bit planes). Also useful for quantifying grain.

### 2.6 entropy — Frame Entropy
**What it measures:** Shannon entropy of the luminance histogram.
**Reference:** None (no-reference).

```bash
ffmpeg -i input.mp4 -vf "entropy=mode=normal,metadata=mode=print:file=entropy.log" -f null -
```

**Parameters:**
- `mode` — `normal` (per-frame entropy) or `diff` (entropy of frame differences).

**Output:** `lavfi.entropy` — per-frame value. Low entropy = simple/flat frames, high = complex/textured.

**Use case:** Detects compression collapse (over-compressed frames have abnormally low entropy). `diff` mode catches temporal anomalies.

### 2.7 siti — Spatial & Temporal Information
**What it measures:** ITU-T Rec. P.910 SI (spatial complexity) and TI (temporal complexity).
**Reference:** None (no-reference, but needs temporal context).

```bash
ffmpeg -i input.mp4 -vf "siti=print_summary=1,metadata=mode=print:file=siti.log" -f null -
```

**Output:**
- `lavfi.siti.si` — Spatial Information (frame complexity). Higher = more detail/edges.
- `lavfi.siti.ti` — Temporal Information (inter-frame change). Higher = more motion.

**Use case:** Content classification. Low SI + low TI = static/simple (banding-prone). High SI = grainy/detailed. High TI = action/motion.

### 2.8 colordetect — Color Property Detector
**What it measures:** YUV color range, alpha mode.
**Reference:** None.

```bash
ffmpeg -i input.mp4 -vf "colordetect=mode=all,metadata=mode=print:file=color.log" -f null -
```

**Output:** `lavfi.colordetect.color_range` (pc/full vs tv/limited), `lavfi.colordetect.alpha_mode`.

### 2.9 showinfo — Frame Metadata Dump
**What it measures:** Comprehensive per-frame info (PTS, size, checksum, etc.).
**Reference:** N/A (informational).

```bash
ffmpeg -i input.mp4 -vf "showinfo,metadata=mode=print:file=info.log" -f null -
```

**Output:** Per-frame PTS, DTS, duration, frame number, checksum, side data.

### 2.10 edgedetect — Edge Detection
**What it measures:** Edge maps for structural analysis.
**Reference:** None (no-reference).

```bash
ffmpeg -i input.mp4 -vf "edgedetect=mode=canny:low=0.1:high=0.2:planes=y" -f null -
```

**Parameters:**
- `mode` — `wires` (white/gray on black), `colormix`, `canny` (Canny edge detector).
- `low` / `high` — Canny thresholds.
- `planes` — which planes (default all).

**Use case:** Not a quality metric per se, but edge maps can be used to detect ringing (Gibbs phenomenon) by comparing edge density and position across frames, or to measure structural distortion.

### 2.11 photosensitivity — Flash/Flicker Detector
**What it measures:** Rapid luminance changes that may trigger epilepsy.
**Reference:** None (no-reference).

```bash
ffmpeg -i input.mp4 -vf "photosensitivity=frames=30:threshold=1" -f null -
```

**Parameters:**
- `frames` — window size (2–240, default 30).
- `threshold` — detection threshold (lower = stricter, default 1).
- `skip` — pixels to skip for speed.
- `bypass` — if true, analyzes but doesn't modify output.

**Use case:** Detects temporal flicker/mosquito noise indirectly — rapid luminance oscillations correlate with temporal instability from motion compensation artifacts.

### 2.12 bbox — Bounding Box
**What it measures:** Bounding box of non-black content.
**Reference:** None.

```bash
ffmpeg -i input.mp4 -vf "bbox=skipwhite=1,metadata=mode=print:file=bbox.log" -f null -
```

### 2.13 idet — Interlace Detector
**What it measures:** Progressive vs interlaced vs telecine detection.
**Reference:** None (no-reference).

```bash
ffmpeg -i input.mp4 -vf "idet,metadata=mode=print" -f null -
```

**Output:** `single.current_frame` (tff/bff/progressive/undetermined), plus aggregate counts.

### 2.14 cropdetect — Crop Region Detector
**What it measures:** Detects black borders/crop regions.
**Reference:** None.

```bash
ffmpeg -i input.mp4 -vf "cropdetect=limit=16:round=16,metadata=mode=print" -f null -
```

---

## 3. FFmpeg Full-Reference Filters (Need Two Inputs)

These require a reference video, but we can use our CRF probe's reference clips:

### 3.1 psnr — Peak Signal-to-Noise Ratio
```bash
ffmpeg -i distorted.mp4 -i reference.mp4 -lavfi psnr=stats_file=psnr.log -f null -
```
Output: Per-frame `lavfi.psnr.psnr_y`, `psnr_cb`, `psnr_cr`, `psnr_avg`.

### 3.2 ssim — Structural Similarity
```bash
ffmpeg -i distorted.mp4 -i reference.mp4 -lavfi ssim=stats_file=ssim.log -f null -
```
Output: Per-frame SSIM + overall. Components: `lavfi.ssim.Y`, `U`, `V`, `All`.

### 3.3 ssim360 — SSIM for 360° Video
Specialized version with equirectangular projection handling. Not useful for our content.

### 3.4 xpsnr — Extended Perceptually Weighted PSNR
```bash
ffmpeg -i distorted.mp4 -i reference.mp4 -lavfi xpsnr=stats_file=xpsnr.log -f null -
```
Like PSNR but perceptually weighted. Better correlation with human judgment.

### 3.5 identity — Frame-by-Frame Identity
```bash
ffmpeg -i a.mp4 -i b.mp4 -lavfi identity -f null -
```
Output: Per-frame identity score in metadata.

### 3.6 libvmaf (full model)
```bash
ffmpeg -i distorted.mp4 -i reference.mp4 \
  -lavfi "libvmaf=model=version=vmaf_v0.6.1:log_fmt=json:log_path=vmaf.json" \
  -f null -
```

---

## 4. Signal Processing Filters for Custom Detectors

### 4.1 Edge-Based Analysis (Ringing, Mosquito Noise)

**edgedetect** produces edge maps. Chain with temporal difference for ringing:
```bash
# Edge density per frame — high ringing = elevated edge count in smooth regions
ffmpeg -i input.mp4 -vf "edgedetect=mode=canny:planes=y,metadata=mode=print" -f null -
```

**Potential chain: edgedetect → temporal difference → threshold**
This would detect mosquito noise (oscillating edges near sharp boundaries). Not a pre-built filter, but achievable with `geq` or `tblend`:
```bash
# Conceptual: edge frames differ temporally = temporal edge instability
ffmpeg -i input.mp4 -lavfi \
  "[0:v]edgedetect=mode=canny:planes=y[e]; \
   [e]tblend=all_mode=difference:all_opacity=1.0[diff]; \
   [diff]metadata=mode=print" \
  -f null -
```

### 4.2 Temporal Analysis (Flicker, Temporal Inconsistency)

**signalstats YDIF/VDIF** — frame-to-frame luma/chroma change. Sudden spikes = temporal artifact.

**tblend** filter for custom temporal differencing:
```bash
# Absolute frame difference — useful for detecting temporal discontinuities
ffmpeg -i input.mp4 -vf "tblend=all_mode=absolute_diff:all_opacity=1.0,showinfo" -f null -
```

### 4.3 Frequency Analysis

**Note:** `showfreqs` and `showspectrum` are **audio** filters, not video. They visualize audio spectra.

For video frequency analysis, we'd need custom approaches:
- Use `geq` (generic equation) filter to compute per-pixel frequency-domain proxies
- Use `split` + `boxblur` + `blend` to create band-pass filters
- The libvmaf VIF feature IS a frequency-domain analysis at 4 scales

### 4.4 Histogram Analysis

**histogram** filter (video, not in our list but available):
```bash
ffmpeg -i input.mp4 -vf "histogram=level_height=255:components=0" -f null -
```
Visual only, not numeric. But can be combined with `showinfo` to read back.

**colorbalance** and **curves** for visual inspection, not analysis.

### 4.5 Motion Estimation Filters

**vidstabdetect** (from libvidstab, enabled in our build):
```bash
ffmpeg -i input.mp4 -vf "vidstabdetect=shakiness=10:result=transforms.trf" -f null -
```
Outputs per-frame motion vectors. High motion instability can indicate encoding artifacts.

**mestimate** (motion estimation):
```bash
ffmpeg -i input.mp4 -vf "mestimate=method=epzs:mb_size=16:search_param=2400" -f null -
```

---

## 5. Compound Filter Chains for Artifact Detection

### 5.1 Blocking Detection (blockdetect + signalstats)
```bash
# Combined: blockiness + broadcast range violations
ffmpeg -i input.mp4 -vf \
  "blockdetect=period_min=8:period_max=32:planes=1, \
   signalstats=stat=brng, \
   metadata=mode=print:file=combined.log" \
  -f null -
```

### 5.2 Blur + Edge Density (sharpness measurement)
```bash
# blurrise + edge count as two views of sharpness
ffmpeg -i input.mp4 -vf \
  "split[blur][edge]; \
   [blur]blurdetect=block_width=32:block_height=32:block_pct=80[b]; \
   [edge]edgedetect=mode=canny:planes=y[e]; \
   [b][e]hstack=inputs=2[out]" \
  -map "[out]" -f null -
```

### 5.3 CAMBI Heatmap Extraction
```bash
# Per-frame banding heatmaps as .gray files
ffmpeg -i input.mp4 -i input.mp4 \
  -lavfi "libvmaf=feature=name=cambi:cambi_heatmaps_path=/tmp/cambi_hm:log_fmt=json:log_path=cambi.json" \
  -f null -
```

### 5.4 Comprehensive Single-Pass Analysis
```bash
# Multiple analysis filters in one pass (for 4 samples)
ffmpeg -i clip.mp4 -i clip.mp4 \
  -lavfi " \
    split=4[s1][s2][s3][s4]; \
    [s1]blockdetect=planes=1,metadata=mode=print:file=/tmp/block.log[b]; \
    [s2]blurdetect=block_pct=80,metadata=mode=print:file=/tmp/blur.log[bl]; \
    [s3]libvmaf=feature=name=cambi:log_fmt=json:log_path=/tmp/cambi.json[c]; \
    [s4]siti=print_summary=0,metadata=mode=print:file=/tmp/siti.log[si]; \
    [b][bl][c][si]null[out]" \
  -map "[out]" -f null -
```

### 5.5 Temporal Artifact Detection
```bash
# Detect frame-to-frame instability (mosquito noise proxy)
ffmpeg -i input.mp4 -vf \
  "split[orig][delayed]; \
   [delayed]setpts=PTS+1/TB[t]; \
   [orig][t]blend=all_mode=difference:all_opacity=1.0, \
   signalstats=stat=tout, \
   metadata=mode=print:file=temporal.log" \
  -f null -
```

---

## 6. libvmaf Model Customization

### 6.1 Built-in Models
Available in our build (from libvmaf v3.x embedded in ffmpeg 8.1):

| Model | Notes |
|-------|-------|
| `vmaf_v0.6.1` | Default. v0 with VIF+ADM+motion. |
| `vmaf_v0.6.1neg` | No Enhancement Gain variant. |
| `vmaf_float_v0.6.1` | Float version (if float features enabled). |
| `vmaf_float_b_v0.6.3` | Float b-model. |
| `vmaf_float_v0.6.1neg` | Float NEG variant. |
| `vmaf_float_4k_v0.6.1` | 4K-specific model. |

### 6.2 Custom Model Training
**Possible but requires the Python library** (not bundled in our static ffmpeg build).

**What's needed:**
1. **Subjective scores** (MOS or DMOS) from human evaluation on reference+distorted pairs
2. **Feature extraction** on each pair (VIF, ADM, motion, etc.)
3. **Training script** (`vmaf/train_vmaf.py` or the new `vmaf-train` CLI)
4. **Output:** A `.json` model file usable with `model=path=custom.json`

**The training pipeline:**
```
Dataset (YUV/H.264 clips + MOS scores)
    → run_vmaf_extract (extract features per clip)
    → train_quality_model (SVR or similar regression)
    → output model.json
    → validate with test set
```

**Limitation:** Training needs the `vmaf` Python package, which requires building from source. Our static ffmpeg build doesn't include it. To train, you'd need to:
```bash
git clone https://github.com/Netflix/vmaf.git
cd vmaf/python
pip install -e .
# Then use vmaf_quality_runner, train_vmaf_model, etc.
```

**VMAF v1 (2026-06):** Netflix released new models with CAMBI as a core feature, chroma metrics, improved motion, and NEG-by-default. These may not yet be in our ffmpeg build (which bundles libvmaf v3.x from 2023). Check with:
```bash
# If vmaf CLI were available:
vmaf --version
# Or check model list:
ffmpeg -i ref.mp4 -i dist.mp4 -lavfi "libvmaf=model=version=vmaf_v1.0:log_fmt=json" -f null -
# If it errors with "unknown model", v1 isn't bundled.
```

### 6.3 Custom Feature Combinations (No Custom Model Needed)
You can extract ANY combination of features without training a new model:
```bash
# Extract CAMBI + motion + ADM without a model fusion
ffmpeg -i dist.mp4 -i ref.mp4 \
  -lavfi "libvmaf= \
    model=none: \
    feature=name=cambi|name=motion|name=adm: \
    log_fmt=json:log_path=output.json" \
  -f null -
```

This gives you raw feature scores per-frame without any SVR fusion, which is perfect for building your own scoring logic.

---

## 7. Audio Analysis Tools

### 7.1 ebur128 — EBU R128 Loudness Scanner
```bash
ffmpeg -i input.mp4 -af "ebur128=video=1:peak=sample" -f null -
```
Output: Integrated loudness, loudness range, peak levels, short-term loudness.

### 7.2 aspectralstats — Frequency Domain Audio Statistics
```bash
ffmpeg -i input.mp4 -af "aspectralstats=measure=entropy+flatness,metadata=mode=print" -f null -
```
Output: Mean, variance, centroid, spread, skewness, kurtosis, entropy, flatness, crest, flux, slope, decrease, rolloff.

### 7.3 astats — Time Domain Audio Statistics
```bash
ffmpeg -i input.mp4 -af "astats=metadata=1:reset=1" -f null -
```
Output: DC offset, min/max level, RMS level, crest factor, noise floor, bit depth, dynamic range, zero crossings.

### 7.4 Audio Quality Reference Filters
```bash
# Audio PSNR
ffmpeg -i distorted.mp4 -i reference.mp4 -af apsnr -f null -

# Audio Signal-to-Distortion Ratio
ffmpeg -i distorted.mp4 -i reference.mp4 -af asdr -f null -

# Audio Scale-Invariant SDR
ffmpeg -i distorted.mp4 -i reference.mp4 -af asisdr -f null -
```

---

## 8. Metadata Pipeline Architecture

The `metadata` filter is the glue that makes all of this programmable:

```bash
# Print all metadata from analysis filters
-metadata=mode=print:file=output.log

# Selectively filter metadata
-metadata=mode=select:key=lavfi.blockdetect.blockiness:function=greater:expr=10

# Forward metadata for downstream processing
-metadata=mode=add:key=my_score:expr=lavfi.blockdetect.blockiness*2
```

**Key pattern for batch analysis:**
```bash
ffmpeg -i input.mp4 -vf \
  "blockdetect, \
   blurdetect, \
   signalstats=stat=tout+vrep+brng, \
   freezedetect, \
   metadata=mode=print:file=analysis.json" \
  -f null -
```

Each filter writes to metadata; `metadata=mode=print` dumps them all to a file. The output format is line-by-line:
```
frame:0 pts:0 pts_time:0
lavfi.blockdetect.blockiness=2.345678
lavfi.blurdetect.blurriness=0.123456
lavfi.signalstats.YMIN=16
lavfi.signalstats.YMAX=235
...
```

---

## 9. Practical Recipes

### 9.1 Detect Banding in a Library File
```bash
FFMPEG=tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg

# CAMBI-only, no reference needed
$FFMPEG -i movie.mp4 -i movie.mp4 \
  -lavfi "libvmaf=feature=name=cambi:log_fmt=json:log_path=/tmp/cambi_out.json:n_subsample=10" \
  -f null -

# Parse: average CAMBI across frames
jq '[.frames[].metrics.cambi] | add/length' /tmp/cambi_out.json
```

### 9.2 Detect Blocking + Blur + Banding
```bash
$FFMPEG -i movie.mp4 -i movie.mp4 \
  -lavfi " \
    split=3[s1][s2][s3]; \
    [s1]blockdetect[b]; \
    [s2]blurdetect[bl]; \
    [s3]libvmaf=feature=name=cambi:log_fmt=json:log_path=/tmp/combined.json; \
    [b][bl]null[out]" \
  -map "[out]" -f null -

# blockdetect/blurdetect go to metadata; combine with metadata=mode=print
# Or run them separately with metadata output:
$FFMPEG -i movie.mp4 -vf \
  "blockdetect,blurdetect,metadata=mode=print:file=/tmp/meta.json" \
  -f null -
```

### 9.3 Content Complexity Screening (for probe scheduling)
```bash
# SI/TI per clip — use to prioritize which films need probing
$FFMPEG -i clip.mp4 -vf "siti=print_summary=1" -f null -
# Output includes average SI and TI in the summary
```

### 9.4 Entropy Collapse Detection
```bash
# Low entropy per frame = possible compression collapse
$FFMPEG -i movie.mp4 -vf "entropy=mode=normal,metadata=mode=print:file=entropy.log" -f null -
# Parse: find frames where entropy drops dramatically
```

### 9.5 Temporal Consistency Check
```bash
# YDIF from signalstats = frame-to-frame luma change
# Sudden spikes indicate temporal artifacts
$FFMPEG -i movie.mp4 -vf "signalstats,metadata=mode=print:file=sig.log" -f null -
# Look for: YDIF spikes, VDIF spikes, tout detections
```

---

## 10. What's NOT Available (Gaps)

### Not in Our Build
- **Standalone `vmaf` CLI** — would give simpler interface and model listing. Our build ships only ffmpeg/ffplay/ffprobe.
- **VMAF v1 models** — may not be bundled (v1 released 2026-06, our libvmaf is v3.x from 2023).
- **`vmaf` Python library** — needed for custom model training.
- **No standalone CAMBI tool** — must go through ffmpeg's libvmaf filter.

### Not in FFmpeg at All
- **No ghosting detector** — no built-in ghost/echo artifact filter.
- **No mosquito noise detector** — no dedicated temporal-high-frequency noise filter.
- **No quantization parameter (QP) map** — can't extract per-macroblock QP from encoded stream.
- **No motion vector visualization** — `vidstabdetect` writes transforms, not raw MVs. `mestimate` estimates but doesn't output MVs in a standard format.
- **No frame-level VMAF** — the libvmaf filter computes pooled VMAF; per-frame requires parsing JSON log output.
- **No video spectral analysis** — `showspectrum`/`showfreqs` are audio-only. Video frequency analysis requires custom filter chains or external tools.

### Possible but Not Built-In
- **Per-frame bpp from ffmpeg** — we compute this from mediaInfo, not from ffmpeg analysis.
- **10-bit vs 8-bit source detection** — `bitplanenoise` gives hints but isn't definitive. Our current approach (mediaInfo parsing + ffprobe) is more reliable.
- **Grain analysis** — no dedicated filter. `bitplanenoise` on lower bitplanes + `entropy` can approximate, but nothing validates against human perception of grain vs noise.

---

## 11. Build Configuration Key Flags

From our ffmpeg 8.1 build:
```
--enable-libvmaf          # VMAF/CAMBI/etc.
--enable-libvidstab       # Video stabilization (motion analysis)
--enable-libzimg          # High-quality resampling (for scaling operations)
--enable-vulkan           # GPU acceleration (not analysis, but filtering)
--enable-opencl           # GPU compute (some analysis filters may use)
--enable-libplacebo       # HDR/SDR tone mapping
--enable-chromaprint      # Audio fingerprinting
```

**Filters available count:** 576 total filters in this build.

---

## 12. Decision Matrix: Which Tool for Which Artifact

| Artifact | Primary Tool | Secondary | Reference Needed? |
|----------|-------------|-----------|-------------------|
| Banding/contouring | libvmaf CAMBI | — | **No** |
| Blocking (DCT grid) | blockdetect | signalstats tout | **No** |
| Blur/softness | blurdetect | — | **No** |
| Frozen frames | freezedetect | — | **No** |
| Temporal flicker | photosensitivity | signalstats YDIF | **No** |
| Noise level | bitplanenoise | entropy | **No** |
| Content complexity | siti | entropy | **No** |
| Overall quality | libvmaf (v0.6.1) | psnr + ssim | **Yes** |
| Color difference | ciede2000 (via libvmaf) | — | **Yes** |
| Luma/chroma stats | signalstats | — | **No** |
| Bit depth detection | bitplanenoise | — | **No** |
| Interlacing | idet | — | **No** |
| Crop borders | cropdetect | bbox | **No** |
| Audio loudness | ebur128 | astats | **No** |
| Audio spectrum | aspectralstats | — | **No** |
| Flash safety | photosensitivity | — | **No** |
| Mosquito noise | **(no dedicated tool)** | signalstats + edgedetect chain | **No** (chain) |
| Ringing | **(no dedicated tool)** | edgedetect chain | **No** (chain) |
| Ghosting | **(no dedicated tool)** | — | N/A |

---

## 13. Key Takeaway for Our System

**What we can deploy immediately for no-reference detection:**
1. **CAMBI** (banding) — already in production via `controller/lib/banding.js`
2. **blockdetect** (blocking) — trivial to add, metadata output, fast
3. **blurdetect** (blur) — trivial to add, metadata output, fast
4. **freezedetect** (frozen frames) — trivial, high-value QA
5. **signalstats** (luma/chroma stats, temporal outliers) — rich data, fast
6. **entropy** (information content) — compression collapse detection
7. **bitplanenoise** (bit-plane noise) — 10-bit source detection
8. **siti** (SI/TI) — content complexity for probe scheduling

**What needs development work:**
- Compound filter chains for ringing/mosquito detection
- Batch metadata aggregation pipeline
- Threshold calibration against human judgment

**What requires external tools:**
- True no-reference perceptual quality (BRISQUE, NIQE, MUSIQ — via pyiqa)
- Learned video quality models (FAST-VQA, DOVER — need GPU)
- Ghosting detection (no good open-source solution exists)
