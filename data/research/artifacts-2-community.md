# Video Compression Artifacts: Community Knowledge Report

**Purpose**: Comprehensive catalog of compression artifacts as understood by encoding communities (Doom9, Reddit, release groups, practitioners). For a no-reference artifact detection system targeting 1080p Bluray/WEB-DL encodes (H.264/H.265, 2–8 Mbps) using the ffmpeg ecosystem.

**Sources**: Doom9 forums, Reddit (r/htpc, r/Piracy, r/Handbrake, r/ffmpeg, r/AV1), Scene/P2P release group standards, Jaded Encoding Thaumaturgy (JET) guide, Codec Wiki, Fora Soft field guide, practitioner blogs, ITU-T standards.

---

## 1. BLOCKING (Macroblocking / Tiling / Mosaicing / Pixelating / Checkerboarding)

**Community names**: blocking, macroblocking, tile artifacts, mosaic effect, pixelation, checkerboarding, quilting, jaggies

**What causes it**: The frame is divided into blocks (8×8 in H.264, up to 64×64 in HEVC) and each block is independently DCT-transformed and quantized. When quantization is too coarse (low bitrate), neighboring blocks no longer align at their shared edges, producing visible grid-like seams. The grid is real and countable — a 1920×1080 frame with 8×8 blocks has 32,400 potential block edges.

**Community wisdom on when it appears**:
- Dark areas first — "Watch dark areas, often macroblocks will be visible there first" (Doom9 practitioner)
- Fast motion amplifies it
- x264 at low bitrate is the classic case; HEVC hides it better with larger CUs but still exhibits it
- "Wet patches in water, leaves" — Doom9 practitioners describe a related degradation where HF coefficients are dropped while LF coefficients sustain, creating smooth/waxy patches in textured areas

**Bitrate range**: Obvious below ~4 Mbps for 1080p H.264; less common in HEVC until ~2 Mbps. At 2–8 Mbps H.264, it appears in high-motion scenes. Scene rules (2011 x264 standard) set minimum 8000 kbps for 1080p, maximum 14000 kbps — the floor is specifically to prevent blocking.

**Encoder/format affected**: All DCT-based codecs, but H.264 more than HEVC at the same bitrate. Hardware encoders (NVENC, AMF, QSV) exhibit more blocking than software at the same bitrate because they run at roughly "fast" preset equivalent.

**Detection**: Already have `blockdetect` (ffmpeg). Good coverage.

**Key references**:
- Doom9 thread: "Compression Artifacts" (forum.doom9.org/showthread.php?t=177072)
- Doom9 thread: "Help for a correct analysis of a video source" (forum.doom9.org/showthread.php?t=177062)
- Scene rules: 2011 x264 standard section 2.13 — minimum bitrates to prevent blocking
- Fora Soft field guide: "Blocking — visible square tiles, born from coarse DCT quantization"

---

## 2. BANDING (Contouring / Posterization / Striation)

**Community names**: banding, contouring, posterization, color banding, striation, staircase effect in gradients

**What causes it**: Too few distinct brightness/color levels to represent a smooth gradient. In 8-bit video (256 levels), a sky ramping from code value 90 to 110 across 400 pixels means 20-pixel-wide flat bands with visible steps. The encoder quantizes coarsely in flat regions, and the AQ algorithm doesn't allocate enough bits to these areas.

**Community wisdom**:
- "Wet patches" in Doom9 parlance is the x265-specific manifestation — when bitrate-starved, x265 tends to blur/smear rather than block, and dark flat areas develop smooth waxy patches that look like "wet concrete" (Doom9, multiple threads)
- Netflix built CAMBI specifically because PSNR/SSIM/VMAF are blind to banding
- 10-bit encoding is the standard fix — 4x the levels, so bands shrink to below perceptual threshold
- Strong in-loop deblocking (`--deblock -3:-3`) helps blocking but can worsen banding in flat areas
- SAO (`--no-sao`) is often disabled by quality encoders because it creates detail loss, but SAO helps with banding — a tradeoff
- `--aq-strength` higher values retain more gradients (avoid banding) but risk ringing; lower values preserve edges but risk banding (Doom9 compressibility check thread)
- Strong intra smoothing in x265 (`--strong-intra-smoothing`) is an additional blur that helps prevent banding — disable for grainy content, keep for flat/smooth content (Codec Wiki)

**Bitrate range**: Any bitrate if the source has smooth gradients and the encode uses 8-bit. Most common in: skies, fades, studio backdrops, dark scenes, smoke/fog. Even high-bitrate 8-bit encodes can show banding in challenging gradients.

**Encoder/format affected**: All codecs equally at 8-bit; 10-bit encoding largely solves it. x265 defaults to 10-bit which is a major advantage. x264 in High profile 8-bit is most vulnerable.

**Detection**: We have CAMBI — this is well covered. The Netflix-developed detector is the gold standard for no-reference banding detection.

