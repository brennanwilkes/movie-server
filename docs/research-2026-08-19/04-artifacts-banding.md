# 04 — Artifact detection for BPP+: banding and other compression artifacts

**Date:** 2026-08-19 · **Track:** B (artifacts) · **Status:** research report, no scores changed

**Scope.** Is CAMBI obtainable? What other artifact detectors are viable on this box, and do
they survive the two degeneracy tests that killed gShare (§11.3 — separate CGI from film stock,
independent of mean luma)? Where in `BPP+ = round(100·sqrt(bpp/target))` does an artifact term
belong? What is the cheapest detector shortlist against the probe's *existing* 8×4s sampled frames?

**Ground rule kept throughout.** There is still **no valid subjective label anywhere in this
library** (BPP-PLUS.txt §11.1 — the 2026-08-13 blind test was retracted). Every claim below that
is about *detection validity* is therefore [UNTESTED], and no fitted value is proposed. Correlations
quoted against the retracted labels (blockMean −0.090, blurMean −0.266) are **withdrawn with the
labels** and are not used as evidence either way (§11.4).

---

## 1. Executive summary

| Question | Answer |
|---|---|
| Is CAMBI obtainable? | **Yes, but only via a static libvmaf build.** Not in controller ffmpeg 5.1 (`Unknown filter 'camb'`, no `--enable-libvmaf`), not in jellyfin-ffmpeg 7.1.4, not on the host (ffmpeg 4.2.7). Two routes: compile `libvmaf` standalone ([SOLID]) or pull a static ffmpeg build with libvmaf included ([DIRECTION] — not yet verified in the BtbN asset manifest). |
| Top detector recommendation | **CAMBI for banding** (the artifact BPP+ has never measured at all) with **blockdetect kept as-is** (blocking). Not VMAF, not SSIM (both full-reference and grain-broken, §11.2). |
| Which lever in the formula | **A multiplicative term on the `target` (denominator)** — `target' = complexity · biasFactor(R) · HEADROOM_TARGET · artifactPenalty`, capped. Reasoning in §4. This is structurally the same one-number-shape as a gate (§1.2d) but with real error-propagation properties: it scales the *distance* from target rather than clipping at one bit level. |
| Detector shortlist for existing 8×4s samples | CAMBI + blockdetect + blurdetect chained into the *single existing decode pass* — that pass is effectively free to extend. gridRatio needs its own frame-pair decode (not chainable), so it stays a per-film second pass. |

The one-line verdicts per source are in the relevant sections (`VERDICT:` lines).

---

## 2. CAMBI — the banding detector BPP+ has never had

**What it is.** CAMBI (Contrast-Aware Multiscale Banding Index), PCS 2021, G. van der Auwera /
Netflix. Detects false contours — the smooth-ramp step-banding an 8-bit quantiser leaves in skies,
gradients and dark scenes. Scale **0 (clean) to ~24 (unwatchable)**; **~5 begins to annoy**
[SOLID — Netflix TechBlog / libvmaf docs; the "~5 annoying" figure is a commonly-cited
interpretation and the techblog is the primary source].

**Why it is special for us.** It is an **artifact detector, not a quality model** — "is this defect
present", not "how good is this". That is the structural point that made blockdetect usable too
(prior survey, `RESEARCH-quality-metrics-2026-08-01.md` §1). It is **hand-designed from the contrast
sensitivity function, not fitted to a UGC dataset**, so it does not inherit the KoNViD/LIVE-VQC
"wrong distortion class" problem that kills BRISQUE/NIQE/VIDEVAL/RAPIQUE/FastVQA for our content
(prior survey §1).

**Grain robustness — the whole reason it survives where VMAF/SSIM/NIQE fail.**
- CAMBI is **no-reference by default**; grain is in both the reference and the integrate when the
  reference is provided, so the pixelwise all-reference grain penalty of SSIM/VMAF (§11.2) does not
  apply [SOLID — Netflix TechBlog].
