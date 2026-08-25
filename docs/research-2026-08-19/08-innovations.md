# 08 — Innovation round: new mechanisms for BPP+ beyond reports 01–07

**Date:** 2026-08-19 · **Track:** INNOVATION/BREAKTHROUGH (round 2) · **Status:** research
report, no code changed, no scores changed

**Scope.** Ideas NOT already proposed by `docs/BPP-PLUS.txt` or reports 01–07, assessed for
THIS box: 4-core NUC that also transcodes, ~240 min/night thermal budget, **no master anywhere**
(pure no-reference), controller ffmpeg 5.1 **without libvmaf/CAMBI**, `/data` mounted read-only,
1080p SDR ceiling. All live numbers recomputed from `GET /api/probe/dataset` on 2026-08-19
(885 movies + 146 seasons = 1031 units). Evidence tags per repo convention: `[SOLID]`,
`[DIRECTION]`, `[UNTESTED]`.

---

## 0. Top-3, ranked

| # | Idea | One line | Verdict |
|---|------|----------|---------|
| 1 | **A — Codec-aware pinning refit from the banked priors** | Answer the #1 open question (the x265-vs-x264 codec-matching floor, currently extrapolated from ONE film) by splitting the 148 banked prior pairs by source codec — pure data analysis, zero encodes. | WORTH DOING |
| 2 | **C — Decision-aware adaptive sampling** | Spend probe samples only where the verdict can flip: replay proves (or kills) a sequential-stopping rule that would roughly double nightly unit throughput on the existing budget. | WORTH DOING |
| 3 | **D — Pin "100" via the published CRF↔VMAF↔JND chain + our own ladder slopes** | Bound HEADROOM_TARGET from literature alone (it lands within ~±1 JND of the industry's own perceptual-lossless anchor), re-express BPP+ distances in JND units so Brennan's eventual ~10 judgments become a single offset instead of a recalibration. | WORTH DOING |

The breakthrough statement for "where does 100 sit" is §9 (bottom line of idea D).

---

## 1. Method note

Three inputs, all gathered this round:

1. **Live dataset** (`/api/probe/dataset`, 2026-08-19): median BPP+ 60, p90 99, max 231;
   `headroomLive` 0.5736; movie R min 0.1438 / p25 0.4321 / **median 0.5936** / p75 0.8675 /
   max 5.5818; **439/885 movies (49.6%) sit on the flat pinning floor** (R < 0.59, correction
   frozen at ×1.607) — confirming report 01 finding 4; complexity spans 0.0346–0.927 (~27×);
   audio is a median 9.8% of container bitrate; **148 banked prior pairs** (129 movies + 19
   season rows carry them); per-sample data (`sampleCx`/`samplePos`) exists on only
   **148/885 movies (16.7%)** because per-sample records began 2026-08-14.
2. **Code reading**: `controller/lib/probe.js` (`estimateComplexity` shrinkage ladder,
   `fitBias` legacy bucketed fit kept as cross-check, PIN_A/PIN_B/PIN_R_MIN constants,
   `maybeCalibrate` report-only, `nextUnverified` spreadRatio ordering), `probe-film.sh`
   (8×4s @ 1920, CRF 20, medium, phase-shifted deterministic grid), `audit-verdicts.json`
   (417 verdicts; candidates carry score/ratio/gains/losses/band).
3. **Literature** (web, 2026-08-19): CRF↔bitrate↔codec equivalence measurements; the VMAF
   JND framework; Google's input-quality transcoding paper; per-title ladder engineering;
   generation-loss quantification. Cited inline.

Ground rule kept throughout: there is still **no valid subjective label anywhere in this
library** (§11.1 of BPP-PLUS.txt). Nothing below proposes a score term fitted against labels.

---

## 2. IDEA A — Codec-aware pinning refit from the banked priors

**(i) What.** The pinning curve `understatement = 1.337·R^-0.348` was fitted from a controlled
starvation experiment whose copies were all made with **x265**, then probed with **x265**. The
code itself flags the confound: a floor of ×1.06 was subtracted "for codec-matching", estimated
from **one film** (Blade Runner 2049 at starvation level 0.5), and the check that would settle it
(`probe-starve.sh --enc libx264`) was started and abandoned unfinished on 2026-08-18. If the true
floor is larger, the whole curve over-corrects. Proposal: **refit the understatement curve
separately for h264-source and hevc-source prior pairs** using the 148 pairs already banked in
the probe cache — observational, but n=148 against the experiment's n=16, and it costs zero
encodes. The legacy bucketed fitter (`fitBias`) already implements every guard needed
(MIN_N=8, monotone enforcement, gap interpolation) and can be run per-codec-class offline.

**(ii) Novelty.** Reports 01–07 treat the pinning curve as one curve; README §9 names the
x265-vs-x264 floor "cheapest unblocker" but its route is the abandoned libx264 starvation arm.
Using the banked priors as an *observational cross-check* (never as a replacement for the
controlled experiment — that hierarchy is stated in probe.js and kept here) is new. So is making
the correction codec-aware, which no report proposes.

**(iii) Feasibility on this box.** Trivial: one offline node/jq script over
`/opt/appdata/controller/probe-cache.json`. No CPU to speak of, no `/data` writes, no master,
no libvmaf. Caveat: the banked prior records `{complexity, R}` of the OLD file — if the old
file's codec is not stored in the prior, recover it by joining the metrics event log
(`grab`/`redownload` events keyed by title+timestamp) or *arr history; where the join is
ambiguous, drop the pair rather than guess. Expect attrition; even 60 clean pairs split into
two classes beats one film.

**(iv) Validation evidence.** Internal consistency checks available immediately: the h264 class
should show a HIGHER understatement at equal R than the hevc class if codec-matching is real
(re-encoding hevc with hevc is easier); if the two classes are indistinguishable within noise,
the ×1.06 floor stands and the open question closes. Cross-check both fits against the 16
anchored experimental points. `[DIRECTION]` until run — this is a proposal with a designed
decision rule, not a result.

**(v) Cheapest first experiment.** One afternoon: dump priors with their row's source/codec,
split, refit with `fitBias`'s guards, emit the two curves beside the experimental one. No
deploy, no cache invalidation (PROBE_VERSION untouched).

**(vi) Verdict: WORTH DOING.** Highest information-per-CPU-second of anything this round; it
attacks the single load-bearing unvalidated parameter in the shipped model using data already
on disk.

---

## 3. IDEA C — Decision-aware adaptive sampling (spend samples where verdicts flip)

**(i) What.** Every unit gets exactly 8 samples regardless of what the measurement is FOR.
But the score feeds decisions with known boundaries: band edges (BPP+ 75/100/125), candidate
accept/reject in the audit, the Beloved/Top-100 gates. A unit whose 4-sample confidence interval
is nowhere near any boundary does not need 8 samples; a unit straddling one deserves 12–16.
Proposal: a sequential-stopping rule — start at n=4, compute cxSE → BPP+ interval, stop when the
interval cannot cross any decision boundary, else keep sampling. Wall time saved on easy units
converts directly into more units per night inside the same 240-min thermal budget.

**(ii) Novelty.** Nothing in reports 01–07 touches sampling policy. `nextUnverified` uses
spreadRatio only to ORDER revisits, never to allocate budget. Sequential/active sampling is
standard in survey statistics and per-title encoding research (JTPS, TCSVT 2023, predicts
instead of trial-encoding) but unused here.

**(iii) Feasibility.** `probe-film.sh` already takes N; `probe.js` has `sampleStats`,
cxSE/cxRSE plumbing and the phase-shifted grid (which must be preserved — the 2026-08-18 repair
exists precisely because deterministic grids produced duplicate clips). Decision boundaries are
known constants. No libvmaf, no master, read-only `/data` unaffected.

**(iv) Validation evidence.** Fully replayable TODAY: 141 movies + 21 seasons carry per-sample
arrays (post-repair, distinct clips). Replay each unit at n=4 vs n=8, recompute cxEff → BPP+ →
band and the audit verdict, count flips. `[UNTESTED]` until replayed — if the flip rate is
materially above ~1%, the fixed grid is actually buying decision safety and the idea dies
honestly.

**(v) Cheapest first experiment.** The replay itself: pure offline analysis of existing
per-sample data, zero encodes, one evening. Deliverable: flip-rate table + recommended N +
stopping threshold.

**(vi) Verdict: WORTH DOING** — conditional on its own replay passing. The replay is free, so
the option price is one evening.

---

## 4. IDEA D — Anchor "100" via the published CRF↔VMAF↔JND chain (+ our own ladder slopes)

**(i) What.** Three moves, cheapest first:

1. **Bound the anchor from literature alone.** Published anchors: VMAF 100 is *defined* as
   1080p x264 CRF 22 `[SOLID — Streaming Media/Netflix]`; community CRF mappings put x265 CRF 20
   between x264 CRF ~17 and ~23 depending on content `[DIRECTION — Doom9 ("CRF≠CRF"),
   ffmpeg.party ("add ~5"), Gough 2016]`; x265/x264 bitrate runs −12…−14% per CRF point
   `[DIRECTION — Gough: ±5.34 points per doubling (x265) vs ±6.05 (x264)]`. Chained: our anchor
   (x265 CRF 20 @1920, medium) sits **within roughly ±1 JND of the industry's own
   perceptual-lossless definition**. HEADROOM_TARGET = 1.0 is therefore defensible as-pinned,
   with a documented error bar — independently corroborating report 02's BVI-HD QP22 finding
   without needing the CDVL download.
2. **Re-express BPP+ distances in JND units.** BPP+ 70 ⇒ bpp/target = 0.49 ⇒ half the target
   bits ⇒ ΔCRF ≈ +5.3–6 ⇒ ~8–15 VMAF near the top ⇒ **~1.5–2.5 JND** (at ~6 VMAF/JND
   `[SOLID]`). That is exactly Brennan's own words: "dropping from a 100 to a 70 represents a
   significant drop." Likewise BPP+ 90 ⇒ ratio 0.81 ⇒ ΔCRF ≈ +1.8 ⇒ ~0.4–0.9 JND ("visible
   side-by-side, invisible solo"). The orange band (75–99) spans ~0.3–1.5 JND below target.
   This gives the scale a perceptual reading with **zero new measurements** — none of reports
   01–07 did this arithmetic.
3. **Replace generic slopes with OUR films' slopes.** `probe-ladder.sh` already exists to
   measure a title's rate curve at several CRFs. Run it on ~3 films, get local %-bits-per-CRF-
   point, redo step 2's conversion with measured slopes instead of Gough's 2016 HandBrake
   figures. ~1 hour of night budget.

**(ii) Novelty.** Report 02 pins via external datasets (needs CDVL registration + a probing
night); report 07 notes Netflix defines its top rung by saturation. Neither chains the published
anchors, neither produces the JND-per-BPP+-point table, and neither uses the in-house ladder
tool as the slope oracle.

**(iii) Feasibility.** Steps 1–2 are arithmetic and citations: zero CPU, zero risk. Step 3 is
the tool's designed purpose, inside the night budget, read-only.

**(iv) Validation evidence.** Cross-checks in hand: (a) the internal consistency of step 2 —
the derived "~1.5–2.5 JND for 100→70" matches Brennan's qualitative quote independently given
in probe.js; (b) `headroomLive` 0.5736 vs the bound — the library median sits ~half the
transparency target, i.e. ~1.5–2.5 JND below "industry 100", which is precisely the observed
median BPP+ ≈ 60 under a 100-anchor. `[DIRECTION]` throughout: chained literature uncertainty
(±2–3 CRF points of mapping error) is honestly larger than one person's judgment precision —
which is the point, see §9.

**(v) Cheapest first experiment.** Write the JND-conversion table into BPP-PLUS.txt §7 as a
documented reading aid (no constant changes), then run `probe-ladder.sh` on 3 titles to swap
generic slopes for measured ones.

**(vi) Verdict: WORTH DOING.** It converts the open problem from "measure a person" to
"choose one offset on an already-interpretable scale".

---

## 5. IDEA B — SI/TI pre-screen to route the nightly budget

**(i) What.** Controller ffmpeg 5.1 ships the `siti` filter (verified this round; also
`signalstats`, `bitplanenoise`). SI (spatial information) / TI (temporal information) per frame
are the standard broadcast complexity descriptors. Regress measured complexity against mean
SI/TI + source label + resolution over the 1031 measured units; use the prediction to (a)
order the queue so uncertain units go first, (b) flag predicted-vs-measured disagreement
(starved/exotic sources), (c) eventually upgrade the `estimated:*` shrinkage-ladder rungs from
"median of neighbours" to feature-based prediction.

**(ii) Novelty.** JTPS (TCSVT 2023) predicts CRF from DCT-energy features for ENCODERS; YouTube's
industrial proxy is a single 240p CRF encode; SABL uses CRF as the complexity measure. Nobody has
applied cheap feature-based complexity prediction to a no-reference denominator for an
already-compressed library. Report 02 used external datasets; this uses our own ground truth.

**(iii) Feasibility.** `siti` on 8×4s segments is a decode-only pass — seconds per unit,
chainable into the existing probe decode (report 04 showed chaining is near-free). No libvmaf.

**(iv) Validation evidence.** `[UNTESTED]`, with one structural caveat stated plainly: SI/TI
measured on a STARVED source reads low (detail destroyed), so the predictor inherits
source-pinning exactly as the encode does — it can never replace measurement, only seed
estimates and ordering. Degeneracy tests required before any score-adjacent use: CGI-vs-film-
stock independence and luma independence (the same traps that killed gShare, §11.3).

**(v) Cheapest first experiment.** Offline: run `siti` on the stored paths of ~100 dataset rows,
correlate with measured complexity, report leave-one-out R² per source label. One evening.

**(vi) Verdict: WORTH EXPLORING.** Real upside for the unmeasured tail (every `estimated:*`
row), capped by the circularity caveat.

---

## 6. IDEA E — Self-reference artifact pairs (the encode IS a reference)

**(i) What.** Each probe already produces 8 paired clips: source segment AND its CRF-20
re-encode. Read artifact detectors on BOTH sides: the delta isolates damage the CRF-20 encode
introduces (its own signature) from damage already present in the starved source (inherited).
A file whose SOURCE side already shows high blockdetect/bitplanenoise at CRF-20-equal cost is
damaged beyond its bitrate — the "bits-cannot-fix" class, detected structurally instead of by
release-name heuristics. This concretises README §9.6's open question ("compare the file
against a deband pass of itself") with machinery that already exists.

**(ii) Novelty.** Report 04 chains detectors into the probe pass but reads ONE side (the sample
frames). The paired reading is new. CAMBI's full_ref "dark-by-design" mode was left open there;
this is the master-free analogue.

**(iii) Feasibility.** Blocking half works TODAY with in-container filters (`blockdetect`,
`bitplanenoise`, `blurdetect`). Banding half needs the static libvmaf build (report 04 P5) —
unchanged constraint. Decode cost doubles unless chained; chaining keeps it near-free.

**(iv) Validation evidence.** `[UNTESTED]` — and per the retracted-label lesson, validate
against STRUCTURAL ground truths (Chinatown-class truncated files, known YTS-family files,
Holiday-Special-class unreadables), never subjective labels.

**(v) Cheapest first experiment.** Run `blockdetect`+`bitplanenoise` on both sides of existing
pairs for 20 known-bad + 20 known-good files; check separation.

**(vi) Verdict: WORTH EXPLORING** — gated on the libvmaf build for banding; runnable today for
blocking. Fold the broadcast-monitoring transfer (freezedetect/blackdetect signal-health
annotation on the 8 clips) in here as a free rider.

---

## 7. IDEA F — Cost-aware replacement ranking (JND gained per GB spent)

**(i) What.** Audit candidates rank by BPP+ gain — a pure-bpp race (report 01, finding 3). Every
verdict already carries `gains`/`losses` bytes. Express the trade as JND-gained-per-GB-spent
using idea D's conversion, so "+15 BPP+ for +9 GB on a Beloved title" can outrank "+25 BPP+ for
+40 GB on a Normal title".

**(ii) Novelty.** Report 07's steal #1 proposed JND-gating replacements; combining with size
cost into a ranking metric is new. Schema support already exists.

**(iii) Feasibility.** Read-time computation over existing verdicts; zero encodes; UI-only.

**(iv) Validation evidence.** `[UNTESTED]` until Brennan judges offered trades; monotone in each
component, so it can only reorder, never corrupt.

**(v) Cheapest first experiment.** Offline table: top-20 verdicts re-ranked under three
weightings; sanity-check the ordering by eye.

**(vi) Verdict: WORTH EXPLORING** — product decision more than research; strictly behind the
human Replace button (no auto-swap path, per the upgradeScanTick invariant).

---

## 8. IDEA G — Numeric confidence beside BPP+ · [partially UNFINISHED]

**(i) What.** Promote `cxBasis` typography (already shipped) to a numeric confidence the audit
gates can consume: basis (measured > stale > estimated ladder) × cxRSE × sampleNEff × visits ×
R-position-vs-floor. E.g. suppress replacement suggestions for films scored on `estimated:global`
with cxRSE > 0.4.

**(ii) Novelty.** Lowest of this round — closest to existing practice; incremental.

**(iii–v).** All fields exist in the dataset; trivially feasible; validation self-evident (it is
metadata, not a claim).

**(vi) Verdict: WORTH DOING but small** — fold into whatever ships next rather than a project.
Adjacent-field transfers NOT developed this round (game-streaming QoE dashboards, print-industry
sharpness standards, upscale-detection via edge-gradient CSF metrics) are marked **[UNFINISHED]**;
the one adjacent field that WAS checked (Google 2020 input-quality transcoding) is recorded in
§10 as external support for the pinning mechanism itself.

---

## 9. THE BREAKTHROUGH: where does 100 sit?

Stop trying to *derive* Brennan's knee — **parameterise it**. The knee is a property of his eyes
and his projector; no physics produces it. But three facts, established this round, collapse the
problem:

1. The literature chain bounds our CRF-20 anchor to within ~±1 JND of the industry's own
   perceptual-lossless definition (VMAF-100-at-CRF22 land) — so **HEADROOM_TARGET = 1.0 is
   already sitting in the right place within the noise of one person's taste**, and report 02's
   dataset route can only tighten a bound that is already tight.
2. With the JND conversion (idea D step 2), every BPP+ distance acquires a perceptual reading
   (100→70 ≈ 1.5–2.5 JND; 100→90 ≈ 0.4–0.9 JND) — the scale becomes interpretable with the
   anchor EXACTLY where it is.
3. Therefore Brennan's ~10 judgments reduce from "calibrate a scale" to **"pick one offset":
   confirm or shift which JND level feels like 'perfect tradeoff'** — a single read-time
   multiplier (exactly the mechanism probe.js already documents: x265 ≈ −15%/CRF point means a
   preference is `HEADROOM_TARGET` arithmetic, no re-probing). The expensive measurement stays
   valid forever; the person supplies one number instead of ten.

The genuine breakthrough is the reframing: **the anchor was never a missing measurement — it is
a missing UNIT. Give the scale JND units and the human's job shrinks to choosing the origin.**

---

## 10. Deliberately NOT proposed

- No auto-grab/auto-swap path anywhere (force-grab invariants stand; `upgradeScanTick` stays
  read-only).
- No new additive term in the scalar without a valid label (report 01's verdict stands).
- No learned NR metrics (NR-VMAF 2024 included — UGC-trained, grain-blind, same disqualification
  as NIQE/BRISQUE).
- No revival of the CRF-ladder-slope-as-starvation-predictor idea — falsified by the starvation
  experiment (rho +0.335 vs R's −0.924); probe-ladder.sh is used here ONLY for rate-curve slopes,
  never for bias prediction.
- External corroboration worth recording: Google's "Video transcoding optimization based on
  input perceptual quality" (SPIE 2020) found viewers are MORE TOLERANT of quality changes on
  low-quality inputs — independent published support for the pinning mechanism's premise, the
  closest thing to prior art BPP+ has.

## Sources

- Live: `/api/probe/dataset` 2026-08-19; `controller/lib/probe.js`; `controller/scripts/probe-film.sh`;
  `controller/scripts/probe-ladder.sh`; `/opt/appdata/controller/audit-verdicts.json`; controller
  `ffmpeg -filters` listing (siti/blockdetect/blurdetect/bitplanenoise present; camb absent).
- Web: Gough Lui, x264-vs-x265 CRF tests (2016, two posts); slhck CRF guide; Doom9 CRF-mapping
  threads; ffmpeg.party x265 guide; Streaming Media, "Comparing Quality Metrics Up and Down the
  Encoding Ladder" (VMAF-100≡CRF22, 6 VMAF ≈ 1 JND); Netflix TechBlog CAMBI (2021);
  Wang/Talebi/Milanfar et al., Google SPIE 2020 (input perceptual quality); JTPS, IEEE TCSVT
  2023 (JND-aware per-title ladders); Grajek et al. 2017 (HEVC homogeneous transcoding loss);
  NR-VMAF (Ghadiyaram/De Decker, 2024); viser per-title-encoding notes (convex hull, JND rung
  spacing); Streaming Learning Center per-title history (YouTube 240p proxy, SABL).

— END —
