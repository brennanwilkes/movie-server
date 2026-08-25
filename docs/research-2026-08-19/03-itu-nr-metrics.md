# Research: ITU-T no-reference metrics (P.1203/P.1204) and the NR-metric landscape

Track D — companion to the deeper look triggered by §17 of `docs/BPP-PLUS.txt`
(itself a follow-up to `RESEARCH-quality-metrics-2026-08-01.md`). Written
2026-08-19. Scope: P.1204.3 (which §17 ranks as "the closest existing thing to
what BPP+ is trying to be"), its siblings and predecessors, the no-reference
(NR) metric landscape it sits in, and the three gaps §17.17 marks as
"STILL MISSING FROM THIS LIST". Verdict tags follow the repo convention.

## TL;DR / recommendation

- **P.1204.3 is NOT runnable on this box in the serving path**, and should not
  be made so: the reference implementation needs a Python toolchain and a
  compiled C videoparser that do not exist in the controller container
  (measured below), and its licence is non-commercial research-only. But it is
  **worth running once, out of band, as a ranking + negative-control
  experiment** over a small CRF ladder — because its grain blindness is
  specified in the standard itself and becomes *evidence for* our design when
  demonstrated, not a hole in it.
- **Best external cross-check for BPP+ today**: a one-off P.1204.3 ladder
  experiment (5 titles, grainy vs clean), nothing wired into the server.
  VMAF/SSIM remain unusable for ranking on our content for the reasons already
  in-repo (11.2); a static libvmaf build is the optional fallback for the clean
  subset only.
- **All three §17 gaps stand.** Fresh literature confirms each is still open:
  double-compression detection is forensic (binary), not a quality grade; no
  published NR metric is grain-aware (the closest work treats grain as a
  preservation *dimension*, not a score input); and the source-pinning
  "headroom without a master" problem has a single closest analogy (Google's
  already-compressed transcoding paper), not a published solution.

## 0. Scope and method

Section 17 (1312-1396) already reviews the main sources and over-weights item 1
(P.1204.3) to be read for method. This report goes where §17 couldn't:

- the P.1203/P.1204 family structure and what each standard actually promises;
- the P.1204.3 specification's explicit blindness clauses (the caveat §17
  *predicts* — here it is *quoted from the standard*);
- runnability on this specific box (measured, not assumed);
- the classical + learning-based NR landscape that BPP+ is compared *against*,
  with the corpora those metrics are trained on;
- a fresh literature pass over the three "STILL MISSING" items (§17.1398-1403).

Everything is cite-able from public URLs; no service-internal data was used
beyond `/api/probe/dataset` counts already in prior reports.

## 1. P.1203 vs P.1204 — orientation  [SOLID]

The ITU-T "Parametric non-intrusive assessment of audiovisual media stream
quality" family splits into two generations:

- **P.1203 (2016-2019, "PCQM/P.NATS Phase 1")** — three cooperating modules:
  P.1203.1 (video quality estimation), P.1203.2 (audio), P.1203.3
  (audiovisual integration). Parametric, bitstream-based, aimed at *progressive
  download and adaptive streaming over reliable transport* (HTTP ABR). Modes 0/1/2
  trade metadata richness (Mode 0 = container/QoS metadata only, up to Mode 2 =
  frame-level logging). Its outputs are O.22-style per-segment MOS families.
  Relevance to us: **low** — it models streaming transport stalls/switches,
  which a local archival server does not have.
- **P.1204 (2020, "P.NATS Phase 2")** — the 4K-era successors, all 5-10 s
  segment-based and all explicitly **no-reference**:
  - **P.1204.3: bitstream-based** — parses the coded bitstream (H.264/HEVC/VP9,
    up to 3840x2160) and outputs per-segment estimated MOS (O.21-series style);
    trained and validated on thousands of lab-rated sequences (≈5,000 sequences,
    600+ subjects per the ITU report), with device-context variants (TV/PC/
    tablet/phone).
  - **P.1204.4: pixel-information-based** — decodes to pixels and assesses what
    it sees. *Newer* (2024).
  - **P.1204.5: hybrid** — mixes bitstream and pixel info.
