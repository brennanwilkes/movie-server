# 05 — Grain and Contrast: What the Industry Actually Does With Film Grain in Quality Measurement

**Thought C, "deal with grain properly".** 2026-08-19. Companion to `BPP-PLUS.txt` §8.7, §9, §11, §16.A.5, §16.A.6, `HANDOFF-2026-08-17.md`, `REPORT-grain-2026-08-13.md`.

One claim up front, because everything else in this file argues around it:

> **Grain is the single hardest case for objective picture-quality metrics, and the industry's answer is not a smarter per-file score — it is (a) to spend more bits on grainy content when a transparent encode is the goal, and (b) to treat grain as a recognised *feature* that is *modelled and restored separately* from the video signal when bitrate must drop.** Every one of those choices is a deliberate policy decision, not something a metric discovers automatically.

---

## 1. Executive summary — the defensible position

**Grain is genuinely expensive, and BPP+ — through its measured per-film `complexity` denominator — already answers the grain question the way a transparent-encode (CRF-20) standard requires.** A grainy film has a high measured complexity, so reaching BPP+ 100 legitimately demands more bits — that is not a bias, it is the correct creative-intent-friendly outcome, and it is the same conclusion the delivery industry reaches when it spends more bitrate on grainy masters or synthesises the grain in-band (Section 3).

**The one place grain can still mislead is *confidence*, not *rank*** (Section 6, 7): a grainy film's measured complexity is a delicate number — its `blockMean`/`blurMean` error bars are large, its `spreadRatio` worse — and every naive *"how much of this file is grain"* quotient so far tried has collapsed into a brightness statistic (`gShare`, r = −0.885 vs mean luma) or into encoder-flavour noise (`-tune grain`). A `grainShare = 1 − complexity_denoised/complexity_raw` (`BPP-PLUS.txt` §16.A.5) is sound as a **descriptive diagnostic only**. It should never gate, bonus, or discount a score without a lab pass — the last two times a grain-derived term was wired into a score (`gShare`, `blockMean`∝`wBPP+`) it failed the only test that matters, Brennan's eyes.

**Darkness is a separate axis that BPP+ (bits) is structurally blind to — exactly as PSNR and VMAF are.** Netflix's CAMBI exists precisely because PSNR/VMAF have "very little correlation" with banding, and banding lives in dark/flat scenes (Section 5). Blockiness and banding are not proportional to bitrate; they are bit-depth and coefficient-quantization artifacts. Extra bits are necessary but not sufficient; the *useful* signal is a **gate beside the score** (design constraint 1.2d, open this round), not another score term.

**Position for Brennan:**
1. Keep the measured per-film `complexity` denominator. It is grain-aware by construction and ranks grainy films correctly as bit-hungry. **GRAIN-YES.**
2. Do **not** add a "grain bonus" term — a bonus re-introduces the PSNR-style error (rewarding grain-as-signal while ignoring that reproducing it *costs* bits) in reverse. The measured reality on this box strengthens that: all 26 complexity≥0.30 films sit at R ≤ 1.09, i.e., the grain films are the ones *under*-provisioned, not over-credited.
3. If a gate is wanted, make it "high complexity + low R" (this grainy title is far below its own transparency target) → an annotation/attention flag, the natural thing `R` and `cxBasis` already half-provide.
4. Treat darkness/banding as a second, independent axis — a future gate, not a term. CAMBI's source-relative `full_ref` mode is the industry reference for "dark by design, not crushed by us."
5. `grainShare` may ship as a diagnostics/annotation column (italic, like `estimated`), with the published caveats from Section 7.

---

## 2. How the industry handles grain (the authoritative picture)

The deliverable side has converged on one architecture, from Netflix's AV1 to VVC research: **separate the grain from the signal at encode, transmit a compact grain *model*, and let the decoder resynthesise the grain.** This is solved technology in production, and it encodes the industry's answer to "is grain a feature or a defect?": **feature that must be restored, but whose restoration is cheaper than its reproduction.**

- **Norkin & Birkbeck, "Film Grain Synthesis for AV1" (DCC 2018).** Netflix's own grain model: a diagonally-symmetric **autoregressive (AR) model** plus a **grain strength that is a function of intensity**. The encoder **denoises the source, encodes the denoised signal, and transmits the grain *model**, the decoder re-adds the grain. Predicts "up to ~50% bitrate savings" on heavy-grain content. *This is the production proof that "grain complexity" and "content complexity" are separable by analysis — which is precisely what `grainShare` assumes.*
  URL: https://norkin.org/pdf/DCC_2018_AV1_film_grain.pdf · IEEE: https://ieeexplore.ieee.org/document/8416572 · **[SOLID]**
- **Netflix Tech Blog, "AV1 @ Scale: Film Grain Synthesis, The Awakening" (July 2025).** Film-grain synthesis enabled at scale in July 2025 after a limited 2021 rollout. Confirms the two-part model: an AR model for the grain pattern + a strength-as-function-of-intensity — the same structure as the 2018 paper. Confirms the business reason: grain is cinema-expected, so it is synthesised rather than dropped.
  URL: https://entertainer.news/2025/07/02/av1-scale-film-grain-synthesis-the-awakening-by-netflix-technology-blog-jul-2025 (original 403s) · **[SOLID]**