- Degeneracy test 1 (CGI vs film stock): CAMBI keys on **flat regions** — the candidate detector's
  *own* strong signal is flat painted surfaces and clean gradients. Film grain *aggravates* banding
  perception in dark gradients but CAMBI's flat-region selectivity is exactly the discriminator the
  retracted blind test said blockdetect lacks ("large flat painted regions" is what made Spirited
  Away read blocky — HANDOFF open-risk #2). **Test 1 is CAMBI's home turf, not its blind spot.**
- Degeneracy test 2 (independence from mean luma): CAMBI is designed around banding, which lives in
  *gradients*, not darkness per se; but its raw score is heavily luma-dependent by construction
  (darker → lower local dynamic range → easier to band). **This is the test to insist on** — same
  trap as gShare's r −0.885 vs mean luma (§11.3). Verdict: [UNTESTED] on our library; must be
  checked over the probe dataset before any score use.

**Runnability on this box — the crux.**
- Controller ffmpeg: `ffmpeg 5.1.9-0+deb12u1`; `-vf camb` → **`Unknown filter 'camb'`**; `ffmpeg -version`
  and build config show **no `--enable-libvmaf`**. `vmafmotion` exists as a built-in metric, but
  that is not CAMBI. [SOLID — tested 2026-08-19]
- jellyfin-ffmpeg 7.1.4: no libvmaf (BPP-PLUS.txt §16.A.6 — "jellyfin-ffmpeg 7.1.4 does not
  either"). [UNTESTED this session, documented in design doc]
- Host ffmpeg: **4.2.7**, too old for blockdetect, forget CAMBI. [SOLID]
- No `libvmaf` anywhere on the box today. [SOLID]

**Three acquisition routes, ranked:**

1. **Compile `libvmaf` standalone and use the `vmaf` CLI** with `--feature cambi` (and no
   `--reference` = no-reference mode). The `vmaf` tool is a standalone binary; it needs the source
   video (or a pipe) and emits a per-frame/global `cambi` score. Building `libvmaf` from source on
   this 4-core NUC is a ~10–20 min build — the *previous session's recommendation* for the CRF-ladder
   tool and the design doc's already-endorsed "second static ffmpeg built with libvmaf for the
   ladder ONLY" (§16.A.6 item 6). The ladder fork and the CAMBI fork need the **same** static libvmaf
   build. [SOLID — libvmaf source builds cleanly; docs show `vmaf --reference X --distorted Y --feature cambi`]
2. **A static ffmpeg build with libvmaf enabled** (e.g. BtbN FFmpeg-Builds linux64-gpl, ~122 MB
   tar.xz). This is the only route that puts `camb` *inside ffmpeg* so it can chain into the existing
   `probe-film.sh` pass. **Feature list not yet verified** — must confirm `x265`/`libvmaf`/`camb`
   in that specific build before trusting it. Danger warned in the design doc: a different x265 build
   would make new complexity measurements **incomparable** to the 1031 existing ones — so the static
   build is for CAMBI/detector work, **never** for the complexity encode itself. [DIRECTION]
3. **pyiqa** (`pip install pyiqa`, 0.1.16 wheel — 7.8 MB, available on PyPI) exposes several NR
   models, but has **no CAMBI** (CAMBI is libvmaf-only). pyiqa's monotonic-trained models repeat the
   UGC-distortion-class problem. Not the path to CAMBI. [SOLID — wheel inspected]

**VERDICT: USE THIS — but plan the obtainability, not the filter.** CAMBI is the highest-value
detector in scope (a distortion BPP+ is structurally blind to — banding is where 8-bit delivers
visibly-different-to-grained-darkness artifacts), it is obtainable, and it is cheap at 720p
(~10–20 s for CAMBI+blockdetect over 32 s, extrapolated — prior survey §intro). The design doc's own
survey already said "USE THIS" (§16.A.6). The work item is a **one-time static libvmaf build** on the
NUC, pinned, ladder-only, never the scoring encode.

---

## 3. The other artifact detectors, with grain-robustness notes

All artifacts BPP+ could plausibly want to see. Each: what it detects, how to run it on our box,
its grain-robustness against the two §11.3 degeneracy tests, and a one-line verdict.

### 3.1 Blocking (blockdetect) — present in the probe today
Runs: already chained into the probe's single decode pass (`controller/scripts/probe-film.sh:117`,
`blockdetect,blurdetect`, gives `blockMean` in the dataset). Based on Muijs & Kirenko 2005
(average difference across block boundaries minus inside). Spans `period_min=8, period_max=24`.
- **Degeneracy 1 (CGI/flat):** FAILS as a *clean vs artifact* signal — Spirited Away (99th pct
  blockMean 6.60) read as blocky yet judged clean; the detector is responding to large flat painted
  regions with block-sized ramps, a documented false-positive class (blind-test notes). As a *flatness
  detector* it is doing its job; as a compression detector it confounds.
- **Degeneracy 2 (mean luma):** untested [UNTESTED].
- Acquisition: **already have it, zero cost — this is its main virtue.**
- **VERDICT [SOLID as a detector — §11.4]: KEEP, as an input to diagnostics only.** Not falsified,
  not validated. Its correlations from the retracted labels are withdrawn. Do not score with it until
  either a valid label exists or a flatness-confounded use is off the table.

### 3.2 CAMBI (banding) — §2 above
**VERDICT: USE THIS (obtainability is the work, not the detector).**

### 3.3 Blur (blurdetect) — present in the probe today
Runs: same chain, `blurMean` in the dataset. Perceptual blur — but **blur is ambiguous**: soft
cinematography (Heat, Brennan: "a little under-resolutioned… not totally in focus") vs
over-compression smoothing. NIQE's same failure mode runs the other way: it *rewards* compression
blur as "natural" (prior survey §1, NIQE disqualified). Heat's complexity 0.059 is deliberately the
blurriest of the eleven at 1.7 Mb/s — and that is its *transfer*, not damage.
- **Degeneracy 1:** fails — "clean but starved" Quadrant-B films are exactly the soft ones; `blurMean`
  vs `complexity` Spearman −0.197 on the live dataset (n=1031) is confounded with the content being soft.
- **Degeneracy 2:** untested.
- **VERDICT [SOLID as a detector, WRONG AXIS for a quality term]: keep as a secondary diagnostic
  only** (prior survey: "Use as a secondary signal only").

### 3.4 Ringing / mosquito noise — no detector in scope
Mosquito noise (ringing around detail edges, worst on sharp text/edges at low bitrate) has
validated no-reference detectors (e.g. in VMAF research models) but **none ship in ffmpeg 5.1 as a
filter**, and none are grain-robust by construction. On flat pans with grain, edge-ringing is
masked — the same masking argument as CAMBI for gradients but reversed (grain masks *this* defect,
so detection would under-fire on the exact content we care about).
- **VERDICT [UNTESTED, no cheap path]: SET ASIDE until something ships it.** Not worth a custom
  detector build against an unsolved degeneracy surface.

### 3.5 DCT-grid / gridRatio — the design doc's best remaining candidate
Runs: `scripts/probe-noise-origin.sh` + `analyze-noise-origin.js`. Measures the 8×8-grid correlation
of the difference field: compression error lands on block boundaries, grain knows nothing about the
grid. **Star Wars 9:19 = 1.165; No Other Choice (2025) = 0.995** [DIRECTION, n=2, §9].
- **Degeneracy 1:** passes by construction — CGI rendered at native res has no encoder-added grid
  pattern either; a clean-transfer CGI film probes ~1.00 (predicted, [UNTESTED]). This is the
  property that makes it "the best remaining artifact candidate" (§9.2).
- **Degeneracy 2 (independent of mean luma):** the bright-pixel gate (`BRIGHT=140`) was itself a
  lesson from gShare's luma coupling — it measures only bright flat areas, so it should be luma-free
  *within the measured region*, but the per-film selection of which regions qualify is luma-driven. Verdict: **untested** — need to verify the score doesn't correlate with `complexity`/mean-luma over the dataset, exactly as §9.2's "test first, it is not a result" demands.
- **Cost:** NOT chainable into the existing decode pass. Needs its own decode as raw gray frames +
  a node analyser (~seconds of decode + node processing per film). 
- **VERDICT [UNTESTED, best candidate]: build it into the probe pass as a SECOND decode, and test
  the §11.3 degeneracies over the dataset before trusting a single number.** It is the only candidate
  that isolates *the thing more bits can fix* (encoder-added grid) rather than the thing they cannot
  (content flatness/softness).

### 3.6 Contouring (false contours) — same defect family as banding, different scale
Banding *is* the visible contouring on a quantised ramp; CAMBI covers it. A separate "MPEG-2-style
Œ2 contouring" detector is redundant with CAMBI. **VERDICT [SOLID]: fold into CAMBI, do not double-count.**

### 3.7 Colour bleed / chroma banding
Chroma subsampling artifacts (4:2:0 steps on saturated gradients — e.g. a red sky). CAMBI as
shipped measures luma; libvmaf has a chroma-inclusive mode in research form. All our files are 4:2:0
by scene norm. **VERDICT [DIRECTION, cheap]: revisit after CAMBI luma works; not before.**

---

## 4. Where the lever goes — `BPP+ = round(100·sqrt(bpp/target))`

`target = complexity · biasFactor(R) · HEADROOM_TARGET`. An artifact term can enter four ways.
The error propagation matters (design doc §4.4): the sqrt **halves** a relative error on the argument,
so a term inside the ratio beats a term added outside it by a factor of two in score space.

| Option | Form | Effect | Double-count / propagation analysis |
|---|---|---|---|
| **A. Multiply the denominator** (recommend) | `target' = target · AP`, `AP ≥ 1` | BPP+ falls by `sqrt(AP)`: a 1.5× artifact burden reads −18 points (~ a quarter-band). | **No double-count with the gates** — blocks the *distance* while the gates cap the ceiling, the two are orthogonal. Error: an errant AP of 2.0 on a film with none gets *half-credited* (sqrt), the gentlest failure mode of the four. 
| **B. Multiply the numerator** (`bpp` side) | `bpp' = bpp / AP` | Numerically identical to A (same ratio), score-identical. | Distinguishing A from B is pure convention — but *convention still matters*: putting the term in the denominator keeps the semantic "target: how many bits this *should* be" intact, and future additive gates then read as "other ceilings" next to source-tier (§10.1), not inside the numerator's meaning. Pick A for readability, not math. |
| **C. Add/subtract a term in score space** | `BPP+' = BPP+ − k·AP` | Linear subtraction in score space. | **Worst propagation.** Error in AP enters unshrunk (no sqrt shield) and needs `k` fitted per band — reintroduces the "additive constant with no valid labels" problem that already made every fitted weight in the model unvalidated (§11.1, 16.B). Rejected. |
| **D. A gate** (constraint 1.2d) | hard ceiling on BPP+ if AP > threshold | Collapses a 130 to a 100 — *hides* the degree. | Matches the "bits cannot help" shape (Blair Witch class — §9.3, grain is *not* fixed by bits) and is where gridRatio → artifact gate belongs if the target is "never show 120 on an artifact-laden 2 Mbps rip". But a gate is binary-ish; the honest state (§11.1) says we have **no confirmed compression-damaged film** — a gate keyed to a detector we haven't validated is a filter doing a measurement's job. Use a gate only for the *directional* prediction ("this cannot improve"), not the score. |

**Recommendation (A vs D is the real choice):**
- **CAMBI/banding** = **A** — the question is "how many points fewer", a degree. Cap it so a bad
  reading cannot flush a film below red artificially (i.e. `AP ≤ ~1.6` → ≥ −20, ~a quarter-band).
  Scored as a ratio, shielded by the sqrt, forward-compatible with any future label.
- **gridRatio/boiling** = **D-style gate** (or annotation) for now — its demonstrated output is
  "this film's grain is codec-touched and bits cannot fix it" (§9), which is the gate shape, **but
  keep it as a displayed annotation (`artifacts: high` in the one-number shape, §16.A.6 item 7), not
  a clamp**, until n=2 becomes a validation. The design doc's own §16.B gate 2 (constant not a
  measurement) applies first: measure a pilot, see if gridRatio varies per film at all.