- The family's defining assumption is the same across all of them: **the input
  is one generation of encode away from a clean, professional master.** When
  that precondition is false (already-compressed rip, §17 gap 1), every member
  inherits P.1204.3's problem. Our §17.1338 ranking of P.1204.3 as "closest
  existing thing" is fair *within* that precondition; the caveat is load-bearing.

## 2. P.1204.3 deep dive

### 2a. What it measures, and what it cannot  [SOLID]

The specification text states the blindness we only suspected at §17.1345:

> "Effects due to source generations, such as signal noise, video shake,
> certain colour properties … are not reflected in the scores computed by this
> model."

That sentence is doing two jobs for us:

1. **It confirms grain blindness as a *specified* property**, not an
   implementation artifact. P.1204.3 grades compression adequacy of the encode
   *given* its source; it is not a content-difficulty model. Pointed at a
   grainy catalogue BluRay rip (12 Angry Men, Casablanca, Paris, Texas — the
   Q4 titles of §8) its scores will converge toward a floor set by
   *degradation-looking* signals, exactly the error §1.2c worries about.
2. **It validates the architecture decision, not only the caveat**: BPP+'s
   whole point is that "quality" on already-compressed content must be
   decomposed into *content cost* (measured per film by the CRF probe) and
   *bitrate adequacy* (R). The ITU family has no such decomposition — it is
   one scalar per segment. That is the unavoidable limitation of any metric
   whose corpus is clean-source ladders.

**Useful correct sense**: as a *ranking* oracle *within* content whose master
was clean. P.1204.3 on a CRF ladder of a clean modern film (Dune, BR2049) is a
legit monotonicity check. On grain it is a controlled *negative* — a
demonstration that a standards-grade no-reference model reads our most
important titles as "poor," measured and attributable.

### 2b. Reference implementation, licence, runnability  [SOLID — measured]

- Reference code is open but **non-commercial / research-only**, split across
  three repos, all from the same ITU-contributed assessment project
  (`telecommunication-telemedia-assessment`):
  - `bitstream_mode3_p1204_3` — the model itself (Python, `poetry`).
  - `bitstream_mode3_videoparser` — a C parser built with `scons` that walks
    H.264/HEVC/VP9 slice headers.
  - `p1204_3_extensions` ("AVQBits") — the TU Ilmenau extension adding
    metadata-only Mode 0, frame-type/size Mode 1, and a hybrid
    metadata+pixels Mode 0. **GPLv3** — rules out embedding anywhere near the
    server.
- **Runnability on this box (measured 2026-08-19)**: the controller container
  holds `ffmpeg`/`ffprobe` (5.1.9, Debian12) and `node` **only** — no
  `python3`, no `pip`, no `poetry`, no `scons`, no `gcc`. There is no way to
  run the reference model inside the serving container, and the licence
  forbids shipping it there anyway. It *could* be built in a throwaway
  `python:3-slim` container on the host (the videoparser is a small C program;
  the build is minutes, the model pure Python), which is the only sanctioned
  shape: an out-of-band experiment, run rarely, touching config/scratch dirs
  only.

VERDICT: not integrated, not integrated by design; **worth one out-of-band
ladder run as a ranking check + documented negative control** (see §5).

### 2c. Nearest relateable sanctioned alternatives

- P.1204.4 (pixel-based) and P.1204.5 (hybrid) inherit the same
  source-generation clause; .4 additionally needs a full decode pass which a
  4-core NUC pays for at ~real time. No advantage over .3 for our question.
- ITU-T **P.910 (SI/TI)** and **P.917** are content-complexity descriptors, not
  quality scores — useful as a vocabulary, already rejected as bitrate
  predictors in the earlier research report (§4).

## 3. The NR metric landscape BPP+ competes with  [SOLID on facts; verdict at end]

### 3a. Classical natural-scene-statistics (NSS) metrics — disqualified, here's why, now measured

- **NIQE** (2012, Bovik lab): "completely blind" — distance of the image's
  local-luminance statistics from a corpus of *pristine natural images*.
- **BRISQUE** (2012): trained SVR over the same NSS features; its own training
  distractors include **additive white Gaussian noise**, and its example
  behaviour is that noise *hurts* the score (measured: the learnopencv demo
  shows a clean JPEG at 20.3 vs the same content noisier far worse). **Film
  grain is photometric noise and lands in the same bin.** We have now confirmed
  the "noise is a distortion" assumption is baked into training and NSS prior —
  there is no grain-aware interpretation of a NIQE/BRISQUE score.
