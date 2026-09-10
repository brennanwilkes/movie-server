# Source-Quality Artifacts in High-Bitrate 1080p Encodes

**Date:** 2026-08-26
**Scope:** Artifacts that exist BEFORE or INDEPENDENT OF the encoder — properties of the source, transfer, or mastering chain. Not compression artifacts.

---

## Table of Contents

1. [Upscale Detection](#1-upscale-detection)
2. [Telecine / Pulldown](#2-telecine--pulldown)
3. [Analog Transfer Artifacts](#3-analog-transfer-artifacts)
4. [HDR/SDR Conversion Artifacts](#4-hdrsdr-conversion-artifacts)
5. [Audio-Video Sync](#5-audio-video-sync)
6. [Encoding Provenance](#6-encoding-provenance)
7. [Dark/Night Scene Quality](#7-darknight-scene-quality)
8. [Chroma-Specific Artifacts](#8-chroma-specific-artifacts)
9. [Text/Graphics Artifacts](#9-textgraphics-artifacts)
10. [Summary: Priority Matrix](#10-summary-priority-matrix)
11. [References](#11-references)

---

## 1. Upscale Detection

### What it looks like

A 1080p file that was actually produced by scaling a 720p or 480p source. Visually: soft image despite nominal resolution, absence of fine high-frequency detail, ringing or "haloing" from Lanczos/bicubic interpolation, slight blurriness in textures. Common in piracy (re-encoded from streaming rips, cam sources upscaled for fake "BluRay" tags).

### How common in 1080p Bluray/WEB-DL

Low for legitimate Bluray (mastered at native resolution). Moderate for WEB-DL and ripper-to-ripper re-encodes where someone deliberately re-packages 720p as "1080p". More common for older catalogue titles mastered from SD sources.

### Detection methods

**Without the original — YES, several methods exist:**

#### A. FFT / Frequency Analysis (Best method)

A truly native 1080p image contains high-frequency spatial content. An upscaled image has a sharp frequency cutoff at the original resolution's Nyquist frequency, because upscaling cannot create information that wasn't there.

Tools:
- **`resdet`** (github.com/0x09/resdet) — C library + CLI. Uses DCT zero-crossing detection to identify the original resolution. Works by detecting that traditional resampling produces a characteristic frequency-domain signature with zero-crossings at multiples of the upscale ratio.
  ```
  resdet -o offset -n 1 source.y4m
  ```
  Reports best-guess native resolution with confidence percentage. Supports video input directly via FFmpeg.

- **`video-fft`** (github.com/slhck/video-fft) — Python package. Computes magnitude spectrum of luminance per frame. An upscaled frame shows "grey boxes" in the 2D spectrum where high frequencies are absent. Outputs a per-frame score from the azimuthally-averaged 1D power spectrum.
  ```python
  from video_fft import VideoFFT
  v = VideoFFT("input.mp4")
  v.analyze()  # writes spectrum images + CSV with per-frame scores
  ```

- **`getnative`** (github.com/Infiziert90/getnative) — VapourSynth-based. Tries multiple resize kernel parameters and finds the resolution where the inverse operation minimizes error. Originally for anime but works on any content.

- **`fresdet`** (github.com/Sagnac/fresdet) — Lightweight variant. If measurement yields scaling values close to 1.5, the 1080p is likely upscaled from 720p.

#### B. Edge Sharpness / Natural Image Statistics

A native 1080p image has natural edge profiles. Upscaled images show:
- Softer edges with wider spread (the interpolation kernel smooths them)
- Artifacts from the upscaling kernel visible in edge profiles
- Ringing (oscillations) near strong edges from Lanczos or bicubic

#### C. Simple Heuristic: Bitrate-per-pixel

An upscaled video has high resolution but relatively low bitrate per pixel compared to native content. Computing `bitrate / (width × height × fps)` gives a lower value than expected for native content at the same codec quality.

### ffmpeg detection approach

```bash
# Extract a representative frame as Y4M (preserves chroma separation)
ffmpeg -i input.mp4 -ss 30 -vframes 1 -pix_fmt yuv420p frame.y4m
# Analyze with resdet
resdet frame.y4m
```

Or via FFT:
```python
# pip install video-fft
from video_fft import VideoFFT
v = VideoFFT("input.mp4")
v.analyze(output_dir="/tmp/fft")
# Low scores at high frequencies = upscaled
```

### Worth detecting?

**HIGH priority.** An upscaled 1080p file has literally fewer pixels of information than a native one. Directly impacts BPP scoring (the bpp denominator is real but the numerator is inflated by interpolation artifacts rather than detail). Also affects any edge-based or texture-based quality metric.

### Key references

- `resdet` — github.com/0x09/resdet (312 stars, active)
- `video-fft` — github.com/slhck/video-fft (used by VQEG for quality assessment)
- `getnative` — github.com/Infiziert90/getnative (249 stars)
- Video StackExchange: "How to find/detect the real video resolution" (ongoing since 2020)

---

## 2. Telecine / Pulldown

### What it looks like

Content shot on film (24fps) was converted to NTSC (29.97fps) via 3:2 pulldown — each film frame is displayed for either 2 or 3 video fields in alternating pattern. When this pulldown is NOT properly removed (IVTC not performed), the result is:
- **Combing artifacts** — visible horizontal lines on moving objects (one field is from a different moment in time than the other)
- **Judder** — 2:3:2:3 cadence causes uneven motion (one frame holds slightly longer than the next)
- **Frame blending** — if the content was deinterlaced without IVTC first, fields from different time moments get averaged together, producing ghosting

### How common in 1080p Bluray/WEB-DL

Low for Bluray (properly authored BluRay is progressive 24p). Moderate for DVD-origin content that was upscaled. Possible for older catalogue titles where the encoding chain was sloppy. Most common in anime fansubs and older TV series on disc.

The related issue of **mixed cadence** (some scenes progressive, some telecined) is common in TV shows that mixed film-originated and video-originated segments.

### Detection methods

**Without the original — YES:**

#### A. FFmpeg `idet` filter (built-in, fast)

```bash
ffmpeg -i input.mp4 -vf idet,metadata=mode=print -frames:v 360 -an -f null -
```

Reports:
- Single-frame detection: TFF/BFF/Progressive/Undetermined counts
- Multi-frame detection: same (more accurate, uses history)
- Repeated fields: Neither/Top/Bottom counts

**Interpreting results:**
- If `Repeated Fields: Top: N` or `Bottom: N` is nonzero → telecine detected
- If progressive count is high but not 100% → mixed content
- If TFF/BFF count is high → interlaced content

#### B. FFmpeg `fieldmatch` filter

```bash
# Detect telecine pattern and reconstruct progressive frames
ffmpeg -i input.mp4 -vf "fieldmatch=order=tff:combmatch=full,metadata=mode=print" \
  -frames:v 360 -an -f null -
```

Outputs per-frame match type: c (combed), n (normal), p (previous repeated), u (undetermined).

#### C. Frame Rate Analysis

```bash
ffprobe -show_entries stream=r_frame_rate,avg_frame_rate,nb_frames -of default input.mp4
```

If `r_frame_rate = 30000/1001` (29.97) for film content, pulldown may be present. Compare against TMDB/IMDB listed frame rate for the title.

### Worth detecting?

**MEDIUM priority.** Pulldown artifacts are visible but uncommon in modern 1080p sources. When present, they indicate a poorly authored source that may also have other quality issues. The `idet` filter is essentially free to run and could be run once per file.

### Key references

- FFmpeg `idet` filter documentation
- FFmpeg `fieldmatch` filter documentation
- `interlace-detection-test-patterns` — github.com/bbgdzxng1 (test patterns for idet validation)
- Cloudinary glossary: Inverse Telecine

---

## 3. Analog Transfer Artifacts

### What they look like

When content originates from analog sources (VHS, laserdisc, broadcast capture), the digital file may retain:

- **Dot crawl** — A line of moving dots along edges between saturated colors. Caused by imperfect separation of luminance and chrominance in composite video. Most visible on horizontal borders between red/green/blue regions.
- **Rainbowing (cross-color)** — Rainbow patterns on fine repetitive patterns (e.g., distant skyscraper windows, striped shirts). High-frequency luma data upsets the chroma demodulator.
- **Head switching noise** — A band of distorted/noisy pixels at the very bottom of the frame. Caused by the VCR switching between read heads. Typically masked by overscan on CRTs but visible in full-raster digital captures.
- **Tape skew** — Horizontal displacement at the top or bottom of the frame caused by tape stretching or tension issues.
- **Chrominance noise** — Random color speckles, most visible in dark saturated areas. Caused by sensor limitations, signal degradation, or multi-generation composite dubbing.

### How common in 1080p Bluray/WEB-DL

Very low for legitimate Bluray. Moderate for content mastered from analog sources (VHS-era films, TV recordings, home video). When present, these are strong indicators of a low-quality source chain.

### Detection methods

**Without the original — PARTIALLY:**

#### A. Head Switching Noise (detectable)

The bottom 5-15 lines of the frame often contain noise that doesn't match the rest of the image. Can be detected by:
```bash
# Extract bottom strip, compute noise statistics vs. rest of frame
ffmpeg -i input.mp4 -vf "crop=iw:20:0:ih-20,noise=alls=0:allf=t" -frames:v 1 bottom.png
```

Compare noise metrics between the bottom strip and the central frame. A large discrepancy suggests head switching.

#### B. Dot Crawl / Rainbowing (harder, partially detectable)

Dot crawl creates a characteristic moving pattern along color edges. Detection requires:
- Edge detection on color boundaries
- Looking for periodic dot patterns along those edges
- Temporal analysis (dot crawl moves frame-to-frame)

No simple ffmpeg filter detects this. Would require custom analysis comparing chroma edge profiles.

#### C. Chrominance Noise (detectable via bitplanenoise)

```bash
# Extract chroma planes and measure noise
ffmpeg -i input.mp4 -vf "extractplanes=planes=u+v,bitplanenoise" -f null -
```

High chrominance noise in a file that claims to be from a clean digital source is a red flag for analog provenance.

### Worth detecting?

**LOW priority for this library.** Our content is primarily Bluray/WEB-DL from digital sources. Analog artifacts would only appear in older content mastered from tape. When present, they're a strong signal about source quality and affect chroma scoring. Could be run as a lightweight check: scan the bottom strip for head-switching noise (fast, reliable) and the chroma planes for noise (fast, somewhat reliable).

### Key references

- AV Artifact Atlas (avartifactatlas.com) — comprehensive catalog of analog video artifacts
- ntsc-rs (github.com/valadaptive/ntsc-rs) — analog artifact simulator (useful for understanding what these look like)
- bavc/avaa — AV Artifact Atlas source repository with per-artifact documentation

---

## 4. HDR/SDR Conversion Artifacts

### What they look like

When HDR content (Rec.2100, 10-bit, ST2084 PQ curve, up to 1000+ nits) is incorrectly converted to SDR (Rec.709, 8-bit):

- **Clipped highlights** — Bright areas (specular highlights, sky, explosions) lose all detail and become flat white. The tone mapping curve truncates the top end.
- **Washed-out / flat appearance** — Colors lose saturation, contrast appears low. The PQ curve is misinterpreted, compressing the entire dynamic range into a narrow band.
- **Color shift / wrong gamut** — If the color matrix tags are wrong (e.g., BT.2020 content decoded with BT.601 or BT.709 matrix), reds become too dark, greens too bright, or vice versa. This is a metadata error, not a processing one.
- **Shadow crush** — Dark areas lose detail, becoming pure black. The tone mapping curve clips the bottom end.
- **Banding in gradients** — 10-bit content downsampled to 8-bit without proper dithering shows visible stepping in gradients (sky scenes, dark walls).
- **Skin tone distortion** — Natural skin tones become orange, green, or desaturated depending on the tone mapping algorithm.

### How common in 1080p Bluray/WEB-DL

Moderate and increasing. 1080p SDR BluRay is the intended format, but some WEB-DL sources are tone-mapped from 4K HDR masters. Improper tone mapping during the encoding chain is a real concern, especially for scene-encoded WEB-DLs.

Color matrix mis-tagging is surprisingly common — files tagged BT.709 that were encoded from BT.2020 content, or vice versa. This affects the entire image globally.

### Detection methods

**Without the original — YES, partially:**

#### A. Color Matrix Verification

```bash
ffprobe -show_entries stream=color_space,color_transfer,color_primaries -of default input.mp4
```

Check for consistency:
- `color_transfer=smpte2084` + `color_primaries=bt2020` = HDR content → should be decoded with BT.2020 matrix
- `color_transfer=bt709` + `color_primaries=bt709` = SDR content → BT.709 matrix
- Mismatched or missing tags = potential color shift

#### B. Highlight Clipping Detection

```bash
# Count pixels at max white (255,255,255 in 8-bit)
ffmpeg -i input.mp4 -vf "signalstats=stat=tout+vrep+brng" -f null - 2>&1 | grep "YUT"
```

A high count of clipped highlights (Y=235 or higher in limited range, or 255 in full range) in large flat areas suggests clipping from improper tone mapping.

#### C. Histogram Analysis for Crushed Blacks

```bash
# Check for black clipping (large spike at luma=16 or luma=0)
ffmpeg -i input.mp4 -vf "histogram=mode=waveform" -frames:v 1 histogram.png
```

A large spike at the very bottom of the waveform with no gradation indicates shadow crush.

#### D. Gamut Volume Check

If a file claims SDR (BT.709) but has color values outside the BT.709 gamut boundary, it was likely converted from HDR without proper gamut mapping:
```python
# Would require extracting frames to RGB and checking gamut boundary
# Not a simple ffmpeg one-liner
```

### Worth detecting?

**HIGH priority.** HDR-to-SDR conversion artifacts directly impact perceived quality — washed-out images, clipped highlights, and color shifts are immediately noticeable. Color matrix mis-tagging is easy to detect and fix (re-tag, not re-encode). Clipped highlights cannot be fixed but indicate the source was improperly mastered.

### Key references

- FFmpeg `zscale` + `tonemap` filters (documentation on HDR→SDR conversion)
- BT.2124 / SMPTE ST 2084 (PQ curve specification)
- Forasoft: "Color Bleeding, Shift, and Chroma Subsampling Artifacts" (2026)

---

## 5. Audio-Video Sync

### What it looks like

- **Fixed offset** — Audio and video are off by a constant amount (e.g., audio is 100ms ahead) from beginning to end.
- **Drift** — Sync is correct at the start but gradually worsens. Audio runs slightly faster or slower than video. Causes: mismatched clock sources during recording, sample rate conversion errors, VFR footage treated as CFR.

### How common in 1080p Bluray/WEB-DL

Very low for properly authored Bluray (frame-accurate muxing). Low for WEB-DL. Moderate for re-encoded content where the audio was separately processed. Drift is more common in content that went through multiple encode generations.

### Detection methods

**Without the original — YES, for drift:**

#### A. Duration/Start Time Comparison (Fast check)

```bash
ffprobe -show_entries stream=start_time,duration,codec_type -of default input.mp4
```

If audio and video start times differ significantly, or their durations differ by more than a few frames, there's likely a sync issue.

#### B. Timestamp Analysis (Drift detection)

```bash
# Extract first and last PTS for audio and video
ffprobe -show_entries packet=pts_time,stream_index -of csv input.mp4 | \
  awk -F',' '$2==0{if(!vmin||$1<vmin)vmin=$1;if($1>vmax)vmax=$1} \
            $2==1{if(!amin||$1<amin)amin=$1;if($1>amax)amax=$1} \
            END{printf "Video: %.3f - %.3f (dur=%.3f)\nAudio: %.3f - %.3f (dur=%.3f)\nDiff: %.3f ms\n",
                 vmin,vmax,vmax-vmin,amin,amax,amax-amin,(vmax-vmin)-(amax-amin)}'
```

If video duration differs from audio duration by more than 100ms, drift is present.

#### C. Content-Based Sync Detection (Advanced)

The gold standard: inject or detect a known sync point (clap, flash) and measure offset. For existing content without test patterns, audio-visual correlation can be computed using:
- Extract audio energy envelope (via `ebur128` or RMS)
- Extract video motion energy (via `signalstats` or motion vectors)
- Cross-correlate the two signals
- Peak of cross-correlation gives the offset

This requires Python/NumPy and is not a simple ffmpeg one-liner, but is deterministic and works on any content.

```bash
# Extract audio waveform (raw PCM)
ffmpeg -i input.mp4 -vn -f s16le -ac 1 -ar 16000 audio.pcm
# Extract per-frame luminance energy
ffmpeg -i input.mp4 -vf "signalstats=stat=bit_depth" -f null - 2>&1
```

### Worth detecting?

**LOW-MEDIUM priority.** Sync issues in Bluray/WEB-DL are uncommon and usually indicate a fundamentally broken encode. The duration check is trivial to run and catches drift. Content-based detection is expensive and rarely needed. A simple `ffprobe` duration comparison per file is worth adding to any batch QA pipeline.

### Key references

- ITU-R BT.1359-1 (lip-sync tolerance: ±45ms audio lead, ±125ms audio lag)
- avsyncdoctor (github.com/ahmeddoghri) — AV sync drift detection and repair
- Forasoft: "Lip-Sync Test Methodology" (2026)

---

## 6. Encoding Provenance

### What it looks like

Every encoder leaves fingerprints in the bitstream:
- **Metadata encoder tag** — Container or stream carries a string naming the encoder ("Lavc", "x264", "HandBrake", hardware encoder names)
- **SEI messages** — H.264/H.265 Supplemental Enhancement Information messages embedded in the video stream, containing encoder name, version, and encoding parameters. Survives container-level tag stripping.
- **Structural choices** — GOP structure, frame partitioning, quantization patterns, deblock filter offsets differ between encoders.

### How common in 1080p Bluray/WEB-DL

Universal — every file has an encoder signature. The question is whether the signature matches expectations. Legitimate Bluray: typically encoded with professional hardware encoders (Intel QSV, NVIDIA NVENC, or proprietary). WEB-DL: varies (x264/x265 for software, hardware for streaming platforms). Piracy: often x264/x265/Lavc with various presets.

### Detection methods

**Without the original — YES:**

#### A. Container Metadata (Easy)

```bash
ffprobe -show_entries stream=codec_name,profile,level -show_format_tags -of json input.mp4
```

Look for:
- `encoder` tag in format or stream metadata
- x264/x265 SEI strings (in bitstream, not container)

#### B. SEI Message Extraction

```bash
# Extract SEI messages from H.264 stream
ffprobe -select_streams v -show_entries packet=side_data_list -of json input.mp4
# Or more directly:
ffprobe -show_entries frame=side_data_list -select_streams v -of json input.mp4 2>/dev/null | \
  python3 -c "import json,sys; data=json.load(sys.stdin); [print(f['side_data_list']) for f in data.get('frames',[])]"
```

x264 writes a user data unregistered SEI with its full settings string. This is highly diagnostic.

#### C. GOP Structure Analysis

```bash
# Show frame types
ffprobe -show_entries frame=pict_type -select_streams v -of csv input.mp4 | head -50
```

Analyzing the I/P/B frame pattern reveals:
- x264/x265 default GOP: specific B-frame patterns
- Hardware encoders: typically fixed GOP with regular IDR intervals
- Professional encoders: may use different structures

#### D. Quantization Fingerprinting

Double-compression detection: if a video was encoded twice at different GOP sizes, periodic patterns appear in DCT coefficient distributions at block boundaries. This is forensic-grade analysis requiring custom tools.

### Worth detecting?

**LOW priority for quality assessment.** Provenance is interesting for forensics and for verifying that a file is what it claims to be (e.g., "BluRay" tag on a file encoded with x264 at CRF 23). It does not directly affect perceived quality. However, it can be a useful proxy: hardware encoders at high quality presets vs. software encoders at low quality presets correlates with overall file quality.

The SEI string is essentially free to extract and could be stored as a metadata field for future reference.

### Key references

- Calabi Labs: "How Encoder Fingerprints Reveal AI Video" (2026)
- Phasm: "H.264 Video Steganography & Encoder Fingerprint Mimicry" (2026)
- ClipForensics: Compression History Reconstruction
- Yang/EVA 2020: 97.6% accuracy on encoder identification from container+encoding features

---

## 7. Dark/Night Scene Quality

### What it looks like

- **Shadow crush** — Dark areas have no visible detail, all tones below a threshold collapse to pure black (luma=0 or luma=16 in limited range). Causes: incorrect gamma, aggressive contrast, 8-bit quantization in dark range, or source-level exposure issues.
- **Black level clipping** — Related to shadow crush but specifically from incorrect signal range (full vs limited mismatch). A "limited range" file (16-235) displayed as "full range" (0-255) crushes the bottom 16 levels.
- **Noise reduction "waxiness"** — Aggressive NR in dark scenes removes film grain but also destroys fine texture, making faces and surfaces look plastic/waxy. This is a source-level processing choice, not an encoder artifact.
- **Temporal noise flickering** — In low-light scenes, noise patterns change rapidly frame-to-frame, creating a "boiling" or "crawling" appearance even at high bitrates.
- **Macroblocking in shadows** — Encoders allocate fewer bits to dark areas (perceptual model: less visible), but if the source already had noise in dark areas, the blocks become very visible.

### How common in 1080p Bluray/WEB-DL

Very common. Almost every film has dark scenes. Shadow crush from 8-bit quantization affects any content where the bottom ~10% of the signal range contains meaningful detail. Waxiness from NR is common in WEB-DL sources where streaming platforms apply NR before encoding.

### Detection methods

**Without the original — YES:**

#### A. Black Level / Shadow Crush Detection

```bash
# Count pixels at or near zero in luma
ffmpeg -i input.mp4 -vf "signalstats=stat=tout" -f null - 2>&1 | \
  grep "tout" | awk '{print $NF}' | sort -n | head -20
```

A large fraction of pixels at Y=0 (or Y=16 in limited) indicates crushing. The `signalstats` filter reports `YMIN` which reveals how much of the signal is at the floor.

#### B. Histogram Spike Detection

```bash
# Generate per-frame histogram, check for spikes at bottom
ffmpeg -i input.mp4 -vf "histogram=mode=waveform:level_height=256" -frames:v 1 waveform.png
```

A large spike at the bottom of the waveform with no gradation below it = shadow crush.

#### C. Noise Level in Dark Regions

```bash
# Extract dark regions (below luma=50), measure noise
ffmpeg -i input.mp4 -vf "curves=dark='0/0 50/0 100/100',noise=alls=0:allf=t" -frames:v 1 dark.png
```

More practically: measure temporal noise variance in dark areas across consecutive frames. High variance in dark regions = noisy source or poor NR.

#### D. Signal Range Verification

```bash
ffprobe -show_entries stream=color_range -of default input.mp4
```

If `color_range=pc` (full) but the file should be `tv` (limited), or vice versa, shadow detail will be crushed or lifted.

### Worth detecting?

**HIGH priority.** Dark scene quality is one of the most common complaints about compressed video. Shadow crush from quantization or range mismatch is detectable and sometimes fixable (re-tagging the range). Noise in dark areas directly affects BPP scoring (noise costs bits that could buy detail). Our current CAMBI detector only catches banding; it misses noise, crushing, and waxiness.

### Key references

- KTC: "Black Crush Explained" (2026)
- FFmpeg `signalstats` filter documentation
- salivity.github.io: "Kdenlive Histogram: Monitor Shadow Crush in Log Footage"

---

## 8. Chroma-Specific Artifacts

### What they look like

- **Chroma banding** — Color gradients break into visible steps (similar to luma banding but in color channels). Most visible in smooth saturated gradients (sunsets, colored lights). Different from luma banding: a file can be clean in luma but banded in chroma.
- **Color bleeding / chroma smear** — Colors extend past their edges. Caused by 4:2:0 subsampling storing color at 1/4 the resolution of luma. Saturated reds and blues bleed most visibly.
- **Chroma subsampling artifacts** — When sharp color transitions exist (colored text on contrasting backgrounds, graphic overlays), 4:2:0 produces dark fringing or "color moiré" at edges. Worst case: neon-colored text on black backgrounds.
- **Color shift from wrong decode matrix** — If a file encoded with BT.709 matrix is decoded with BT.601 (or vice versa), the entire image's color balance shifts. Reds darken, greens brighten, or similar systematic hue rotation. This is a metadata error.
- **Chrominance noise** — Random color speckling, most visible in dark saturated areas. Can be from the source (sensor noise, analog tape) or from aggressive chroma quantization.

### How common in 1080p Bluray/WEB-DL

4:2:0 chroma subsampling is universal in consumer video (Bluray, WEB-DL, streaming). Color bleeding from subsampling is present in every such file but only visible in specific content (highly saturated edges, colored text). Chroma banding is common in dark saturated scenes. Color matrix mis-tagging is uncommon but not rare.

Our current CAMBI detector is luma-only. Chroma banding is structurally invisible to it.

### Detection methods

**Without the original — YES, partially:**

#### A. Per-Component Chroma PSNR (vs. internal reference)

```bash
# Compute PSNR per component
ffmpeg -i input.mp4 -i reference.mp4 -vf psnr -f null - 2>&1 | grep "average"
# Output includes psnr_y, psnr_u, psnr_v
```

Without a reference, we can still measure chroma noise characteristics:
```bash
# Extract chroma planes and measure statistics
ffmpeg -i input.mp4 -vf "extractplanes=planes=u+v" -f rawvideo -pix_fmt gray - 2>/dev/null | \
  python3 -c "
import sys, numpy as np
data = np.frombuffer(sys.stdin.buffer.read(), dtype=np.uint8)
# Measure frame-to-frame variance in chroma = noise level
print(f'Chroma std: {data.std():.2f}, mean: {data.mean():.2f}')
"
```

#### B. Chroma Edge Sharpness

Compare chroma channel edge profiles against luma edges. If chroma edges are significantly softer than luma edges beyond what 4:2:0 naturally produces, the source had excessive chroma processing.

#### C. Color Matrix Verification

```bash
ffprobe -show_entries stream=color_space,color_transfer,color_primaries -of default input.mp4
```

Cross-check consistency. A file with `color_space=bt709` but `color_transfer=smpte2084` (HDR) is mis-tagged.

#### D. Chroma Banding via CAMBI (if extended)

Our existing CAMBI probe could be extended to chroma planes:
```bash
# Apply CAMBI to chroma plane (converted to luma-like format)
ffmpeg -i input.mp4 -vf "extractplanes=planes=u,v" -c:v libvmaf -model=version=vmaf_v0.6.1 -feature cambi -o /dev/null
```

Or use the `cband` metric from the recent CBAND paper (2026) which specifically targets chroma banding using early-layer CNN features.

### Worth detecting?

**HIGH priority.** Our current CAMBI is explicitly luma-only (stated in AGENTS.md). Chroma banding is a different artifact that affects perceived quality independently. Color bleeding from 4:2:0 is universal but only matters for specific content (colored text, saturated graphics). Color matrix mis-tagging is easy to detect and important to flag (global color shift).

### Key references

- Forasoft: "Color Bleeding, Shift, and Chroma Subsampling Artifacts" (2026) — comprehensive treatment
- Wikipedia: Chroma subsampling (artifact types, gamma luminance error)
- CBAND metric paper (arxiv 2508.08700, 2026) — CNN-based banding metric that works on chroma

---

## 9. Text/Graphics Artifacts

### What they look like

- **Ringing around text** — Oscillating halos (alternating bright/dark lines) along sharp edges of text, logos, or graphics. Caused by the encoder's deblocking/deringing filters or by the source being re-encoded. Most visible on high-contrast text (white text on dark background).
- **Mosquito noise** — Shimmering/flickering pixels immediately adjacent to sharp edges. Similar to ringing but temporal — the noise pattern changes frame-to-frame. Very visible on static text overlays.
- **Burned-in subtitle quality** — When subtitles are hard-baked into the video, the re-encode for burning introduces artifacts specifically in the text region. The subtitle area becomes a high-frequency zone that consumes disproportionate bits, potentially degrading quality in surrounding areas.
- **Subtitle ringing** — Sharp subtitle text (especially outlined/bordered subtitles) creates strong edges that produce ringing in the compressed output.
- **Logo/watermark blocking** — Station logos in corners create constant high-frequency content that the encoder must allocate bits to, sometimes at the expense of the rest of the frame.

### How common in 1080p Bluray/WEB-DL

Ringing and mosquito noise: present to some degree in every lossy encode, but severity varies by encoder and bitrate. Text-related artifacts are most common in:
- Fan-subs with burned-in translations
- WEB-DLs from platforms that burn in forced subtitles
- Screen-capture content
- News/documentary content with lower thirds

Bluray typically uses soft (rendered) subtitles, so this is less of an issue.

### Detection methods

**Without the original — PARTIALLY:**

#### A. Edge-Ringing Detection

Ringing can be detected by measuring the oscillation pattern near strong edges:
```bash
# Signalstats detects ringing via the TOUT (total outage) metric
ffmpeg -i input.mp4 -vf "signalstats=stat=tout+vrep" -f null - 2>&1 | grep "tout"
```

The `vrep` (vertical repeat) metric specifically looks for repeated vertical patterns, which correlates with ringing.

#### B. Subtitle Region Quality Comparison

If subtitles are consistently in the bottom 15% of the frame, compare the PSNR/VMAF of that region vs. the rest:
```bash
# Bottom region (subtitle area)
ffmpeg -i input.mp4 -i reference.mp4 -vf "crop=iw:ih/7:0:ih*6/7,psnr" -f null -
# Center region (no subtitles)
ffmpeg -i input.mp4 -i reference.mp4 -vf "crop=iw:ih/3:0:ih/3,psnr" -f null -
```

A significant quality drop in the subtitle region indicates the text is consuming encoder bits.

#### C. High-Frequency Energy in Text Regions

Text creates localized high-frequency spikes. Measuring local frequency content around detected text regions reveals how much the encoder struggled with them.

### Worth detecting?

**LOW priority.** Text-related artifacts are a property of lossy encoding rather than the source. They're most relevant for comparing encode quality (which our BPP/CAMBI already addresses) rather than source quality. However, detecting burned-in subtitles is useful metadata — it tells us the file went through an extra encode generation and may have lower effective quality in the text region.

### Key references

- Forasoft: "Mosquito Noise & Ringing: Edge Artifacts Explained" (2026)
- Wikipedia: Ringing artifacts
- guide.encode.moe: "Recognizing Video Artifacts" — fansubbing reference

---

## 10. Summary: Priority Matrix

| Artifact | Severity | Frequency | Detectable w/o Original | ffmpeg Detectable | Priority |
|----------|----------|-----------|------------------------|-------------------|----------|
| **Upscale detection** | High | Low-Medium | YES (FFT/resdet) | Partially (needs Python tools) | HIGH |
| **HDR/SDR conversion** | High | Medium | YES (metadata + histogram) | YES | HIGH |
| **Shadow crush / black level** | High | High | YES (histogram/signalstats) | YES | HIGH |
| **Chroma banding** | Medium | Medium | YES (chroma PSNR) | Partially (needs chroma extraction) | HIGH |
| **Color matrix mis-tagging** | High | Low | YES (ffprobe) | YES (trivial) | HIGH |
| **Telecine / pulldown** | Medium | Low | YES (idet filter) | YES (built-in) | MEDIUM |
| **A/V sync (drift)** | High | Very Low | YES (duration compare) | YES (trivial) | MEDIUM |
| **Color bleeding (4:2:0)** | Medium | Universal | Partially | Partially | MEDIUM |
| **Dark scene noise** | Medium | High | Partially | Partially | MEDIUM |
| **Analog transfer artifacts** | Medium | Very Low | Partially | Partially | LOW |
| **Text/ringing** | Low | Medium | Partially | Partially | LOW |
| **Encoding provenance** | Low | Universal | YES (SEI/tags) | YES (ffprobe) | LOW |

### Recommended Detection Order (bang-for-buck)

1. **Color matrix verification** — trivial `ffprobe`, catches global color shifts instantly
2. **Signal range check** (full vs limited) — trivial `ffprobe`, catches shadow crush / lifted blacks
3. **Frame rate analysis** — trivial `ffprobe`, flags potential telecine/pulldown
4. **idet filter** — fast, built into ffmpeg, detects interlacing and repeated fields
5. **Shadow crush histogram** — fast, detects clipped blacks quantitatively
6. **Duration/sync check** — fast `ffprobe`, detects A/V drift
7. **Chroma plane noise analysis** — moderate, detects chroma-specific issues
8. **Upscale detection (resdet/video-fft)** — requires external tools but high value
9. **CAMBI extension to chroma** — requires our existing probe infrastructure

---

## 11. References

### Tools

| Tool | Purpose | Language | URL |
|------|---------|----------|-----|
| resdet | Upscale detection via DCT zero-crossings | C | github.com/0x09/resdet |
| video-fft | Upscale detection via FFT magnitude spectrum | Python | github.com/slhck/video-fft |
| getnative | Native resolution finder | Python/VapourSynth | github.com/Infiziert90/getnative |
| fresdet | Lightweight upscale detection | Rust | github.com/Sagnac/fresdet |
| ntsc-rs | Analog artifact simulator (reference) | Rust/WASM | github.com/valadaptive/ntsc-rs |
| avsyncdoctor | AV sync drift detection | Python | github.com/ahmeddoghri/avsyncdoctor |
| idet test patterns | Interlace/pulldown detection test cases | Media | github.com/bbgdzxng1/interlace-detection-test-patterns |

### Papers & Articles

| Title | Year | Relevance |
|-------|------|-----------|
| AV Artifact Atlas | ongoing | Catalog of all analog video artifacts |
| Forasoft: "Color Bleeding, Shift, and Chroma Subsampling" | 2026 | Comprehensive chroma artifact treatment |
| Forasoft: "Mosquito Noise & Ringing" | 2026 | Edge artifact analysis |
| Forasoft: "Lip-Sync Test Methodology" | 2026 | A/V sync measurement standards |
| Calabi Labs: "How Encoder Fingerprints Reveal AI Video" | 2026 | Encoder identification methods |
| CBAND metric (arxiv 2508.08700) | 2026 | CNN-based banding detection including chroma |
| Phasm: "H.264 Video Steganography & Encoder Fingerprint" | 2026 | Deep treatment of encoder identification |

### FFmpeg Filters Referenced

| Filter | Purpose | Section |
|--------|---------|---------|
| `idet` | Interlace/telecine detection | §2 |
| `fieldmatch` | IVTC field matching | §2 |
| `signalstats` | Total outage, vertical repeat, luma stats | §4, §7, §9 |
| `histogram` | Waveform analysis for shadow/highlight clipping | §4, §7 |
| `extractplanes` | Isolate chroma planes for analysis | §3, §8 |
| `bitplanenoise` | Per-bitplane noise estimation | §3 |
| `psnr` | Per-component PSNR (y, u, v) | §8 |
| `ebur128` | Audio loudness measurement (sync reference) | §5 |
| `noise` | Noise generation for calibration | §7 |
| `curves` | Gamma/brightness manipulation for dark region isolation | §7 |

---

*This report covers source-quality artifacts only. Compression-specific artifacts (blocking, mosquito noise from quantization, motion estimation errors) are covered separately in the existing CAMBI and BPP+ infrastructure.*
