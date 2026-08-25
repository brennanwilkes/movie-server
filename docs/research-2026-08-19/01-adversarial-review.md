# Adversarial Review of the BPP+ Score

**Author**: review agent, adversarial critic (per doc §0 handoff pattern).
Sources: `docs/BPP-PLUS.txt` (1407 lines, the subject), `docs/DESIGN-CRF-PROBE.md`,
`docs/HANDOFF-2026-08-17.md`, `docs/REPORT-grain-2026-08-13.md`,
`docs/audit-2026-07-31/raw/RESEARCH-quality-metrics-2026-08-01.md`,
`docs/audit-2026-07-31/raw/bitrate-plateau-2026-08-01.md`, plus code
(`controller/lib/probe.js`, `lib/audit.js`, `lib/arr-inspect.js`) and live data
(`GET /api/probe/dataset`, two snapshots: `probe-dataset.json` gen
2026-08-19T16:39Z and `live-dataset.json` gen 2026-08-20T00:05Z, 1031 units,
885 movies + 146 seasons).

This is a **critique document**. It attacks the shipped model and the document
that describes it; it does not fix them. One structural question (one-number vs
terms, the prompt's "criteria 5 / 16.A") is answered because the prompt asks.

Severity notation: CRITICAL / MAJOR / MINOR. Findings tagged `[SOLID]`,
`[DIRECTION]`, `[UNTESTED]` per the doc's usage.

--------------------------------------------------------------------------------

## 1. Executive verdict

**The shipped index is more defensible than the document that describes it.**
Four of the five biggest problems are with **BPP-PLUS.txt's own asserted
numbers** — they are stale, internally contradictory, or fabricated from a
stale base — and exactly **one** is a genuine model defect with user-visible
consequence. Ordered:

| # | Finding | Sev | Basis |
|---|---------|-----|-------|
| 1 | **`biasFactor` is applied to an audio-polluted R.** R = `srcBitrate/probeBitrate` with the **container** rate (audio in). §3.2 removes audio from the numerator, but the pinning curve's argument still carries it. Video-only R is up to 43% lower than container R in this library; when R sits above the flat floor (0.59), the correction is **under-applied by up to 15%**, inflating BPP+ by **up to ~+8.7%** (median ~+1.8%), preferentially on the **multi-dub/lossless-audio releases §3.2 says NOT to flatter**. I verified this arithmetically against all 885 movies (423 above the floor; 411 change biasFactor when audio is excluded). | **MAJOR** | §3.2 vs §5.2; probe.js:1040-42 |
| 2 | **The document's snapshot numbers are stale or wrong.** §7 "886 movies, med 64, p90 109, max 217" vs live 885 / med 60 / p90 98 / max 231. "bad" share 573→654 (73.9%). §8.7 "Q1 24% bad, 11% wow" is false on *any* axis (raw 60.6%/5.9%; cxEff 44.8%/10.0%). §4.4 "only 10 units carry cxRSE, 1 pooled >8" is now **152** (132 mv + 20 seas; 104 with sampleN>8). Spearman pairs listed in §8.7 don't reproduce: live (raw) flat-cx **+0.44** vs doc +0.195; live-cx **−0.33** vs doc −0.574. Trap-11's 0.837 is **0.7922** live. The doc's own §0 rule ("re-run 7-9 when you touch the model") was skipped after the 2026-08-18 recalibration. | **MAJOR** | §7, §8.7, §4.4, trap 11 |
| 3 | **The sign-flip story survives only on a different axis.** The *direction* of §8.7 (per-film target penalises grain) is real; the *magnitude* is not as claimed. The popular "0.195→−0.574 flip" numbers are not in the live data. | **MINOR** (claim), none (score) | §8.7 |
| 4 | **Candidate comparisons are a pure-`bpp` race; the probe cancels out of its own decision.** `audit.js` scores every candidate with `bppIndex(c.bpp, row.key)` — the row's target. For within-film comparisons the entire probe/pinning/headroom apparatus can only rescale a constant; **ranking between releases of the same film is bitrate-per-pixel (× codec × res) alone**. probe.js:1568 says this is intended; the document never states that the per-film denominator *cannot affect the candidate ranking it is sold for*. | **MAJOR** (epistemic) | §1.2(e), probe.js:1551-68, audit.js:502,1785 |
| 5 | **49.5% of movies sit on the flat pinning floor (R<0.59 clamped), where the correction is a constant rather than a curve** — exposing the under-sampled region that is exactly where the experiment's own range (0.59-2.27) did not reach and 16.A.2 says to extend. Harmless by design, but it means the *dominant* class of file (starved copies) gets its correction from under-measured territory. | MINOR→MAJOR if 16.A.2 never runs | §5.2, §13 Q8 |

**The single most dangerous thing in the model** is finding 1: a silent,
systematic, *disfavoured-class* over-credit present in every score in the
library and proportional to how much it matters (starved files are the ones the
correction exists for, and they are the ones it under-delivers on for exactly
the multi-track class §3.2 calls out). Several of its victims are new releases
(Obsession, The Secret Agent, Crime 101, The Whale).

**The single most valuable next experiment** is **16.A.4** (forced-choice A/B)
run *after* a one-line audio-R fix — because until the R fed to §5.2 is
video-only, every fitted pinning coefficient is estimated against the wrong
x-axis, and after the 2026-08-18 recalibration the fit line's params are the
one piece of the model that is *load-bearing and unvalidated* (result 3 says as
much and itself flags "at risk: the coefficient").

**Bottom line**: keep BPP+ as a single normalized measure (section 4). Fix #1
by construction, not by research. Re-run every number in §7–§9 (the doc's own
§0 rule — the reports in AGENTS.md and this doc did *not*). Then 16.A.4. Do not
add terms to the scalar.

--------------------------------------------------------------------------------

## 2. Attack log, in adversarial depth

### 2.1 A1 — audio-polluted R biases the pinning curve (MAJOR, NEW)

**Mechanism.** `R = srcBitrate / probeBitrate` (probe.js:1040-42). On the
numerator the *container* rate is used (audio in). The probe rate is video-only
(x265 null-output of the clip). So `R` is overstated wherever audio is
non-trivial. `biasFactor = clamp(1.337 * R^-0.348, 1, 2)`, held flat below
R=0.59 — so an **inflated R makes biasFactor too small** (weaker correction).

**Measured on all 885 movies** (`live-dataset.json`, per-row `srcBitrate` +
`audioBps`):
- median audio share of the container: **9.8%**; max 65.4% (matches §3.2).
- 423 movies have container-R above the flat floor (0.59). Of those:
  - median bias under-application: **3.6%** of the factor
  - max **15.4%** (The Witch, Obsession, The Secret Agent, The Man Who Knew
    Infinity — roughly the ~37% audio-share cluster)
- 411 movies change their biasFactor when audio is excluded.
- BPP+ inflation: median **~+1.8%**, max **~+8.7%** (>= +8% for about 8 films,
  a scattering of multi-audio 2020–2026 releases).

**Why it's worse than it sounds.** §3.2 exists precisely to stop the numerator
flattering multi-dub/lossless releases; §5.2 reintroduces the same bias one
layer deeper, on the *correction* input, on the starved class it was designed
to fix, and nothing in the doc's §5.2, trap 11 or §13 mentions it. trap 11
mentions audio in `R` only to warn against plotting "the ratio BPP+ divides by"
(which is audio-free), never that the *correction curve's argument* carries it.

**Fix (worth stating, not doing here).** Compute the R fed to biasFactor (and,
for consistency, to the over-supply/downsize path) on `(srcBitrate - audioBps)`
instead of `srcBitrate`. All rows already carry measured `audioBps` (1031/1031).
This is a one-line change in the sample-R computation, not a research item. This
fix also *tightens* trap-11's 0.837→0.7922 gap monotonically, because it removes
the audio share from `R`.

### 2.2 A2 — the document is stale, and its own §0 rule requires keeping it fresh

BPP-PLUS.txt §0: "Re-run the numbers in sections 7-9 when you touch the model;
they are all derived from live data and go stale silently." The 2026-08-18
recalibration (pinning fit + refinement sessions since) is exactly such a touch;
the doc's quoted numbers predate the batch. Concretely, live (`live-dataset.json`):

| Assertion in doc | Doc value | Live value (movies) |
|---|---|---|
| units | 886 | 885 |
| BPP+ p10/p25/med/p75/p90/max | 46/54/64/83/109/217 | 46/51/60/75/98/231 |
| bad<75 / warn / ok / wow | 573/188/86/39 (64.7%) | 654/145/57/29 (73.9%) |
| R med | 0.64 | 0.59 |
| cxRSE-carrying units (§4.4) | "only 10, 1 pooled>8" | 152 (132+20); 104 with sampleN>8 |
| grainy >=0.30 population (§8.7 "82") | 82 / maxR 1.17 | **26** / maxR 1.09 |
| Q1 cleanest med BPP+ / bad / wow | 84 / 24% / 11% | 71 / 60.6% (raw) / 5.9% |
| Q4 grainiest med BPP+ / bad / wow | 49 / 81% / 0% | 55 / 73.0% / 1.4% |
| Spearman(flat, cx) | +0.195 | **+0.442** (raw) / +0.254 (cxEff) |
| Spearman(live, cx) | −0.574 | **−0.331** (raw) / −0.518 (cxEff) |
| trap 11 median bpp+/(100√R) | 0.837 | **0.7922** |

The changes are not noise. The "bad" share jumped ~9 points; the max score moved
to 231 (Nexus Dawn); the top-10 changed (Blue Velvet dropped off, Sinners
entered). Most agents/AGENTS.md text was written against the stale profile.

### 2.3 A3 — §8.7's "penalises grain" survives only on the wrong axis

Direction is real (flat 0.13 rewards grain-expensive content; live per-film
target discourages it), but:
- The famous numbers **+0.195 / −0.574 don't reproduce** on any axis I tried
  (raw, cxEff). Live: +0.44/+0.25 (flat) and −0.33/−0.52 (live) respectively.
  The doc's own §4.1 uses raw complexity for its headline quartiles, so quoting
  the "−0.574 flip" as if it were computed on the same (raw) axis is wrong.
- "82 movies with complexity >= 0.30" is **26** now; highest R among them is
  1.09, not 1.17; still zero "wow". The *conclusion* (grain is starved, not
  indulged) survives; the *contrast* the doc uses to sell it is off.
- The lone `[SOLID]` here is really `[DIRECTION]` until the doc's own open
  question 0 (valid label) is answered.

### 2.4 A4 — the probe cannot affect within-film candidate ranking (MAJOR, epistemic)

`audit.js:502`/`:1785`: `rescoreCand` sets `bppPlus: bppIndex(c.bpp, row.key)`.
`:1729`: upgrade gain is `bppIndex(candBpp, row.key)` vs `bppIndex(row.bpp,
row.key)`. Same key → same target → **the denominator divides out of every
within-film comparison**. Therefore:
- Complexity, biasFactor, HEADROOM_TARGET, cxEff — the entire per-film machine —
  only move the *labels/bands*, never *which release wins* for a given film.
- probe.js:1551-68 claims this is the point of the keying ("a candidate for a
  film IS that film"), but the doc's §1.2(e) sells the index as "ranking
  candidate releases against each other and against the copy already held" and
  presents the per-film denominator as its load-bearing justification. Both
  cannot be the real story. The decision BPP+ makes for the Upgrade tab is
  `√(candBpp/rowBpp)`, i.e. pure bpp × codec-scale × res-scale.

This is **not** a complaint that the code is broken — the property "the
denominator cancels, so a bad target can't corrupt a same-film decision" is
genuinely valuable and should be *documented as a feature*. It is a complaint
that the document over-sells precision as decision-driving when it is
label-driving. (Decision-driving across films, e.g. "is my copy of X adequate
for its content", is real; within-film it is not.)

### 2.5 A5 — the pinning floor greases the majority of the library

`biasFactor` is clamped flat below R=0.59. **448/885 movies (50.6%) sit at
biasFactor >= 1.60** (i.e. at/above the translucent floor); another class sits
above the well-measured top (R>2.27, isolated 8/16 pts). The flat-below region
is *the* region that matters for the identified defect (starved copies). This
is honestly documented (§5.2 "no extrapolation", §13 Q8) and the fix (16.A.2,
extend the starvation experiment below 0.59) is item #2 in the doc's own list.
Rating: MINOR as engineering, MAJOR if 16.A.2 is allowed to stay dormant.

### 2.6 A6 — internal contradictions worth fixing in the document

1. **§2.4 CRF-equivalence column** uses −13.6%/CRF as if fixed, while §6 says
   it varies 2× (−9.9 to −19.4) between films and "is not an input to BPP+".
   The column is a handrail; it is presented as more.
2. **§7 "886 movies" vs 885 full rows everywhere** — off-by-one, likely a film
   added/removed mid-edit; §10.2's "187 of 886 (21%)" reuses the wrong
   denominator (live: 120/885=13.6% on-disk; 187 is via originalFilePath).
3. **§5.3 bucket 0.50-0.70 = 1.414 (doc) vs 1.429 (live biasFit json)** — small
   but shows the cross-check numbers (§5.3 "live fit 2026-08-18, 112 pairs")
   are themselves drifting (live says pairs=113).
4. **probe.js:1723 comment says n=15** while the live `pinning` metadata block
   says "8 films, 16 points" and §5.1 says 16 controlled points. One point
   dropped somewhere; nobody wrote down which. Minor, but it's exactly the kind
   of unreportable drift §16.B.6 protects against.

### 2.7 A7 — what did NOT have to happen (the "clean" runs I tried to break)

For fairness, the numbers that held up under direct attack:
- `bppPlus == round(100·√(bpp/target))` exactly (max abs error 0.4997 = the
  rounding), and `cxEff == complexity·biasFactor` (0 rows off by >0.1%).
- `biasFactor == clamp(1.337·max(R,0.59)^-0.348,1,2)` exactly on all 885 rows.
- The R identity R = srcBitrate/(complexity·W·H·fps at probe geometry) held on
  883/885 movies (2 mid-pooling entries differ — Sully + one other — because R
  and cx were captured at different visits; a pooling race, cosmetic).
- Ordering of top/bottom/oversupplied/starved lists is stable between the two
  dataset generations.
- The supply-quantization §7.2 findings reproduce: 335 films in 1.9–2.4 Mb/s
  (doc said 329), 58 in 0.7–1.0 (58), 94 in 5.8–6.6 (doc 70). Good.

--------------------------------------------------------------------------------

## 3. What survives the attack, and how solid it is

`[SOLID]` — verified against live data and reasoning:
- **Denominator-cancellation inside a film** (A4's silver lining). A bad target
  cannot corrupt a within-film upgrade/grab call. This is the strongest property
  of the shipped design.
- **Audio removal from the numerator** (§3.2) works and is the *correct*
  direction; it is merely incomplete (A1 exposes the missing audio removal in
  the sibling statistic R).
- The **formula, band edges, and rounding** implemented in arr-inspect.js are
  faithful to the document and to `/api/probe/dataset` (verified bit-exact).
- **Source-tier and audio gates** (§10) are properly separate from the score
  (re-encode, 4K, imax). No abuse found.
- **biasFit/monotone guards** (§5.3) behave as documented (1.429 vs 1.414
  bucket drift aside).
- **Supply dissects into presets** (§7.2) — robust across both data snapshots.

`[DIRECTION]` — plausible, correct shape, wrong/unvalidated magnitude:
- The **√-exponent** "200 = half the error of 100" rests on one SSIM ladder
  (Lawrence) whose own errors at the top of the range are large (see
  bitrate-plateau doc). The *direction* (more bits → less visible error) is
  surely right; the *claim* (error ∝ bitrate^-0.5, ratio 2:1 at 200 vs 100) is
  a fit, not a measurement, and the doc itself labels it the weakest link. If
  the true exponent were e.g. -0.35, 200 wouldn't mean half-error at all. Keep
  it, but stop quoting it as a perceptual fact until 16.A.4 produces paired
  labels.
- **§8.7's sign flip**: real direction, wrong numbers (A3).
- **"Source pinning is the one demonstrated defect"** (§16 intro): direction
  solid; coefficient live-fit, audio-polluted x-axis (A1), floor unrecognised
  (A5).

`[UNTESTED]` — I could neither confirm nor falsify; the doc's own tags agree
(no valid subjective label anywhere):
- gridRatio (9.2), blockMean/blurMean (11.4), grainShare (16.A.5), CRF-fixed-
  quality claims (§4, open Q4), CAMBI/VMAF recommendations, "flatter Q4 but
  it's all starved" — see §13 Q0: nothing here is decision-grade until labels
  exist.

--------------------------------------------------------------------------------

## 4. The one-number question (the prompt's structural ask)

**Question re-read from the doc's own terms:** "Single scalar BPP+, gates
beside the score vs terms inside it." The doc history (§2.5 §16.A) has drifted
toward "one number plus annotations", exactly as 1.2(d) demanded. Is that
right?

**Recommendation: keep the one-number design — but stop describing BPP+ as a
quality rating and describe it as *bitrate-adequacy per film content*, with
everything else as gates.** Reasons:

1. **Every attempt to enrich the scalar collapses without a valid label.**
   Terms need weights; weights need a fit; the only "fit" ever run against a
   subjective yardstick was retracted (11.1). GrainShare, gridRatio, watermark,
   any of them *as terms* would import one more arbitrary coefficient on top of
   the already-unvalidated exponent and anchor. There is no evidence basis to
   do it and a long history of that exact failure (11.1, 11.3, 11.5, 16.B.3).
2. **The scalar is, in fact, adequate for its real decision.** Within a film,
   A4 shows decisions are bpp-driven (with codec/res/source/audio gates) — the
   scalar's per-film part only matters across films, where it does exactly what
   it needs (labels a starved copy of Deliverance below a fat copy of
   Armageddon). We do not have a demonstrated failure where a *term* would have
   changed an outcome; we have many where a term would have imported noise.
3. **The "single number" is not where the multi-dimensionality belongs.** The
   doc's own 16.A.7 future step — "87 — GREAT, compression strong · grain
   normal · artifacts low" — is the right shape: a scalar *plus four spoken
   gates/annotations*, never a weighted blend.
4. **The one place the scalar SHOULD earn back a term is its headline claim:
   the exponent.** If we ever move off √(bpp/target), it should be *after*
   16.A.4 labels, and as a rescalabable monotone function of the same two
   variables (a curve, not a blend), preserving 1.2(d).

Caveat the prompt will want: my verdict is **not** "BPP+ is right". It is
"one-number is the least-wrong architecture we have evidence for, and the
remaining fights are all about the *inputs* (R, exponent, headroom target),
not the *scalar vs vector* choice."

**Do not do**: a multi-factor dashboard, adaptive scoring, per-profile score
blends, or any term whose weight isn't recoverable from a valid label.

--------------------------------------------------------------------------------

## 5. Response to the prompt's four meta-questions

- **(a) "Does the doc's model support the claims?"** No, half of §7-§9 does not
  even support itself (§2.2, A3). The *code* is fine; the *report* is not.
- **(b) "Are the getters/candidates/labels doing the same thing?"** No.
  Candidates get the row's key (A4) → label-only; the document sells per-film
  precision as decision-critical (§1.2(e)). The summary in AGENTS.md
  ("bppIndex(candidate, key=row.key)") is correct, but silent on consequence.
- **(c) "Is the one real quantity trustworthy?"** With A1 fixed (audio-free
  R), the *within-film* quantity is trustworthy (denominator cancels). The
  *across-film* quantity depends on the exponent and headroom anchor, which
  are unvalidated (QV0). So: trustworthy for its decision, untrustworthy as an
  absolute "this is 60 on a perceptual scale".
- **(d) "What is the single most dangerous thing and the single most valuable
  experiment?"**
  - Decision-dangerous: A1 (audio-polluted R under-correcting the starved,
    multi-track class). Slow-burn-dangerous: A2 (a document that misstates the
    live distribution will mislead the next four invariants and the next agent,
    exactly as §11.1 misled blockMean).
  - Most valuable experiment: 16.A.4 forced-choice A/B, prefixed by the
    one-line audio-R fix — because it is the only route that can validate the
    exponent, the headroom anchor, R, and the grain story in one pass, and all
    four currently rest on unvalidated (or retracted) substrate. (16.A.1, the
    x264 confound run, is cheaper but only de-risks a coefficient; do it first
    if the night budget is scarce, but 16.A.4 is the unlock.)

--------------------------------------------------------------------------------

## 6. Summary table for the orchestrator

| # | Attack | Severity | One-line fix / falsification path |
|---|--------|----------|-----------------------------------|
| 1 | Audio-polluted R feeds biasFactor → under-correction on multi-track starved files | MAJOR | Use (srcBitrate−audioBps) in sample-R; keep audio out of the pinning axis. Re-recalibrate curve on clean R |
| 2 | All §7–§9 numbers stale / wrong relative to live data; violates the doc's own §0 | MAJOR | Re-run §7–§9 against /api/probe/dataset after 2026-08-18 changes |
| 3 | §8.7 sign-flip story quoted with unreproducible magnitudes | MINOR | Claim direction only, or recompute on cxEff axis |
| 4 | Per-film target cannot affect within-film ranking (probe is label-only there) | MAJOR | Say so in §1.2(e); stop selling per-film precision as decision-critical within a film |
| 5 | Pinning floor covers 50.6% of movies; 16.A.2 never run | MINOR→MAJOR | Run 16.A.2 (requires no new method, ~10 min/pair) |
| 6 | Doc internal contradictions (886 vs 885; 1.414 vs 1.429; n=15 vs 16 pts; CRF column) | MINOR | Reconcile the off-by-ones; annotate n |

Danger ranked: **A1 (model) > A2 (document) > A4 (epistemic)**, A5/A3/MINOR
below. Value ranked: **16.A.4 > 16.A.1 > 16.A.2 = §7–§9 re-run > 16.A.5 (grain
capture, time-sensitive) > 16.A.6 (VMAF axis, blocked on label)**.

--------------------------------------------------------------------------------
END
--------------------------------------------------------------------------------

## ROUND 2 — ADVERSARIAL VERIFICATION (2026-08-19)

Verifier: second-pass adversarial agent. Every number below recomputed with python3 from
`/tmp/opencode/probe-dataset-now.json` (gen 1787192740935 = 2026-08-20T02:25:41Z; 1031 rows =
885 movies + 146 seasons) — NOT from this report's text, BPP-PLUS.txt, or any earlier snapshot.
Code claims checked against `controller/lib/probe.js`, `controller/scripts/probe-film.sh`,
`controller/lib/arr-inspect.js`, `controller/lib/audit.js`. No code or data was modified.

### 0. What stored R actually is (resolves the round-2 prompt's note; load-bearing for A1)

Stored `R` is **NOT** `srcBitrate/probeBitrate`. It is
`R = srcBitrate / (probeBitrate × eff_src)` with `eff_src = 1.6` for H.264/MPEG4 sources and
`1.0` for HEVC sources (`probe-film.sh:161-171` — codec normalisation to HEVC units).
Verified within 1% on **885/885** movies. Consequences:

- Any analysis comparing raw `srcBitrate/probeBitrate` against the 0.59 floor is testing the
  wrong variable (the floor belongs to the normalised R). This report's A1 arithmetic ("423
  above the floor") used un-normalised R; on fresh data that arithmetic yields 753 above /
  704 changed — matching neither its own 423/411 nor the true 446/434 (below). Its counts are
  unreproducible under either reading.
- The sibling identity A7 claims — `R = srcBitrate/(complexity·W·H·fps)` — is **FALSIFIED as
  stated** (see §7, new-error N3): it can only hold for H.264-source rows, because complexity
  is always H.264-normalised (`probeBitrate×1.6/px`, probe.js:836-840) while R's eff_src is 1.0
  for HEVC sources.

### 1. Finding 1 (audio-polluted R) — [REVISED]: mechanism real, scope cut by ~60%, fix as written would harm

**Code premise, corrected.** probe-film.sh:72-74 does NOT feed R the container rate
unconditionally: `SRCBPS = video-stream bit_rate if present and ≤ container×1.05, else
container total`. So the numerator is a MIX. Classified all 885 movie paths by ffprobe:
**526 VB-matched** (dataset src == per-stream rate → audio ALREADY excluded) vs **359
TB-matched** (src == container total → audio in). Spot checks: Marley & Me (mp4) src 980,060 ==
stream rate, container 1,629,981; Superbad (mp4) 1,695,804 vs 2,521,887; The Witch (mkv)
1,700,572 == container; Drive My Car (mkv) 2,290,004 == container. A1's "R uses the container
rate (audio in)" is true only for the TB subset (40.6%).

**Recomputed on the TRUE (normalised) R, all 885 movies, report's method
(video-only R = (src−audioBps)/(probe×eff)):**
- Above floor: **446** (report 423); biasFactor changes: **434** (report 411). Both +23 vs the
  report — snapshot drift plus its un-normalised arithmetic.
- BPP+ inflation median **+1.84%** — report's "~+1.8%" VERIFIED.
- Max **+8.02%** (The Witch), not "~+8.7%".
- "≥ +8% for about 8 films" — **FALSIFIED**: exactly **1** film ≥8%; 25 films ≥5%.

**The class split changes the conclusion:**
- TB-class (genuinely polluted), above floor: 281 rows, 269 change; median −2.17% BPP+ if audio
  subtracted (i.e. current scores inflated +2.2%), max 8.02%, ≥5%: 11 films. Max genuine R-drop
  **47.5%** (Drive My Car), not "up to 43%".
- VB-class (numerator already clean), above floor: 165 rows, ALL 165 would change — the report's
  fix would spuriously DEFLATE them (median −1.51%, max −7.73%). This is over-correction of
  exactly the kind §3.2 warns about, applied to 59% of the library.
- Direction claim "preferentially multi-dub/lossless": VERIFIED as a trend — median inflation by
  track count: 1tr +1.3%, 2tr +2.8%, 3tr +3.1%, 7tr +4.9% — but the worst single victims are
  2-track dual-language releases (Obsession, The Secret Agent, Crime 101, The Whale, all +7.7%),
  not large dub sets.
- The "max 65.4% audio share" anchor is itself an artifact: for VB files `audioBps/srcBitrate`
  is an audio-to-VIDEO ratio, not a container share. Marley & Me's true container share is
  39.3%; max GENUINE container share ≈ 47.5% (Drive My Car).

**Corrected fix statement:** not "subtract audioBps from srcBitrate" (one line, wrong for 526
files) but "record which numerator SRCBPS used and subtract only on the TB path" — i.e. a
provenance flag in probe-film.sh plus the subtraction at sample-R time. audioBps coverage claim
VERIFIED: 885/885 movies, 146/146 seasons = 1031/1031. Severity stays MAJOR; the defect is real
on ~40% of the library and the fitted pinning curve's x-axis is polluted for exactly those rows
— but the proposed one-liner would introduce a NEW error twice the size of the median one it
fixes.

### 2. Finding 2 (stale §7–9 numbers) — [VERIFIED], with the irony that the report's own replacements have already drifted

Fresh vs report:
- p10/p25/med/p75/p90 = 46 / 51 / 60 / 75 / 98.6; max **231** = Nexus Dawn (argmax confirmed by
  title) — all match the report's row.
- Bands bad/warn/ok/wow = **655 / 143 / 58 / 29**, bad share **74.0%** (report 654 / 73.9% —
  one-file drift, immaterial).
- R median **0.5936** ✓. cx≥0.30: **26** ✓, maxR **1.0877**→"1.09" ✓, zero wow among them ✓.
- Trap-11 median bpp⁺/(100√R) = **0.7922** ✓ exact.
- Supply bands reproduce exactly: 335 / 58 / 94 ✓.
- biasFit: pairs=113 ✓ (doc said 112); bucket 0.5–0.7 F=**1.429** ✓ (doc 1.414) — confirms A6.3.
- **BUT** the report's own §4.4 replacement numbers are stale AGAIN: cxRSE-carrying units now
  **169 (148 mv + 21 seas)**, not 152 (132+20); sampleN>8 now **116**, not 104 (sampleNEff>8
  also 116). Refinement sessions pooled more samples between the report's snapshot and this one.
  This does not weaken A2 — it strengthens it: the decay rate is the finding.
- Formula spot-checks clean: max |bppPlus − round(100·√(bpp/target))| = **0**;
  max rel |cxEff − complexity·biasFactor| = 5×10⁻⁴. A7's first two bullets hold bit-exact.

### 3. Finding 3 (pure-bpp candidate race) — [VERIFIED]

Code confirmed: `rescoreCand` (audit.js ~:498) sets `bppPlus: bppIndex(c.bpp, row.key)`; the
upgrade-gain block (~:1729) computes `curPlus = bppIndex(row.bpp, row.key)` vs
`cndPlus = bppIndex(candBpp, row.key)`; candidate cards (~:1785) same. Same key ⇒ same target ⇒
cndPlus/curPlus = √(candBpp/rowBpp) identically — the entire probe/pinning/headroom apparatus
cancels out of every within-film comparison. The epistemic point stands as written.

### 4. Finding 4 (flat-floor share) — [VERIFIED]

R < 0.59: **439/885 = 49.6%** (claim 49.5% — rounding). Companion A5 number: biasFactor ≥ 1.60 =
**447 (50.5%)** (report 448/50.6%, off-by-one drift). Additionally 23 movies sit above the
experiment's measured top (R > 2.27), which A5 mentions only glancingly.

### 5. Finding 5 (§8.7 sign-flip non-reproduction) — [VERIFIED]

Fresh Spearman, n=885: flat-vs-complexity **+0.442** (report +0.442 ✓); live-vs-complexity
**−0.330** (report −0.331 ✓); cxEff axis **+0.252 / −0.518** (report +0.254 / −0.518 ✓). The
doc's +0.195/−0.574 pair is confirmed absent from live data on both axes. Quartiles (raw
complexity axis): Q1 med **71**, bad **61.1%**, wow **5.9%** (report 71/60.6/5.9 — Δ0.5 pt is
quartile-boundary convention); Q4 med **55**, bad **73.0%**, wow **1.4%** ✓ exact. cxEff-axis Q1:
med 76, bad 45.7%, wow 10.0% (report cited 44.8%/10.0%). Verdict unchanged: direction real,
magnitude claims unreproducible.

### 6. New errors found in THIS report (round-1)

- **N1 (MAJOR).** A1's premise is over-scoped: the R numerator is already audio-free for 526/885
  movies (59.4%) because probe-film.sh prefers the video-stream bitrate. The proposed one-line
  fix would double-subtract there, spuriously deflating BPP+ by up to 7.7% — a new error larger
  than the median one it repairs. See §1.
- **N2 (MODERATE).** A1's tail claim ">= +8% for about 8 films" is false on fresh data: 1 film
  (The Witch, +8.02%); 25 films ≥ +5%. Max is +8.02%, not ~+8.7%. Counts 423/411 → 446/434.
- **N3 (MINOR).** A7's "R identity held on 883/885 (2 mid-pooling entries differ)" is off by two
  orders of magnitude. True state: `R = src/(probe·eff)` holds 885/885; the complexity form holds
  only for single-visit H.264/MPEG4 rows (~762/885); all 44 single-visit HEVC-source films sit
  systematically at ×1.6 (complexity is always H.264-normalised, R's eff_src is 1.0 for HEVC);
  pooled rows scatter widely (Sully 1.41, Dunkirk 0.74, Chinatown 0.69, Drive 1.43).
- **N4 (MINOR).** A1's "max 65.4% audio share … matches §3.2" mixes numerators: for VB files that
  ratio is audio/video, not audio/container. Genuine max container share ≈ 47.5%. The headline
  victim class is unchanged; the quoted extreme is an artifact of the same mixed-numerator bug
  the finding describes.
- **N5 (COSMETIC).** Report's own freshness anchors (152 cxRSE units; 104 sampleN>8; 654 bad)
  have drifted to 169 / 116 / 655 within a day — reinforcing A2 rather than undermining it.

### 7. Round-2 verdict table

| # | Round-1 finding | Verdict | Fresh numbers |
|---|-----------------|---------|---------------|
| 1 | Audio-polluted R | **REVISED** | Real on 359/885 (TB) rows; 446 above floor, 434 change; median +1.84%, max +8.02% (1 film ≥8%); fix must be provenance-scoped, not universal |
| 2 | Stale §7–9 | **VERIFIED** | med 60, max 231 Nexus Dawn, bad 74.0%, trap11 0.7922, supply 335/58/94 all confirm; report's own 152/104 now 169/116 |
| 3 | Pure-bpp race | **VERIFIED** | audit.js rescoreCand/:1729/:1785 all key candidates to row.key; target cancels identically |
| 4 | Flat-floor share | **VERIFIED** | 439/885 = 49.6% at R<0.59; bf≥1.60: 447 (50.5%) |
| 5 | Sign-flip non-repro | **VERIFIED** | +0.442/−0.330 raw, +0.252/−0.518 cxEff; Q1 71/61.1/5.9, Q4 55/73.0/1.4 |

Bottom line for round 3: do A1 as a provenance-scoped fix (flag SRCBPS source in probe-film.sh,
subtract audioBps only when the numerator was the container fallback), then re-fit pinning on
clean R; re-run §7–§9 (again); 16.A.4 remains the unlock. Everything else in round 1 stands.

--------------------------------------------------------------------------------