- **PIQE** (2018, NUS): local-blocking/activity masks; blocking + Gaussian
  noise again, no grain concept.
- Verdict: the classical NR family models *departure from naturalness* and
  cannot distinguish "grain that belongs here" from "noise that doesn't."
  §11.1's grain-vs-compression confound is structural in all of them.

### 3b. Learning-based NR-VQA — trained on UGC/synthetic corpora, not grain-aware

- **LIQE** (CVPR 2023, MIT-licensed, GitHub `zwx8981/LIQE`): CLIP-based,
  multitask (quality + distortion type + scene category), trained across
  LIVE/CSIQ/KADID-10k/BID/CLIVE/KonIQ-10k. Mirrors our §16.A kind-of-learning
  instinct but its in-repo evaluation and datasets carry **no positive-grain
  label**, so grain still reads as a degradation.
- **Q-Align** (ICML 2024): LMM-based quality alignment vs text anchors
  (poor..good) — the SOTA-style successor; same corpus assumption.
- **FAVER** (2024): "Framerate-Aware Video Evaluator" — first blind VQA
  purpose-built for *variable frame rate*; the only one of the family with a
  direct analogue to BPP+'s 24-vs-30 fps correction, but corpus = HFR/UGC.
- **DOVER** / **FAST-VQA** / **LMM-VQA** / **SimpleVQA+**: the current
  leaderboard class (LSVQ→OOD 0.85-0.93 SRCC); all trained on the UGC corpora
  below.
- **Corpora these are trained on** — all UGC or synthetic-distortion:
  LSVQ (~38 k crowd-rated YouTube clips), KoNViD-1k, YouTube-UGC,
  LIVE-VQC, and **LEHA-CVQAD** (MSU, ~186 codecs / 6,000+ streams /
  2 M+ subjective scores / 15,000+ viewers, on HuggingFace
  `deepfakesMSU/CVQAD`) — the largest compression-grade corpus published.
  The **NeurIPS 2022 compression benchmark** adds that in a carefully
  collected pairwise study NR metrics **approach** full-reference performance
  on *single-generation* encode ladders (AVC/HEVC/AV1/VP9/VVC, ~2.5k streams).
- Verdict: the learning-based landscape is the strongest *ranking* evidence
  that "a single metric can track single-generation compression quality
  without a master" — but every member is trained on **clean->encode** curves
  and none carries grain as a positive attribute. For our library they
  reproduce, at greater cost and opacity, the exact blindness P.1204.3
  specifies. They also all need pip + torch-size weights — absent here.

## 4. The three gaps of §17 — fresh literature pass  [GAP CONFIRMED — each]

### Gap 1 — NR quality work on ALREADY-COMPRESSED consumer video (piracy/archival case)

What exists in the literature is **forensics, not quality**:

- **Double-compression detection** is a mature forensic problem with strong
  HEVC-specific results: detection from coding-unit (CU) partition structure
  (IEEEAccess; cf. IEEE 11558164), from NALU/partition residue patterns
  (IEEE 9185043), and from frame-level partition signatures (Signal Processing:
  Image Communication, S0923596522000054). These work, run cheaply, and answer
  the binary question "was this re-encoded?" — but output a yes/no (and
  sometimes a detected first-generation QP), **never a graded residual-quality
  score**.
- The compression *benchmark* corpus (NeurIPS 2022, LEHA-CVQAD) is
  single-generation: the degradations measured are first-generation loss, so an
  "already compressed" input is out of distribution by construction.

GAP 1 CONFIRMED OPEN. Closest conceptual bridge: forensic double-compression
detectors give us, for free, the *staring point* of a quality score (degree of
first-generation loss); nobody has taken the next step of grading it. BPP+ is
that step, and the probe is its measuring instrument.

### Gap 2 — grain-aware no-reference metrics