**Key references**:
- Netflix CAMBI paper and implementation (included in VMAF)
- Fora Soft: "Banding — blind spot for PSNR/SSIM/VMAF; use CAMBI"
- Doom9: AQ strength discussion in compressibility check thread
- JET guide: "Deblocking will affect how much smoothing is applied. This can be harmful to dithering and grain"

---

## 3. RINGING (Haloing / Overshoot / Gibbs Phenomenon)

**Community names**: ringing, haloing, ghosting around edges, Gibbs phenomenon, edge ringing, overshoot

**What causes it**: When the DCT quantizer truncates high-frequency coefficients that a crisp edge needs, the reconstructed edge overshoots and oscillates — like a struck bell ringing instead of stopping cleanly. Creates faint "halo" or "ghost shadow" lines parallel to high-contrast edges.

**Community wisdom**:
- Common around text overlays, logos, building edges against sky
- Worse with aggressive sharpening pre-filters or sharpening in the encode chain
- "At CRF20, I start noticing 'pixel clouds' around moving objects more and more" — Doom9 visually lossless thread
- SAO in HEVC is specifically designed to reduce ringing, but at the cost of detail loss — "SAO aims to reduce visual artifacting, particularly around edges. However, it's very prone to creating detail loss" (JET guide)
- Release groups consider visible ringing a quality defect; the 2007 x264 scene rules mention sharp edges in cropped regions causing artifacts
- Community wisdom: "In Blu-ray encodes, the only ringing you'll be likely to see is from upscaling methods such as Lanczos and sharp Bicubic variants, or possibly from badly done sharpening" (fansubbing guide)

**Bitrate range**: Visible at moderate-to-low bitrates, exacerbated by sharpening. At CRF 20+ (x264) / CRF 25+ (x265), becomes noticeable.

**Encoder/format affected**: All codecs. SAO in HEVC helps but is a blunt instrument. x264 without SAO is more prone.

**Detection**: `blurdetect` partially catches this as a loss of sharpness, but ringing is specifically about edges being too sharp (halo) rather than too soft. Not well covered by existing detectors. Could potentially use edge-aware difference metrics.

**Key references**:
- Fora Soft field guide: "Ringing — weakly caught by metrics, small in pixels but visible to eye"
- Doom9 visually lossless thread: CRF thresholds for visibility
- Fansubbing guide: ringing section with HQDeringmod/EdgeCleaner discussion

---

## 4. MOSQUITO NOISE (Edge Busyness / Edge Shimmer)

**Community names**: mosquito noise, edge busyness, edge shimmer, edge flutter, dot crawl around edges

**What causes it**: Ringing that moves — because the encoder re-quantizes each frame slightly differently, the ringing around edges shimmers and dances frame to frame, creating "a cloud of busy dots hovering around hard edges, exactly like mosquitoes around a porch light" (NIST). Worst on: sharp text, logos, computer-generated graphics over flat backgrounds.

**Community wisdom**:
- "AVC: Scrutinize dark parts, expect wet patches in water, leaves" — Doom9 practitioner, though "wet patches" is more blur; mosquito noise is specifically around edges
- Per-frame metrics miss the motion — "Per-frame metrics miss the motion; needs temporal check" (Fora Soft)
- Most visible in low-bitrate webrips and MPEG-2 TV captures
- "In Blu-ray encodes, you're much more likely to see mosquito noise from poorly done sharpening" (fansubbing guide)
- Hardware encoders are particularly prone because they can't adaptively control quantization around edges as well as software encoders

**Bitrate range**: Common below ~6 Mbps for 1080p H.264. At 2–8 Mbps, present in any content with sharp edges over flat backgrounds.

**Encoder/format affected**: All DCT-based codecs. Worse in MPEG-2, still visible in H.264 and HEVC at low bitrates.

**Detection**: NOT covered by our current detectors. This is a temporal artifact — the spatial component (ringing) exists in individual frames, but the *shimmer* only manifests in motion. Would require frame-to-frame comparison of edge regions. ffmpeg doesn't have a dedicated mosquito noise detector.

**Key references**:
- ITU-T Rec. P.930: "Form of edge busyness distortion sometimes associated with movement"
- Fora Soft: "Per-frame metrics miss the motion; needs temporal check"
- Codec Wiki: mosquito noise section with DCT explanation

---

## 5. BLUR / SMEARING / DETAIL LOSS (Texture Smearing / Wet Patches / Waxy Artifacts)

**Community names**: blur, smearing, texture loss, detail loss, waxy artifacts, wet patches, watercolor effect, "the watercolor test", mush, softness

**What causes it**: When the encoder quantizes away high-frequency coefficients (which carry fine texture detail), or when denoising/aggressive deblocking removes texture. Also caused by downscaling from higher resolution. x265 specifically tends to smear rather than block when starved — "The difference between x264 and x265 is that the former creates blocking and the latter blurs when it's bitrate-starved" (Doom9).