- **blockMean/blurMean** = **neither** — they stay diagnostics. (§11.4: not falsified, not validated,
  inputs to no score. Do not promote them on the strength of a dataset-side correlation, which is
  circular without a label.)

The design-doc phrasing to keep: "gates beside the score rather than terms inside it" (constraint
1.2d) governs *the bits-cannot-help classes*, and an artifact *degree* term is compatible with it as
long as a) it is multiplicative — never additive in score space — and b) its worst-case effect is a
bounded band movement, so its failure is visible but not catastrophic. **The distinction the previous
round of this constraint missed: gates answer "should this upgrade", the score answers "how good is
what I have". An artifact term used as a score degradation is not a ceiling; it is still a
measurement. Keep them different kinds of object in the code (a `gates` array vs a `target`
multiplier), or one will start doing the other's job.**

---

## 5. Detector shortlist for the probe's existing 8×4s sampled frames

The probe already decodes 8 samples × 4 s × (currently width 1920, CRF 20, medium) into one pass,
with blockdetect/blurdetect in it. The shortlist is ordered by cost-of-obtaining vs value, and every
entry is measured against the *actual* pipeline.

### Tier 1 — basically free, do now
| Detector | Where it hooks | Cost |
|---|---|---|
| blockMean / blurMean | already in `probe-film.sh` pass | ~6 s/sample shared decode (existing) |
| **CAMBI** (once libvmaf is available) | chain the `camb`/`cambi=` output into the SAME pass, exactly like blockdetect sits today | ~10–20 s over 32 s at 720p (prior-survey extrapolation; with libvmaf the per-frame cost is well under realtime at 1080p) |