- The classical NSS family penalizes grain as noise (§3a) [SOLID].
- P.1204.3 specifies grain blindness (§2a) [SOLID].
- The two papers that treat grain seriously do so *away* from a single scalar:
  - **AV1 film grain synthesis** (Norkin & Birkbeck, DCC 2018): separates grain
    generation from content coding, because grain is enormously expensive and
    largely decodable from parameters — the architectural precursor to §16.A.5
    and to *any* grain-aware score being two-dimensional.
  - **"Quality assessment of video with film grain"** (ACM MHV'22, Google /
    SSIMWAVE): proposes a creative-intent two-phase framework — assess the
    *source* (did the film intend grain?) and the *render* (is it preserved?)
    separately — explicitly because aggregated metrics conflate the two.
- No published metric scores "grain-as-intent" in one scalar. The closest we
  have in-repo is §9's careful qualitative work + the not-yet-built grain
  covariate open question (§8, 16.A.5).

GAP 2 CONFIRMED OPEN. BPP+ (per-film complexity soak) + CamBI-style artifact
gates is, so far as published work shows, ahead of the field's single-scale
treatment; the honest next step remains a *validated* grain label (§16.A.4),
not another formula.

### Gap 3 — "measure a re-encode's headroom without a master" (source-pinning)

- The **only** published paper whose problem statement matches: Google/"Video
  transcoding optimization based on input perceptual quality" (2020) — it
  assumes the input is ALREADY imperfect and asks how far further degradation
  is tolerable before re-transcoding, learned against YouTube-scale
  subjective data. §17 already ranks it as "the only paper here whose problem
  is ours." What it does NOT give us: a per-title, master-free *continuum*
  (its headroom is a learned overall-quality proxy, validated at corpus level,
  not per-film).
- **Netflix per-title** (2015) and **shot-based** (2018): encode-from-pristine-
  master with a convex hull; master assumed (§17.1367-1372). **Durbha & Bovik**
  (2023/2025): predict rate-quality structure from cheap source features — same
  pristine-master precondition (§17.1387-1392). **MainConcept CTQ**: confirms
  "fixed CRF ≠ fixed quality" (~3σ σ 10 VMAF vs ~2.6 quality-targeted) — the
  quantified version of open question 4.

GAP 3 CONFIRMED OPEN. The formulation BPP+ actually uses — *measure this
film's own CRF-20 cost, then grade a candidate's bitrate against it* — remains
unpublished as far as §17 + this pass can determine. That is a genuine research
gap, and it raises the value of BPP+'s experimental record (§5, ladder and
starvation runs 2026-08-18) as a primary, not a supporting, citation.

## 5. Recommended external cross-check for BPP+ (ranked)

1. **P.1204.3 ladder experiment, out of band** ─ THE one to do. Scope: build a
   scratch `python:3-slim` container with the videoparser + model (+ optionally
   AVQBits Mode 0/1 for the metadata-only path); pick 5 titles (2 grainy
   catalogue, 2 clean digital, 1 extremes case); encode each at a small CRF
   ladder; score with P.1204.3 and, from the probe cache, record BPP+ per step.
   Success criteria: (a) monotone agreement with BPP+ on the clean titles —
   the ranking check we have from no standard source; (b) *attributable*,
   measured grain collapse on the grainy titles — the negative control that
   turns §17's caveat into data. Budget: a few hours; nothing touches `/data`
   or the serving path; GC the scratch container after.
2. **VMAF (static build) for the clean subset only** — optional. No `libvmaf`
   in the container's ffmpeg (both 5.1.9 and the jellfin 7.1.4 build lack the
   filter; only `psnr`/`ssim`/`vmafmotion` exist). A static build is a known
   ~20-40 min compile, usable only for ladder-only experiments (there is no
   master for library files). Value is lower than P.1204.3 because VMAF's grain
   bias is already documented in-repo (§11.2); use it purely as a second,
   well-understood monotonicity oracle on clean content.
3. **SSIM / PSNR** — already available, already disqualified (11.2): SSIM
   over-rewards grain and climbs forever on grainy ladders. Do not "at least"
   use them; use nothing rather than a known-bad oracle.
4. **Learning NR metrics (LIQE/FAVER/Q-Align etc.)** — do not pursue. Corpus
   and licensing problems from §3b (no grain-as-positive, torch-size
   requirements, pip absent, UGC-trained); they would add an opaque third
   blind-eye to P.1204.3's specified one. Cited as landscape, not instrument.