**Community wisdom**:
- "Wet patches in water, leaves" — the Doom9 community's specific term for x265's tendency to lose texture in natural scenes at moderate bitrates
- "x265 seems to 'smear' grain into other grain" — Doom9 x264 vs x265 grain comparison
- "NVENC smears grain/noise" — hardware encoders are particularly bad at preserving grain texture
- SAO in HEVC can cause detail loss: "SAO tends to blur quite heavily" (Codec Wiki)
- CU-tree rate control can starve simple areas: "CU Tree... often leads to simpler areas (such as backgrounds) being starved of bitrate, creating noticeable blocking artifacts" (JET guide) — but the JET community actually wants to disable it to prevent patchy quality
- AQ mode 2 in x265 "can make smear in patches of the image" (Doom9, quoting x265 devs)
- "Granite texture behind trinity's head is noticeably less well defined. As if it's just slightly out of focus" — Doom9 Matrix encode comparison
- The "visually lossless" Doom9 community settles on CRF 17-19 with `--no-sao` as the transparency threshold for 1080p

**Bitrate range**: Appears across all bitrates but manifests differently — at high bitrates it's subtle texture loss, at low bitrates it's gross smearing. At 2–5 Mbps H.264 1080p, very common in textured scenes.

**Encoder/format affected**: x265 more than x264 (different degradation mode). Hardware encoders (NVENC, AMF) worst — they effectively run at "fast" preset. AQ mode 2 in x265 specifically problematic.

**Detection**: We have `blurdetect`. This is reasonably well covered, though "waxy" texture loss is subtly different from optical blur and may need a texture-aware metric.

**Key references**:
- Doom9: "Visually lossless encoding" thread — CRF thresholds and no-sao discussion
- Doom9: x264 vs x265 grain comparison thread — smearing evidence
- JET guide: CU-tree and AQ discussions
- Doom9 analysis thread: "wet patches" as specific x265 failure mode

---

## 6. GRAIN DEGRADATION / GRAIN FREEZING / GRAIN DESTRUCTION

**Community names**: grain destruction, frozen grain, static grain, grain smearing, lost grain, grain aliasing, quantization noise masquerading as grain