CAMBI is the only Tier-1 addition and it changes the pass from "blockiness + blur" to "blockiness +
blur + banding" for a bounded time cost. This is the low-hanging fruit and matches the prior survey's
exact plan ("run blockdetect and CAMBI on the same 8 samples").

### Tier 2 — second decode, worth it for gridRatio only
| Detector | Where it hooks | Cost |
|---|---|---|
| gridRatio | new decode in `probe-noise-origin.sh` (already built as a standalone tool) | own decode of ~48 bright-region frames + node analysis (seconds), plus per-film selection of static-bright scenes |

The §9 measurement was done with exactly this tool (Star Wars 9:19, No Other Choice). It is not
chainable into the blockdetect pass because it needs raw gray frame pairs, not the encode output.
**Run it over a pilot (16.B gate 2) before scheduling anything.**

### Tier 3 — not now
- VMAF, SSIM: full-reference, excluded (§1.2a), grain-broken (§11.2). Only ever a rate-curve tool,
  which is the blocked-on-libvmaf ladder item — separate from this report's artifact scope.
- NIQE/BRISQUE/pyiqa learned-NR: UGC-distortion-class models, NIQE explicitly disqualified
  (prior survey §1). No.
- Custom mosquito/ringing detector: unsolved degeneracy surface, no shipping filter. No.