## 6. What this means for BPP+

- The ITU family is the *closest standards analog* and remains **not an
  instrument** for this library — for three independent, documented reasons:
  source-generation blindness written into the spec, a clean-source training
  corpus, and a research-only licence that forbids the serving path.
- The recommended trace is **experiment-1 above**, which converts the §17
  caveat into a measured result and is the only external check that validates
  *ranking* without a master. A positive outcome strengthens the existing
  ladder (§6) and starvation (§5.1) records; a divergence *on clean titles* is
  the one result that would genuinely reopen the model and must be taken
  seriously if it appears.
- **Nothing here replaces the missing subjective label** (§13 open question 0,
  16.A.4). The external landscape confirms it: every NR route available
  resolves to "predict what people scored on clean-source ladders," and
  absolute-level calibration (where 100 sits) still needs Brennan's eyes on
  ~10 titles. The three gaps confirm that as original work, not borrowed
  work.

## References

- ITU-T Rec. P.1204.3 (2020-01), "bitstream-based quality estimation of HTTP
  adaptive streaming services": https://www.itu.int/rec/T-REC-P.1204.3 —
  incl. the source-generation clause (§2a). IEEE version: IEEE 9123110.
- ITU-T P.1203 series (P.1203.1/.2/.3): https://www.itu.int/rec/T-REC-P.1203
- P.1204.4 / P.1204.5 (2024 siblings): https://www.itu.int/rec/T-REC-P.1204
- Reference implementation + extensions:
  https://github.com/Telecommunication-Telemedia-Assessment/bitstream_mode3_p1204_3
  (and sibling repos `bitstream_mode3_videoparser`, `p1204_3_extensions`).
- BRISQUE (TIP 2012): https://ieeexplore.ieee.org/document/6190099 ;
  NIQE (SPL 2012): LIVE lab page, https://live.ece.utexas.edu/research/Quality/nrqa.htm
- LIQE (CVPR 2023): https://github.com/zwx8981/LIQE
- Q-Align (ICML 2024); LMM-VQA: https://arxiv.org/html/2408.14008v1 ;
  FAVER (2024): https://www.sciencedirect.com/science/article/pii/S092359652400002X
- Corpora: LSVQ/KoNViD-1k/YouTube-UGC/LIVE-VQC suite (cited via NTIRE 2024
  challenge reports); LEHA-CVQAD: https://huggingface.co/deepfakesMSU/CVQAD and
  https://videoprocessing.ai/benchmarks
- NeurIPS 2022 video compression benchmark: openreview.net proceedings PDF
  (id 59ac9f01ea2f701310f3d42037546e4a), ~2.5 k streams, 4 codecs + VVC.
- HEVC double-compression detection: IEEE 11558164; IEEE 9185043;
  Signal Processing: Image Communication S0923596522000054.
