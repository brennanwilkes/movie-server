# Research: video quality metrics for a no-reference home library

**Date:** 2026-08-01
**Scope:** external literature/vendor research only. No code was changed.
**Question:** can we do better than BPP+ for predicting perceived quality of ~1000 library files,
computed on a Skylake NUC with no usable GPU compute, played back on a 1280x720 native projector
via a Gen-2 Fire TV Stick?

Source-quality tagging used throughout:
- **[peer]** peer-reviewed or arXiv preprint
- **[vendor]** vendor engineering blog / official project docs / official repo
- **[std]** standards body (ITU-T)
- **[2nd]** secondary/commercial explainer site — treat as hearsay unless corroborated
- **[unverified]** I could not fetch a primary source; stated from search snippets only
- **[opinion]** my own reasoning, not sourced

---

## TL;DR / recommendation

**There is no good no-reference metric for this problem. Do not go looking for one — the literature
is clear that blind metrics fail exactly on our distortion class.** The NR field is overwhelmingly
trained on user-generated-content distortions (shaky phone video, bad exposure, upload transcodes),
and the one paper that specifically tested a classic NR metric against compressed video concluded
it "cannot be used for video-codec comparisons" and that it *rewards* the blur that heavy
compression produces [peer, arXiv:1907.03842].

**If I had to pick ONE approach: a CRF-probe (sample-encode) complexity normalizer, computed at
720p.** Concretely, per file:

1. Pick N=8 samples of 4s each, spread evenly, skipping the first/last 5%.
2. Downscale each to 1280x720 (this is the display truth — see §6).
3. Encode each with `libx265 -crf 20 -preset medium` (or x264 CRF 18) to `/dev/null`,
   record the output bits.
4. `probeBitrate` = total probe bits / total probe seconds. This is a *measured, per-title,
   content-adaptive* answer to "how many bits does THIS movie need at target quality," and it is
   exactly the number that BPP+'s hardcoded `0.13` constant is guessing at.
5. Score `R = sourceVideoBitrate_720p_equivalent / probeBitrate`. R >= ~1.0 means the file carries
   at least as many bits as a fresh transparent-ish encode of the same content would. R << 1 means
   bit-starved.
6. In the same pass, run `ffmpeg -vf blockdetect` and libvmaf's **CAMBI** on the same 8 samples.
   These are genuinely no-reference, genuinely validated on *compression* artifacts specifically
   (blockiness and banding), ship in FFmpeg/libvmaf, and cost almost nothing. They are the
   safety net for step 5's failure mode (below).

This is the same technique Netflix/Bitmovin per-title encoding is built on, scaled down: Netflix
brute-forces an encode matrix per title and reads the convex hull [vendor]; Bitmovin computes a
"complexity factor" during a complexity-analysis pass before choosing the ladder [2nd]; `ab-av1`
does literally the sample-encode trick — "cut a small section of the video, say 20s long, and
encode that" — as its production method [vendor, GitHub].

**Cost per file, estimated:** [opinion — extrapolated, not measured]
- 32s of 720p x265 CRF20 preset=medium on a Skylake dual/quad-core: roughly 30–90s CPU.
- Seek + decode of a 1080p H.264/HEVC source to grab 8 samples: ~10–30s.
- blockdetect + CAMBI over the same 32s at 720p: ~10–20s.
- **Total ~1–3 min/file wall clock, ~20–50 CPU-hours for 1000 files.** That is a few days of
  `nice`d background work, or one weekend. Storage cost is zero (encode to null muxer).
