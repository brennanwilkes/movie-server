# 02 — Dataset & Calibration research (Thought A)
### Can BPP+ be calibrated/validated against EXISTING labelled datasets of encode quality?

Research date: 2026-08-19. Author: dataset & calibration researcher.
Question: does any public dataset of per-clip perceptual quality let us test the BPP+
claim — "100 = this film's bits match a CRF-20 encode of itself" — so that the latent
axis, the headroom anchor (open question 2), the band edges, and the sqrt exponent
(open question 7) stop being unvalidated constants?

Evidence tags as in BPP-PLUS.txt: [SOLID] / [DIRECTION] / [UNTESTED] / [RETRACTED-grain].

The live library numbers quoted below are from `/api/probe/dataset` on 2026-08-19
(885 movies measured).

---

## 1. EXECUTIVE SUMMARY

**Verdict: calibration against existing datasets is FEASIBLE — for the latent axis, the
headroom anchor and the band edges — provided three traps are respected. No dataset can
certify the grain half of the library, and pretending one does is the fatal-flaw
candidate. Avoidable.**

What BPP+ actually claims, restated in label-testable form:

    BPP+ = 100 * sqrt( video_bpp / (complexity * biasFactor(R) * HEADROOM_TARGET) )

The numerator is a pure file property. `complexity` is measured *on the file*. The only
tunable constants are `HEADROOM_TARGET` (=1.0) and the pinning curve. So a dataset of
encoded clips with perceptual labels can in principle pin four things, in increasing
order of confidence:

1. **Headroom** — at each dataset's *near-transparent* rung the score should read ≈ 100.
2. **Band edges** — at the rung where degradation becomes clearly visible ("warn" edge)
   the score should read ≈ 75, consistently across content.
3. **Sqrt exponent** — fit MOS-vs-BPP+ per content and compare the exponent to 0.5.
4. **Pinning** — on a fixed-content ladder, the measured complexity should fall with
   encode severity, and DV the correction curve should track the labelled DMOS drop.

**The best single dataset is BVI-HD** (Bristol): 384 distorted clips, 1080p25, 5 s, a
full psychometric compression curve per source content (QPs 22→47, HEVC + synthesis),
double-stimulus DMOS on 86 subjects, and — critically — the ladder *includes the
visually-lossless anchor* (QP 22, DMOS < 10) which is exactly the data needed to pin
HEADROOM_TARGET externally. Gate: a free CDVL registration.

**Three datasets are worth the bandwidth** (BVI-HD, MSU CVQAD, Netflix public);
**three are structurally dangerous as ground truth** (KonViD-1k, LIVE-VQC, YouTube-UGC
absolute MOS) because their labels are single-unpaired-clip MOS — the exact confound
that invalidated the in-house blind test (BPP-PLUS §11.1); and **nothing anywhere has
real SDR-1080p film grain with compression scores**, which is [SOLID] the single most
important gap for *our* library.