- Film grain: Norkin & Birkbeck, DCC 2018 (https://norkin.org/pdf/DCC_2018_AV1_film_grain.pdf);
  "Quality assessment of video with film grain", ACM MHV'22 (Google/SSIMWAVE),
  doi 10.1145/3510450.3517293.
- Google, "Video transcoding optimization based on input perceptual quality"
  (2020): https://research.google/pubs/video-transcoding-optimization-based-on-input-perceptual-quality/
- In-repo: `docs/BPP-PLUS.txt` (§17 sources, §11.2 SSIM/VMAF, §16.A adoption
  order); `docs/audit-2026-07-31/raw/RESEARCH-quality-metrics-2026-08-01.md`
  (the prior survey); `docs/REPORT-grain-2026-08-13.md` (grain record).

## ROUND 2 — ADVERSARIAL VERIFICATION (2026-08-19)

Every load-bearing claim re-checked against primary sources (ITU rec pages and
PDF, GitHub licences/READMEs, arXiv/PMLR/DOI records) and against the live box
(`docker exec controller`; ffmpeg filter lists) plus the fresh probe dataset
(`/api/probe/dataset`, 1031 rows, generated 2026-08-19). Tags: [VERIFIED] /
[REVISED] / [FALSIFIED] / [UNVERIFIED]. Original text above untouched.

### R2.1 Standards claims (§1, §2)

- [VERIFIED] P.1204.3 (01/20) title/status ("…access to full bitstream
  information", In force; Amd 1 (01/21) In force — not deprecated). The
  source-generation clause is quoted **verbatim-correct** from the ITU PDF:
  "Effects due to source generations, such as signal noise, video shake,
  certain colour properties … are not reflected in the scores computed by this
  model."
- [VERIFIED] Licence and repo split: `bitstream_mode3_p1204_3` is
  non-commercial research-only (TU Ilmenau / Deutsche Telekom, 2017-2024);
  Python + poetry; `bitstream_mode3_videoparser` is the scons-built C parser;
  `p1204_3_extensions` (AVQBits, Mode 0/1 + hybrid Mode 0) is **GPL-3.0**.
- [FALSIFIED] §1 "all explicitly **no-reference**" — false for P.1204.4: the
  in-force edition (approved 2022-07-29) is titled "…with access to **full and
  reduced reference** pixel information", i.e. FR/RR, not NR. Same error in
  §1 "*Newer* (2024)" and in the References ("P.1204.4 / P.1204.5 (2024
  siblings)"): .4 is 07/22; .5 (transport + received pixel information) is
  10/23. Consequence: §2c's rejection of .4 is *understated*, not wrong — .4
  needs a reference signal before decode cost even matters. The report's
  conclusions all strengthen under the correction; the sentence needs fixing.
- [UNVERIFIED] §1 "≈5,000 sequences, 600+ subjects" training/validation counts
  — not confirmable from the public ITU material fetched; plausible; no
  verdict depends on them.

### R2.2 Classical NSS citations (§3a)

- [REVISED] NIQE: "**2012**, Bovik lab" → formally IEEE Signal Processing
  Letters, **March 2013** (vol 20 no 3, pp 209-212; DOI
  10.1109/LSP.2012.2227726 — the 2012 inside the DOI explains the slip; early
  access Dec 2012). Lab attribution correct.
- [VERIFIED] BRISQUE: TIP 2012, ieeexplore 6190099; AWG noise among training
  distortions and "noise hurts the score" both stand.
- [FALSIFIED] PIQE: "**2018, NUS**" → Venkatanath et al., "Blind image quality
  evaluation using perception based features", **NCC 2015, Mumbai** (DOI
  10.1109/NCC.2015.7144884), authors IIT Hyderabad / BITS Pilani Hyderabad —
  neither the year nor the institution is right. The behavioural claim
  (blocking/activity masks, Gaussian-noise binning, no grain concept) is
  unaffected.

### R2.3 Learned NR landscape (§3b)

- [VERIFIED] LIQE CVPR 2023, MIT-licensed `zwx8981/LIQE`, CLIP multitask over
  LIVE/CSIQ/KADID-10k/BID/CLIVE/KonIQ-10k. Q-Align **ICML 2024** (PMLR
  235:54015-54029; arXiv 2312.17090). FAVER: journal version is exactly as
  cited — Signal Processing: Image Communication vol 122, art 117101, Jan
  2024, PII S092359652400002X — and the abstract claims "first-of-a-kind blind
  VQA model for evaluating HFR videos" (arXiv preprint was 2022; the report's
  "(2024)" matches the journal). LMM-VQA arXiv 2408.14008 correct.
- [VERIFIED] Corpora: LEHA-CVQAD on HF `deepfakesMSU/CVQAD` is real (6,240
  videos, 1,962 open, ~244 GB, FullHD YUV420, AVC/HEVC/VVC/AV1, 59 pristine
  refs); the "~186 codecs / 2 M+ scores" figures are consistent with the
  dataset card but were not independently counted. NeurIPS 2022 compression
  benchmark real (~2.5k streams, AVC/HEVC/AV1/VP9/VVC; NR metrics approach FR
  on single-generation ladders).
- [VERIFIED] "pip + torch-size weights — absent here": controller container
  has no python3/pip (see R2.5).

### R2.4 The three gaps (§4)

