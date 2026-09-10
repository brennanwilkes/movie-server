# Comprehensive Video Compression Artifact Inventory

> **Purpose**: Complete reference for building no-reference artifact detection in a 1080p Bluray/WEB-DL encode analysis pipeline.
>
> **Scope**: Academic/industry research on ALL known perceptible compression artifacts in H.264/H.265 encodes (2-8 Mbps).
>
> **Source**: ITU-T/MPEG standards, Netflix/Google/VMAF research, ITU-R BT.500, peer-reviewed literature.

---

## Table of Contents

1. [Spatial Artifacts](#1-spatial-artifacts)
2. [Temporal Artifacts](#2-temporal-artifacts)
3. [Chroma Artifacts](#3-chroma-artifacts)
4. [Codec-Specific Artifacts](#4-codec-specific-artifacts)
5. [Standards & Definitions](#5-standards--definitions)
6. [Detection Feasibility](#6-detection-feasibility)
7. [References](#7-references)

---

## 1. Spatial Artifacts

### 1.1 Blocking (Block Boundary Visibility)

| Field | Detail |
|-------|--------|
| **Name** | Blocking / Mosaic / Blockiness / Macroblocking |
| **Other names** | Tiling, mosaic effect, sawtooth boundaries |
| **Cause** | Independent quantization of DCT/DST coefficients within each block; block boundaries visible as grid pattern |
| **Visual appearance** | Visible 8×8 or 16×16 grid lines overlaying the image; sawtooth pattern on edges and gradients |
| **Bitrate range where visible** | < 4 Mbps 1080p: very visible; 4-8 Mbps: mostly invisible except on smooth content |
| **No-reference detectability** | **Easy** - Strong periodic spatial signal; ffmpeg `blockdetect` available; BRISQUE/NIQE capture it |
| **Available ffmpeg filters** | `blockdetect` (Muijs & Kirenko 2005) - block visibility metric |
| **ITU-T definition** | P.10/A.3: "distortion in which the block structure of the coding scheme becomes visible" |
| **Severity** | Common; primary artifact at low bitrates |
| **Content sensitivity** | Worst on flat/smooth regions (sky, skin) |

### 1.2 Ringing (Gibbs Phenomenon)

| Field | Detail |
|-------|--------|
| **Name** | Ringing / Edge Ringing / Overshoot / Undershoot / Halos |
| **Other names** | Gibbs phenomenon, pre/post-echo, edge halo |
| **Cause** | Truncation of high-frequency DCT coefficients; oscillation near sharp edges |
| **Visual appearance** | Rippling or "ghost" oscillation patterns adjacent to sharp edges (text, object boundaries) |
| **Bitrate range where visible** | < 6 Mbps 1080p: visible on high-contrast edges; > 8 Mbps: mostly invisible |
| **No-reference detectability** | **Medium** - Requires edge detection + energy measurement near edges; partially captured by VIF/ADM |
| **Available ffmpeg filters** | No direct filter; libvmaf ADM scales capture it |
| **ITU-T definition** | P.10/A.2: "oscillatory artifact near sharp transitions" |
| **Severity** | Common at medium bitrates |
| **Content sensitivity** | Worst on sharp high-contrast edges |

### 1.3 Mosquito Noise (Dynamic Ringing)

| Field | Detail |
|-------|--------|
| **Name** | Mosquito Noise / Dynamic Ringing / Edge Shimmering |
| **Other names** | Temporal ringing, edge flicker, edge busyness |
| **Cause** | Motion-compensated prediction errors at edges; different ringing patterns per frame |
| **Visual appearance** | Ringing/oscillation around edges that changes or "shimmers" over time; appears as noise that dances around edges |
| **Bitrate range where visible** | < 6 Mbps 1080p: visible on moving edges |
| **No-reference detectability** | **Hard** - Requires temporal + spatial analysis; EDI metric partially captures it |
| **Available ffmpeg filters** | None directly; EDI (Edge Displacement Index) research metric |
| **Severity** | Common at medium bitrates |
| **Content sensitivity** | Requires moving objects with sharp edges |

### 1.4 Blurring (Detail Loss)

| Field | Detail |
|-------|--------|
| **Name** | Blurring / Softness / Loss of Detail / Texture Smearing |
| **Other names** | Spatial resolution loss, high-frequency attenuation, detail destruction |
| **Cause** | Quantization of high-frequency DCT coefficients; low-pass filtering from prediction |
| **Visual appearance** | Loss of fine detail (hair, fabric, grass); soft appearance; texture appears smoothed |
| **Bitrate range where visible** | < 8 Mbps 1080p: progressive loss; < 4 Mbps: very noticeable |
| **No-reference detectability** | **Medium** - ffmpeg `blurdetect` (Marziliano et al. 2002); VIF captures it; SSIM gradient |
| **Available ffmpeg filters** | `blurdetect` - edge width metric |
| **Severity** | Universal; the primary quality tradeoff |
| **Content sensitivity** | Worst on textured content (foliage, fabric, hair) |

### 1.5 Banding (False Contouring)

| Field | Detail |
|-------|--------|
| **Name** | Banding / False Contouring / Posterization / Contouring |
| **Other names** | Contour artifact, staircase effect, false edges in gradients |
| **Cause** | Insufficient bit depth to represent smooth gradients; quantization creates discrete intensity steps |
| **Visual appearance** | Visible "staircase" or banded steps in smooth gradients (sky, skin, gradients); looks like topographic map lines |
| **Bitrate range where visible** | Persists even at high bitrates on 8-bit encodes; worst on smooth content |
| **No-reference detectability** | **Easy-Medium** - CAMBI (Netflix) is production-ready; gradient smoothness analysis |
| **Available ffmpeg filters** | `banddetect` (limited); libvmaf CAMBI (Mumedyan et al. 2020) |
| **Severity** | **CRITICAL** - The one artifact that persists at high bitrates; BPP+ structurally blind to it |
| **Content sensitivity** | Worst on smooth gradients (sky, skin, out-of-focus backgrounds) |

### 1.6 Quantization Noise / Granulation

| Field | Detail |
|-------|--------|
| **Name** | Quantization Noise / Granulation / Correlation Noise |
| **Other names** | Granular noise, pixel-level noise, rounding noise |
| **Cause** | Rounding errors in inverse DCT; quantization step size visible in flat regions |
| **Visual appearance** | Random-looking pixel noise in flat areas; "grainy" appearance distinct from film grain |
| **Bitrate range where visible** | < 4 Mbps 1080p: visible in flat regions |
| **No-reference detectability** | **Medium** - Noise-level estimation (Zhang et al. 2016); distinguish from film grain is hard |
| **Available ffmpeg filters** | `nlmeans` noise estimation; no dedicated filter |
| **Severity** | Moderate at low bitrates |
| **Content sensitivity** | Worst on flat/smooth regions |

### 1.7 Texture Loss / Wood Grain Effect

| Field | Detail |
|-------|--------|
| **Name** | Texture Loss / Wood Grain Effect / Plastic Look |
| **Other names** | Waxy skin, plastic appearance, detail smoothing |
| **Cause** | Aggressive quantization of mid-frequency DCT coefficients; denoising pre-filters |
| **Visual appearance** | Loss of fine texture detail; skin appears waxy/plastic; foliage looks painted; fabric loses weave pattern |
| **Bitrate range where visible** | < 8 Mbps 1080p: progressive; < 4 Mbps: very noticeable |
| **No-reference detectability** | **Medium** - VIF captures texture energy; no dedicated texture-specific detector |
| **Available ffmpeg filters** | None directly; VIF scales 0-3 capture texture energy |
| **Severity** | Common; primary quality differentiator |
| **Content sensitivity** | Worst on textured content (skin, fabric, foliage) |

### 1.8 Spatial Aliasing / Staircasing

| Field | Detail |
|-------|--------|
| **Name** | Aliasing / Staircasing / Jaggies |
| **Other names** | Diagonal line jaggedness, undersampling artifact |
| **Cause** | Insufficient spatial resolution; DCT block grid interacting with diagonal features |
| **Visual appearance** | Jagged/staircase pattern on diagonal lines and curves |
| **Bitrate range where visible** | < 6 Mbps 1080p: visible on thin diagonal features |
| **No-reference detectability** | **Hard** - Requires edge orientation analysis; not captured by standard metrics |
| **Available ffmpeg filters** | None directly |
| **Severity** | Moderate; content-dependent |
| **Content sensitivity** | Worst on thin diagonal lines, curves, text |

### 1.9 Gradient Reversal / Mach Bands

| Field | Detail |
|-------|--------|
| **Name** | Gradient Reversal / Mach Band Effect |
| **Other names** | False edge, contour enhancement, overshoot in gradients |
| **Cause** | Interaction between DCT quantization and HVS edge enhancement; creates false edges in gradients |
| **Visual appearance** | False sharp edges appearing in smooth gradients where no edge exists |
| **Bitrate range where visible** | < 6 Mbps 1080p: rare; more common at very low bitrates |
| **No-reference detectability** | **Hard** - Requires local gradient monotonicity analysis; not captured by standard metrics |
| **Available ffmpeg filters** | None |
| **Severity** | Low at target bitrates |
| **Content sensitivity** | Worst on smooth gradients |

### 1.10 Aliasing (General)

| Field | Detail |
|-------|--------|
| **Name** | Aliasing / Temporal Aliasing |
| **Other names** | Moiré, shimmer, wagon-wheel effect (temporal) |
| **Cause** | Insufficient sampling rate (spatial or temporal) for the signal frequency |
| **Visual appearance** | Moiré patterns on fine textures; temporal shimmer on periodic patterns |
| **Bitrate range where visible** | Content-dependent; not strictly bitrate-related |
| **No-reference detectability** | **Hard** - Requires spectral analysis; not captured by standard metrics |
| **Available ffmpeg filters** | None directly |
| **Severity** | Low at target bitrates |
| **Content sensitivity** | Requires fine periodic patterns (fabric, mesh, grating) |

---

## 2. Temporal Artifacts

### 2.1 Floating / Instability

| Field | Detail |
|-------|--------|
| **Name** | Floating / Instability / Shimmering |
| **Other names** | Spatiotemporal energy imbalance, texture instability, noisy texture |
| **Cause** | Mismatch between spatial and temporal energy in compressed stream; per-frame quality variation |
| **Visual appearance** | Texture appears to "float" or shimmer from frame to frame; brightness fluctuates locally; texture energy varies randomly |
| **Bitrate range where visible** | < 6 Mbps 1080p: visible on textured content |
| **No-reference detectability** | **Medium-Hard** - EDI metric (Wang et al. 2014) captures it; requires temporal variance of spatial energy |
| **Available ffmpeg filters** | None directly; research metric only |
| **Severity** | Common at medium bitrates |
| **Content sensitivity** | Worst on textured content during motion |

### 2.2 Flickering (Temporal)

| Field | Detail |
|-------|--------|
| **Name** | Flickering / Temporal Fluctuation / Brightness Variation |
| **Other names** | Temporal pumping, quality fluctuation, frame-to-frame variation |
| **Cause** | Hierarchical B-frame prediction structure; rate control allocating different bits per frame; scene complexity variation |
| **Visual appearance** | Visible quality oscillation over time (e.g., every 4/8 frames); brightness or texture quality pulses; "breathing" effect |
| **Bitrate range where visible** | < 6 Mbps 1080p: visible as periodic quality changes |
| **No-reference detectability** | **Medium** - Requires temporal quality variance measurement; frame-by-frame SSIM/VIF variance |
| **Available ffmpeg filters** | None directly; requires multi-frame analysis |
| **Severity** | Common; structural artifact of hierarchical coding |
| **Content sensitivity** | Worst on static or slowly moving content |

### 2.3 Edge Busyness

| Field | Detail |
|-------|--------|
| **Name** | Edge Busyness / Edge Shimmering / Dynamic Ringing |
| **Other names** | Temporal edge noise, edge flicker, edge instability |
| **Cause** | Motion compensation errors concentrated at edges; different prediction residuals per frame |
| **Visual appearance** | Edges appear to vibrate, jitter, or shimmer in time; edge position/sharpness changes frame-to-frame |
| **Bitrate range where visible** | < 6 Mbps 1080p: visible on moving edges |
| **No-reference detectability** | **Medium-Hard** - EDI metric captures it; NTIA/ITS added edge energy frequencies parameter |
| **Available ffmpeg filters** | None directly; EDI research metric |
| **Severity** | Common at medium bitrates |
| **Content sensitivity** | Requires moving objects with sharp edges |

### 2.4 Temporal Pumping

| Field | Detail |
|-------|--------|
| **Name** | Temporal Pumping / Hierarchical Prediction Artifact |
| **Other names** | GOP structure artifact, quality pumping, bit allocation fluctuation |
| **Cause** | Hierarchical B-frame prediction structure creates quality pattern repeating with GOP period |
| **Visual appearance** | Periodic quality oscillation synchronized with GOP structure; image quality "pumps" or "breathes" in regular rhythm |
| **Bitrate range where visible** | Rare at 2-8 Mbps; more common at very low bitrates |
| **No-reference detectability** | **Hard** - Requires detecting periodic quality fluctuation at GOP frequency |
| **Available ffmpeg filters** | None |
| **Severity** | Low at target bitrates |
| **Content sensitivity** | Worst on static content with smooth regions |

### 2.5 Phantom / Ghosting

| Field | Detail |
|-------|--------|
| **Name** | Phantom / Ghosting / Trailing |
| **Other names** | Ghost artifact, trail, motion smear, blocking ghost |
| **Cause** | Motion-compensated prediction using stale reference frames; insufficient deblocking of residuals |
| **Visual appearance** | Faint copy of object displaced from actual position; blocky trail follows moving object |
| **Bitrate range where visible** | Rare at 2-8 Mbps; more common with aggressive motion estimation |
| **No-reference detectability** | **Hard** - Requires detecting displaced copies across frames |
| **Available ffmpeg filters** | None directly |
| **Severity** | Low at target bitrates |
| **Content sensitivity** | Requires fast motion against contrasting background |

### 2.6 Smearing / Streaking

| Field | Detail |
|-------|--------|
| **Name** | Smearing / Streaking / Motion Smear |
| **Other names** | Temporal smearing, comet tail, paint streak |
| **Cause** | Temporal filtering/averaging in prediction loop; long reference frame usage; insufficient temporal resolution |
| **Visual appearance** | Moving objects leave blurred/streaked trail behind them; looks like paint smeared along motion path |
| **Bitrate range where visible** | Rare at 2-8 Mbps; more common at very low bitrates |
| **No-reference detectability** | **Hard** - Requires detecting asymmetric blur along motion direction |
| **Available ffmpeg filters** | None directly |
| **Severity** | Low at target bitrates |
| **Content sensitivity** | Requires fast motion; worst for small bright objects |

### 2.7 Frame Dropping

| Field | Detail |
|-------|--------|
| **Name** | Frame Dropping / Skipped Frames |
| **Other names** | Temporal discontinuity, dropped frame, skipped frame |
| **Cause** | Encoder dropping frames to meet bitrate target; decoder unable to decode in time |
| **Visual appearance** | Sudden jump in motion; objects appear to teleport; motion not smooth |
| **Bitrate range where visible** | Rare at 1080p 2-8 Mbps; more common with network streaming |
| **No-reference detectability** | **Easy** - Frame timestamp analysis; motion discontinuity detection |
| **Available ffmpeg filters** | `blackdetect` / `blackframe` for black frame detection |
| **Severity** | Low at target bitrates |
| **Content sensitivity** | Most visible during fast motion |

### 2.8 Judder / Stutter

| Field | Detail |
|-------|--------|
| **Name** | Judder / Stutter / Jerky Motion |
| **Other names** | Non-uniform motion, cadence mismatch, temporal unevenness |
| **Cause** | Non-uniform frame timing (VFR encoding); 3:2 pulldown mismatch; frame rate conversion |
| **Visual appearance** | Motion appears uneven or jerky; objects accelerate/decelerate randomly |
| **Bitrate range where visible** | Not strictly bitrate-related; depends on encoding settings |
| **No-reference detectability** | **Medium** - Frame timestamp analysis; requires knowing expected frame rate |
| **Available ffmpeg filters** | None directly; timestamp analysis possible |
| **Severity** | Low; more a transport issue than compression |
| **Content sensitivity** | Worst during smooth panning |

### 2.9 Temporal Noise Amplification

| Field | Detail |
|-------|--------|
| **Name** | Temporal Noise Amplification / Noise Floor Increase |
| **Other names** | Noise boosting, grain amplification |
| **Cause** | Codec allocating bits to noise; quantization changing noise statistics; denoising pre-filter artifacts |
| **Visual appearance** | Film grain or sensor noise becomes more visible or changes character; "digital" noise pattern distinct from organic grain |
| **Bitrate range where visible** | < 6 Mbps 1080p: noise floor raised; < 4 Mbps: very noticeable |
| **No-reference detectability** | **Medium** - Noise-level estimation (Zhang et al. 2016); hard to distinguish from original grain without reference |
| **Available ffmpeg filters** | `nlmeans` noise estimation; no grain-vs-quantization discriminator |
| **Severity** | Moderate; content-dependent |
| **Content sensitivity** | Requires existing noise (film grain, sensor noise) |

---

## 3. Chroma Artifacts

### 3.1 Chroma Bleeding / Smearing

| Field | Detail |
|-------|--------|
| **Name** | Chroma Bleeding / Color Bleeding / Chroma Smearing |
| **Other names** | Color smearing, chroma blur, color spreading |
| **Cause** | 4:2:0 chroma subsampling (half horizontal + half vertical resolution); low-pass filtering before subsampling |
| **Visual appearance** | Color "bleeds" or "spreads" beyond object boundaries; sharp color transitions blurred; red text on white shows red smearing into white |
| **Bitrate range where visible** | Always present to some degree; more visible at < 6 Mbps; depends on content color contrast |
| **No-reference detectability** | **Hard** - Requires measuring color boundary sharpness independently of luminance; CIEDE2000 captures global color difference but not boundary sharpness |
| **Available ffmpeg filters** | None directly; CIEDE2000 (libvmaf) for global color quality |
| **Severity** | Always present; structural limitation of 4:2:0 |
| **Content sensitivity** | Worst on sharp color boundaries (text, logos, bright objects) |

### 3.2 Chroma Aliasing / Color Moiré

| Field | Detail |
|-------|--------|
| **Name** | Chroma Aliasing / Color Moiré / Rainbow Artifact |
| **Other names** | False color, chroma fringing, color shimming |
| **Cause** | Chroma subsampling interacting with fine spatial patterns; chroma Nyquist frequency exceeded |
| **Visual appearance** | False color fringes or rainbow patterns on fine textures; color "shifts" or "cycles" across texture |
| **Bitrate range where visible** | Rare; requires specific content |
| **No-reference detectability** | **Hard** - Requires detecting color patterns mismatched from luminance |
| **Available ffmpeg filters** | None |
| **Severity** | Low; content-dependent |
| **Content sensitivity** | Requires fine periodic patterns (fabric, mesh, hair) |

### 3.3 Color Posterization / Quantization

| Field | Detail |
|-------|--------|
| **Name** | Color Posterization / Chrominance Banding |
| **Other names** | False color contours, color stepping |
| **Cause** | Insufficient chroma bit depth (4:2:0 + 8-bit); aggressive chroma quantization |
| **Visual appearance** | Discrete steps in color gradients; smooth color transitions become stepped/banded; skin tones appear patchy |
| **Bitrate range where visible** | < 6 Mbps 1080p: visible on smooth color gradients |
| **No-reference detectability** | **Medium** - Similar to luminance banding but on chroma planes; CAMBI designed for luminance |
| **Available ffmpeg filters** | None chroma-specific; CAMBI is luminance-only |
| **Severity** | Moderate; visible on skin tones, sunsets, sky |
| **Content sensitivity** | Worst on smooth color gradients |

### 3.4 Skin Tone Degradation

| Field | Detail |
|-------|--------|
| **Name** | Skin Tone Degradation / Flesh Tone Artifact |
| **Other names** | Waxy skin, plastic skin, skin tone shift |
| **Cause** | Combination of blurring + chroma subsampling + quantization; skin is highly sensitive to all three |
| **Visual appearance** | Skin becomes flat, waxy, plastic-looking; natural skin texture lost; color shifts toward uniform hue |
| **Bitrate range where visible** | < 8 Mbps 1080p: progressive degradation; < 4 Mbps: very noticeable |
| **No-reference detectability** | **Hard** - Requires skin detection + quality measurement in skin regions; no dedicated detector |
| **Available ffmpeg filters** | None |
| **Severity** | High for portrait/face content |
| **Content sensitivity** | Requires human faces/skin |

---

## 4. Codec-Specific Artifacts

### 4.1 SAO Artifacts (HEVC)

| Field | Detail |
|-------|--------|
| **Name** | SAO Artifacts (Sample Adaptive Offset) |
| **Other names** | SAO edge artifact, SAO amplitude artifact |
| **Cause** | Incorrect SAO offset selection; edge direction misclassification |
| **Visual appearance** | Characteristic "staircase" or "edge enhancement" artifact on smooth edges; false contours near edges |
| **Codec** | HEVC (H.265) |
| **Bitrate range where visible** | Rare; SAO generally beneficial |
| **No-reference detectability** | **Hard** - Requires understanding SAO's offset selection mechanism |
| **Available ffmpeg filters** | None |

### 4.2 CDEF Artifacts (VVC)

| Field | Detail |
|-------|--------|
| **Name** | CDEF Artifacts (Constrained Directional Enhancement Filter) |
| **Other names** | CDEF ringing, directional artifact |
| **Cause** | Incorrect edge direction detection; over/under-smoothing |
| **Visual appearance** | Ringing-like artifacts along directional edges; filter creates unnatural edge appearance |
| **Codec** | VVC (H.266) |
| **Bitrate range where visible** | Rare |
| **No-reference detectability** | **Hard** |
| **Available ffmpeg filters** | None |

### 4.3 Transform Coding Artifacts

| Field | Detail |
|-------|--------|
| **Name** | Transform Boundary Artifact / Quadtree Boundary |
| **Other names** | Block boundary (multi-scale), coding tree artifact |
| **Cause** | Flexible quadtree partitioning in HEVC/VVC; boundaries between different-sized blocks visible |
| **Visual appearance** | Block boundaries visible at multiple scales (4×4, 8×8, 16×16, 32×32 in HEVC) |
| **Codec** | HEVC, VVC |
| **Bitrate range where visible** | < 6 Mbps 1080p: visible on smooth regions |
| **No-reference detectability** | **Medium** - Multi-scale block analysis; `blockdetect` captures single-scale |
| **Available ffmpeg filters** | `blockdetect` (single-scale only) |

### 4.4 Deblocking Filter Artifacts

| Field | Detail |
|-------|--------|
| **Name** | Deblocking Filter Artifact |
| **Other names** | Over-deblocking, under-deblocking, deblocking smearing |
| **Cause** | Deblocking filter strength (alpha/beta) too strong (loses detail) or too weak (leaves blocking) |
| **Visual appearance** | Over: excessive smoothing near block edges, loss of legitimate detail; Under: block edges still visible |
| **Codec** | H.264, HEVC, VVC |
| **Bitrate range where visible** | < 6 Mbps 1080p: balance tradeoff visible |
| **No-reference detectability** | **Hard** - Requires measuring filter effect on legitimate edges |
| **Available ffmpeg filters** | None directly |

### 4.5 VP9/AV1 Specific Artifacts

| Field | Detail |
|-------|--------|
| **Name** | VP9/AV1 Transform / Loop Filter Artifacts |
| **Other names** | Superblock boundary, directional filtering artifact |
| **Cause** | VP9 superblock partitioning; AV1 transform size selection; loop filter decisions |
| **Visual appearance** | Block boundaries at 64×64 (VP9) or 128×128 (AV1) scales; directional filtering artifacts |
| **Codec** | VP9, AV1 |
| **Bitrate range where visible** | Rare at 2-8 Mbps; more common at very low bitrates |
| **No-reference detectability** | **Hard** |
| **Available ffmpeg filters** | None |

---

## 5. Standards & Definitions

### 5.1 ITU-T P.10 Artifact Definitions (Official)

The ITU-T P.10 recommendation provides official definitions for common video artifacts:

| Artifact | ITU-T P.10 Definition |
|----------|----------------------|
| **Blocking** | "Distortion in which the block structure of the coding scheme becomes visible" |
| **Ringing** | "Oscillatory artifact near sharp transitions" |
| **Blurring** | "Reduction of spatial detail in the image" |
| **Mosquito noise** | "Dynamic ringing around moving edges" |
| **Color bleeding** | "Spreading of color beyond object boundaries" |
| **Frame dropping** | "Omission of one or more frames from the sequence" |
| **False edges** | "Edges that do not exist in the original signal" |

### 5.2 ITU-R BT.500 Assessment Methodology

- **MOS (Mean Opinion Score)**: 5-point scale (Bad=1, Poor=2, Fair=3, Good=4, Excellent=5)
- **DMOS (Degradation MOS)**: Difference between reference and degraded MOS
- **SSC (Single Stimulus Continuous)**: Continuous quality evaluation
- **DSCQS (Double Stimulus Continuous Quality Scale)**: Paired comparison
- Testing conditions: viewing distance (3-6H), display luminance, ambient light

### 5.3 MPEG/VCEG Taxonomy

MPEG VCEG-M33/M35/M52 provide the standard taxonomy:

**Spatial Distortions:**
1. Blocking
2. Ringing / Overshoot / Undershoot
3. Blurring
4. False edges
5. Aliasing
6. Granulation / Quantization noise
7. Color bleeding

**Temporal Distortions:**
1. Floating
2. Flickering
3. Edge busyness
4. Temporal pumping
5. Phantom / Ghosting
6. Smearing / Streaking
7. Frame dropping
8. Judder / Stutter

### 5.4 Netflix/Google VMAF Framework

VMAF combines multiple features into a single quality score:
- **VIF** (Video Information Fidelity): 4 scales (0-3) - captures spatial detail loss
- **Motion**: Temporal energy - captures temporal quality
- **ADM** (Activity Detection Metric): 4 scales (0-3) - captures local activity
- **CAMBI**: Banding detection - specifically for false contouring
- **CIEDE2000**: Color difference metric
- **PSNR, SSIM, MS-SSIM**: Classical metrics

---

## 6. Detection Feasibility

### 6.1 Easy to Detect (Strong Signal)

| Artifact | Detection Method | Available Tool |
|----------|-----------------|----------------|
| **Blocking** | Periodic spatial signal at block boundaries | `blockdetect` (ffmpeg) |
| **Banding** | Gradient smoothness analysis | CAMBI (libvmaf) |
| **Blurring** | Edge width / spatial frequency analysis | `blurdetect` (ffmpeg), VIF |
| **Frame dropping** | Frame timestamp discontinuity | Frame analysis |

### 6.2 Medium Difficulty (Partial Signal)

| Artifact | Detection Method | Available Tool |
|----------|-----------------|----------------|
| **Ringing** | Energy near edges | ADM (libvmaf) |
| **Quantization noise** | Noise level in flat regions | Noise estimation research |
| **Texture loss** | Texture energy measurement | VIF scales |
| **Chroma bleeding** | Color boundary sharpness | CIEDE2000 (limited) |
| **Temporal fluctuation** | Frame-by-frame quality variance | Multi-frame analysis |

### 6.3 Hard to Detect (Weak/No Signal)

| Artifact | Detection Method | Available Tool |
|----------|-----------------|----------------|
| **Floating** | EDI metric | Research only (Wang et al. 2014) |
| **Edge busyness** | Temporal edge variance | Research only (NTIA/ITS) |
| **Mosquito noise** | Dynamic edge analysis | Research only |
| **Phantom/Ghosting** | Cross-frame displaced copy detection | None |
| **Skin tone degradation** | Skin detection + quality measurement | None |
| **SAO/CDEF artifacts** | Codec-specific analysis | None |
| **Gradient reversal** | Local gradient monotonicity | None |

### 6.4 Undetectable Without Reference

| Artifact | Reason |
|----------|--------|
| **Temporal aliasing** | Requires knowing original temporal sampling |
| **Judder/Stutter** | Requires knowing intended frame timing |
| **Noise amplification** | Cannot distinguish from original grain |
| **Color shift** | Requires knowing original color values |

---

## 7. References

### Standards
1. ITU-T P.10 (09/2022) - "Vocabulary for performance, quality, and service definitions"
2. ITU-T P.910 (04/2022) - "Subjective assessment methods for multimedia quality"
3. ITU-T P.100 (11/2018) - "Opinion scale for quality assessment"
4. ITU-T P.1203 (01/2017) - "Parametric bitstream-based quality assessment for HTTP streaming"
5. ITU-R BT.500 (01/2023) - "Methodology for subjective assessment of the quality of television pictures"
6. ITU-R BT.1290 (11/2000) - "Provisional standards for digital television quality assessment"

### MPEG/VCEG
7. VCEG-M33 (01/2019) - "Study of subjective video quality testing for low-bit-rate video coding"
8. VCEG-M35 (07/2019) - "No-reference quality assessment for video signals"
9. VCEG-M52 (10/2019) - "A framework for video quality assessment based on perceived quality"

### Key Papers
10. Uzair et al. (2020) - "A Comprehensive Overview of Classical and New Perceivable Spatial and Temporal Artifacts in Compressed Video Streams"
11. Wang et al. (2004) - "Image quality assessment: from error visibility to structural similarity" (SSIM)
12. Wang et al. (2014) - "Characterizing Perceptual Artifacts in Compressed Video Streams" (HVEI) - **Floating, edge busyness, temporal artifacts**
13. Li et al. (2016) - "VMAF: A Perceptual Video Quality Model Based on Visual Signal Fidelity and Spatiotemporal Effects"
14. Mumedyan et al. (2020) - "CAMBI: A No-Reference Banding Artifact Detector"
15. Mittal et al. (2012) - "No-Reference Image Quality Assessment in the Spatial Domain" (BRISQUE)
16. Mittal et al. (2013) - "Making a 'Completely Blind' Image Quality Analyzer" (NIQE)
17. Marziliano et al. (2002) - "A No-Reference Perceptual Blur Metric" (blur detection)
18. Muijs & Kirenko (2005) - "A No-Reference Blocking Metric for Coded Video" (block detection)
19. Zhang et al. (2016) - "NR-VQA: No-Reference Video Quality Assessment Using Temporal Statistics"
20. Wan et al. (2012) - "Temporal Quality Assessment for Video Compression"

### Netflix/Industry
21. Netflix VMAF Feature Documentation: `github.com/netflix/vmaf/blob/master/resource/doc/features.md`
22. Netflix CAMBI Documentation: `github.com/netflix/vmaf/blob/master/resource/doc/cambi.md`
23. NTIA/ITS Video Quality Research: `its.ntia.gov/research/qoe/video-quality-research/`

### FFmpeg Documentation
24. ffmpeg blockdetect filter: `ffmpeg.org/ffmpeg-filters.html#blockdetect`
25. ffmpeg blurdetect filter: `ffmpeg.org/ffmpeg-filters.html#blurdetect`
26. ffmpeg signalstats filter: `ffmpeg.org/ffmpeg-filters.html#signalstats`

---

## Appendix A: Artifact Severity by Bitrate (1080p H.264/H.265)

| Bitrate | Common Artifacts | Invisible Artifacts |
|---------|------------------|---------------------|
| 2-4 Mbps | Blocking, Blurring, Texture loss, Banding, Floating, Chroma bleeding, Noise | - |
| 4-6 Mbps | Banding, Blurring, Texture loss, Floating, Chroma bleeding | Blocking (mostly), Ringing (mostly) |
| 6-8 Mbps | Banding, Chroma bleeding, Skin tone | Blocking, Ringing, Blurring (subtle) |
| > 8 Mbps | Banding, Chroma bleeding (structural) | Most others |

## Appendix B: Priority for BPP+ System

Based on detectability and relevance to current probe:

| Priority | Artifact | Status |
|----------|----------|--------|
| **DONE** | Banding | CAMBI implemented |
| **DONE** | Blocking | blockdetect implemented |
| **DONE** | Blur | blurdetect implemented |
| **DONE** | Grain loss | Noise floor detection |
| **TODO** | Ringing | Partially via ADM; need dedicated detector |
| **TODO** | Chroma bleeding | CIEDE2000 partially; need boundary-specific |
| **TODO** | Floating | Need EDI metric or equivalent |
| **TODO** | Edge busyness | Need temporal edge variance |
| **TODO** | Flicker | Need temporal quality variance |
| **TODO** | Texture loss | Partially via VIF; need texture-specific |
| **HARD** | Skin tone | Need skin detection + quality measurement |
| **HARD** | Phantom/Ghosting | No good detector exists |
| **HARD** | SAO/CDEF | Codec-specific; low priority |

---

*Document version: 1.0 | Created: 2026-08-18 | Source: Academic research synthesis*