- **An Overview of Coding Tools in AV1 (APSIPA).** FGS saves **up to 50% bitrate on heavy grain**; and — the load-bearing negative — **FGS is not used in objective (FR-metric) comparisons because the synthesised grain is only statistically, not geometrically, equal to the source grain** (so SSIM/PSNR/other pointwise metrics punish it even though viewers find it identical). This is one of the two cleanest published statements that *grain is a case the pointwise metrics get wrong by design* (the other is issue #1192, §4).
  URL: https://apsipa2022.org/ (paper: An Overview of Coding Tools in AV1) · **[SOLID]**
- **"Gain of Grain: A Film Grain Handling Toolchain for VVC (VVenC)" (arXiv 2024).** The VVC-era research follow-up: a dedicated grain-handling toolchain that balances *retaining cinematic grain* against compression efficiency and evaluates perceptual quality. Confirms grain handling is a first-class, separately-designed subsystem of modern codecs — not something the rate-distortion loop does "naturally."
  URL: https://arxiv.org/abs/2402.00622 · **[DIRECTION]**
- **x265 `--tune grain` internals** (official docs + Doom9 + Waggoner). The purpose is explicit: *"neither to retain nor eliminate grain, but prevent noticeable artifacts caused by uneven distribution of grain."* It sets `--aq-mode 0`, `--cutree 0`, `--ipratio 1.1`, `--pbratio 1.0`, `--qpstep 1`, `--sao 0`, `--psy-rd 4.0`, `--psy-rdoq 10.0`, `--recursion-skip 0`, plus `--rc-grain` (rate control that strictly minimises QP fluctuation across frames — overrides cause **grain strobing**). Ben Waggoner (Amazon Prime Video) notes the flag's numbers are famously stale (tuned pre-x265-2.0; `--psy-rdoq 50` "way overkill"; modern film practice is `--no-sao --deblock -1:-1 --aq-mode 1`). **Relevance:** even the encoder community treats "grain mode" as *artifact-avoidance* plus high-frequency retention — not as a *measurement* of grain, and not as "grain = bad". It also shows why `-tune grain` could never act as a provenance detector (`REPORT-grain-2026-08-13.md`): the flag influences encoder decisions only; it does not classify content.
  URLs: https://x265.readthedocs.io/en/master/presets.html · https://github.com/videolan/x265/blob/master/doc/reST/presets.rst · https://forum.doom9.org/showthread.php?p=1972383 · https://gist.github.com/dvaupel/9bb532715d5167239487bdc93bb1de2d · **[SOLID]**
- **Streaming ladders.** (No clean peer-reviewed capture this round beyond the above; Netflix's per-title optimisation content treats grain as a content-class that "needs more bitrate or synthesis" — consistent with, not contradicting, everything above.) **[UNTESTED]** — see open questions Q1.

**The takeaway for this Explorer:** when a delivery pipeline is allowed to spend bits (a transparent-encode goal — exactly what CRF-20/the BPP target means), it *spends them on the grain*; nobody discounts the need. When it cannot spend bits, it models the grain out and restores it. Both answer the same way BPP+'s denominator does: **grain earns its bits, because grain is screen content.**

---

## 3. Grain as feature vs grain as cost — evidence on both sides

### Grain as feature (creator intent)

- **SSIMWAVE / U. Waterloo, "Quality assessment of video with film grain" (MHV '22, paper #32).** The most on-point academic framing found this round. Film grain "originates from small metallic silver particles on processed photographic celluloid"; modern cameras can nearly eliminate it, **yet creators deliberately inject simulated grain in post to "emulate dust in the environment, enrich texture details, and develop a certain visual tone."** Heavy compression "may remove film grain, but meanwhile remove meaningful texture content … or deteriorate the artistic effect of the creator's intent." They then build a framework that **unifies natural-video QoE with creative-intent-friendly QoE** and instantiate it for grainy content, predicting how *different groups of subjects* (creative-intent-savvy vs naive) rate it. This is the industry's name for our `1.2d` problem: quality is not one scale; some grain loss is a fidelity error, some is a feature loss.
  URL: https://dl.acm.org/doi/10.1145/3510450.3517293 · **[SOLID]**
- **Netflix AV1 pipeline (Section 2):** synthesis preserves the *look* of grain at a fraction of the bits. Feature-preservation as policy.

### Grain as cost (bits are genuinely spent / entropy is real)

- **The APSIPA AV1 overview (Section 2):** up to 50% bitrate savings when grain is *not* encoded in-band — the cleanest industry statement that grain costs real bits and that "the same picture without the grain" is dramatically cheaper.
- **Our own engineering fact, restated:** `complexity` is published as "largely grain cost" for the films it measures (12 Angry Men, complexity 0.9270); the `bpp` scale is `srcBitrate/(width×height×fps)` — grain consumes the same bytes as any high-frequency detail.
- **Live library (this round, n=885):** complexity vs bppPlus Spearman **−0.334**; complexity vs R **−0.313**; cxEff vs bppPlus **−0.519**. The denominator shifts scores down as film grainstalls, exactly as a correct cost should. And the horizon is now *better* rather than *worse*: the 720p projector that hid grain is dead (2026-08-19); the 1080p replacement removes the ~44% downscale that made low-bpp copies look fine — so "grain films are under-provisioned" is about to become visible on the wall.

**Where the two must not be confused:** the "grain is a feature" argument does **not** license a score bonus. A feature that costs bits still costs bits; the correct handling is the *denominator* (that film is expensive to reproduce transparently) and, when bits cannot be spent, the *restore-from-model* pipeline — both of which keep the score's meaning ("compared with a transparent, photometrically-faithful encode of *this film*, is your file adequate?"), which is already the meaning `BPP+` has and the flat-vs-measured cutover delivered (`BPP-PLUS.txt` §8.7: Spearman +0.195 **flat** vs −0.574 **per-film** — the flat constant over-blessed low-grain clean digital and over-penalised grain).

---

## 4. Grain-aware measurement — what exists, and what failed here

### What the industry has (all FR/HR — they have the master; we never do)

- **Netflix/vmaf issue #1192 (closed 2023): "VMAF and AV1's film grain synthesis priority issue."** The recommendation, in the thread and on the AV1 list: **when computing objective metrics on grain-synthesised content, disable decode-time FGS** — because a pointwise metric sees the statistically-equivalent-but-geometrically-different resynthesised grain as noise/error. That is the industry's own admission that **no FR metric currently common in production is trustworthy on grain**. (And per `BPP-PLUS.txt` §11.2, Netflix lists film grain *first* among VMAF's unaddressed areas.)
  URL: https://github.com/Netflix/vmaf/issues/1192 · **[SOLID]**
- **SSIMWAVE MHV '22 (Section 3):** predicts perception of "different groups of subjects" — i.e. separates naive from creative-intent-savvy ratings. Not a deployable metric for us, but the only paper with the correct objective (two audiences).
- **BVI-HD (U. Bristol, IEEE TMM 2018):** 32 references × 12 distortions (HEVC + **HEVC-with-texture-synthesis**), 384 sequences, 86 subjects. Published finding: FR metrics "expose limitations … especially on synthesised content." **Seven/eight SOTA FR metrics lose rank on texture-synthesised content.** That is the closest peer-reviewed parallel to "the metric can't tell real-grain from resynth" and "synthesised texture is fine to the eye but failed by every pointwise metric." Its **BVI-SynTex** companion dataset (2020) extends it.
  URLs: https://ieeexplore.ieee.org/document/8322297 · https://ieeexplore.ieee.org/document/9016124 · **[SOLID]**
- **So, for us (no reference available, no decode-time hook):** FR grain-aware metrics are out of reach by construction. Whatever we do must be NR. NR options are CAMBI-family (Section 5), block/banding detectors, or a denoising-delta — which is exactly the `grainShare` proposal.

### What we tried and what happened (Brennan's eyes are the only AR-to-DMOS we have)

| Attempt | Verdict | Evidence |
|---|---|---|
| `-tune grain` as a provenance detector | **Failed.** "Does not measure grain." | `REPORT-grain-2026-08-13.md`: CGI *Up* gShare 0.407 ≈ *Casablanca* 0.422 ≈ *Alien* 0.421; verbatim false claim "grain = ECMA errors." Actual sealer: item 12. |
| `gShare` (grain-model share quotient) | **Falsified.** | r = **−0.885** vs mean luma — it measures brightness, not grain (`BPP-PLUS.txt` §11.3). A grain quotient with no intensity normalisation collapses into a brightness statistic. |
| `blockMean` (and derivative `wBPP+`) | **Killed.** | `HANDOFF-2026-08-17.md`: Spearman vs "algorithm" — src Mb/s **0.905**, complexity **0.824**, R 0.146, blurMean −0.266, **blockMean −0.090**. False positives at the 99th pct (Spirited Away), 97th (I Am Legend Inception); false negatives at 3rd/2nd/2nd pct (Star Wars, Jurassic Park, Taxi Driver). wBPP+ (×(1.33/blockMean)^0.40) is therefore **wrong and must not be resurrected.** |
| The blind test itself | **Retracted.** | `BPP-PLUS.txt` §11.1: the artefacts Brennan scored were *grain*; labels measured grain-visibility, not compression. So no valid subjective label exists anywhere on this box yet. **This is why every candidate and every response curve stays a hypothesis for rank/position** (open questions Q7). |

The pattern is consistent and it is the report's most important *methodological* finding: **any NR grain term that is a simple ratio of two scalars computed once per film is unstable, and the failure modes is bright-luma/dark-luma confounding.** The one thing that survived scrutiny was not a grain term at all — it was the per-film `complexity` (an *encode-cost*, measured against a fixed CRF-20 reference, which happens to be dominated by grain on grainy films). That is the argument for keeping the denominator and for keeping any grain add-on strictly out of the scoring expression this round.

---

## 5. Darkness and contrast (the second axis — bits are not enough here)

Banding (false contouring) is the dark/flat-scene sibling of grain cost: it is **not** proportional to bitrate, and both incumbent metrics miss it.

- **Netflix CAMBI — the reference.** "Contrast-Aware Multiscale Banding Index" (Sole, Afonso, Krasula, Li, Tandon; **Oct 2021**; arXiv PCS-2021). No-reference, white-box, built "from first principles": 4 contrast steps × 5 scales = 20 per-frame maps, pooled with **CSF-based weights**, and, critically, **spatial pooling that keeps only the worst-percentile pixels** (poorest regions dominate — same "worst-wins" philosophy as our attention model). **Netflix explicitly states PSNR and VMAF have "very little correlation" with banding MOS while CAMBI correlates strongly.** Banding triggers on sources as subtle as a one-clip change in a smooth gradient; it is most visible in skies, **dark scenes**, flat backgrounds, on big high-contrast screens and **when the viewing surrounds are dark** (our projector room).
  URL: https://netflixtechblog.com/cambi-a-banding-artifact-detector-96777ae12fe2 · arXiv https://arxiv.org/abs/2102.00079 · **[SOLID]**
- **CAMBI `full_ref` (Dec 2021)** — the practical answer to "dark by design vs crushed by the encode": a full-reference mode that subtracts **banding already present in the source**, so source-intended gradients (a designed dark sky) are not counted, and *introduced* banding is. Same philosophy as our "flags must be relative to intent" rule.
  URL: https://github.com/Netflix/vmaf/blob/master/resource/doc/cambi.md · **[SOLID]**
- **SSIMWAVE MHV '22 "Perceptual modelling for banding detection"** (Yeaganeh, Wang) — the creative-intent-framing companion to CAMBI, by the same authors as the grain-QoE paper in §3. Confirms the industry now treats banding as its own perceptual class with its own model, not as a corner of generic FR error.
  URL: researchr alias page https://researchr.org/alias/kai-zeng (doi pointer) · **[DIRECTION]**
- **ffmpeg tooling** (verified present on `docker exec controller`, 2026-08-19): `ffmpeg` **5.1.9** with debanding `gradfun` and denoisers `hqdn3d`, `nlmeans`, `bm3d`, `dctdnoiz`, `fftdnoiz`, `atadenoise`, `owdenoise`, `vaguedenoiser`, `removegrain`, `denoise_vaapi`. So the *measurement* half of both axes is instrumentable with zero new installs. (The YouTube-banding paper in the CAMBI thread uses `gradfun` as its de-facto deband reference.) **[SOLID]** (tool presence) / **[UNTESTED]** (whether our files show measurable banding).

**Relationship to BPP+.** BPP+ measures *bits bought* relative to what the film needs at CRF-20. A dark film whose shadows band at low bits is scored low — correctly — but the *reason* is bits, and no amount of "this title deserves better bitrate" ordering will say *"and a 10-bit source or a deband step would fix the banding your 8-bit file cannot."* That is the classic "bits-cannot-help" case, and it is why the recommendation is a **gate** (flags/annotation) rather than a term: the term would be non-monotonic in bitrate, which BPP+ must not become. Constraint `1.2d` ("gates beside the score, not inside it") is exactly the right home.

---

## 6. Formula / score-position recommendation

**Six positions, one each for the six ways grain could enter the score expression:**

**1. Denominator — KEEP (GRAIN-YES).** `BPP+ = 100·sqrt(bpp / target)`, `target = cxEff·headroomTarget`, `cxEff = complexity·biasFactor`. For a grainy film `cxEff` is large (12 Angry Men 0.9270); reaching BPP+ 100 therefore *correctly* requires more bits. This is not a penalty of an error — it is the statement "a transparent encode of this film is expensive, and you are far below it." It matches delivery practice (industry spends the bits or models the grain). The per-film measurement's flat-vs-live superiority is documented (`BPP-PLUS.txt` §8.7 + our rho): flat +0.195 vs per-film −0.574 complexity-vs-score correlation means the old constant over-praised clean digital and unfairly docked grain. **Do not touch the denominator for grain.**

**2. NO grain-bonus term.** A bonus in the numerator (reward low-grain files, or rescue high-grain ones) is the PSNR/SSIM error in reverse: it would tell two films with identical content that the lower-bpp, equal-look copy is "better, because you didn't need to spend the bits" — false, because at equal *look* the lower-bpp grainy copy is exactly the transparency-adequate copy it measures. A bonus untethers score from what a transparent encode costs. **No.**

**3. `grainShare` as an ANNOTATION, not a score input.** See §7. Ship it (if at all) in the same typographic-confidence class as `cxBasis: estimated` (italic) — a diagnostic, never a weight.

**4. "High complexity + low R" as a GATE (the natural grain signal).** On this box every high-complexity film is under-provisioned: of 885 files, 26 have complexity ≥ 0.30 and **all 26 have R ≤ 1.09 (max ever observed 1.09, median much lower)**. In other words: **not one grain-heavy film on the server is at CRF-20 transparency**. The 1080p projector makes that worth surfacing as an attention flag ("this grainy title is far below its own transparency target — a bigger release would be the textbook gain"), which is what `auditGain`/`R` already compute — they just do not say *"because it is grainy."* Add the *annotation*, not a rank.

**5. Darkness/banding — second AXIS, gate only.** No term. Reference implementation for "dark by design" is CAMBI `full_ref` (§5): compare-file-vs-source intent. In practice for us: a `gradfun`-or-CAMBI-clone pass is instrumentable with existing ffmpeg, but is a *safety-gate/provenance* feature (like the runtime guard), not a score. **[UNTESTED]** until a night or two of lab passes exist — see Q4.

**6. Keep `blockMean`/`blurMean` dead and keep `wBPP+` dead.** `HANDOFF-2026-08-17.md` binds this; nothing in this round changes it. CAMBI-style CSF multiscale machinery is the only NR banding path that has ever survived contact with subject data, and it is a build, not a tweak (Q4).

**The distinction that decides 4 vs 5:**

| Case | What bits can buy | Correct BPP+ statement | Action |
|---|---|---|---|
| **GRAIN-YES** | A transparent encode *will* reproduce the grain. | Grain films need more bits; a low-R grainy film is under-provisioned. | Keep denominator; add "grainy + under-provisioned" annotation (item 4). |
| **BITS-CANNOT-HELP** | Banding is a bit-depth/quan-staircase artifact; more MB/s in the same 8-bit encode does not fix it. | BPP+ does not see banding at all — as industry's VMAF does not. | Separate gate (item 5), source-relative (intent-aware), never a term. |

---

## 7. Verdict on `grainShare` (`1 − complexity_denoised/complexity_raw`, §16.A.5)

**Sound as a diagnostic; NOT sound as a score input; and its measurement must be pinned before trusting even the diagnostic.**

Why the *idea* is respectable, not naive:
- It is the exact quantity the AV1 pipeline isolates analytically (denoise → encode → transmit model → resynth). Netflix/Norkin prove the separation is meaningful and that the *cost* of grain is (a) real and (b) separable from the cost of the denoised content.
- Verified tooling exists in-container: `hqdn3d` is a cheap, deterministic, temporal 3DMP denoiser (options `luma_spatial`, `chroma_spatial`, `luma_tmp`, `chroma_tmp`, defaults 0) — fine for an overnight batch; `nlmeans`/`bm3d` are stronger but slower and parametrisation-fragile.

Why it must stay out of the score, and where it can still lie:
1. **The `gShare`/`blockMean` species of failure is real and adjacent.** A scalar salt-and-pepper quotient correlated **−0.885** with mean luma (`BPP-PLUS.txt` §11.3). Any new quotient needs the same kind of confounding-lab that caught `gShare` — specifically: correlation vs mean luma; correlation vs codec; stability across `-tune grain` vs `none` encodes of the *same* film; agreement with the two **Retracted**-class subjective points we once had (no valid labels exist — Q7).
2. **Denoise delta ≠ grain.** `hqdn3d`/`nlmeans` also remove *content* that is texture-but-not-grain: fur, hair, grass, sand, fabric weave, and the documentary-grade camera noise that is part of the picture. The AV1 grain analyser does *not* have this failure mode (AR model + intensity function) and we do not have an equivalent. So `grainShare` will over-read on noisy-but-not-cinematic content — precisely the content (documentaries / drama) where it would be most tempting to trust it.
3. **Grain is signal-dependent** (intensity-modulated). A single scalar ratio compresses a per-intensity function into one number. Fine for a trend line, misleading as a per-film label on its own. **Use it only alongside `cxBasis`, or as a low-variance bucketed trend, never as a film with a single number.** (§16.A.6's "denoise-first measurement" same caveat.)
4. **The `Complexity` already *is* the grain answer.** Whatever `grainShare` adds is an explanation *why* complexity is high — useful for a human, weightless for the rank. Weightless is the point.

**Concrete recommendation:** ship it (if at all) as a diagnostic column in `/api/probe/dataset` and the bpp-lab table, gated by the same degeneracy checks §16.A.5 names, rendered like `cxBasis: estimated` (italic, confidence-flavoured). It is not safe to attach to a rank until Q3's measurement-lab exists and passes.

---

## 8. Open questions

1. **[UNTESTED]** Streaming-ladder practice: do Netflix/YouTube per-title policies *raise* ladder bitrates on grainy content, or always synthesise? (Direction predicable from §2, but a citable source would close it.)
2. **[UNTESTED]** VMAF v1 (netflixtechblog, June 2026) — CSF-modulated distance correction and its phone-model replacement; does its DLM touch grain at all, or is grain still first on the unaddressed list (`BPP-PLUS.txt` §11.2)? Direct fetch 403s; mirror needed.
3. **[UNTESTED]** The measurement-lab for `grainShare`: hqdn3d-vs-nlmeans-vs-AV1-analysis comparison on a handful of our own films (one overnight), to confirm (a) delta stability across the three, (b) no luma/codec confounding, (c) agreement that the 26 high-complexity films are mostly-grain. **This is the gate before any of §7 ships.**
4. **[UNTESTED]** A night of `gradfun`/CAMBI-clone passes on dark-scene files: does measurable banding exist in the library, and does it correlate with anything we already compute (R, 8-bit-ness)? Feeds §5's gate design.
5. **[UNTESTED]** Whether the retracted blind-test can be re-run cleanly (labels must be scored by a viewer who can distinguish "grain visible" from "compression error visible") to produce the first valid subjective anchor (`BPP-PLUS.txt` §11, `HEADROOM_TARGET` pinning Q1 in `docs/DESIGN-CRF-PROBE.md` §12).
6. **[UNTESTED]** Sanity: do the *Beloved* tier's own chosen replacements on heavy-grain titles actually land with higher BPP+ after swap? (If the denominator is right, a transparent-tier grab of a grainy film should *tighten* R — a cheap model test.)
7. **[UNTESTED]** Still-fresh question the SSIMWAVE paper itself raises: does "creative-intent-friendly QoE, differing by group of subject" mean our *per-title gates* should be parameterised by Brennan's own taste curve rather than by a universal 100? That is `docs/DESIGN-CRF-PROBE.md` §12's open pin, restated into the second axis.

---

## Source / verdict summary

| Source | Verdict | Link |
|---|---|---|
| Norkin & Birkbeck, Film Grain Synthesis for AV1 (DCC 2018) | **[SOLID]** — the production grain architecture | https://norkin.org/pdf/DCC_2018_AV1_film_grain.pdf · https://ieeexplore.ieee.org/document/8416572 |
| Netflix, AV1 @ Scale: FGS, The Awakening (Jul 2025) | **[SOLID]** | https://entertainer.news/2025/07/02/av1-scale-film-grain-synthesis-the-awakening-by-netflix-technology-blog-jul-2025 |
| APSIPA, An Overview of Coding Tools in AV1 | **[SOLID]** — "up to 50% savings"; FGS excluded from FR comparison | https://apsipa2022.org/ |
| Zeng/Yeganeh/Wang, QoE of video with film grain (MHV '22) | **[SOLID]** — natural-vs-creative-intent unification | https://dl.acm.org/doi/10.1145/3510450.3517293 |
| Netflix/vmaf issue #1192 | **[SOLID]** — disable FGS for metric time | https://github.com/Netflix/vmaf/issues/1192 |
| CAMBI blog + arXiv (PCS 2021) | **[SOLID]** — PSNR/VMAF blind to banding | https://netflixtechblog.com/cambi-a-banding-artifact-detector-96777ae12fe2 · https://arxiv.org/abs/2102.00079 |
| CAMBI `full_ref` doc (Dec 2021) | **[SOLID]** — source-relative banding | https://github.com/Netflix/vmaf/blob/master/resource/doc/cambi.md |
| x265 docs `--tune grain` + Doom9/Waggoner | **[SOLID]** — grain-tune is artifact-avoidance, stale numbers | https://x265.readthedocs.io/en/master/presets.html · https://forum.doom9.org/showthread.php?p=1972383 |
| BVI-HD (IEEE TMM 2018); BVI-SynTex (2020) | **[SOLID]** — FR metrics weakest on synthesised content | https://ieeexplore.ieee.org/document/8322297 · https://ieeexplore.ieee.org/document/9016124 |
| Gain of Grain (VVenC toolchain, arXiv 2402.00622) | **[DIRECTION]** | https://arxiv.org/abs/2402.00622 |
| SSIMWAVE, Perceptual modelling for banding detection (MHV '22) | **[DIRECTION]** | https://researchr.org/alias/kai-zeng |
| Hacking VMAF & VMAF NEG (MHV '22); Stable VMAF (Springer 2025) | **[DIRECTION]** — preprocessing/adversarial manipulation | https://dl.acm.org/doi/10.1145/3508259.3508272 · https://link.springer.com/article/10.1007/s00530-025-01795-5 |
| VMAF v1, Good Is Not Good Enough (Jun 2026) | **[SOLID]** (CSF correction) / grain-status **[UNTESTED]** | https://netflixtechblog.com/vmaf-v1-good-is-not-good-enough-60d7e4244ea8 |
| Digital Transitions heritage scanning | **[UNTESTED]** — grain management in archive scanning | https://heritage-digitaltransitions.com/film-scanning-transmissive-material-preservation-workflows-tools-and-best-practices-for-cultural-heritage |
| ffmpeg 5.1.9 tool presence (`gradfun`, `hqdn3d`, `nlmeans`, `bm3d`, …) | **[SOLID]** (presence), **[UNTESTED]** (measurements) | `docker exec controller ffmpeg -version` + `-filters` |
| Internal priors: `gShare` (r=−0.885), `blockMean`, `wBPP+`, blind-test retraction | **[FALSIFIED / KILLED]** — binds §6 items 3 & 6 | `BPP-PLUS.txt` §9/§11, `HANDOFF-2026-08-17.md`, `REPORT-grain-2026-08-13.md` |

---

## Internal data used this round (live, 2026-08-19)

- Dataset: `/tmp/opencode/probe-dataset.json` (n=885 movies). Spearman (pure Python, no deps):
  - complexity vs bppPlus: **−0.334**
  - complexity vs R: **−0.313**
  - cxEff vs bppPlus: **−0.519**
  - blockMean vs blurMean: **0.076** · blockMean vs complexity: **−0.117** · spreadRatio vs complexity: **0.073**
- Grain cohort: 26 films with complexity ≥ 0.30; **all 26 have R ≤ 1.09** (max 1.09) → zero grain-heavy files are at/above transparency.
- Engineering facts: `complexity` is "largely grain" (*BPP-PLUS.txt* §8.7; 12 Angry Men 0.9270); flat-vs-live Spearman +0.195 vs −0.574; `gShare` r = −0.885 vs mean luma (falsified); `blockMean` r = −0.090 vs the eye (killed). 1080p projector planned; 720p native dead 2026-08-19.

---

## ROUND 2 — ADVERSARIAL VERIFICATION (2026-08-19)

Method: every number recomputed from `/tmp/opencode/probe-dataset-now.json` (fresh pull, n=1031 rows = 885 movies + 146 seasons; movies-only counts identical to this report's snapshot), external quotes re-fetched from primary sources, internal priors traced to their owning documents. Original text above is untouched; corrections are stated here, not edited in.

**Recomputed ground truth (movies, fresh dataset):**
- Grain cohort: **26 films** with complexity ≥ 0.30 — count VERIFIED. Max R = **1.0877** (*Citizen Kane* 1941), median R = **0.737**, min 0.190.
- Quartile table (§8.7 shape): Q1 median cx 0.073 → live BPP+ 71 (flat-equiv 63; 61% bad, 6% wow); Q4 median cx 0.198 → live 55 (flat 94; 73% bad, 1% wow). Max bppPlus among the 26 grain films = 91 (none reach wow ≥ 125). All match.
- Spearman: complexity↔bppPlus **−0.330**, complexity↔R **−0.308**, cxEff↔bppPlus **−0.518** — this report's −0.334/−0.313/−0.519 reproduce EXACTLY on its cited snapshot `/tmp/opencode/probe-dataset.json`; drift is refinement-level.
- blockMean↔blurMean 0.076, blockMean↔complexity −0.117, spreadRatio↔complexity 0.073 — reproduce exactly on the cited snapshot (fresh: 0.078/−0.121/0.073).

### Per-claim verdicts

1. **Grain cohort & "all 26 sit at R ≤ 1.09" (§1 pos 2, §6 item 4, data block)** — **[VERIFIED]** with one phrasing correction. Count (26), max (1.09 = Citizen Kane 1.0877), and the conclusion (no grain-heavy title near the R>1.2 revisit trigger) all hold. But "**zero grain-heavy files are at/above transparency**" (data block) and "**not one grain-heavy film is at CRF-20 transparency**" (§6 item 4) slightly overreach: **3 of the 26 have R ≥ 1.0** (Citizen Kane 1.088, Key Largo 1.03, Stalag 17 1.00). Defensible form: *none exceeds R = 1.2; only one is meaningfully above 1.0.*

2. **Flat-vs-live flip "+0.195 vs −0.574", attributed to `BPP-PLUS.txt` §8.7 (lines 62, 110, 192)** — **[REVISED — numbers wrong AND misattributed].** §8.7 states **+0.442 / −0.328**, which is what the data gives: Spearman(flat, complexity) = **+0.442**, Spearman(live, complexity) = **−0.330** raw (**+0.252 / −0.518** against cxEff). The +0.195/−0.574 pair appears nowhere in §8.7 and does not reproduce on any axis (`01-adversarial-review.md` flagged exactly this at its lines 33–34, 111–112, 123–126; this report repeats it three times). The qualitative claim — the flat constant rewarded clean digital and docked grain, the per-film denominator reverses the sign — SURVIVES on the raw axis (+0.442 → −0.330). Replace the pair everywhere with +0.442/−0.328 (or +0.252/−0.518 for cxEff).

3. **`blockMean`/`wBPP+` "Killed" verdict (§4 table row 3, §6 item 6, source-summary last row)** — **[REVISED — evidence withdrawn; conclusion survives on different grounds].** The kill evidence cited (HANDOFF-2026-08-17.md: blockMean −0.090, blurMean −0.266, the Spirited Away / I Am Legend / Inception / Star Wars / Jurassic Park / Taxi Driver case list) is **blind-test-derived, and `BPP-PLUS.txt` §11.4 explicitly withdrew it** along with "the 'do not revive blockMean' verdict": blockMean/blurMean are **"UNTESTED, NOT FALSIFIED"** — candidate detectors, inputs to no score. This report is internally inconsistent: its own §4 row 4 retracts the blind test ("no valid subjective label exists") while row 3 uses that same test's correlations as kill evidence. Timeline note: report written 17:08, `BPP-PLUS.txt` last modified 19:40 same day (docs are git-untracked, so §11.4's insertion cannot be dated relative to writing — treat as supersession, not fault). What remains true: keep them out of the score (they were never in it), CAMBI-style machinery is the only NR banding path with subject-data pedigree, and §11.4 itself adds "that is not an argument to revive them." Exec-summary phrase "failed the only test that matters, Brennan's eyes" inherits the same problem — that test was retracted.

4. **`gShare` r = −0.885 vs mean luma (§1, §4, §7.1)** — **[VERIFIED, historical]**. Confirmed in two primary docs (`REPORT-grain-2026-08-13.md`, `BPP-PLUS.txt` §11.3 "DO NOT REVIVE IT"). No `gShare`/`grainShare` field exists in code — the only occurrence is a comment (`controller/lib/probe.js:1061`). Correctly cited as falsified history.

5. **P.1204.3 blindness clause (via `03-itu-nr-metrics.md` §2a)** — **[VERIFIED verbatim]** from the standard: *"Effects due to source generations, such as signal noise, video shake, certain colour properties (and other similar video factors), as well as other impairments related to the payload, are not reflected in the scores computed by this model."*

6. **FGS −66%, *They Cloned Tyrone* (§2, Netflix "The Awakening")** — **[VERIFIED]**: regular AV1 @ **8274 kbps** vs AV1+FGS @ **2804 kbps** ≈ **66%** reduction (2804/8274 = 33.9%). Blog dated 2025-07-02; original URL 403s (mirror used), figures confirmed via search capture and consistent with `07-netflix-techblog.md`.

7. **Norkin & Birkbeck DCC 2018 (§2)** — **[VERIFIED]** from the IEEE abstract + author PDF: AR grain model, strength as a function of intensity, denoise→encode→transmit-model→resynth, "up to 50%" savings on heavy grain. Also directly supports §7.3's "grain is signal-dependent" (strength is a per-intensity function, so one scalar per film collapses it) — that inference is sound.

8. **CAMBI (§5)** — **[VERIFIED]** core mechanics: no-reference, CSF-weighted 4×5 multiscale maps, worst-percentile spatial pooling, "PSNR and VMAF have very little correlation" with banding MOS, `full_ref` source-relative mode. One date slip: arXiv 2102.00079 was submitted **29 Jan 2021** (PCS presentation Sept 2021, techblog Feb 2022) — "Oct 2021" matches no milestone; harmless.

9. **BVI-HD (§4)** — **[VERIFIED structure]**: 32 references × 12 distortions (incl. HEVC-with-texture-synthesis), 384 sequences, 86 subjects, 8 FR metrics evaluated. The specific "seven/eight lose rank" detail is from the paper body, not the abstract — plausible, not independently re-verified.

10. **x265 `--tune grain` internals (§2)** — **[VERIFIED exactly]** against x265 `presets.rst`: aq-mode 0, cutree 0, ipratio 1.1, pbratio 1.0, qpstep 1, sao 0, psy-rd 4.0, psy-rdoq 10.0, recursion-skip 0; purpose quote verbatim ("neither to retain nor eliminate grain…"); `--rc-grain` minimises QP fluctuation, overrides risk strobing. Doom9/Waggoner colour accepted as attributed.

11. **ffmpeg tool presence (§5)** — **[RE-VERIFIED live]**: controller container runs ffmpeg **5.1.9**; all 11 named filters present (`gradfun hqdn3d nlmeans bm3d dctdnoiz fftdnoiz atadenoise owdenoise vaguedenoiser removegrain denoise_vaapi`).

12. **APSIPA "FGS excluded from FR comparisons" (§2)** — **[VERIFIED-DIRECTION]**: directly supported by vmaf issue #1192 (pointwise metrics punish synthesised grain; disable decode-time FGS when scoring) and by Norkin's own statement that objective metrics capturing FGS gains are an open research topic. The exact APSIPA sentence was not re-fetched this round; the load-bearing negative stands on the two corroborating sources.

13. **Gain of Grain arXiv 2402.00622 (§2)** — **[VERIFIED exists]** (Menon et al., VVC/VVenC grain toolchain, Feb 2024); **[DIRECTION]** tag appropriate.

14. **Streaming-ladder practice (§2, Q1)** — remains **[UNTESTED]**; nothing found this round changes it.

### Net effect on the six formula positions (§6)

All six positions STAND, two with corrected justifications:
- Items 1–3, 5: unchanged (item 1 now carries +0.442/−0.328 instead of +0.195/−0.574).
- Item 4: stands; soften "not one grain-heavy film is at transparency" to "none reaches R > 1.2; max observed 1.09."
- Item 6: conclusion stands (keep blockMean/blurMean/wBPP+ out of the score), but the binding must be re-cited to **`BPP-PLUS.txt` §11.4** ("untested, not falsified; inputs to no score"), not to HANDOFF-2026-08-17.md's withdrawn blind-test statistics.

### Tally

New errors found this round: **2** (items 2 and 3 above). Pre-existing error carried forward: **1** (the +0.195/−0.574 pair, already flagged in round 1). Everything else checked out.