- Compare: a full-file libvmaf run is ~6.6 fps single-threaded and ~23 fps default-threaded on a
  laptop-class CPU [vendor, Netflix/vmaf issue #382 — reported by users, not a Netflix benchmark],
  i.e. 1.5–6 hours *per movie*. Full-file anything is off the table.

**The failure mode you must design around:** a CRF probe of an already-destroyed source
(YTS 2 Mbps rip) will produce a *low* probe bitrate, because the artifacts are already smooth and
blocky and therefore cheap to re-encode. R will look fine. This is why you keep an absolute floor
(BPP+, or absolute probe bitrate) and the blockdetect/CAMBI detectors. [opinion — this follows
directly from how rate-distortion works and from the NIQE finding that blur reads as "good"
[peer, arXiv:1907.03842], but I found no paper that measures the size of this effect.]

---

## 1. No-reference / blind video quality metrics

### The honest summary

Almost every modern NR metric is a **model fitted to human scores on a UGC dataset**
(KoNViD-1k, LIVE-VQC, YouTube-UGC, LSVQ). Those datasets are dominated by capture-side
distortions. Our distortion is a single clean axis: transcode quantization on professionally shot
and mastered film. NR metrics generalize badly across datasets — one survey-style rundown reports
cross-dataset SROCC collapsing "below 0.6 on UGC transcoding" for all metrics tested, versus
"0.94 or higher" for full-reference VMAF [2nd, forasoft.com].

### Per-metric verdict

| Metric | Year | Code | Runs on our box? | Validated on compression? | Verdict |
|---|---|---|---|---|---|
| **BRISQUE** | 2012 | MATLAB orig; `pyiqa`, OpenCV contrib, `piq` | Yes, CPU, fast | Partially — LIVE IQA includes JPEG/JP2K | Known non-monotonic on JPEG quality [2nd, MathWorks]; per-frame image metric, no temporal term |
| **NIQE** | 2013 | `pyiqa`, MATLAB | Yes, CPU, fast | **Tested and failed** | Do not use — see below |
| **VIIDEO** | 2016 | `scikit-video` (`pip install scikit-video`) | Yes but the package is effectively unmaintained since ~2019 and needs pinned old NumPy/SciPy [2nd, forasoft.com] | Weak | Skip |
| **V-BLIINDS** | 2014 | `scikit-video` | Same maintenance problem | LIVE-trained, some compression | Skip |
| **VIDEVAL** | 2021 | MATLAB | Painful | UGC | Skip (RAPIQUE supersedes) |
| **RAPIQUE** | 2021 | **MATLAB >=2019 + Deep Learning Toolbox**, plus Python for the SVR [vendor, GitHub README] | **No** — MATLAB dependency is a hard blocker | UGC only (KoNViD-1k, LIVE-VQC, YouTube-UGC) [vendor] | Skip. 20x faster than VIDEVAL, ~146s/video at 720p per its own README, but wrong distortion class and wrong runtime |
| **CONTRIQUE** | 2022 | PyTorch, research repo | CPU-only inference would be slow | Synthetic + UGC | Not verified in detail; skip on runtime grounds |
| **FAST-VQA** | ECCV 2022 | PyTorch (`VQAssessment` org) | GPU-oriented | UGC (LSVQ, ~0.83 SROCC) [2nd] | Skip — non-commercial research license, GPU-shaped |
| **DOVER / DOVER-Mobile** | 2023 | PyTorch | GPU-oriented | UGC; splits "technical" vs "aesthetic" | Skip, same reasons |
| **Google UVQ** | 2022 | Apache-2.0, `google/uvq` | TensorFlow, CPU-runnable but slow | UGC | The only permissively-licensed learned NR video model I found [2nd]. Still wrong training distribution. |
| **FFmpeg `blockdetect`** | FFmpeg 5.1, 2022 | **built into ffmpeg** | **Yes, ~real-time** | **Yes — it literally measures the DCT-grid blocking artifact of over-compression**; based on "A no-reference blocking artifact measure for adaptive video processing" (2005) [vendor, FFmpeg docs] | **USE THIS** |
| **FFmpeg `blurdetect`** | FFmpeg 5.1, 2022 | built in | Yes | Perceptual blur — but blur is ambiguous (soft cinematography vs over-compression) | Use as a secondary signal only |
| **CAMBI** | 2021 | **inside libvmaf** | Yes | **Yes — banding, i.e. the artifact PSNR/SSIM/legacy-VMAF miss.** Hand-designed from the contrast sensitivity function, not dataset-fitted, which is why it generalizes [vendor, Netflix TechBlog] | **USE THIS.** Scale 0 (clean) to ~24 (unwatchable), ~5 starts to annoy [2nd, forasoft.com quoting Netflix] |

### Why NIQE in particular is disqualified

This is the single most load-bearing citation in this report. Antsiferova et al. tested NIQE
directly on compressed video for codec comparison [peer, arXiv:1907.03842]:

- It produces "outlying scores on black and solid-coloured frames."
- It "has low-quality scores for videos with detailed textures and higher scores for videos of
  lower bitrates due to the blurring of these textures after compression."
- Conclusion: "not universal and currently can not be used for video-codec comparisons."

Read that middle bullet again. NIQE prefers the *more compressed* file, for exactly the reason
your SSIM experiment failed in the opposite direction: **texture/grain is the confound in both
directions.** Full-reference SSIM over-rewards grain reproduction; NR-NIQE punishes grain as
"unnatural" and rewards the smoothing that destroys it. Neither is measuring what you want.

### The one structural point

CAMBI and blockdetect work because they are **artifact detectors**, not quality models. They ask
"is this specific defect present," not "how good is this." That question is answerable without a
reference. "How good is this" is not, for our content. Build on detectors.

---

## 2. VMAF specifically

### 2a. It is full-reference. What do people do without a reference?

**There is no credible self-reference VMAF workflow, and the common ideas are garbage.** Concretely:

- **Compare the file against a CRF-0 re-encode of itself.** This measures the loss introduced by
  your CRF-0 re-encode, which is ~zero. You will get ~98–100 on a 2 Mbps YTS rip and ~98–100 on a
  remux. Useless. VMAF "reaches its ceiling of 100 when the encode is perceptually
  indistinguishable from the source" — when the source is already degraded "you're measuring only
  the additional loss introduced by re-encoding, not the original quality that was lost in the
  initial compression" [2nd, but this is a mechanical consequence of the metric's definition and
  is not in dispute].
- **Compare against a denoised/upscaled version of itself.** This measures the effect of your
  denoiser/upscaler. It has no defined relationship to perceived quality.
- **Compare a 1080p file against its own 720p downscale-then-upscale.** This measures how much
  detail survives a resolution round-trip — i.e. it is a *sharpness/complexity* probe, not a
  quality probe. It might weakly correlate with "does this file have real 1080p detail or is it an
  upscale," which is a genuinely useful separate question, but it is not quality.