**Effort estimate.** Tier 1 = one static libvmaf build (~10–20 min) + wiring the `cambi=` stat into
`probe-film.sh`'s existing `BLK/BLR` capture block (~30 min of script). Tier 2 = run
`probe-noise-origin.sh` on a ~10-film stratified pilot (same-profile CG/film/stock/low-bitrate mix the
design doc prescribes for the retest, §16.A item 3) and check gridRatio's degeneracy correlations
over the dataset (~1 h). Total realistic weekend: Tier 1 fully instrumented, Tier 2 pilot analysed.

---

## 6. Open questions

1. **The libvmaf build.** Confirm both routes build *and run* on the 4-core NUC in < 20 min each —
   standalone `libvmaf` CLI vs a static ffmpeg build with `camb`. The standalone CLI is simpler but
   the static ffmpeg is the one that slots into `probe-film.sh`. **Blocking decision for everything
   in Tier 1.**
2. **CAMBI degeneracy test 2 (mean luma).** cc range: run CAMBI on the probe dataset's existing
   samples (once instrumented) and check Spearman(CA, meanLuma) over 1031 units. gShare died on
   r −0.885; CAMBI needs to be well under |0.3| to be trustable, and even then that is a dataset
   correlation, not a label.
3. **Does CAMBI pick up grain-boil or blocky-flat instead of banding?** The Spirited Away false-
   positive class (flat painted regions) is exactly what CAMBI's *flat* regions do. The clean way to
   separate: run CAMBI on the same two §9 clips (Star Wars 9:19 vs No Other Choice) — if CA is
   high on the clean-but-grainy film, it is sharing blockdetect's confound.