**Recommended first step (one night's budget, ~2–3 h):** CDVL account → download the
BVI-HD subjective file + the 32 HEVC clips at QP 22 and QP 37 (≈64 clips, ~0.5–1 GB)
→ probe each → read off three numbers: where QP-22 lands (headroom), where QP-37 lands
(band edge), and the per-content exponent. Start the CDVL registration today; it is the
rate-limit of the whole plan.

---

## 2. DATASET-BY-DATASET

### 2.0 Table

| Dataset | Content | # clips | Res / dur | Codec(s) | Quality label | Refs? | Download | NR-usable? | Fit to our library |
|---|---|---|---|---|---|---|---|---|---|
| **BVI-HD** | clean modern broadcast/texture, feature-balanced | 32×12 = 384 | 1080p25 / 5 s | HEVC HM14 + HEVC-SYNTH | DMOS, DSIS, 86 subj, QP22→47 full psychometric | yes | CDVL (free acct) | **yes** | BEST |
| **MSU CVQAD** (NeurIPS'22) | Vimeo/xiph/YouTube-UGC | 36 src, 2,486 str (open 1,022) | FullHD / 10 s | AVC/HEVC/AV1/VP9/VVC/LCEVC (~22 encoders) | crowdsourced pairwise → BT scalar | yes (identified) | scores: GitHub free; videos: link DEAD | yes | bitrates 1/2/4 Mbps = our plateau |
| **Netflix public (NFLX_dataset_public)** | animation + live | 9 contents × ~8 pts | ≤1080p | H.264-ish ladder | MOS (panel) + expert score | yes | Google Drive grant | yes | 1080p 1.8–6 Mbps |
| **YouTube-UGC** | 15 UGC categories | 1,500 × 20 s | 360p–4K | RAW / H.264 CRF10 / VP9 variants | MOS whole+chunk; DMOS for G/S/V | yes (RAW/CRF10) | GCS public; RAW 2 TB, H264 110 GB, VP9 20 GB | yes | authentic; huge |
| **KonViD-1k** | Flickr CC UGC | 1,200 × 8 s | 85% 720p | H.264-ish authentic | ACR MOS 1-5, 50 ratings | no | 2.3 GB zip, no gate, LIVE | yes (but label danger) | authentic; 720p-heavy |
| **LIVE-VQC** | smartphone UGC | 585 | mixed | authentic | MOS, 240 ratings | no | free form | yes (but label danger) | weak (phone footage) |
| **ITU-T / VQEG-HD3 / TUM** | standard test seqs | VQEG-HD3 ~84 GB | 1080p25 | AVC-family | MOS/DMOS per rate point | yes | CDVL | yes | rates 5–30 Mbps too high |
| **MSU annual codec comparisons** | 15–20 clips | n/a | varied | all codecs | codec-vs-codec ranking | yes | no per-clip MOS release | no | no |
| **Double-compression forensic sets** | known YUVs, 500–6000 kbps | thousands | 720p/1080p | AVC/HEVC | BINARY single-vs-double, NO MOS | yes | papers | no | no labels |
| **HDR grain studies** (2306.14432; Gain-of-Grain) | 4K HDR, some ISO-noise clips | 7–50 | 4K HDR | AV1 / VVC+FGS | MOS/DMOS 42 subj | yes | partial | — | 4K HDR ≠ us, but WARNING value |
| **BVI-Texture / SynTex / BVI-CC** | static+dynamic texture | 100+/186/306 | FHD/UHD | HEVC + synthesis | MOS/DMOS | yes | gated or 30–170 GiB | yes | texture stress proxy |

---

### 2.1 BVI-HD — *the* dataset for this question    **[SOLID on structure; sizes UNTESTED]**

Zhang, Moss, Baddeley, Bull — *A Video Quality Database for HEVC Compressed and
Texture Synthesized Content*, IEEE TMM 20(10):2620–2630, 2018.
Homepage: https://fan-aaron-zhang.github.io/BVI-HD/ · Paper: https://doi.org/10.1109/tmm.2018.2817070

- **Content**: 32 progressive 1080p25 reference sequences, 5 s each, selected from a
  131-candidate pool (the standard broadcast test material pool — Xiph/deƒ/VQEG/SVT)
  to maximise range and uniformity of five features: spatial information (SI),
  colourfulness, motion vector, texture (TP) and dynamic texture (DTP). So the content
  is deliberately *feature-uniform* — clean modern broadcast-grade video, textured
  but NOT photochemical film grain.
- **12 distortions per reference** (= 384 total): six HEVC encodings (HM 14.0, Random
  Access, Main profile, QPs **22/27/32/37/42/47**) plus six HEVC-**SYNTH** encodings
  (texture-synthesis mode: B-frames' static/dynamic texture warped/synthesised rather
  than coded) at QPs 27 and 42 × 3 synthesis thresholds. The synth conditions are the
  direct, controlled version of "the encoder refuses to buy texture bits".
- **Labels**: double-stimulus impairment scale (DSIS, reference-anchored), 86 subjects,
  DMOS per clip; the QP range was justified so the psychometric curve is *complete*
  — QP 22 ≈ visually lossless (DMOS < 10), QP 47 ≈ severely degraded, and the paper
  reports **75%-correct-detection at ≈ QP 36**. That gives us a *labelled* "clearly
  visible degradation" position per content.
- **Download**: "all videos" via CDVL after a personal account registration
  (https://www.cdvl.org/); instructions/related files + all subjective data linked from
  the homepage. Distorted clips delivered compressed (orders ~0.5 MB (QP47) to ~10 MB
  (QP22) each → **384 clips ≈ 1–3 GB**; the uncompressed refs ≈ 390 MB each × 32 ≈
  12.5 GB, and the refs are *not needed* for NR use). [Exact sizes need the README —
  UNTESTED.]
- **Why it is the backbone**: (a) 1080p25 — exactly our geometry; (b) a per-content
  *ladder* including the near-transparent rung — the only thing that can pin
  `HEADROOM_TARGET` externally; (c) reference-anchored (DSIS) labels — immune to the
  grain-vs-compression single-clip confound; (d) the synth conditions are the best
  public proxy for "bits that buy texture (grain-adjacent) that viewers may not value".

**Verdict for our purposes: THE primary calibration dataset. All other candidates are
supplementary or checks against it.** Caveat: HEVC-only, HM14, clean content.

---

### 2.2 MSU NeurIPS-2022 Compressed Video Quality Dataset (CVQAD)    **[DIRECTION; videos gated]**

Antsiferova, Lavrushkin, Smirnov, Gushchin, Vatolin, Kulikov — *Video compression
dataset and benchmark of learning-based video-quality metrics*, NeurIPS 2022 (Datasets
& Benchmarks). Bench page: https://videoprocessing.ai/benchmarks/video-quality-metrics.html
· Repo: https://github.com/msu-video-group/MSU_VQM_Compression_Benchmark

- **Content**: 36 FullHD source clips (10 s each) clustered from ~18,000 high-bitrate
  Vimeo/Xiph/YouTube-UGC videos by SI/TI complexity, genre-balanced (sports, gaming,
  nature, interviews, UGC…). Encoded by ~22 encoder variants across **7 standards —
  AVC, HEVC, AV1, VP9, VVC, LCEVC, …** at three target bitrates **1,000 / 2,000 /
  4,000 kbps** (VBR), plus some at a faster and a slower preset. 2,486 streams total;
  1,022 in the public "open" part.
- **Labels**: crowdsourced **pairwise** comparisons — 766,362 valid answers, ~11,000
  uniquely identified participants, ≥10 votes per pair, verification questions used;
  Bradley–Terry → a scalar per clip. **Scores are consistent within each reference
  group** (pairs only compared videos of the same source) — so within-content ordering
  is the designed read; cross-content absolute scores are *not* the design.
- **Access**: `Subjective_scores.csv`, `Metric_scores_example.csv`, `video_categories.json`
  and the correlation notebook are all **live on GitHub today**. The *video files* were
  shared at `calypso.gml-team.ru:5001` (password-protected) — verified **down today**
  (connection refused on both http/https, port 5001). The 36 refs are identified by
  source, so it may be possible to reconstruct refs from Vimeo/Xiph/UGC links, but the
  exact compressed streams are the point and cannot be replica-labelled. Contact
  `vqa@videoprocessing.ai` to ask for a rehost.
- **Value if the videos return**: the *only* dataset that tests BPP+ across AVC/HEVC/
  VP9/AV1 on the same content at **exactly our bitrate plateau** (median library
  2.25 Mb/s; 37% of movies sit on a ~2.1 Mb/s preset) — a direct test of the
  `X265_EFFICIENCY` multiplier and of the "registered axis survives codec change" claim.

**Verdict: second in the ordering; parked on access. Scores free, videos currently
unreachable.**

---

### 2.3 Netflix public VMAF dataset (NFLX_dataset_public)    **[DIRECTION; Drive-gated]**

https://github.com/Netflix/vmaf/blob/master/resource/doc/datasets.md ·
`resource/dataset/NFLX_dataset_public.py` · video folder:
https://drive.google.com/folderview?id=0B3YWNICYMBIweGdJbERlUG9zc0k (request access).

- **Content**: 9 contents (Big Buck Bunny, Birds in Cage, Crowd Run, El Fuente 1/2,
  Fox Bird, Old Town Cross, Seeking, Tennis) at **1080p max**, each encoded at several
  resolutions (288→1080) and bitrates (~0.4–6 Mb/s at 1080p). YUV420p, released for
  VMAF training/validation — a per-content **rate ladder** exactly in our format.
- **Labels**: both a **MOS** (non-expert panel, in `NFLX_dataset_public.py` per asset)
  and the file-name encoded **expert score** (`{content}_{expert}_{height}_{bitrate}`).
- **Access**: Google Drive folder, access granted on request (works in practice).
  Package as a whole is small (tens of GB max, mostly the multiple-res points).
- **Content bias**: 9 contents, dominant animation; visually *very* clean; no grain.
  This is the "clean streaming content" extreme of our library — a fine *confirmation*
  set, a poor standalone.

**Verdict: cheap secondary confirmation; Drive-gated; clean-content-only.**

---

### 2.4 YouTube-UGC    **[DIRECTION; downloads large, labels have two kinds]**

https://media.withyoutube.com/ugc-dataset · Wang/Inguva/Adsumilli MMSP 2019;
subjective release Yim/Wang/Birkbeck/Adsumilli ICIP 2020.

- **Content**: 1,500 clips × 20 s, 15 categories, 360p→4K. Originals distributed as
  **RAW YUV (≈2 TB)** or **H.264 CRF-10 (~110 GB)**; VP9 variants (VOD / VODLB / CBR)
  for Gaming/Sports/Vlog (~20 GB).
- **Labels**: (a) **MOS** for whole + 3 overlapping 10-s chunks, crowdsourced 100+
  raters, 1–5; (b) **DMOS** for the Gaming/Sports/Vlog VP9 variants; (c) the 2021 UVQ
  release adds 600+ content labels; (d) a 2024 release adds 33 compression variants
  (AV1/VP9/H.264 × 11 bitrates 100→3000 kbps) with **ordinal** labels only ("higher
  bitrate ⇒ ≥ quality; newer codec ⇒ ≥ quality"), no graded MOS per variant.
- **Which part is usable**: only the **DMOS** subset (reference-anchored, genuinely
  gradated) and the ordinal-variant subset. The absolute **MOS** on the originals is
  single-clip and authentic-distortion-contaminated — same danger class as KonViD.
- **Content**: authentic UGC errors (blur, shake, banding) dominate; no film grain.

**Verdict: the DMOS/VP9 1080p corner is a usable low-bitrate test (≤3,000 kbps);
the absolute-MOS half must be kept out of any headline result.**

---

### 2.5 KonViD-1k    **[SOLID structure; label danger; free and immediate]**

http://database.mmsp-kn.de/konvid-1k-database.html (page verified live today) ·
Hosu et al., QoMEX 2017. Videos zip **2.3 GB**, no registration, 8 s per clip.

- **Content**: 1,200 videos fairly sampled from YFCC100m (Creative Commons); 85% at
  720p, 9% at 1080p; authentic distortions (H.264 compression, packet loss, blur,
  shake). No reference, one clip = one score.
- **Labels**: ACR single-stimulus **MOS**, ~50 ratings per clip, 5-point, with narrow
  CIs required. None of the distortion mix is decomposable on the ship.
- **The trap**: an absolute MOS given *one unpaired clip* is exactly the instrument
  BPP-PLUS §11.1 retracted — raters can never separate "compression" from "grain or
  capture errors" without a pair/anchor. So KonViD is the cheapest *range check* of
  cross-content band consistency, and a **weak falsifier** (a low correlation there is
  not evidence about the compression-only axis).
- **Content**: UGC; no film grain; 720p-heavy.

**Verdict: free, immediate, 2.3 GB — use as a broad "do the bands at least sit on the
right side of the MOS scale" check, never as headline.**

---

### 2.6 LIVE-VQC    **[DIRECTION; skip]**

Sinno & Bovik TIP 2019 · https://live.ece.utexas.edu/research/LIVEVQC/index.html

- 585 in-the-wild videos, captured on 101 devices by 80 users, MOS (205k ratings).
  Download via a free form. Same structural class as KonViD (single-clip absolute MOS,
  no reference, no ladder) but the content is mostly casual smartphone footage of
  *lower* transfer to a home cinema library. No advantage over KonViD except size.

**Verdict: same label danger class with worse transfer; skip for this calibration.**

---

### 2.7 ITU-T / VQEG test material (VQEG-HD3, TUM 1080p25)    **[DIRECTION; superseded]**

- VQEG-HD3 1080p sequences with subjective scores (the Netflix-VMAF README documents
  the 84 GB combined zip via CDVL). TUM 1080p25: 4 sequences × 2 AVC encoders + Dirac
  at 5–30 Mb/s → 48 points, 2010. Both are full-reference, clean-content, **5–30 Mb/s**
  — one or two orders above the plateau that matters (2.1 Mb/s) and above the 1080p
  streaming ladder.

**Verdict: superseded by BVI-HD for our bitrate band; not worth the downloads.**

---

### 2.8 MSU annual Codecs Comparison    **[SOLID shape; not usable]**

The yearly codec shoot-out produces panel judgement on probe clips at matched
bitrates, but there is no public per-clip MOS release — the scores are codec-vs-codec
rankings. The *dataset behind it* (CVQAD, §2.2) is the usable artifact.

**Verdict: skip; its dataset is CVQAD.**

---

### 2.9 Double-compression (re-encode) forensic datasets    **[SOLID shape; no labels]**

Several papers construct exactly the *piracy-scene* material we care about — known
YUVs re-encoded twice at 500–6,000 kbps (Jiang 2019; Furushita 2025; He 2021). But the
label is **binary** "single vs double compressed" (a *detection* task), with **no
subjective scores** at all. Confirms §17's "still missing" claim: nobody has released a
*graded-quality* dataset of re-encoded consumer video.

**Verdict: unusable for calibration; the only role would be cheap raw material for an
in-house ladder, which `probe-starve.sh` already produces.**

---

### 2.10 HDR film-grain studies    **[SOLID as a warning, not content-transferable]**

- *Subjective evaluation of content-based AV1 optimisation* (arXiv **2306.14432**):
  4K HDR, 7 sequences, 42 subjects, DSCQS MOS/DMOS at multiple QPs, and notably two
  clips with ISO (sensor) noise — MeridianFace, NocturneRoom. Finding that matters
  here: **non-experts rated the *lower-*bitrate encoding of grainy/noisy content
  HIGHER than a higher-bitrate one** (qp27 vs qp39) in four conditions, statistically
  significantly in three. I.e. on grainy content, for naive eyes, rate-quality can go
  *non-monotonic* — the clean-content rate-quality assumption that underlies BPP+ is
  empirically falsified on grainy content by *external* data, matching our own
  reasoning in §11 and §13 open-Q4.
- *Gain of Grain* (Menon et al., MMSys 2024): VVC (VVenC) + film-grain-synthesis at
  **1080p, bitrates 0.25–6.0 Mb/s**, documenting how FGS masks compression artifacts at
  low bitrate. No public graded-MOS dataset release.

**Verdict: not transferable content-wise (4K HDR), but externally confirms the
grain-confound and the risk of calibrating purely on clean content. The "grain is a
gate-shaped fact" in BPP-PLUS §12.7 is consistent with this external evidence.**

---

### 2.11 BVI-Texture / BVI-SynTex / BVI-CC    **[DIRECTION; gated or large]**

- **BVI-Texture** (data.bris DOI 10.5523/bris.1if54ya4xpph81fbo1gkpk5kk4, ~30.8 GB):
  100+ real static/dynamic texture sequences with HEVC rate/distortion + subjective
  scores. Texture ≈ the closest public thing to "content bits buy nothing visible".
- **BVI-SynTex** (~170 GiB): CGI-generated textures, HEVC subjective subset.
- **BVI-CC** (Frontiers 2022): 9 UHD sources → 306 encodings (HM / AV1 / VTM) with
  MOS/DMOS; available on request.

**Verdict: the "bits vs texture" axis is the grain-adjacent stress BVI-HD already
carries in its SYNTH conditions; these three add depth at a heavy download/gate cost —
worth it only *after* the BVI-HD synth results say we need more.**

---

## 3. FEASIBILITY — is the calibration idea valid or rigged?

### 3.1 What the test can and cannot do

Given a clip and a labelled score (MOS/DMOS), probe the *encoded clip* exactly as the
nightly does, compute BPP+ with the live correction, and ask questions. Crucially the
probe's input is the **encoded benchmark clip itself**, never a master, so the whole
exercise stays inside the no-reference box BPP+ promises (BPP-PLUS §1.2a/c).

The claim being tested has **three separable layers**. Rank them.

**(A) Within-content monotonicity — real but near-tautological.** On a fixed content
ladder, `complexity` is (mostly) constant, so BPP+ is monotone in bitrate by
construction, while MOS/DMOS is monotone by the study design. A rank test here is a
sanity check only; a dataset that only offered this would brand the exercise rigged.

**(B) The headroom anchor — the genuinely testable claim.** "100 = this content's
CRF-20 cost" projects onto a dataset's *near-transparent rung*:
- BVI-HD QP22 (DMOS < 10, "visually lossless") should read **BPP+ ≈ 100**.
- MSU/Netflix top rungs and YouTube-UGC CRF-10 in the same way.
If the QP-22 rung reads ≈ 130, then `HEADROOM_TARGET` should be ~(100/130)² ≈ 0.59 —
which is **the same 0.57 that `headroomLive` already reports from the library median**.
A clean BVI-HD pin is the first ever *external* evidence for open question 2, and the
two sources agreeing would be a remarkable amount of independent support for one knob.

**(C) Band consistency and cross-content spread — the honesty test.** For every
reference, QP≈36 is the labelled "75% correct detection" point; per-ref BPP+ there
should sit near the `warn` edge (75) *and* the spread between refs should be small.
Two possible outcomes:
- **tight** → band edges are content-normalised well → the axis is real;
- **spread that tracks TP/DTP (texture richness)** → the denominator's residual error
  really does run with grain/texture (a systematic, content-correlated error — the
  exact shape documented in open questions 3–4), and we would know *where* the bands
  are wrong before trusting them library-wide.

**(D) The sqrt exponent** — the weakest link (BPP-PLUS §2.1, open Q7). Per-content
MOS-vs-DMOS gives a psychometric curve; the exponent of that curve is directly
compared with the 0.5 the model assumes. Datasets give this for *free* if we use the
per-content ladders (BVI-HD, Netflix), and it is the honest quantitative answer to
"is `bitrate^-0.5` right?".

**(E) Pinning on a labelled ladder.** `probeBitrate` falls with encode severity on any
fixed-content ladder — that *is* source pinning reproduced under external ground truth.
Worth reporting `biasFactor` across each ladder so the fitted `1.337·R^-0.348` is
visually checked against a dataset's DMOS drop. (Respect trap 12: it constrains the
shape, it does not re-derive the constant.)

### 3.2 Validity traps (make the test honest or it is rigged)

1. **Only within-content rank ("does BPP+ order the ladder?")** — near-tautological;
   must never be reported as evidence. The evidence is the *anchor* and the
   *cross-content band scatter*.
2. **Pooling across content into one global Spearman.** BPP+ is content-normalised by
   design and the doc's own §8.4 – §9, §11.1 show cross-content contamination is the
   known open area. A pooled coefficient mixes the claim with its confounds. Report
   content-stratified statistics; pool only after stratifying by texture/SI.
3. **Using an unpaired absolute MOS (KonViD, LIVE-VQC, YouTube-UGC originals) as the
   "compression" label.** Single-clip raters cannot separate compression from grain/blur
   (the §11.1 lesson; externally confirmed by §2.10 where naive viewers even *prefer*
   starved grainy encodes). Reference-anchored DMOS (BVI-HD DSIS, YouTube-UGC DMOS/cVD,
   MSU pairwise) are the only safe labels. Absolute-MOS datasets get "did the bands at
   least fall on the right side" treatment, nothing more.
4. **Feeding the pristine source as "BPP+ = ∞".** No such value exists. The master is
   the *anchor of the MOS scale*, not a BPP+ point.
5. **Tune-then-validate on the same rows.** All four claims above must be computed
   once, pre-registered, then acted on. If HEADROOM_TARGET is adopted it should be from
   a pre-chosen subset (or one dataset) and *confirmed* on another (BVI-HD → Netflix
   public → CVQAD). Otherwise a single noisy dataset quietly relabels 1,000 films.
6. **Claiming "BPP+ is validated" because it works on clean content.** Every benchmark
   here is clean-source. The honest scope statement: *the per-content adequacy axis and
   its anchor are testable; the grainy-catalogue half of our library is not certified
   by any public dataset*, and the BVI-HD SYNTH conditions are at best an oblique
   probe of it (§4).
7. **Clip geometry/scheduling.** The probe was built for whole films (8–16 samples,
   phase-shifted, keyed per unit). Benchmark clips are 5–20 s and must be measured with
   the *same* encoder settings (CRF 20, 1920×1080 ref width, x265-in-container) but a
   separate unit-key namespace and **out of the nightly queue** — otherwise 384 tiny
   units would eat the nightly budget and pollute the 1,031-unit stats. Use the manual
   `/api/probe/run` path or a small standalone script reusing `probe-film.sh`; keep
   `PROBE_VERSION` untouched.
8. **Codec confusion in the reading.** BVI-HD is HM14-HEVC, our library is mostly H.264
   x265-family; the QP↔CRF mapping is approximate. Report on *bitrate* as the
   independent axis; treat QP only as a cross-check. The x265/HEVC clips get the
   `X265_EFFICIENCY` multiplier exactly as the nightly would; that is the design, not
   a bug — and CVQAD (when videos return) is the one place the multiplier is itself
   testable across AVC/VP9/AV1.

### 3.3 Honest summary

**Feasible.** BVI-HD alone can pin the headroom anchor, the band edges, the sqrt
exponent and the pinning shape on a full psychometric ladder in ~2–5 h of probing. The
so-called fatal flaw would only appear if we (1) used absolute single-clip MOS as
truth and (2) pooled across content — both are *avoidable by design*, which is itself
a finding: **the field's default validation protocol (global SROCC on unpaired MOS) is
exactly the protocol the retracted in-house blind test showed false.** We should not
silently inherit it.

---

## 4. THE GRAIN PROBLEM FOR DATASETS

- **BVI-HD's SYNTH conditions — how labelled:** the synthesis replaces texture in
  B-frames (30–55% of blocks, content-dependent) with warped/templated patches, and the
  delivered clips are the *reconstructed* frames. Subjective results are literally the
  same DSIS DMOS as the HEVC rungs: **synthesised clips scored equal-or-better than the
  corresponding HEVC clips at the same QP** while being far cheaper. That is a clean,
  labelled statement of "bits that reproduce texture do not fully count as perceived
  quality" — the same principle as the grain-absorption worry (§9, §13 Q3–4) carried
  out with *real* texture on a *labelled* scale. Our BPP+ would read those clips as
  **starved** (bpp collapsed by synthesis) and score them low — a direct, falsifiable
  prediction we can now test; if BPP+ says "bad" while DMOS says "fine", that is the
  spuriousness-causing pattern, localised with numbers. **[DIRECTION]**
- **Is there ANY dataset with real film-grain + subjective scores?** At **SDR 1080p:
  no.** [SOLID, after surveying BVI/Netflix/LIVE/Konstanz/MSU plus the double-compression
  literature.] The only grain-plus-scores material anywhere is 4K HDR (arXiv 2306.14432,
  ISO-noise clips; the FGS toolchain papers). The doc's own conclusion stands and is now
  better evidenced: **no public SDR dataset can certify the grain half of our library.**
- **Therefore**: the calibration generalises to our grainy catalogue *only* through the
  per-content normalisation itself. BVI-HD gives the *nearest testable proxy* (texture);
  the texture-vs-grain gap is the residual risk and should be written into any adopted
  band model as an unvalidated dimension (same status as today — validated neither way).

---

## 5. DATASET-TO-LIBRARY TRANSFER

Our library (live, 2026-08-19): 885 movies, 831 H.264 / 52 HEVC; **median 2.25 Mb/s,
37% on a ~2.1 Mb/s preset, 52% on three presets total**; geometry 1080p-cap (probe
width 1920, letterboxed on height); median BPP+ 60, median R 0.59.

| Transfer need | Best match | Worst |
|---|---|---|
| Bitrate band (plateau 1–6 Mb/s) | **MSU CVQAD (1/2/4 Mbps)**, Netflix public 1080p, YouTube-UGC VP9 (≤3 Mbps) | TUM (5–30), VQEG-HD3 |
| Resolution | BVI-HD, Netflix public (1080p) | KonViD (720p), LIVE-VQC (phone) |
| Codec | CVQAD (AVC/HEVC/AV1/VP9/VVC) | BVI-HD (HEVC-only), YouTube (VP9) |
| Content type vs grainy catalogue | BVI-HD SYNTH (texture stress proxy) | everything (all clean modern) |
| Subjective-label safety | BVI-HD (DSIS-anchored), MSU (pairwise), YouTube-UGC (DMOS only) | KonViD, LIVE-VQC, YouTube-UGC absolute MOS |
| Gated/free | KonViD (2.3 GB, live today) | BVI-HD (CDVL), Netflix (Drive), CVQAD (videos dead) |

**Useless for transfer**: SJTU 4K-HEVC (4K-only), HDR-Sports / HDR-LIVE (HDR), LIVE-
Netflix QoE (mobile rebuffering), TUM 1080p25 (rate range), MSU annual (no per-clip
labels), double-compression forensics (no MOS).

---

## 6. CONCRETE RUN-PLAN (ordered; sizes; what to do)

**Standing rules**: benchmark clips are measured with the *same* encoder settings as the
nightly (CRF 20, x265 in the controller container, 1920 ref width) via the manual
`/api/probe/run` path or a standalone `probe-film.sh` loop; separate unit-key namespace
(e.g. `bvi:q22:s03`, `nflx:tennis:1800`); never in the nightly queue; `PROBE_VERSION`
unchanged. Encode strictly sequentially (4-core box). Cost model from live data: a
whole-film 8-sample probe is a median ~199 s; a 5–10 s clip with 1–2 samples is
~25–50 s.

A single night is 240 min of ~limited encode budget. Everything below is budgeted in
probe-seconds, not wall time.

**Phase 0 — decision gate (0 GB, 0 h).** Write the analysis protocol (claims B–E,
content-stratified stats, pre-registered headroom rule) BEFORE any download. Never
re-tune on the same rows. Register for CDVL today (days' latency — it is the
rate-limit of the whole plan).

**Phase 1 — MINIMAL FIRST STEP (one night, ~40–90 min encode).**
- BVI-HD: subjective file + **32 clips × {QP22, QP37}** = 64 HEVC clips (~0.5–1 GB).
  (QP22 = the near-transparent anchor; QP37 ≈ the 75%-detection "clearly degraded"
  rung.)
- Probe each (1–2 samples, ~30 s) ⇒ 64 × 30 s ≈ **35 min** sequential.
- Compute BPP+ (live-corrected AND raw) per clip.
- Read off the three numbers: **the BPP+ mass at QP22** (→ headroom), **the BPP+
  mass at QP37** (→ warn-band edge), and per-content **exponent vs 0.5**. Plus the
  QP22-vs-QP37 content-stratified spread as the band-consistency error.
- Success criteria are pre-registered: QP22 lands in 90–115 (headroom stays ≈1), QP37
  lands in 60–90 (bands hold), content-stratified spread < ±20 at QP37.
- One night's budget comfortably fits; results go straight into open questions 2 + 7.

**Phase 2 — full BVI-HD (all 384 clips incl. SYNTH, ~2–5 GB, ~2–5 h encode across
nights or a manual session).**
- Add QP 27/42/47 HEVC + the six SYNTH conditions.
- Analysis: full per-content psychometric curves; the SYNTH-vs-HEVC divergence is the
  grain-proxy stress test (§4). Decide whether the band scatter tracks TP/DTP —
  the systemic-content-error probe for open questions 3–4.

**Phase 3 — cross-dataset confirmation (1–2 nights, each small):**
- **Netflix public**: accept Drive; pick the 1080p points of the 9 contents (~7 GB
  worst, grab only the 1080p assets ≈ 1–2 GB); confirm the headroom pin off the dataset
  BVI-HD wasn't tuned on (claim 5, trap 5).
- **MSU CVQAD**: ask for rehost now; if delivered, it is the one cross-codec ladder at
  our exact bitrates — the `X265_EFFICIENCY`/codec-agnosticism test.
- **YouTube-UGC DMOS corner**: Gaming/Sports/Vlog 1080p VP9 variants (VOD/VODLB/CBR,
  ~20 GB total — pick ~20–40 clips, < 2 GB); the sub-1 Mb/s end of the axis.
- **KonViD-1k (2.3 GB, free)**: band-range check only ("does red/orange/green sit on
  the right thirds of the MOS scale"); labelled as unpaired-label-confounded; never
  headline.

**Phase 4 — adoption (0 GB).** If Phase 1 + Phase 3 agree: adopt HEADROOM_TARGET from
the pre-registered subset, version the score, update BPP-PLUS.txt section 2.2 and 13,
and record itself as the first external anchor. If they disagree: treat every dataset
signal as evidence for open questions 3–5, do not adopt, and let 16.A.4 (in-house
forced-choice labels) be the arbiter. Either way §2.2/§13 get new text.

---

## 7. OPEN QUESTIONS I COULD NOT CLOSE

1. **BVI-HD exact download sizes and delivery format** — are the distorted clips
   delivered as HEVC bitstreams, YUV, or re-encoded master-based (determines whether
   SYNTH clips' bpp numerator actually reflects the synthesis save)? Needs the CDVL
   README. Gating assumption: "a few GB of compressed clips".
2. **MSU CVQAD videos — is there a live rehost?** calypso.gml-team.ru:5001 was
   connection-refused today. Contact channel (`vqa@videoprocessing.ai`) untested.
3. **Do the Netflix public folder requests still get granted?**
4. **Are BVI-HD's 32 refs on public mirrors** (Xiph/VQEG) for the optional full-reference
   side-by-side? Some will be; the feature-balanced custom subset probably will not be.
5. **Nobody publishes SDR-1080p film-grain + compression scores.** Ask the BVI group
   directly (they own BVI-Texture/SynTex) whether unpublished grainy-SDR-with-scores
   material exists; it would be the last missing dataset.
6. **The `-15%/CRF-point` conversion vs HM14 QPs** — the QP↔CRF mapping used to cross-
   check Phase 1's rung identity is approximate until tested on BVI-HD's own rate curve.

---

## 8. AUTHORITY & URLS (checked 2026-08-19)

- BVI-HD — https://fan-aaron-zhang.github.io/BVI-HD/ · https://doi.org/10.1109/tmm.2018.2817070 [live]
- MSU CVQAD — https://github.com/msu-video-group/MSU_VQM_Compression_Benchmark [live]
  · https://videoprocessing.ai/benchmarks/video-quality-metrics.html [live]
  · slides: link sharing `calypso.gml-team.ru:5001/sharing/lxSWi6vtg` [dead today]
- Netflix public — https://github.com/Netflix/vmaf/blob/master/resource/doc/datasets.md [live]
  · https://github.com/Netflix/vmaf/blob/master/resource/dataset/NFLX_dataset_public.py [live]
- YouTube-UGC — https://media.withyoutube.com/ugc-dataset [live]
- KonViD-1k — http://database.mmsp-kn.de/konvid-1k-database.html [live]
- LIVE-VQC — https://live.ece.utexas.edu/research/LIVEVQC/index.html [live]
- VQEG-HD3 — via https://github.com/Netflix/vmaf/blob/master/resource/doc/datasets.md [live]
- arXiv 2306.14432 (HDR AV1 grain) — https://arxiv.org/abs/2306.14432
- Gain of Grain — https://doi.org/10.1145/3638036.3640805
- BVI-Texture — https://data.bris.ac.uk/data/dataset/1if54ya4xpph81fbo1gkpk5kk4 [live]
- BVI-CC — https://www.frontiersin.org/journals/signal-processing/articles/10.3389/frsip.2022.874200/full
---

## ROUND 2 — ADVERSARIAL VERIFICATION (2026-08-19)

Verifier: independent round-2 check. Method: every live-library number recomputed from
`/tmp/opencode/probe-dataset-now.json` (885 movies + 146 seasons, fresh); every dataset
fact re-checked against primary sources live today (dataset pages fetched, the BVI-HD
instructions + subjective-data zips actually downloaded and read, IEEE/Bristol PDFs
attempted); the §4 negative claim attacked with fresh searches (CVQAD successors,
grain-inclusive datasets, 2024-2026 releases). Original text above left untouched.

### R2.1 Live-library numbers quoted in §5 — [VERIFIED]

Recomputed from the dataset JSON: 885 movies; 831 h264 / 52 hevc (+2 mpeg4, unmentioned);
median srcBitrate 2.249 Mb/s (= "2.25"); median BPP+ 60 (min 30 / p10 46 / p25 51 /
p75 75 / p90 99 / max 231 — matches BPP-PLUS §7 exactly); median R 0.594 (= "0.59");
`headroomLive` 0.5736 (= "the same 0.57"). Two binning-dependent figures are soft:
"37% on a ~2.1 Mb/s preset" (BPP-PLUS §7.2 says 38%, 335 films — same data, different
bin edges; fine) and "**52%** on three presets total", which undershoots §7.2's own
56% (492 films) measured the same day from the same file. [REVISED, minor: read 56%
or cite §7.2.] Nothing else in §5 drifts.

### R2.2 BVI-HD (§2.1) — structure [VERIFIED]; two facts [REVISED]; one open question [ANSWERED]

[VERIFIED] against the live homepage (fan-aaron-zhang.github.io/BVI-HD/) and the
University of Bristol repository record: 32 references + 384 distorted; 12 distortions
(HEVC + HEVC-SYNTH); five low-level features optimised for coverage/uniformity; 86
subjects; double-stimulus methodology; IEEE TMM 20(10):2620-2630, 2018; DOI
10.1109/tmm.2018.2817070 correct; download gated only by a free CDVL personal account
(cdvl.org view-file id=2955); subjective data + instructions available as direct zips
from the Bristol vilab page (no gate). 1080p25/5 s is right — note one 2026 arXiv paper
mislabels BVI-HD "1080p, 50-120 fps" (conflating BVI-HFR); do not "correct" the report
from secondary citations.

[REVISED] **Content provenance.** §2.1 says the 131-candidate pool is "the standard
broadcast test material pool — Xiph/deƒ/VQEG/SVT". The official README (downloaded,
read) says the 32 sources were "**either captured by Bristol Vision Institute or
selected from the VQEG HDTV Phase I database**, and are truncated from their original
length." No Xiph/SVT mention. Immaterial to the plan, but cite the README, not folklore.

[REVISED] **QP-ladder details are cited beyond what I could independently confirm.**
The abstract confirms only: QP range determined by a preliminary subjective study which
showed "a wider range of QP values should be used than the current recommendation".
The specific claims — QPs 22/27/32/37/42/47, SYNTH at QP 27/42 × 3 synthesis thresholds,
DMOS < 10 at QP 22, 75%-correct-detection ≈ QP 36 — match the literature's description
of this paper but the paper text was unreachable today (IEEE "open access" PDF serves a
15 KB stub; Bristol repository 403s). They are consistent with everything published
about BVI-HD, but Phase 1's pre-registered rungs rest on them: **confirm from the
subjective-data zip (already downloadable, no gate) before registering the success
criteria.** The .mat is 5 KB — trivially checkable.

[ANSWERED] **Open question 1 (delivery format).** The instructions zip answers it:
all clips ship as **losslessly compressed .mp4** in three folders (`ORIG/`, `HEVC/`,
`SYNTH/`), to be decoded to 4:2:0 YUV with ffmpeg (a `decompress.m` script is
included). Consequences, all favourable: (a) the distorted streams survive intact, so
the bpp numerator measures the actual encode — the SYNTH bitrate saving is real and
probeable; (b) no unknown-generation recompression confound; (c) sizes are those of
lossless-of-a-lossy-stream MP4s — the §2.1 estimate "384 clips ≈ 1-3 GB" stays
plausible but is still UNTESTED until the CDVL download. License note worth having in
the plan: README grants **research use only**, property of the University of Bristol;
credit both CDVL and Bristol.

### R2.3 MSU CVQAD (§2.2) — one claim [FALSIFIED], one [REVISED], rest [VERIFIED]

[FALSIFIED] **"Videos currently unreachable / parked on access."** The calypso.gml-team.ru:5001
server being dead is confirmed irrelevant, because the dataset page now offers TWO live
routes the report missed: (1) a **HuggingFace mirror** —
https://huggingface.co/datasets/deepfakesMSU/CVQAD — linked directly from
videoprocessing.ai/datasets/cvqad.html ("You can download the dataset from HuggingFace"),
and (2) a request form that emails a download link ("within a few hours" per QUALINET).
The §2.2 verdict "second in the ordering; parked on access" and open question 2 are
STALE. CVQAD moves from parked to **actionable now**, and as the only cross-codec ladder
at our exact bitrates it should be promoted alongside BVI-HD in Phase 3 (or earlier).

[REVISED] **"~22 encoder variants across 7 standards — AVC, HEVC, AV1, VP9, VVC,
LCEVC, …".** Wrong on standards: CVQAD spans **five** — AVC, HEVC, VVC, AV1, VP9
(dataset page and QUALINET agree; the NeurIPS paper enumerates 11 HEVC + 5 AV1 + 2 AVC
+ 4 other-standard encoders = the "~22" figure, which stands). **No LCEVC anywhere in
CVQAD** — LCEVC appears in MSU's separate codec-comparison reports; it was probably
dragged in from there. The dataset page's own headline is "32 different video codecs
(including different encoding settings)" — both numbers are defensible, say which is which.

[VERIFIED] 36 FullHD sources clustered from >18,000 Vimeo videos (CC BY/CC0, ≥20 Mb/s,
avg 130 Mb/s) by space-time-complexity K-means; three target bitrates 1,000/2,000/4,000
kbps VBR; open part 1,022 streams, hidden 60%; pairwise crowdsourcing via Subjectify.us,
Bradley-Terry, pairs only within one source (+preset); 766,362 valid answers from nearly
11,000 participants; ≥10 votes/pair with verification questions; scores CSV +
categories + correlation notebook free on GitHub (repo live). Two small corrections to
carry: the source pool is **Vimeo-only** — "xiph/YouTube-UGC" entered at the 2025
successor (below), not CVQAD; and the "10 s each" duration appears nowhere in the
primary pages I could fetch (likely right, but tag it UNTESTED). License: CC BY
(QUALINET). Bonus fact strengthening §3.2 trap 3: QUALINET lists the content classes as
including "**grain / noisy**" — see R2.7.

### R2.4 Netflix public (§2.3) — [VERIFIED]

datasets.md is live and says exactly what the report says: `NFLX_dataset_public.py`
plus YUV420P videos on Google Drive, "**please request for access and we will grant
it**"; filename `{content}_{expert score}_{height}_{bitrate Kbps}.yuv`; explicit note
that the expert score differs from the non-expert-panel MOS in the .py — the report's
dual-label description is exactly right. VQEG-HD3 route also confirmed live (single
~84 GB combined ZIP via CDVL advanced search, individual sequences gone). Content-list
and bitrate-range details come from the .py and match. No changes.

### R2.5 KonViD-1k (§2.5) — [VERIFIED]

mmsp-kn.de page live; 1,200 videos; 2.3 GB zip; 8 s each; YFCC100m/Flickr CC fair-sampled;
ACR single-stimulus MOS crowdsourced (CrowdFlower, gold-standard control); resolution
mix **exactly as claimed: 85% 1280×720, 9% 1920×1080** (paper: 12 resolutions total);
frame rates 24/25/30 = 27%/5%/68%. One number I could not pin in the primary text: "~50
ratings per clip" — the paper's pilot used 50 ACR scores/video to build gold questions;
per-video counts for the full 1,200 are higher/varies. Treat "narrow CIs required" as
the load-bearing part (it is) and drop the exact 50 unless confirmed from the meta-data
zip. The label-danger analysis (§2.5, §3.2 trap 3) stands unchanged.

### R2.6 LIVE-VQC and YouTube-UGC (§2.4, §2.6) — [VERIFIED as described / one sub-claim UNTESTED]

LIVE-VQC: 585 in-the-wild videos, 101 devices, 80 users, ~205K ratings, MOS, free form
— consistent with the canonical TIP 2019 paper (page not re-fetched today; nothing
suggests drift). YouTube-UGC: 1,500 × 20 s, 15 categories, 360p-4K, RAW ≈2 TB /
H.264-CRF10 ≈110 GB / VP9 G/S/V ≈20 GB — all standard, matches media.withyoutube.com.
The "(d) 2024 release adds 33 compression variants … ordinal labels only" sub-claim I
could not confirm in this pass — it is the least-cited corner of that dataset; mark it
UNTESTED and verify on the dataset page before relying on it (the DMOS-for-G/S/V half,
which the plan actually uses, is solid).

### R2.7 The negative claim, §4: "no public SDR-1080p dataset combines film grain with compression scores" — [SURVIVES adversarial search; wording must narrow]

Falsification attempts, round 2: searched CVQAD successors, 2024-2026 releases,
grain/texture datasets, compression-MOS datasets. Results:

- **LEHA-CVQAD (ACM MM 2025, arXiv 2507.03990)** — the report missed this and it
  matters as a *CVQAD replacement/superset*: 6,240 clips, 59 FullHD sources (Vimeo +
  Xiph + YouTube-UGC), 186 codec-preset variants, 3 bitrates, ≈1.8M pairwise comparisons
  fused with ≈1.5k absolute MOS into one scale (BT + Elo), open part downloadable
  (HuggingFace / gml-team sharing link), plus an RDAE metric for bitrate-quality
  ordering. Sources are still clean digital capture — **it does not break the negative
  claim**, but it supersedes §2.2's "ask for a rehost" path: if CVQAD feels thin, go
  straight to LEHA-CVQAD. Same within-source pairing design, so same label safety.
- **CVQAD's own content classes include "grain / noisy"** (QUALINET description; also
  shaking, slow-motion, dark/bright). This is sensor/capture noise inside a few Vimeo
  sources, unlabelled as a dimension, mixed into authentic-distortion UGC — it does not
  provide a grain axis and does not falsify the claim, but it means the claim's wording
  must say **photochemical/scanned film grain**, not just "grain": a hostile reader can
  otherwise point at CVQAD and cry falsified.
- Checked and rejected as falsifiers: KVQ and TaoLive (authentic distortions, too few
  ratings per clip per the LEHA paper itself), double-compression forensics (binary
  labels, §2.9 already correct), BVI-Texture/SynTex/CC (texture ≠ film grain, gated),
  HDR/4K grain studies (§2.10 already correctly scoped), Gain-of-Grain (no public
  graded-MOS release, as stated).

Verdict: the negative claim **stands after a second, harder attempt to kill it** — no
public SDR-1080p dataset pairs photochemical film grain with graded compression-quality
labels. Upgrade its evidence status: it now rests on two independent survey passes, not
one. Keep the narrowed wording and keep asking the BVI group (open question 5) — they
remain the likeliest holders of an unpublished grainy-SDR-with-scores set.

### R2.8 Internal consistency of the calibration logic (§3) — [VERIFIED with one material caveat the report under-weights]

The four-layer decomposition (rank / anchor / band spread / exponent) and the eight
validity traps are sound; traps 2, 3, 5 correctly generalise the §11.1 retraction, and
trap 4 (no "master = ∞") is right. Library arithmetic in §3.1(B) checks out: if the
near-transparent rung reads 130, (100/130)² = 0.59 ≈ headroomLive 0.5736. **The caveat:
the QP22-anchor test silently equates two different encoders' "transparent".** The probe
measures CRF-20 **x265 (2026-era)**; BVI-HD's near-transparent rung is QP 22 **HM14
(2013 reference software)**. HM14 is substantially less efficient than current x265 —
a QP22-HM14 stream typically costs *more* bits than a CRF-20 x265 encode of the same
content — so the QP22 rung should be expected to read **above 100 even if
HEADROOM_TARGET = 1.0 is perfectly calibrated**, by an encoder-generation offset, and
the §6 Phase-1 success window "QP22 lands in 90-115" is biased to fail high for reasons
that have nothing to do with headroom. Adopting (100/reading)² on a high reading would
absorb an x265-vs-HM14 efficiency delta into the anchor. Trap 8 and open question 6
gesture at this but the pre-registered criteria do not implement it. Fix inside the
existing protocol, cheaply: before touching HEADROOM_TARGET, decompose the rung reading
on the **bitrate axis** — the per-content ratio (QP22-rung bitrate)/(probed CRF-20
bitrate) estimates the encoder offset directly, and only the residual after removing
it is evidence about headroom. Alternatively anchor at the labelled
crossing-of-transparency rather than at fixed QP22. Note also the live correction
behaves sanely across a dataset ladder (biasFactor decays toward its floor as R grows,
so healthy high-bitrate rungs are scored essentially uncorrected) — no change needed
there. Same logic, weaker form, applies to Netflix-top-rung and YouTube-CRF10 anchors:
each carries its own encoder offset; never average offsets into the constant.

### R2.9 New errors / overclaims found in round 2 (beyond the above)

1. §2.0 table row "MSU CVQAD … 7 standards … LCEVC" — false (R2.3). Table row "Netflix
   public … H.264-ish ladder" — vague but harmless; the public set is AVC-era encodes.
2. §2.2 "may be possible to reconstruct refs from Vimeo/Xiph/UGC links" — overstated
   for CVQAD (Vimeo-only pool, and the exact 10-s trimmed segments matter); moot anyway
   since the streams themselves are now downloadable (R2.3).
3. §1 executive summary "Start the CDVL registration today; it is the rate-limit of the
   whole plan" — now HALF-WRONG: the subjective data, instructions and README are
   ungated direct downloads (so rung identities, DMOS values and delivery format are
   verifiable TODAY without any account); only the video bulk needs CDVL. Re-order
   Phase 0 accordingly.
4. §2.1 "the uncompressed refs ≈ 390 MB each × 32 ≈ 12.5 GB" — refs ship in the SAME
   losslessly-compressed MP4 container as everything else (README folder layout), so
   "uncompressed" is wrong as stated; size still unknown. Cosmetic.
5. Open question 1 — answered (R2.2); open question 2 — answered (R2.3). Questions 3-6
   remain open as written.

### R2.10 Bottom line

The report's decision survives verification: **BVI-HD first, cross-checked on Netflix
public, CVQAD/LEHA-CVQAD as the codec-agnostic ladder, absolute-MOS sets never
headline.** Four corrections must land in any executed plan: (1) CVQAD is obtainable
now — HuggingFace mirror + email form — and LEHA-CVQAD (2025) is the bigger successor;
(2) CVQAD is 5 standards, no LCEVC, Vimeo-only sources; (3) BVI-HD sources are
BVI-captured + VQEG HDTV Phase I, delivered as lossless MP4 (research-use licence),
and the specific QP/DMOS rung numbers should be confirmed from the ungated subjective
zip before pre-registering; (4) the QP22↔CRF-20 encoder-offset caveat must be built
into the Phase-1 success criteria (decompose on the bitrate axis before adopting any
HEADROOM_TARGET change). The grain negative-claim holds, with wording narrowed to
photochemical film grain and LEHA-CVQAD added to the surveyed-and-rejected list.