- **NR-VMAF (a DNN trained to regress VMAF from the distorted video alone)** exists in the
  literature [peer, springer/researchgate: "No-Reference VMAF: A Deep Neural Network-Based
  Approach to Blind Video Quality Assessment", 2024]. I did **not** find a usable open
  implementation. **[unverified]** whether any public weights exist.

VMAF's own FAQ is blunt about the adjacent question of cross-resolution comparison: "one should NOT
compare the absolute VMAF score of a 1080 video with the score of a 480 video obtained at its
native resolution -- it is an apples-to-oranges comparison" [vendor, Netflix/vmaf FAQ].

**Where VMAF IS legitimately usable for us:** as the *stopping criterion for a re-encode decision*,
not as a library quality score. `VMAF(existing_file, my_reencode_of_it)` >= ~95 means "my re-encode
did not add visible damage on top of what was already there." That is exactly what `ab-av1
crf-search` does [vendor, github.com/alexheretic/ab-av1]. Valid. Just don't confuse it with
"this file is good."

### 2b. Model variants and the viewing-condition dimension

The classic (v0) situation [vendor, Netflix/vmaf docs + FAQ]:

- **Default model** (`vmaf_v0.6.1`): assumes a 1920x1080 display, living-room environment,
  viewing distance **3x screen height (3H)**. Distorted video is expected to be rescaled to 1080
  before measuring.
- **`vmaf_4k_v0.6.1`**: 4K display at **1.5H**.
- **`vmaf_v0.6.1neg`** (NEG = No Enhancement Gain): resists score inflation from pre-sharpening /
  contrast tricks. Without it, sharpening can push VMAF to 111.99 and histogram equalization to
  144 [peer, arXiv:2107.04510 "Hacking VMAF and VMAF NEG"]. **This matters to us**: several
  scene-release groups sharpen. If you ever use VMAF comparatively, use NEG.
- **Phone model** (`--phone-model`, or `vmaf_v0.6.1_phone`): "typical phone viewing can be
  approximated as 4 to 5H"; v0 implements this as a **second-order polynomial post-processing of
  the standard score** — i.e. it is a curve fit on top, not a different feature extraction
  [vendor, Netflix TechBlog].

**VMAF v1 (June 2026)** changes this and is directly relevant to us [vendor, Netflix TechBlog,
"VMAF v1: Good Is Not Good Enough", fetched 2026-08-01]:

- Instead of separate polynomial mappings per device, v1 **"adjust[s] the elementary feature values
  based on the normalized viewing distance,"** so one model covers phone / 1080p / 4K.
- Ships **four calibrated models**: Standard 1080p@3H, Phone@5H, 4K@1.5H, 4K@3H. All score
  [0,100] except 4K@3H which is [0,110].
- Fixes a bias that directly bit us conceptually: v0 "favored higher resolutions at lower bitrates,
  preferring compression artifacts over scaling, which could be visually annoying." v1 adds an
  "AIM" component for blockiness.
- **Integrates CAMBI** for banding.
- Adds chroma via a modified SpEED-QA (v0 was luma-only).
- Bounds the motion feature (v0 overpredicted high-motion, underpredicted 60fps).
- ~30–40% faster than v0. Open-sourced on GitHub.

**Which model for a 480-lumen 720p-native projector in a dark room?** There is **no** model for
this and Netflix has not published one. [opinion] The projector is a *large angular image* — the
opposite of a phone — so the phone model is wrong in the direction that matters (it would tell you
artifacts are less visible when a big dark-room image makes them *more* visible). But the panel is
720p, which throws away high-frequency detail before your eye sees it. Those two effects fight.
The defensible position is: **use the standard 1080p@3H model, measured on 720p-downscaled
content** (§6), and treat it as a lower bound on quality (pessimistic), rather than trying to
model the projector.

### 2c. Does VMAF handle film grain better than SSIM?

**Somewhat, but not enough, and Netflix says so themselves.** VMAF v1's own blog lists
"film-grain noise" first in "some areas that we are working on addressing in the future"
[vendor, Netflix TechBlog]. That is Netflix stating in 2026 that VMAF does not handle grain.

The mechanism is the same one that broke your SSIM run: grain is *stochastic*. "The noise appearing
at different pixel locations between the source and decoded video poses challenges for pixelwise
comparison methods like PSNR or VMAF, leading to penalized quality scores" [2nd, summarizing the
AV1 film-grain-synthesis discussion; corroborated by Netflix/vmaf issue #1192 and ab-av1 issue
#139, both of which are open bug reports about exactly this].

The community workaround, which is also Netflix's own AV1 pipeline design: **denoise, encode,
measure on the denoised signal, re-synthesize grain at playback** [vendor, Netflix TechBlog,
"AV1 @ Scale: Film Grain Synthesis, The Awakening"]. The measurement rule that falls out is:
*apply the metric to the denoised material, not the grainy material, because encoding artifacts
are hidden by grain amplitude anyway.*

**Practical implication for Lawrence of Arabia:** your SSIM-keeps-improving-at-247-BPP+ result is
not a bug in your experiment, it is the known behavior of pixelwise FR metrics on 70mm grain.
Any fix must involve denoising before measuring, or measuring at 720p (which is itself a low-pass
that kills most of the grain — see §6), or both. **Downscaling to 720p before measuring is
effectively a free grain filter and is also what your hardware actually does.**

### 2d. What score is "transparent"?

Handle these numbers carefully — none of them come from Netflix.

- **~6 VMAF points = 1 JND.** [2nd, widely repeated]. I could not find this in Netflix's own docs;
  the vmaf FAQ does not mention JND at all [vendor, verified by fetch]. Treat as folklore that is
  probably roughly right.
- **93–95 = transparent top rung for premium content on a big screen.** [2nd, OTTVerse /
  streaming-industry practice]. The one semi-primary anchor I found: a study from RheinMain
  University with the streamer Joyn, tested on a 4K TV, reported VMAF 95 as "on average
  subjectively indistinguishable from the original video signal" **[unverified — I did not fetch
  the study itself, only a secondary description of it]**.
- **<2 point differences are invisible; 3+ points start to be seen.** [2nd, unverified].

[opinion] For our use, the numbers to internalize are: **95 = stop, 93 = fine, differences under
3 points are noise.** Do not build a UI band boundary on a 1-point VMAF difference.

---

## 3. Convex-hull / per-title encoding

The whole industry moved off fixed ladders for the exact reason you measured 2.4x complexity
variance inside one film.

**Netflix, per-title (2015)** [vendor, netflixtechblog.com/per-title-encode-optimization-7e99442b62a2
— **note: I was unable to fetch this page directly, Medium redirect-walled it; the summary below is
from search snippets and secondary coverage, so treat as [unverified] on details**]: brute-force a
matrix of encodes at many bitrate/resolution pairs per title, plot quality vs bitrate, take the
convex hull, and derive that title's ladder. Cost is reported as roughly 20x a normal encode [2nd,
StreamingMedia].

**Netflix, Dynamic Optimizer / per-shot (2018)** [vendor, netflixtechblog.com — again Medium-walled
on direct fetch, so [unverified] on exact figures]: go finer than per-title. Split into shots,
encode each shot at many (resolution, QP) points, evaluate each with VMAF to get an (R,D) point,
compute a per-shot convex hull, then stitch shots together choosing points of **equal
rate-distortion slope** (the Lagrangian condition) via a trellis. Reported savings, from search
snippets: ~25% BD-rate for multi-shot videos, and ~28% (x264) / 34% (x265) / 38% (VP9) bitrate
savings at equal VMAF versus fixed-quality encoding.

**The structural insight, which is the useful part for us:** a two-hour film is not uniformly hard.
A dark dialogue scene and a confetti explosion want different resolutions at the same bitrate.
Therefore **any single scalar quality score for a whole movie is lossy by construction.** The
industry's answer is to score per-shot and aggregate.

**Bitmovin** commercialized the cheap version: compute a "complexity factor" in a
**complexity-analysis pass** over the input, then derive the ladder analytically instead of
brute-forcing the matrix [2nd, bitmovin.com]. This is the architecture we should copy: one cheap
analysis pass, one derived number.

**Practical takeaway for us:** we don't build ladders, but the machinery inverts cleanly. Netflix
asks "given this content, what bitrate reaches quality Q?" We have the bitrate and want to know the
quality. Same curve, read the other way. Which means **the cheapest correct thing we can do is
measure the content's position on that curve, and the cheapest way to do that is a probe encode.**

---

## 4. Cheap complexity proxies

### SI/TI (ITU-T P.910) — do not use as a bitrate predictor

SI is the standard deviation of a Sobel-filtered luma frame, max over time; TI is the std-dev of
the frame-difference signal [std, ITU-T P.910 (10/2023)]. Reference implementation:
`github.com/slhck/siti` (Python), and FFmpeg has a `siti` filter [vendor].

They are widely used, and they are **weak**. The ATHENA group's VCA papers report:

- **"The average Pearson Correlation Coefficient (PCC) of SI with bitrate is 0.28"** — very weak.
- **"The average PCC of EY with bitrate is 0.86"** for their DCT-energy feature.
- "The correlation of SI and TI features with encoding output features such as bitrate are very
  low, which is insufficient for encoding parameter prediction in streaming applications."

[peer, arXiv:2304.12384 "Green Video Complexity Analysis for Efficient Encoding in Adaptive Video
Streaming" — **caveat: the PDF was binary-unreadable to my fetcher; these numbers come from search
snippets of that paper, so treat the exact figures as [unverified] though the qualitative finding
is corroborated across multiple ATHENA papers**.]

**Verdict: SI/TI is a 0.28-correlation predictor of the thing we care about. That is barely better
than BPP+'s constant. Skip it.**

### DCT-energy complexity: VCA (Video Complexity Analyzer)

- `github.com/cd-athena/VCA`, **GPLv3**, C++ with x86 SIMD and multithreading [vendor, repo].
- Computes DCT-based **texture energy (E)** and **gradient of texture energy (h)** per block/frame,
  designed explicitly as a per-title-encoding complexity predictor [vendor, ATHENA lab].
- Reported PCC with bitrate ~0.86 vs SI's 0.28 (see caveat above).
- The GPU successor EVCA claims >1200 fps at 1080p [2nd, ATHENA] — irrelevant to us, but VCA on CPU
  is designed to be fast.
- **This is the one serious alternative to the CRF probe.** It is much cheaper (no encoder in the
  loop) and gives a complexity number directly. Downside: GPLv3, needs building from source, and
  the output is an abstract energy figure that you'd have to calibrate against your own library
  before it means anything.

### The CRF probe — what we should do

`ab-av1` is the working reference implementation of exactly this, in production use
[vendor, github.com/alexheretic/ab-av1 + alexheretic.github.io/posts/ab-av1/]:

- `sample-encode`: "encodes short video samples of an input using provided crf and preset, which is
  much quicker than full encode/vmaf run."
- `crf-search`: "interpolated binary search with sample-encode to find the best crf value delivering
  `--min-vmaf` and `--max-encoded-percent`."
- Rationale as stated by the author: "Encoding a full video and checking VMAF multiple times to
  find a good crf and preset is slow, so the solution is to cut a small section of the video, say
  20s long, and encode that."

**Why the probe beats SI/TI and beats VCA for our purposes:** the probe's output is denominated in
*bits*, the same unit as the thing we're comparing it to. No calibration constant needed. It
handles grain correctly by construction (grain is expensive to code → probe bitrate rises → the
file's bit budget is judged against a higher bar), and it handles animation correctly (cheap to
code → low bar). That is precisely the two failure cases BPP+ gets wrong today.

**Related published anchor:** SVT-AV1 bitrate estimation from motion-search information
[peer, arXiv:2407.05900] and XPSNR-based convex hull estimation for VVC [peer, arXiv:2406.13712]
both take the "cheap partial encode as complexity oracle" route. **[unverified]** on their numbers —
I did not fetch either in full.

### Bonus: XPSNR is worth knowing about

Fraunhofer HHI's **XPSNR** is a perceptually-weighted PSNR that is **now merged into FFmpeg
mainline as the `xpsnr` filter** [vendor, github.com/fraunhoferhhi/xpsnr + FFmpeg 8.0 filter docs].
It is full-reference, so it doesn't solve our core problem, but it is dramatically cheaper than
VMAF with reportedly comparable subjective correlation, and it uses temporal information. If you
ever do need an FR metric inside a probe loop (e.g. "did my CRF-20 probe damage this?"), use
`xpsnr` before you reach for `libvmaf` — it will be several times faster on a Skylake box.
[opinion on the "several times faster" — the repo claims low complexity but I found no head-to-head
timing number.]

---

## 5. Does bits-per-pixel have any standing in the literature?

**Short answer: it has industry standing as a rough sanity check, and essentially zero standing as
a quality predictor. There are no published "transparent 1080p" BPP thresholds that I could find.**

What exists:

- **BPP as a normalization for comparing encodes** is standard practice in the encoding trade press:
  "If the bits per pixel for files A and B are 0.1 and 0.05, respectively, file B is applying half
  the bits per pixel of file A" [2nd, streaminglearningcenter.com]. Note the important corollary
  they state: **"If codecs operate more efficiently at higher resolutions you would expect the data
  rate to increase at higher resolutions, but the bits per pixel to decrease."** BPP is not
  resolution-invariant. Your BPP+ implicitly assumes it is.
- **The Kush Gauge** is the closest thing to a published BPP threshold, and it is a
  back-of-envelope rule from an Adobe employee (Kush Amerasinghe), not research:
  `bitrate_kbps = width * height * fps * motionFactor * 0.07 / 1000`, where motionFactor is 1, 2, or
  4 [2nd, multiple forum/blog sources; originally an Adobe whitepaper]. Note that **0.07 bpp x
  motionFactor** spans 0.07–0.28 bpp for H.264 — and your BPP+ constant of 0.13 sits right in the
  middle of that range. So your constant is defensible; it is roughly "Kush Gauge with
  motionFactor ~2".
- Note also that the Kush Gauge's entire content-adaptivity is that single hand-assigned motion
  factor with a **4x range**. You measured 2.4x complexity variance *within one film*. The
  gauge's own structure concedes that a fixed BPP constant is wrong by up to 4x.
- **Your HEVC x1.8 factor** is in line with the commonly quoted 40–50% bitrate saving of HEVC over
  AVC at equal quality [2nd, many; e.g. "a 50-60% reduction in storage and bandwidth requirements
  going from H.264/AVC to H.265/HEVC" — that figure is vendor marketing and is optimistic;
  ~35–50% is the more defensible range, and it is content-dependent and encoder-dependent].
  **[opinion] 1.8 is slightly generous but not crazy.** It will over-credit low-effort HEVC
  re-encodes of already-compressed sources, which are common in the wild.

**Nothing peer-reviewed treats BPP as a quality metric.** It is a bitrate-planning heuristic. What
the literature says instead is that the bitrate needed for transparency is a function of content
complexity that varies by more than an order of magnitude, which is the entire reason per-title
encoding exists (§3).

---

## 6. Downscaling: 1080p content on a 720p panel

**This is the highest-leverage finding in the report and you should act on it.**

### Established facts

1. **Compression artifacts and scaling artifacts trade off, and which one wins is bitrate- and
   content-dependent.** This is the convex-hull result: at low bitrate, encoding at a *lower*
   resolution beats encoding at full resolution, because the coding error at full resolution
   exceeds the rescaling error. "A 540p resolution can be more efficient and comprise the convex
   hull at certain bitrates like 2.75 Mbps than higher resolutions like 720p and 1080p"; but "on
   sequences with dense edges and low temporal variations, the coding error is overwhelmed by the
   rescaling loss, making encoding at higher resolution always superior... over the whole bitrate
   range" [peer, arXiv:2401.04405 and the convex-hull literature generally].
   **Implication: for a bit-starved 1080p file, downscaling to 720p genuinely improves it. The
   downscale is a low-pass filter and blocking/ringing artifacts are high-frequency.**

2. **Netflix themselves fixed a VMAF bug in this exact area.** VMAF v0 "favored higher resolutions
   at lower bitrates, preferring compression artifacts over scaling, which could be visually
   annoying," and v1 adds the AIM blockiness component to correct it [vendor, Netflix TechBlog,
   VMAF v1]. That is Netflix confirming that the artifact-vs-softness tradeoff is real, is
   perceptually significant, and was being mis-scored by the industry's best metric until 2026.

3. **VMAF measurement convention when your target is a smaller display.** The general rule is to
   measure at the reference resolution and upscale the distorted [vendor, vmaf FAQ]. But the
   commonly given exception is exactly our case: "if you know that the files will be played back on
   a display with HD resolution, but the original source file was 4K UHD, then it might be useful
   to downscale the source to an HD reference" [2nd, OTTVerse/EasyVMAF — practitioner guidance, not
   a Netflix statement]. The generalization to 1080p→720p is straightforward.

4. **Angular resolution.** For a 50-inch screen, "the benefits of 1080p vs. 720p start to become
   apparent when closer than 9.8 feet and become fully apparent at 6.5 feet"
   [2nd, carltonbale.com — a widely-cited enthusiast analysis based on the 1-arcminute acuity
   limit, not peer-reviewed]. The underlying 1-arcminute / 20:20-acuity benchmark is standard
   vision science [2nd, tftcentral.co.uk]. For a projector, the relevant variable is the projected
   *image* size and your seating distance, which I do not have — but the panel is 720p regardless,
   so 1080p detail is discarded before it reaches your eye no matter where you sit.

### What this means concretely

**Every metric we compute should be computed on 1280x720-downscaled video, not on the native
1080p file.** Three separate reasons converge:

- It is what the hardware actually shows. Measuring detail the panel discards is measuring nothing.
- It is a free grain suppressor, which directly addresses the Lawrence of Arabia failure. Grain is
  the highest-frequency content in the frame and is the first thing a downscale removes.
- It compresses the dynamic range of the scores in the right direction: a bit-starved 1080p file
  looks *better* at 720p than its 1080p metrics suggest, and our metric should reflect that rather
  than penalize a file for artifacts nobody will see.

**And it changes the BPP+ arithmetic directly.** BPP+ divides by `width * height`. If the effective
display is 1280x720, the correct denominator is 921,600, not 2,073,600 — a factor of 2.25. A file
that scores 60 BPP+ ("red") today would score 135 against a 720p denominator. **Either the
denominator changes or the 0.13 constant changes, but the current combination is measuring bits per
*stored* pixel when what matters is bits per *displayed* pixel.**

[opinion — the caveat] This is not a free pass. A 1080p file's bits were spent encoding 1080p, and
you don't recover the wasted ones by downscaling; a 1080p file at 2 Mbps is not equivalent to a
720p file at 2 Mbps, because the latter spent all its bits on pixels you'll actually see. The
2.25x is an upper bound on the credit, not the right credit. The honest way to resolve this is
empirical: the CRF probe at 720p answers it directly, because it measures how many bits *this
content* needs *at 720p*.

**[unverified]** I did not find a peer-reviewed study that directly measures "how much does
downscaling to display resolution reduce the visibility of compression artifacts." Searches for it
returned only the adjacent convex-hull literature. The mechanism is well established; the
magnitude is not published as far as I can tell.

---

## What this means for BPP+

**Keep it. Fix its denominator. Demote it to a prefilter. Layer the probe on top.**

Concretely, in priority order:

### 1. Fix BPP+ now (cheap, no new compute)

- **Compute against the displayed pixel count, not the stored one.** Either use 1280x720 as the
  denominator for everything, or keep the current denominator and re-derive the 0.13 constant from
  the 720p reality. Do one or the other, and document which. The current version silently
  penalizes 1080p files for pixels the projector throws away.
- **Reconsider the HEVC x1.8.** It is inside the defensible 35–50% range but on the generous end,
  and it rewards the exact population of files (low-effort HEVC re-encodes of already-lossy
  sources) that are most likely to be bad. x1.6 is a safer constant. [opinion]
- **Publish the honest provenance in the UI copy.** BPP+ is essentially a Kush-Gauge derivative
  with motionFactor pinned at ~2. That's a legitimate industry heuristic; it is not a quality
  measurement, and nothing in the literature says it is. Don't let the "+" imply more rigor than
  it has.
- **Stop using SSIM for validation entirely.** The metric is confounded by grain in the direction
  that produces exactly your Lawrence of Arabia result. There is no threshold you can pick that
  fixes this. [peer, arXiv:1907.03842 for the NR mirror-image of the effect;
  vendor Netflix for the FR side]

### 2. Add the CRF probe as a second tier (the real fix)

Run it as a slow background job over the library, 1–3 min/file, results cached forever
(they only change if the file changes).

```
for each file:
  samples = 8 x 4s, evenly spaced, skip first/last 5%
  for each sample:
    ffmpeg -ss T -t 4 -i FILE -vf scale=1280:720:flags=lanczos \
           -c:v libx265 -crf 20 -preset medium -an -f null -
    record encoded bits
  probeBitrate = total_bits / 32s
  R = sourceVideoBitrate / probeBitrate       # complexity-normalized adequacy
```

`R` replaces the 0.13 constant with a *measured* per-title value. Report it alongside BPP+; where
they disagree, the probe is right. Expect the biggest disagreements on (a) animation and
low-complexity content that BPP+ marks red but is actually fine, and (b) grain-heavy 70mm and
high-motion action that BPP+ marks green but is actually starved.

**Calibrate the CRF constant against your own library before trusting absolute values.** Pick 10
files you have subjectively judged (a known-great remux, a known-bad YTS rip, a couple of
in-betweens), run the probe, and set the R thresholds so those 10 land where you already know they
belong. Without this step the numbers are arbitrary.

### 3. Add the two real no-reference detectors as a floor (cheap, catches the probe's blind spot)

On the same 8 samples, at 720p:

- `ffmpeg -vf blockdetect` → blockiness. Catches over-compressed sources whose artifacts have
  become "cheap to re-encode" and therefore fool the probe.
- `libvmaf` with the CAMBI feature → banding, 0–24, ~5 begins to annoy. Catches the 8-bit
  gradient staircase that neither BPP+ nor the probe will ever see.

These are the only two NR measures in this entire report that are both (a) validated on compression
artifacts specifically and (b) shipping in tools you already have installed.

### 4. Do not build

- Any learned NR metric (BRISQUE/NIQE/RAPIQUE/DOVER/UVQ). Wrong training distribution, and NIQE
  is affirmatively documented to score compressed video backwards.
- Any self-reference VMAF scheme. It measures your re-encode, not the file.
- SI/TI. 0.28 correlation with bitrate.
- Full-file anything. libvmaf at ~7–24 fps means hours per movie.

### 5. Optional, later

If the probe turns out too slow: **VCA** (`cd-athena/VCA`, GPLv3) gives a DCT-energy complexity
number at claimed ~0.86 PCC with bitrate for a fraction of the cost of a probe encode. It needs
building and calibrating, and the GPLv3 may matter depending on how the controller is licensed.

If you ever need a full-reference metric inside a loop (e.g. to decide "is re-encoding this file
safe"), use FFmpeg's built-in **`xpsnr`** filter before `libvmaf` — cheaper, temporal-aware,
mainline.

---

## Sources

### Primary — fetched and read directly
- **[vendor]** Netflix TechBlog, "VMAF v1: Good Is Not Good Enough" (June 2026) —
  https://netflixtechblog.com/vmaf-v1-good-is-not-good-enough-60d7e4244ea8
  (VMAF v1 four device models, viewing-distance feature adjustment, AIM blockiness, CAMBI
  integration, chroma via SpEED-QA, motion bound, film grain listed as unsolved future work,
  30–40% faster.)
- **[vendor]** Netflix/vmaf FAQ — https://github.com/Netflix/vmaf/blob/master/resource/doc/faq.md
  (Cross-resolution comparison is "apples-to-oranges"; upsample the low-res to 1080 and measure
  there; VMAF covers compression + scaling artifacts only; **does not** discuss JND, grain, or
  transparency thresholds.)
- **[peer]** Antsiferova et al., "Barriers towards no-reference metrics application to compressed
  video quality analysis: on the example of no-reference metric NIQE" — https://arxiv.org/abs/1907.03842
  (NIQE outliers on flat frames; rewards compression blur; "cannot be used for video-codec
  comparisons.")
- **[peer]** "Convex Hull Prediction Methods for Bitrate Ladder Construction: Design, Evaluation,
  and Comparison" — https://arxiv.org/abs/2310.15163
  (Abstract only; 300 UHD shots across AVC/HEVC/VVC; compares handcrafted vs DL convex-hull
  predictors. Specific features/accuracies are in the full text, which I could not extract.)
- **[vendor]** RAPIQUE README — https://github.com/vztu/RAPIQUE/blob/main/README.md
  (MATLAB >=2019 + Deep Learning Toolbox required; ~146.5s per 720p video; validated on KoNViD-1k,
  LIVE-VQC, YouTube-UGC — all UGC.)
- **[vendor]** cd-athena/VCA — https://github.com/cd-athena/VCA (GPLv3, C++, SIMD, per-title
  complexity prediction. The repo page does not publish fps numbers.)
- **[2nd]** Fora Soft, "Open-Source No-Reference Video Quality Tools" —
  https://www.forasoft.com/learn/video-quality/articles-vqm/open-source-no-reference-tools
  (Four-tier taxonomy; FFmpeg filters ≥5.1; CAMBI 0–24 scale with ~5 annoying; pyiqa licensing is
  non-commercial; FAST-VQA ~0.83 SROCC on LSVQ; cross-dataset SROCC <0.6 on UGC transcoding vs FR
  VMAF ≥0.94. **Commercial explainer site — corroborate anything load-bearing.**)

### Primary — identified but NOT fetched (Medium redirect wall / binary PDF)
Everything cited from these is flagged [unverified] above.
- **[vendor]** Netflix TechBlog, "Per-Title Encode Optimization" —
  https://netflixtechblog.com/per-title-encode-optimization-7e99442b62a2
- **[vendor]** Netflix TechBlog, "Dynamic optimizer — a perceptual video encoding optimization
  framework" — https://netflixtechblog.com/dynamic-optimizer-a-perceptual-video-encoding-optimization-framework-e19f1e3a277f
- **[vendor]** Netflix TechBlog, "Optimized shot-based encodes: Now Streaming!" —
  https://medium.com/netflix-techblog/optimized-shot-based-encodes-now-streaming-4b9464204830
- **[vendor]** Netflix TechBlog, "CAMBI, a banding artifact detector" —
  https://netflixtechblog.com/cambi-a-banding-artifact-detector-96777ae12fe2
- **[vendor]** Netflix TechBlog, "AV1 @ Scale: Film Grain Synthesis, The Awakening" —
  https://netflixtechblog.com/av1-scale-film-grain-synthesis-the-awakening-ee09cfdff40b
- **[vendor]** Netflix TechBlog, "Toward a Better Quality Metric for the Video Community" —
  https://netflixtechblog.com/toward-a-better-quality-metric-for-the-video-community-7ed94e752a30
- **[peer]** "Green Video Complexity Analysis for Efficient Encoding in Adaptive Video Streaming" —
  https://arxiv.org/pdf/2304.12384 (source of the SI PCC=0.28 vs EY PCC=0.86 figures; PDF was
  binary-unreadable to my fetcher, figures are from search snippets)

### Standards
- **[std]** ITU-T Rec. P.910 (10/2023), "Subjective video quality assessment methods for multimedia
  applications" — https://www.itu.int/rec/T-REC-P.910
  (Defines SI as std-dev of Sobel-filtered luma, max over time; TI as std-dev of frame difference.)
- **[std]** ITU-T P.1401 — referenced by the Fora Soft article for the ±1.96×RMSE confidence-band
  reporting discipline. Not fetched.

### Tools / repos
- **[vendor]** `alexheretic/ab-av1` — https://github.com/alexheretic/ab-av1 and
  https://alexheretic.github.io/posts/ab-av1/ (sample-encode + crf-search; the production reference
  for the CRF-probe technique.)
- **[vendor]** FFmpeg filter docs, `blockdetect` / `blurdetect` / `siti` / `xpsnr` / `libvmaf` —
  https://ffmpeg.org/ffmpeg-filters.html
- **[vendor]** `fraunhoferhhi/xpsnr` — https://github.com/fraunhoferhhi/xpsnr (now merged into
  FFmpeg mainline as the `xpsnr` filter.)
- **[vendor]** `slhck/siti` — https://github.com/slhck/siti (Python SI/TI per P.910.)
- **[vendor]** `chaofengc/IQA-PyTorch` (pyiqa) — https://github.com/chaofengc/IQA-PyTorch
  (`pip install pyiqa`; NIQE, BRISQUE, MUSIQ, TOPIQ, CLIP-IQA etc. **Non-commercial license.**)
- **[vendor]** Netflix/vmaf issue #382 (libvmaf speedup) —
  https://github.com/Netflix/vmaf/issues/382 (user-reported ~6.57 fps single-thread, ~23.6 fps
  default, ~100 fps at n_threads=20, 1080p. User reports, not an official benchmark.)
- **[vendor]** Netflix/vmaf issue #1192 and alexheretic/ab-av1 issue #139 — open reports of VMAF
  being confounded by AV1 film grain synthesis.

### Peer-reviewed, cited but not fully read
- **[peer]** "Hacking VMAF and VMAF NEG: vulnerability to different preprocessing methods" —
  https://arxiv.org/pdf/2107.04510 (sharpening → VMAF 111.99; histogram equalization → 144.
  Numbers from search snippet; **[unverified]**.)
- **[peer]** "Optimal Transcoding Resolution Prediction for Efficient Per-Title Bitrate Ladder
  Estimation" — https://arxiv.org/pdf/2401.04405 (resolution crossover is content-dependent;
  rescaling error vs coding error tradeoff.)
- **[peer]** "Convex-Hull Estimation using XPSNR for Versatile Video Coding" —
  https://arxiv.org/pdf/2406.13712
- **[peer]** "SVT-AV1 Encoding Bitrate Estimation Using Motion Search Information" —
  https://arxiv.org/html/2407.05900
- **[peer]** "Video Quality Assessment: A Comprehensive Survey" — https://arxiv.org/pdf/2412.04508
  (Not read. Likely the best single entry point if this topic is revisited.)
- **[peer]** "No-Reference VMAF: A Deep Neural Network-Based Approach to Blind Video Quality
  Assessment" (2024) — https://www.researchgate.net/publication/381548325 (Exists; no public
  implementation found. **[unverified]**.)

### Forum / hearsay tier — do not build on these alone
- **[2nd]** OTTVerse, "Identifying the Top Rung of a Bitrate Ladder" —
  https://ottverse.com/top-rung-of-encoding-bitrate-ladder-abr-video-streaming/ (source of the
  93–95 transparency convention and the RheinMain/Joyn VMAF-95 claim.)
- **[2nd]** Streaming Learning Center — https://streaminglearningcenter.com/ (BPP as a comparison
  normalizer; VMAF phone model; per-title history.)
- **[2nd]** Kush Gauge — https://blog.sporv.com/restoration-tips-kush-gauge/ and
  https://projects.haykranen.nl/kush/ (`w*h*fps*motionFactor*0.07/1000` kbps; motionFactor 1/2/4.)
- **[2nd]** Carlton Bale, "1080p Does Matter — Here's When" — https://carltonbale.com/1080p-does-matter/
  (720p→1080p benefit thresholds by screen size and distance. Enthusiast analysis from the
  1-arcminute acuity limit; not peer-reviewed.)
- **[2nd]** Bitmovin, "What is Per-Title Encoding?" — https://bitmovin.com/blog/what-is-per-title-encoding/
  (complexity-analysis pass → complexity factor → derived ladder.)
- **[2nd]** MathWorks BRISQUE docs — https://www.mathworks.com/help/images/ref/brisque.html
  (BRISQUE non-monotonicity at JPEG quality 50/60/70.)

### Explicitly unverified / unsourced
- "~6 VMAF points = 1 JND" — folklore. Not in Netflix's own docs (I checked the FAQ).
- The magnitude of artifact-visibility reduction from downscaling 1080p→720p. Mechanism is well
  established; I found no study quantifying it.
- All per-file cost estimates in the TL;DR are my extrapolation from published fps figures for
  other tools on other hardware. **Measure them on the actual NUC before committing to a schedule.**