4. **gridRatio n=2 → n>2.** The pilot (16.B) decides whether gridRatio varies per film at all;
   §9.2's "test first, it is not a result" is load-bearing.
5. **The lever.** Is the multiplicative-denominator choice acceptable, or does the "gates, never
   terms" constraint (1.2d) get hardened into "no artifact term inside the score at all" — in which
   case CAMBI becomes a gate/annotation like everything else? That is a Brennan decision, not a
   technical one; this report argues A is safe and C is wrong.
6. **HEADROOM_TARGET and the sqrt exponent** stay open (design doc open questions) — an artifact
   term multiplies `target`, so it composes with both; changing either later re-distributes the score
   but does not break the artifact term's shape.

---

## Where the one-liners live

| Source | VERDICT |
|---|---|
| Netflix CAMBI techblog + libvmaf `cambi.md` | **USE THIS** — artifact detector, not model; grain-safe by construction; the banding axis BPP+ is blind to |
| libvmaf on this box | **OBTAINABLE but not installed** — static libvmaf build (ladder-only, pinned); never replace the Debian ffmpeg that produced the 1031 measurements |
| ffmpeg blockdetect / blurdetect | **KEEP as diagnostics (blockMean/blurMean, §11.4)** — untested, not falsified, inputs to no score; blockdetect confounds flatness, blurdetect confounds soft transfers |
| gridRatio (probe-noise-origin) | **[UNTESTED, best candidate]** — test §11.3 degeneracies over the dataset before trusting; the only candidate isolating bits-can-fix vs bits-cannot |
| VMAF / SSIM | **EXCLUDED (full-reference §1.2a, grain-broken §11.2)** — ladder-adjacent only, already design-doc'd |
| NIQE etc. (pyiqa learned-NR) | **DISQUALIFIED** — UGC-distortion-class, per prior survey §1 |
| Lever | **A (multiply the denominator)**, capped; gridRatio as gate/annotation; blockMean/blurMean nowhere in the score |

---

## ROUND 2 — ADVERSARIAL VERIFICATION (2026-08-19)