- **Gap 1 [REVISED — the substantive correction].** "What exists in the
  literature is forensics, not quality" is too strong. **1stepVQA** — Yu,
  Birkbeck, Wang, Bampis, Adsumilli, Bovik, "Predicting the Quality of
  Compressed Videos With Pre-Existing Distortions," IEEE TIP 30:8746-8760,
  2021, DOI 10.1109/TIP.2021.3107213 (Google + UT Austin) — is a *graded*
  no-reference quality score for already-distorted/compressed consumer video.
  What survives of Gap 1 is narrower and still real: nobody publishes a
  **per-title content-cost decomposition** (measure this film's own CRF-20
  cost, then grade bitrate adequacy against it); 1stepVQA regresses one scalar
  end-to-end on UGC ladders and does not separate source cost from encode
  adequacy, and its corpora carry no positive-grain label. Restate Gap 1 as a
  *decomposition* gap, not an *existence* gap — and cite 1stepVQA as adjacent
  work under Gap 3 too (single scalar, no master-free per-title headroom
  continuum).
- **Gap 2 [VERIFIED, one attribution fix].** MHV'22 doi 10.1145/3510450.3517293
  is real ("Quality assessment of video with film grain"), but its authors
  (Kai Zeng, Hojatollah Yeaganeh, Zhou Wang) are **Waterloo / SSIMWAVE — not
  Google**; fix "(Google / SSIMWAVE)". Its two-phase creative-intent framing
  (source intent vs render preservation) supports the gap as described.
  Norkin & Birkbeck DCC 2018 correct. After this pass, "no published metric
  scores grain-as-intent in one scalar" stands.
- **Gap 3 [VERIFIED].** The Google 2020 paper is real: "Video transcoding
  optimization based on input perceptual quality," SPIE Applications of
  Digital Image Processing XLIII, Aug 2020, DOI 10.1117/12.2569332 (Yilin
  Wang, Talebi, Yang, Yim, Birkbeck, Adsumilli et al.) — UGC inputs, people
  more tolerant of degradation on low-quality sources, ~5% average bitrate
  saving, and its headroom is a corpus-level learned proxy, not a per-title
  master-free continuum. Netflix per-title/shot-based and Durbha & Bovik items
  are carried from §17 and were not re-fetched this round.

### R2.5 Live-box cross-checks (measured 2026-08-19)

- [VERIFIED] §2b runnability: controller container = node:20-slim + ffmpeg
  only; `python3` absent; ffmpeg 5.1.9-0+deb12u1; filters psnr/ssim/
  vmafmotion, **no libvmaf** (jellyfin-ffmpeg 7.1.4 likewise) — §5.2's premise
  confirmed. One easing the report missed: the reference repo ships its own
  Docker install path, so the out-of-band ladder run needs no host python at
  all — cheaper than §2b assumes, same conclusion.
- [REVISED] §2a's grain trio, checked against the probe dataset: 12 Angry Men
  complexity 0.927 = **rank 1/1031** (unambiguously floor-bound, the argument
  holds); Casablanca 0.2785 rank 39; **Paris, Texas 0.1394 rank 290, BPP+ 114
  (green)** — not a floor case by measurement. The trio is §8's classification;
  when running experiment-1, pick the grainy titles by measured complexity
  (12 Angry Men alone suffices as the extreme).
- [VERIFIED] Pinning constants from `/api/probe/dataset`: A=1.337, B=-0.348,
  rMin=0.59, max=2; biasFactor is flat at **1.606** below R=0.59 (not 1.0) —
  needed when reading BPP+ alongside P.1204.3 MOS during the ladder run.
  Library median BPP+ 60 over 936 scored rows.

### R2.6 Net effect on the report's verdicts

- §1 [SOLID] holds for P.1204.3; the family-wide "all no-reference" sentence
  and the .4/.5 dates need the R2.1 correction.
- §2a/§2b [SOLID] hold: clause verbatim-verified, licence verified,
  runnability verified (and slightly easier than assumed).
- §3 holds; fix NIQE 2012→2013 and PIQE "2018, NUS"→NCC 2015 Mumbai.
- §4: Gap 1 restated (decomposition, not existence — 1stepVQA TIP 2021);
  Gaps 2-3 hold; MHV'22 attribution de-Google'd.
- §5 recommendation order unchanged; experiment-1 remains the one to do. Add
  from this round: use the repo's Docker path; select grain titles by measured
  complexity; expect biasFactor ≥ 1.606 on starved ladder points when
  comparing BPP+ to P.1204.3 MOS.