**What causes it**: Film grain is essentially high-frequency random noise that changes every frame. Encoders treat it as something to compress away (it's "noise"), but grain is a deliberate aesthetic choice from the original. When the encoder can't represent it, grain either: (a) gets destroyed leaving a waxy/smooth texture, (b) freezes and becomes static (especially with `--tune grain` or high `--nr-inter`), or (c) smears into splotchy patterns.

**Community wisdom**:
- "x265 is not tuned for grain retention. We have fought that issue for years but the devs have never considered it a high priority" (Doom9, x265 developer acknowledged issue)
- "--tune grain looks atrocious. The grain became static and it looked worse than medium preset with no changes" (Doom9, multiple users)
- "The grain became static and it looked worse" — `--tune grain` in x265 is widely considered counterproductive by the community
- `--nr-inter 2000` with `--tune grain` creates "frozen grain" — the NR filter is too aggressive (Doom9)
- "I just give all the bitrate I can afford and indeed add a bit noise to avoid wet patches in dark areas" — Doom9 practitioner's approach: add synthetic grain to mask artifacts
- "Sometimes excessive ugly compression artifacts can be hidden by applying artificial noise on the image and then denoising slightly if required. It can create a layer of fake detail to fool your brain. Something like GrainFactory3" (Doom9)
- Ben Waggoner (Microsoft encoder): recommends specific NR settings, warns against overuse
- x265's AQ modes 1-3 were "mostly just ported directly from x264 and then left as they are" — not optimized for grain (Doom9)
- `--psy-rd` and `--psy-rdoq` are the community's tools for grain retention: higher values preserve grain but increase bitrate
- Film grain synthesis in AV1 (`film-grain` parameter) is considered superior because it separates grain from content

**Bitrate range**: Critical issue at all bitrates for grainy content. Worst at 2–6 Mbps for 1080p grainy film transfers.

**Encoder/format affected**: x265 most problematic (grain destruction is its most criticized weakness). x264 handles grain better with `--tune grain` (though still imperfect). AV1 with film grain synthesis is considered the best solution. Hardware encoders destroy grain completely.

**Detection**: Our grain/noise loss detector is relevant here. Could be enhanced by looking for frozen grain (temporal coherence of noise patterns that should be random).

**Key references**:
- Doom9: x264 vs x265 vs NVENC grain comparison thread (forum.doom9.org/showthread.php?t=183035)
- Doom9: Ben Waggoner x265 grain recommendations
- Doom9: "x265 is not tuned for grain retention" — developer acknowledgment
- Reddit r/Piracy: "film grain wrecks performance" discussion
- JET guide: `--psy-rd` and `--psy-rdoq` for grain preservation

---

## 7. FLICKER (Temporal Flicker / I-frame Flicker / Intra-flicker / Breathing)

**Community names**: flicker, temporal flicker, intra-flicker, I-frame flicker, breathing, pulsing, shimmer, temporal fluctuation, stationary area fluctuation

**What causes it**: Co-located blocks in consecutive frames are encoded with different quantization noise patterns — especially at I-frame boundaries where the prediction source changes from temporal (P/B-frames) to spatial (intra prediction). This creates a visible brightness/texture discontinuity at each I-frame. "A noticeable discontinuity between an intra frame and its preceding inter frame" (EURASIP paper).

**Community wisdom**:
- "Coarse-granularity flickering is the sudden luminance changes in large areas of the video. This is most likely caused by the use of group-of-picture structures in the compression algorithm" (AVNetwork)
- "Flickering is a temporal artifact that arises due to variations in reconstructed low-motion areas of consecutive frames. It is very perceivable at low and medium bit rates" (academic papers confirm community observation)
- Fire, candlelight, fireworks, and any flickering light source dramatically worsen this — "The CRF algo tries to render the moving flames somewhat accurately" causing bitrate spikes followed by quality drops (Reddit r/ffmpeg)
- "I-frame heavy" encoding strategy creates high spatial quality per-frame but "fails to solve—and may even exacerbate—temporal jitter and 'breathing' artifacts" (2025 paper on temporal consistency)
- The community describes this as "pixel clouds around moving objects" at CRF 20+ (Doom9)
- Encoders may insert more I-frames when they "give up" on inter-prediction for unpredictable motion, creating visible quality jumps

**Bitrate range**: Most visible at low-to-medium bitrates. At CRF 20+ (x264) / CRF 26+ (x265), becomes noticeable in static areas near motion.

**Encoder/format affected**: All codecs with GOP structures. More noticeable with larger GOP sizes and at lower bitrates. x265's larger CTUs can make the discontinuity more visible.

**Detection**: NOT covered by our current detectors. This is purely temporal — no single frame contains the artifact. Would require measuring frame-to-frame PSNR/SSIM variance in static regions. ffmpeg's `signalstats` or custom temporal difference analysis could help.

**Key references**:
- EURASIP: "Post-processing for flicker reduction in H.264/AVC"
- 2014 IEEE paper: "Standard-Compliant Low-Pass Temporal Filter to Reduce the Perceived Flicker Artifact"
- AVNetwork: flickering section in compression artifacts overview
- 2025 arXiv paper: "Evaluating the Effect of Compression on Video Temporal Consistency"

---

## 8. COLOR BLEEDING / CHROMA SMEARING

**Community names**: color bleeding, chroma bleeding, color smearing, color fringing, chroma blurring

**What causes it**: 4:2:0 chroma subsampling (used in virtually all consumer video) reduces color resolution to 1/4 of luma resolution. When the encoder quantizes chroma coefficients coarsely, colors "leak" past their intended edges. Also caused by aggressive chroma denoising.

**Community wisdom**:
- "Color bleeding — color leaking past its edge. Cause: coarse chroma quantization; 4:2:0 subsampling. Weak detection — luma-focused metrics under-weight chroma" (Fora Soft)
- Less discussed in community forums than blocking/banding because it's subtle in most content
- Most visible in animation with flat color regions and sharp color boundaries
- 10-bit encoding and higher CRF quality settings reduce it

**Bitrate range**: Primarily at low bitrates (<4 Mbps for 1080p). At 2–8 Mbps, only visible in content with sharp color transitions (animation, graphics).

**Encoder/format affected**: All codecs with 4:2:0 subsampling. Hardware encoders more prone due to aggressive chroma quantization.

**Detection**: NOT well covered. ffmpeg's `signalstats` can detect some chroma anomalies but there's no dedicated color bleeding detector. Could measure chroma edge sharpness vs luma edge sharpness.

---

## 9. GHOSTING / MOTION GHOSTING / TEMPORAL GHOSTING

**Community names**: ghosting, motion ghosting, trailing, comet tail, motion smear, duplicate frames

**What causes it**: Improper encoding creates a visible "ghost" or trail behind moving objects. Can be caused by: (a) bad motion compensation in the encoder, (b) field processing errors, (c) duplicate/blended frames, (d) aggressive temporal denoising.

**Community wisdom**:
- "Ghosting — annoying feature of a release, which results into ghost effect during every movement in the movie. It's caused by improper encoding and can't be easily fixed" (Scene nuke dictionary)
- `ghosting` is an official nuke reason in scene releases — considered a serious defect
- `field.shifted`, `dupe.frames`, `blended.frames` are all nuke reasons related to temporal artifacts
- Hardware encoders with aggressive temporal filtering can introduce ghosting
- NVENC and AMF temporal noise reduction creates trailing artifacts behind moving objects

**Bitrate range**: Can appear at any bitrate if the encoder's motion compensation is poor. More common with hardware encoders and aggressive denoising.

**Encoder/format affected**: Hardware encoders most prone. Also affects poorly configured software encodes.

**Detection**: NOT covered. Temporal artifact — would require motion-compensated frame differencing. ffmpeg doesn't have a dedicated ghost detector.

**Key references**:
- Scene nuke dictionary: ghosting, field.shifted, dupe.frames, blended.frames
- Reddit: NVENC quality discussions mentioning trailing artifacts

---

## 10. QUANTIZATION NOISE / POSTERIZATION IN DARK SCENES

**Community names**: quantization noise, dark scene artifacts, dark area degradation, shadow blocking, shadow banding, crush

**What causes it**: Dark scenes have very small signal values where quantization errors become proportionally large. The encoder's AQ algorithm may not allocate enough bits to dark regions because they have low variance (even though human vision is sensitive to artifacts there). This creates a specific flavor of blocking+banding unique to shadows.

**Community wisdom**:
- "Scrutinize dark parts, ripples on water, open fire, crisscross-motion" — Doom9, the canonical "stress test" content
- "AQ helps preserve detail in darker areas, which are common in anime and often prone to banding or blocking artifacts" (JET guide)
- "AQ mode 3" (auto-variance with bias to dark areas) exists specifically to address this
- "Lower AQ strength values increase QP, which increases compression and may lead to more noticeable artifacts" (JET guide)
- The Doom9 community specifically recommends `--aq-mode 3` for content with important dark detail
- SVT-AV1's `variance-boost-strength` parameter exists to boost dark scene encoding

**Bitrate range**: Present at all bitrates but most severe below ~5 Mbps for 1080p. Dark scenes are the hardest content to encode.

**Encoder/format affected**: All codecs. x265's AQ mode 3 was designed for this. Hardware encoders are particularly bad because they can't adaptively boost dark area quality.

**Detection**: Partially covered by banding detection. Could be enhanced by specifically measuring noise/artifacts in low-luminance regions.

---

## 11. STAIRCASE NOISE (Jaggies / Aliasing on Diagonal Edges)

**Community names**: staircase noise, jaggies, aliasing, diagonal edge artifacts, step artifacts

**What causes it**: A special case of blocking that appears as stair steps along diagonal or curved edges. Caused by quantization of high-frequency coefficients that represent smooth diagonal lines, combined with the block grid structure.

**Community wisdom**:
- "Staircase noise — a special case of blocking that appears as stair steps along a diagonal or curved edge" (AVNetwork)
- More visible when content has been upscaled or when the encode resolution doesn't match the source well
- Scene rules strictly require mod-16/mod-8 dimensions partly to avoid this
- "Resizing is not allowed on 1080p encodes" — scene rules, because resizing introduces its own artifacts

**Bitrate range**: Moderate bitrates, most visible on thin diagonal lines and fine detail.

**Encoder/format affected**: All DCT codecs. More visible in H.264 than HEVC due to smaller block sizes.

**Detection**: NOT covered. Would require edge-aware analysis comparing diagonal edge smoothness across frames.

---

## 12. TEMPORAL JITTER / MOTION INCONSISTENCY

**Community names**: jitter, motion jitter, temporal instability, motion inconsistency, stutter (distinct from playback stutter)

**What causes it**: The encoder's motion estimation fails to maintain consistent motion vectors across frames, causing objects to appear to vibrate or jitter slightly even though the original had smooth motion. Particularly bad when the encoder uses different prediction modes for co-located blocks in consecutive frames.

**Community wisdom**:
- "Temporal consistency degrades non-linearly with increasing compression" (2025 arXiv paper)
- "Unpredictable or irregular dynamics experience disproportionately higher instability than sequences with higher, but more predictable, motion magnitude" — the "Predictability Paradox"
- The community describes this as a "jittery mess" around fine detail in motion (Reddit r/handbrake: "Weird Sharpness/Jagged Edges after Encoding")
- High I-frame counts in unpredictable content create "a sequence of high-quality still images" that look jittery in motion
- Hardware encoders are particularly prone due to limited motion estimation

**Bitrate range**: Appears at moderate compression levels. Content-dependent — worst with complex/irregular motion (crowds, water, foliage in wind).

**Encoder/format affected**: All codecs, but content-dependent. x265 with `--psy-rd` can help stabilize motion vectors.

**Detection**: NOT covered. Temporal artifact requiring motion trajectory analysis.

**Key references**:
- 2025 arXiv: "Evaluating the Effect of Compression on Video Temporal Consistency"
- Reddit r/handbrake: jittery encoding artifact reports

---

## 13. SAO ARTIFACTS / OVER-SMOOTHING

**Community names**: SAO artifacts, over-smoothing, detail erasure, texture loss from SAO, "the SAO problem"

**What causes it**: Sample Adaptive Offset (HEVC in-loop filter) is designed to reduce ringing and banding, but x265's implementation is considered too aggressive by the community. It erases fine texture, skin detail, and film grain.

**Community wisdom**:
- "SAO aims to reduce visual artifacting, particularly around edges. However, it's very prone to creating detail loss. It's best to avoid using it unless you're trying to encode a mini-encode" (JET guide)
- "`--no-sao` is mandatory" — Doom9 visually lossless community consensus
- "At CRF values at or above 20, you can leave SAO on... At lower CRF values, it may be desirable to use `--no-sao`" (Codec Wiki)
- "--limit-sao is more of an early termination for the encoder deciding where to use it rather than limiting its strength" (Codec Wiki)
- "If your encode suffers from a lot of ringing, turn SAO back on. SAO does tend to blur quite heavily" (Codec Wiki)

**Bitrate range**: Most visible at CRF < 20 (high quality encodes). At lower quality, SAO's benefits may outweigh its costs.

**Encoder/format affected**: HEVC only (SAO is HEVC-specific). x265's implementation is the concern.

**Detection**: Manifests as blur/texture loss — covered by `blurdetect` but not attributed to its cause. Not a separate detection category.

**Key references**:
- Doom9 visually lossless thread: mandatory --no-sao consensus
- JET guide: SAO discussion
- Codec Wiki: SAO section with threshold guidance

---

## 14. AQ-INDUCED ARTIFACTS (AQ Patchiness / AQ Smear)

**Community names**: AQ artifacts, AQ patchiness, AQ smear, uneven quality distribution, patchy quality

**What causes it**: Adaptive Quantization redistributes bits across the frame based on visual importance, but the algorithm can create visible "patches" where some areas get much more detail than adjacent areas. x265's AQ mode 2 specifically creates "smear in patches" according to both x265 developers and community testers.

**Community wisdom**:
- "AQ mode 2 is going to look better than --tune grain because AQ gives low-detail macroblocks more bits... But AQ mode 2 can make smear in patches of the image" (Doom9, x265 dev confirmed)
- "AQ mode 1 is actually the mode that REDUCES or entirely eliminates smear!" (Doom9)
- CU-tree can create the same problem: "CU Tree... often leads to simpler areas being starved of bitrate, creating noticeable blocking" (JET guide)
- The JET community recommends disabling CU-tree for consistency
- "Lower aq-strength values increase QP, which increases compression and may lead to more noticeable artifacts" (JET guide)

**Bitrate range**: Content-dependent, most visible at moderate bitrates where AQ is actively redistributing.

**Encoder/format affected**: x265 primarily (AQ mode 2). Also affects x264 with aggressive AQ.

**Detection**: Would appear as spatially non-uniform quality — some blocks sharp, adjacent blocks blurry. Not covered by current detectors.

---

## 15. PSY-RDOQ ARTIFACTS (Halo'ing from Psychovisual Optimization)

**Community names**: psy-rdoq artifacts, halo distortion, over-sharpening artifacts, psychovisual distortion

**What causes it**: `--psy-rdoq` in x265 controls psychovisual rate-distortion optimization. At high values (like 10.0, which `--tune grain` uses), it can create artificial over-sharpening and halo artifacts.

**Community wisdom**:
- "psy-rdoq=10 — it will introduce unwanted noise/distortion/halo'ing. Lower it to something like 2-4" (Doom9)
- "It definitely introduces artificial over-sharpening. It seems like --psy-rdoq 10.0 is responsible" (Doom9 visually lossless thread)
- The community consensus is defaults are fine, and only `--tune grain` pushes these too high

**Bitrate range**: Only affects encodes using `--tune grain` or manually high `--psy-rdoq`.

**Encoder/format affected**: x265 only.

**Detection**: Manifests as ringing/haloing — covered by that category.

---

## 16. CREDIT ENCODING ARTIFACTS (End-Credit Compression / Scrolling Text Artifacts)

**Community names**: credit artifacts, rolling credits quality, end credit compression, text scrolling artifacts

**What causes it**: End credits feature small, high-contrast text scrolling against a dark background — one of the hardest things for DCT codecs to encode. The combination of fine detail (text), high contrast (white on black), and motion (scrolling) creates severe ringing, blocking, and mosquito noise.

**Community wisdom**:
- "Credits must not be removed but can be encoded at a lower bitrate provided they don't contain any scenes (bloopers, story, etc)" (scene rules 2007/2011/2016)
- Scene rules explicitly allow differential bitrate for credits — acknowledging this is a known problem
- CRF encoding naturally handles this by spending more bits on credits, but at low CRF the credits can dominate file size
- "Brainstorm (1983) — opens with credits shown amidst computer graphics, against a background of visual 'dither': rapidly moving flashes, dots, and lines against a dark background. These unimportant little artifacts force the CRF encoding algo to use a very high bitrate" (Reddit r/ffmpeg)

**Bitrate range**: A specific content-dependent issue. Credits at low CRF can consume disproportionate bitrate.

**Encoder/format affected**: All codecs. CRF naturally allocates more bits but at the cost of file size.

**Detection**: Not a separate detector category but relevant for understanding why certain regions may have artifacts while others don't.

---

## 17. GENERATIONAL LOSS / RE-ENCODING DEGRADATION

**Community names**: generational loss, re-encoding artifacts, transcoding degradation, lossy-on-lossy

**What causes it**: Encoding an already-compressed source creates compounding artifacts. Each generation adds blocking, blurring, and quantization noise. The community is acutely aware of this — it's why "re-encode" is almost pejorative.

**Community wisdom**:
- "You can, but it's lossy re-encoding — you are decoding an already-compressed file and compressing it again, so quality only goes down" (compresto.app)
- P2P groups explicitly claim superiority over scene groups because they can filter and re-encode from better sources: "We can encode to a better quality within our own standards, and try and make the best quality the source permits" (TorrentFreak)
- The entire Web-DL vs WebRip distinction exists because of this — Web-DL is the original encode, WebRip is a re-encode
- "A bigger effect can be had through light denoising, either NLMeans or BM3D" (Doom9) — pre-filtering before re-encode helps

**Bitrate range**: Relevant at all bitrates. Each re-encode generation compounds.

**Detection**: Not directly detectable without reference, but manifests as multiple artifact types simultaneously.

---

## 18. DITHERING LOSS / BAND FROM QUANTIZATION

**Community names**: dithering loss, quantization banding, quantization distortion, contouring from quantization

**What causes it**: When the source has fine dithering or noise that creates the appearance of smooth gradients, quantization can destroy this dithering pattern, converting what looked like a smooth gradient into visible bands or posterization.

**Community wisdom**:
- "Deblocking will affect how much smoothing is applied. This can be harmful to dithering and grain" (JET guide)
- The fansubbing community specifically notes: "Due to its many flat areas and smooth gradients, banding is a frequent problem in anime, which is caused by the limits of 8-bit color depth and (especially in low bitrate sources) truncation"
- `--deblock -3:-3` preserves dithering but allows blocking to show through
- 10-bit encoding is the standard community fix — it preserves dithering patterns with 4x the code values

**Bitrate range**: Any bitrate with 8-bit encoding and content with fine dithering.

**Detection**: Covered by banding detector (CAMBI).

---

## ARTIFACTS WE ARE MISSING (Gap Analysis)

Based on community knowledge, here are artifacts our current detection system does NOT adequately cover:

| Artifact | Severity | ffmpeg Detectable? | Priority |
|----------|----------|-------------------|----------|
| **Mosquito noise / edge busyness** | Noticeable-Obvious | No standard filter. Needs temporal edge analysis | HIGH |
| **Temporal flicker / I-frame flicker** | Noticeable | No standard filter. Needs frame-to-frame variance in static regions | HIGH |
| **Temporal jitter / motion inconsistency** | Subtle-Noticeable | No standard filter. Needs motion trajectory analysis | MEDIUM |
| **Ghosting / trailing** | Obvious | Could use motion-compensated frame differencing | MEDIUM |
| **Grain freezing / static grain** | Noticeable | Could measure temporal coherence of noise patterns | MEDIUM |
| **AQ patchiness** | Subtle-Noticeable | Could measure spatial variance of quality metrics | LOW |
| **Color bleeding** | Subtle | Could compare chroma edge vs luma edge sharpness | LOW |
| **Staircase noise / jaggies** | Subtle-Noticeable | Could detect with edge analysis | LOW |

### Artifacts we already cover well:
- **Blocking** → `blockdetect` ✓
- **Banding** → CAMBI ✓
- **Blur / detail loss** → `blurdetect` ✓
- **Grain/noise loss** → our grain detector ✓

---

## COMMUNITY WISDOM ON DETECTION (How Experienced Encoders Spot Artifacts)

The Doom9 community's canonical approach to artifact detection (synthesized from multiple threads):

1. **"Watch dark areas first"** — almost all artifacts manifest first in shadows
2. **"Watch water, leaves, fire"** — these are the hardest content to encode
3. **"Pixel-peep while live watching, then step through frames"** — pause for spatial, play for temporal
4. **"Use a known-not-to-introduce-heavy-processing monitor"** — disable all display enhancements
5. **"Diff encode vs source"** — the most reliable method, but requires the source
6. **"Spend countless hours scrutinizing different sources"** — train your eyes on known-good and known-bad material

The scene's approach (from release group standards):
1. **Sample must be cut from the final release** — proves the encode itself, not a separate test
2. **Specific stress test scenes** — dark scenes, water, fire, motion, credits
3. **Minimum bitrate requirements** — prevent blocking at the source level
4. **Proper/nuke system** — community quality enforcement through social mechanisms

---

## KEY CONSTANTS FROM COMMUNITY PRACTICE

These are the encoding thresholds the community considers important:

| Metric | Community Threshold | Meaning |
|--------|-------------------|---------|
| CRF 17-18 (x264) | "Visually lossless" | Doom9 consensus for transparency |
| CRF 19-20 (x264) | "Very good, minor artifacts on close inspection" | Doom9 |
| CRF 22 (x264) | "Good quality, acceptable" | General consensus |
| CRF 25+ (x264) | "Not so good, untrained eyes spot artifacts" | Doom9 survey |
| CRF 28 (x265) | = CRF 23 x264 | Equivalent quality |
| 8 Mbps min (1080p) | Scene minimum | Prevents blocking |
| 4 Mbps min (720p) | Scene minimum | Prevents blocking |
| --no-sao | "Mandatory" for quality | Doom9 consensus |
| --preset slow minimum | x265 quality threshold | Doom9/JET consensus |
| 10-bit encoding | Standard for quality | Eliminates banding |
| CRF 24+ | "Consider 2-pass" | Scene rules threshold |
| Source bitrate ceiling | Must not exceed source | Scene rules (7.10) |

---

## BIBLIOGRAPHY

### Forum Threads
- Doom9: "Compression Artifacts" (2019) — forum.doom9.org/showthread.php?t=177072
- Doom9: "Why do I have strange artifacts in my encode" (2021) — forum.doom9.org/showthread.php?t=182465
- Doom9: "Help me understand my encoding test results" — forum.doom9.org/showthread.php?p=2025468
- Doom9: "Visually lossless encoding for UHD sources" — forum.doom9.org/showthread.php?t=174679
- Doom9: "Help for a correct analysis of a video source" — forum.doom9.org/showthread.php?t=177062
- Doom9: x264 vs x265 grain comparison — forum.doom9.org/archive/index.php/t-183035.html
- Reddit r/ffmpeg: "Best ffmpeg settings for minimising ringing and blocks" — reddit.com/r/AV1/comments/198frrl
- Reddit r/handbrake: "Weird Sharpness/Jagged Edges after Encoding" — reddit.com/r/handbrake/comments/1i60dbh
- Reddit r/Piracy: "Why aren't more releases x265?" — various threads

### Standards
- Scene Rules: 2007 x264 v2 (scenerules.org/html/2007_X264v2.html)
- Scene Rules: 2008 x264 v3.1 (scenerules.org/numbered_html/2008_X264-2.html)
- Scene Rules: 2011 x264 v2 (scenerules.org/html/2011_X264.2.html)
- Scene Rules: 2020 x265 / HDX Standards (scenerules.org/html/2020_X265.html)
- Scene Rules: 2014 Blu-ray (scenerules.org/html/2014_BLURAY.html)

### Guides
- JET Encoding Guide: x265 parameters (jaded-encoding-thaumaturgy.github.io)
- Codec Wiki: x265 encoder guide (wiki.x266.mov/docs/encoders/x265)
- Codec Wiki: Spotting Video Artifacts (codecs.wiki/docs/introduction/video-artifacts)
- Fora Soft: Compression Artifact Field Guide (forasoft.com/learn/video-quality/articles-vqm/compression-artifact-field-guide)
- Fansubbing Guide: Recognizing Video Artifacts (guide.encode.moe/encoding/video-artifacts.html)
- Vibbit: Codec Parameter Tuning Deep Dive (vibbit.ai/blog/codec-parameter-tuning-h264-h265-av1)
- Compresto: x264 vs x265 comparison (compresto.app/blog/x264-vs-x265)

### Academic / Industry
- Yuen & Wu (1998): Survey of compression artifacts in Signal Processing
- ITU-T Rec. P.930: Reference impairment system definitions
- Netflix: CAMBI banding detector paper
- 2014 IEEE: "Standard-Compliant Low-Pass Temporal Flicker Reduction"
- 2006 IEEE ICIP: "Detented Quantization to Suppress Flicker Artifacts in H.264"
- 2020 JESC: "Comprehensive Overview of Classical and New Perceivable Artifacts"
- 2025 arXiv: "Evaluating the Effect of Compression on Video Temporal Consistency"
- AVNetwork: "Compression Artifacts: Why Video Looks Bad" (2017)
- AVNetwork: Nuke Dictionary / Scene nuke reasons (post.rlsbb.cc/nuke-dictionary/)

### Nuke Dictionary (Scene Release Failures)
The scene nuke system reveals what communities consider disqualifying artifacts:
- `ghosting` — motion ghosting, considered serious
- `bad.ivtc` / `no.ivtc` — telecine errors causing jerky motion
- `interlaced` — visible scan lines, makes release unwatchable
- `field.shifted` — field processing errors
- `dupe.frames` / `blended.frames` — temporal integrity failures
- `custom.quant.matrix` — encoding parameter violations
- `bad.crop` / `overcropped` — image geometry errors
- `undersized` / `oversized` — bitrate/sizing violations
- `bad.fps` — wrong frame rate
- `oos` (out of sync) — A/V sync failures
- `cbr.audio` — audio encoding violations