Verifier re-derived every load-bearing claim against live ground truth: the controller container
(`ffmpeg 5.1.9-0+deb12u1`, jellyfin-ffmpeg `7.1.4-Jellyfin`, host `4.2.7`), a fresh
`/api/probe/dataset` pull (1031 rows: 885 movies + 146 seasons, all with non-null blockMean/blurMean),
`controller/scripts/probe-film.sh`, `scripts/probe-noise-origin.sh`, and the primary sources
(Netflix `vmaf/resource/doc/cambi.md`, libvmaf issues #1202/#1567, ffmpeg filter docs). Original text
above is untouched; verdicts below.

### Environment claims

| Claim | Verdict |
|---|---|
| Controller ffmpeg 5.1.9, build config has no `--enable-libvmaf`; `vmafmotion` present but is not CAMBI | **[VERIFIED]** live: config string lacks libvmaf; `-filters` shows `blockdetect`, `blurdetect`, `vmafmotion` only |
| "`-vf camb` → `Unknown filter 'camb'`" as *evidence* | **[REVISED — specious test]** There is no `camb` **or** `cambi` filter name in ANY ffmpeg, including libvmaf-enabled builds. CAMBI is reachable only through the `libvmaf` filter (`feature=name=cambi`). Testing `-vf camb` would fail on every build on earth; the real proof is the missing `--enable-libvmaf` (which the report also cites, so the conclusion stands). Correct probe: `-filters | grep libvmaf`. |
| jellyfin-ffmpeg 7.1.4 has no libvmaf [UNTESTED] | **[VERIFIED]** live this session: 7.1.4-Jellyfin has blockdetect/blurdetect, no `libvmaf`/`cambi` filter. Upgrade the tag. |
| Host ffmpeg 4.2.7, too old for blockdetect | **[VERIFIED]** |

### CAMBI behaviour — including the classic gotcha

| Claim | Verdict |
|---|---|
| Scale 0–24, ~5 begins to annoy | **[VERIFIED]** verbatim from `cambi.md` |
| No-reference by default | **[VERIFIED]** — but see the input gotcha below |
| "grain is in both the reference and the integrate when the reference is provided" | **[FALSIFIED as written — garbled]** In default mode the reference is **ignored entirely**: libvmaf maintainer on issue #1202 — *"only the distorted one is used in CAMBI"*. There is no ref-vs-dist grain cancellation because there is no comparison. In `full_ref` mode the combination is `MAX(0, dist_score − ref_score)` — a difference of two no-reference *scores*, never a pixelwise diff. The conclusion (no SSIM/VMAF-style pixelwise grain penalty) survives; the stated mechanism does not. |
| **THE GOTCHA (§2 route 1): "`--feature cambi` (and no `--reference` = no-reference mode)"** | **[FALSIFIED as stated]** The `vmaf` CLI **requires both** `--reference` and `--distorted` even for no-reference CAMBI — you point both at the SAME file (that is literally the documented invocation in `cambi.md`, and issue #1202 confirms why). There is no reference-less invocation. Same for the ffmpeg `libvmaf` filter: it is a **two-input sink-style framesync filter with no output pad** — distorted pad first, reference pad second. Practical consequence for us: feed our copy as BOTH inputs; the distorted path is what gets scored. |
| Route 2: static ffmpeg "puts `camb` inside ffmpeg so it can chain into the existing probe-film.sh pass… exactly like blockdetect sits today" | **[REVISED — mechanism wrong, cost partly recoverable]** `libvmaf` cannot be appended to the linear `-vf` chain that feeds libx265 (it terminates the graph; zero output pads). It needs `-filter_complex` with a `split` of the decoded stream into `[dist][ref]` pads plus explicit `-map`s — a restructure of each of the 8 sample invocations, not a one-token splice. Still ONE decode per sample inside the same ffmpeg process, so the "no second decode" property survives; "exactly like blockdetect sits today" does not. Also §6.1's checklist item "confirm `x265`/`libvmaf`/`camb`" — drop `camb`, it does not exist; check `libvmaf` only. Note CUDA libvmaf does not implement CAMBI (issue #1567) — irrelevant here, we have no NVIDIA, but do not chase `libvmaf_cuda`. |
| pyiqa has no CAMBI | **[VERIFIED]** — CAMBI ships only inside libvmaf |
| Cost "~10–20 s over 32 s at 720p" | **[CONSISTENT]** prior survey line 55 verbatim; design doc measures 9.9–14.4 s/sample *including* detectors. Still extrapolated, as tagged. |

### Dataset-side numbers

| Claim | Verdict |
|---|---|
| blurMean vs complexity Spearman −0.197 (n=1031) | **[VERIFIED]** recomputed on fresh pull: **−0.199** (drift from data refresh, not error) |
| Spirited Away at 99th pct blockMean 6.60 | **[VERIFIED]** exactly: 6.6022 = p99 of live blockMean (max is No Country for Old Men, 10.363) |
| blockdetect = Muijs & Kirenko 2005, `period_min=8 period_max=24` | **[VERIFIED]** against ffmpeg filter docs (those are the defaults) |
| gridRatio needs its own decode, not chainable | **[VERIFIED]** from `probe-noise-origin.sh`: separate decode of ~48 frames at a chosen bright timestamp + node analyser; different scene selection than the probe's 8×4s grid |
| "single existing decode pass" (§5) | **[MINOR]** it is 8 separate short ffmpeg invocations (one per sample), not one process — wording only, the splice-point analysis is unaffected |

### Formula-lever arithmetic (§4)

| Claim | Verdict |
|---|---|
| sqrt halves a relative error on the argument | **[VERIFIED]** |
| AP=1.5 → −18 points at BPP+ 100 | **[VERIFIED]** 100/√1.5 = 81.65 |
| Cap AP ≤ 1.6 → ≥ −20 | **[VERIFIED]** 100/√1.6 = 79.06 (−20.9) |
| "~a quarter-band" (twice) | **[FALSIFIED — understates]** bands are 25 points wide; −18/−21 is **~0.7–0.8 of a band**, i.e. it crosses a full band boundary (green→orange at 100→82). Say "most of a band", not "a quarter-band". |
| "an errant AP of 2.0 … gets half-credited (sqrt), the gentlest failure mode" | **[REVISED — understates without the cap]** 100/√2 = 70.7 → **−29 points**, which lands a clean green film BELOW the red threshold (75). The sqrt shields relative error, not band membership. The AP ≤ 1.6 cap is therefore load-bearing, not cosmetic — state it as required, not recommended. |

### New findings (not in the report)

1. **Grain-as-dithering is a second grain interaction, and it cuts AGAINST detection.** CAMBI ships an anti-dithering filter precisely because dithered content reads as less banded; film grain IS dithering. So on grainy dark gradients — Schindler's-List-class stock, complexity 0.3511 — CAMBI can UNDER-fire exactly where the report says grain "aggravates banding perception". §6.3's proposed test probes the wrong direction (it asks whether CA fires falsely on grain, not whether it stays silent). The claim "Test 1 is CAMBI's home turf, not its blind spot" is overconfident: grain masks ringing (§3.4 concedes this) by the same masking argument that could mute CAMBI. Add the reverse test: CA on a known-banded-but-grainy ramp must NOT read clean.
2. **`window_size` default 63 px is a visual-angle constant (~1° at 4K seating), so it is resolution-coupled.** The probe scales samples to width 1920 with letterboxed heights 528–1076, so the same pixel window subtends different angles per title — a cross-title comparability caveat the report does not mention. Either fix the sample geometry or record `window_size` alongside the score.
3. **§3.7 "chroma-inclusive mode in research form"** — could not be confirmed in any shipped libvmaf doc; keep [DIRECTION] but treat as unverified folklore until a source exists.

### Bottom line

Every environment fact and dataset number checks out (and jellyfin-ffmpeg upgrades to VERIFIED).
The three corrections that change *work*, not just words: (a) there is no `camb`/`cambi` filter to
wire — plan around the two-input `libvmaf` filter and a `-filter_complex` restructure of
`probe-film.sh`; (b) the vmaf CLI always wants `--reference` and `--distorted` — point both at our
file; (c) the AP cap is what keeps an artifact-term failure out of red, and "quarter-band"
understates its reach. Plus one new validity risk: grain-as-dithering may suppress CAMBI exactly on
the grainy dark content this detector was chosen for.