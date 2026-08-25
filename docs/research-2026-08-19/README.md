===============================================================================
LITERATURE + COMMUNITY RESEARCH ROUND, 2026-08-19
Executive summary of 7 parallel research tracks on BPP+
===============================================================================

What this is: one research effort over docs/BPP-PLUS.txt, run in two rounds by
parallel agents. ROUND 1 (2026-08-19): 7 tracks (1 adversarial + 6 literature/
community). ROUND 2 (2026-08-20): 9 agents — 7 re-verified reports 01-07 claim
by claim against live data, 1 hunted novel innovations (report 08), 1 mined the
per-film dataset for trends (report 09). GOAL WAS INFORMATION, NOT CODE —
nothing below has changed BPP+ or any file on disk. Each report carries its own
round-2 appendix; this README is the map and the honest bottom line.

How to read the numbers: all "live" figures were recomputed from
GET /api/probe/dataset on 2026-08-19 (885 movies, 146 seasons). Where they
disagree with docs/BPP-PLUS.txt §7-9, the LIVE NUMBERS WIN — the doc's snapshot
section is stale (report 01, finding 2). NOTE: one orchestrator-created number
in an early prompt (Parasite BPP+ 155) was WRONG — it was `bppPlusFlat`, not
`bppPlus`. Parasite is genuinely BPP+ 218 (live, and matches the doc). No report
inherited the error; 01 recomputed from live data.

EVIDENCE TAGS as in BPP-PLUS.txt: [SOLID] [DIRECTION] [UNTESTED].

REPORT INDEX
  01-adversarial-review.md   the attack. The 5 findings below (+ R2 re-check).
  02-datasets-calibration.md Thought A: calibrate BPP+ against labelled datasets
  03-itu-nr-metrics.md       Thought D: ITU-T P.1203/P.1204, NR + learned metrics
  04-artifacts-banding.md    Thought B: banding/CAMBI + which formula lever
  05-grain-contrast.md       Thought C: how industry really handles grain
  06-forum-community.md      Reddit/Doom9/TRaSH chatter + film-anecdote table
  07-netflix-techblog.md     Netflix tech blog 2015->2026 deep dive
  08-innovations.md          R2: novel ideas + feasibility (top-3 ranked)
  09-data-mining.md          R2: per-film dataset trends + reproducible snippets

===============================================================================
1. THE ADVERSARIAL BOTTOM LINE (report 01)
===============================================================================
"The shipped index is more defensible than the document that describes it."

Top 5 findings, by severity:

  1. [SOLID, NEW, MAJOR] THE PINNING CURVE'S R IS AUDIO-POLLUTED.
     R = srcBitrate/probeBitrate uses the CONTAINER rate (audio in), while §3.2
     deliberately removed audio from the numerator. Video-only R runs up to 43%
     lower; where R sits above the flat floor the correction is UNDER-applied,
     inflating BPP+ up to ~+8.7% (median ~+1.8%), preferentially on the
     multi-dub/lossless-audio class §3.2 says NEVER to flatter. Fix is a
     one-line change (srcBitrate - audioBps), already instrumented.
     This is the single most dangerous live issue found this round.

  2. [SOLID, MAJOR] THE DOC'S §7-§9 NUMBERS ARE STALE. Live: 885 movies,
     median 60 (doc: 64), p90 98 (109), max 231 (217) = 2036: Nexus Dawn,
     bad-share 73.9% (64.7%), only 26 films with complexity >= 0.30 (doc: 82),
     152 units carry cxRSE (doc: "10"). The doc's own §0 rule says re-run 7-9
     when the model changes; it wasn't done after the 2026-08-18 recalibration.

  3. [SOLID, epistemic] CANDIDATE RANKING IS A PURE-bpp RACE; THE PROBE
     CANCELS OUT. Every candidate is scored with the ROW's target (as §0 says),
     so within-film ranking is video-bpp x codec x res only. The whole
     per-film/pinning apparatus rescales a constant there. This is BY DESIGN and
     GOOD (a bad denominator can't corrupt a same-film decision), but the doc
     over-sells the probe's precision as decision-driving.

  4. [SOLID] 49.5% OF MOVIES SIT ON THE FLAT PINNING FLOOR (R < 0.59), where
     the correction is a constant, not the measured curve. The experiment never
     reached that range (16.A.2 untouched). Harmless by design, but the dominant
     file class gets its correction from under-measured territory.

  5. [MINOR] §8.7's "sign-flip" (flat +0.195 -> live -0.574, grain rewarded ->
     penalised) does NOT reproduce on any live axis. Direction survives (+0.44
     flat / -0.33 live, raw), magnitude doesn't.

VERDICT ON THE ONE-NUMBER QUESTION (1.2d, open this round): keep the single
scalar + gates. A term needs a weight, a weight needs a valid label, and there
is still no valid label (11.1). The real fights are R, the sqrt exponent, and
the headroom anchor — not scalar-vs-vector. Candidate addition to the wording:
describe BPP+ as "bitrate-adequacy per content", not "quality".

THE MOST VALUABLE NEXT EXPERIMENT (all tracks agree): 16.A.4 (forced-choice
A/B) — run AFTER the one-line audio-R fix.

===============================================================================
2. THOUGHT A — CALIBRATION AGAINST LABELLED DATASETS (report 02)
===============================================================================
VERDICT: FEASIBLE for the latent axis, headroom anchor and band edges. Three
traps, all avoidable. One hard limit: NO dataset can certify the grainy half of
the library (no public SDR-1080p dataset combines film grain with compression
scores).

Viable datasets, ranked:
  - BVI-HD — THE primary candidate. 1080p SDR, per-content compression ladder
    INCLUDING the visually-lossless rung (QP22, DMOS<10) and reference-anchored
    DMOS. Enables pinning headroom (QP22 ~= 100), band edge (QP37 ~= 75), and
    the per-content sqrt exponent. ~1-3 GB, needs CDVL registration.
  - MSU CVQAD (the NeurIPS'22 benchmark) — pairwise scores, 7 codecs at
    1/2/4 Mb/s (Brennan's plateau!). Scores free on GitHub; video link DEAD
    today — needs rehost.
  - Netflix public — clean-content MOS ladders at 1080p; Drive-gated; secondary.
  - KonViD-1k / LIVE-VQC / YouTube-UGC — absolute unpaired MOS = STRUCTURALLY
    THE SAME CONFOUND that killed the in-house blind test (11.1). Range-check
    only; never weight against them.

WHAT CALIBRATION CAN PIN (in increasing reliability): (1) the exponent 0.5 via
a per-content rate-MOS ladder [DIRECTION]; (2) HEADROOM_TARGET vs the median ->
the BVI-HD QP22 anchor suggests our "100" is a visually-lossless encode —
HEADROOM_TARGET 1.0 may be defensible after all [DIRECTION]; (3) band edges;
(4) the pinning shape.

FIRST STEP (one night, ~35 min of probing): register CDVL, download BVI-HD's
subjective file + ~32 clips at QP22 and QP37, probe each, and read off three
pre-registered numbers: where QP22 lands (headroom), where QP37 lands (band
edge), and the per-content exponent vs 0.5.

===============================================================================
3. THOUGHT B — ARTIFACT PROBING, esp. BANDING (report 04)
===============================================================================
VERDICT: CAMBI is the right tool, it is the one artifact BPP+ is structurally
blind to, and it is grain-safe by construction (it keys on FLAT regions = the
thing that separates it from CGI vs film-stock degeneracy). NOT obtainable
today — ffmpeg 5.1 in the controller has no --enable-libvmaf; host is 4.2.
Route: a one-time STATIC libvmaf build (standalone vmaf CLI or BtbN static
ffmpeg), ladder-only, never the ffmpeg whose x265 made the 1031 complexity
measurements. ~10-20 min build.

WHICH FORMULA LEVER (the question you asked): if banding ever enters the score,
multiply the DENOMINATOR — target' = target * artifactPenalty, capped ~1.6 so a
misread costs <= ~2 points/1.6, and the sqrt halves the error. Never additively
in score space (unshielded error, needs fitted constants with no valid labels).
gridRatio -> gate/annotation (best UNTESTED candidate for the bits-cannot-fix
class). blockMean/blurMean -> nowhere in the score (11.4 stays).

Cheapest first move: CAMBI + blockdetect + blurdetect chained into the SINGLE
existing 8x4s decode pass — near-zero extra CPU, because those frames already
exist.

===============================================================================
4. THOUGHT C — GRAIN, DARKNESS, CONTRAST (report 05)
===============================================================================
VERDICT: BPP+ is CORRECT-BY-CONSTRUCTION on grain, and there is a defensible
position: industry spends the bits on grainy masters (transparent-encode goal =
what CRF-20 in the denominator already is) or models the grain out and
resynthesises it (AV1 pipeline). Grain IS screen content; a grainy 1080p file
SHOULD score lower at equal bits. The current denominator already does this —
all 26 films with complexity >= 0.30 sit at R <= 1.09, i.e. EVERY grain-heavy
film on the box is under-provisioned, and the new 1080p projector will show it.

The misremembered "misreported grain as artifact" episode (11.1) is the KNOWN
limit, not a bug: nobody can separate grain from compression noise by eye on a
single unpaired clip. P.1204.3 — the industry's own no-reference standard —
specifies the SAME blindness: "Effects due to source generations, such as
signal noise... are not reflected."

Position on the formula (6 points):
  1. Denominator — KEEP. Grain-yes: it IS the transparency target.
  2. NO grain-bonus term (it's the PSNR error in reverse).
  3. grainShare (16.A.5) — annotation only, NOT a score input. Sound diagnostic,
     not score-safe: gShare already collapsed into brightness (r=-0.885), plain
     denoise strips texture-that's-content, and grain is signal-dependent so a
     single scalar lies.
  4. NEW natural gate: complexity-high + R-low = "grainy title far below its own
     transparency target" — already computable, just needs saying. All 26
     grain-heavy films qualify.
  5. Darkness/banding = a SEPARATE axis, gate not term. CAMBI's full_ref mode is
     the "dark by design" reference (compare file vs its own source).
  6. blockMean/blurMean/wBPP+ stay dead.

===============================================================================
5. THOUGHT D — ITU-T P.1203/P.1204 AND THE NR LANDSCAPE (report 03)
===============================================================================
VERDICT: P.1204.3 is NOT runnable on this box in the serving path — no
python/pip/scons in the controller container, and the reference implementation
is basic-model-only + GPLv3/non-commercial extensions. It is DEPRECATED for
in-house HRED/HRQoM anyway (the successor ITU-T work moves to learned models).

What survived the dive:
  - P.1204.3 is the closest existing thing to BPP+, but its blindness to grain
    and to source generations is SPECIFIED IN THE STANDARD. Pointed at a grainy
    1976 Bluray rip it would read grain as degradation — the exact 11.1 trap.
  - Worth ONE out-of-band ladder experiment (5 titles, clean + grainy) as a
    ranking cross-check + a documented negative control.
  - Learned NR metrics (LIQE/FAVER/Q-Align): UGC-trained, grain-blind —
    do not pursue.
  - NIQE/BRISQUE bake in noise-as-distortion — disqualified for this library.
  - Static VMAF (clean titles only) remains the honest calibration axis for the
    ladder, blocked on the libvmaf build (same build as CAMBI).

The three literature gaps the doc names (§17 tail) are STILL open and are
Brennan's landscape:
  1. Already-compressed consumer video quality — the literature is forensic
     DOUBLE-COMPRESSION DETECTION (binary), never a graded quality score.
  2. Grain-aware no-reference metrics — P.1204.3 explicitly excludes them; only
     creative-intent frameworks (MHV'22) exist, not scalars.
  3. Headroom-without-a-master — Google's 2020 already-compressed paper is the
     only match; BPP+'s experiment record (starvation experiment) is currently
     PRIMARY literature, not supporting. Nobody else has graded re-encode
     headroom without a master.

===============================================================================
6. COMMUNITY KNOWLEDGE (report 06)
===============================================================================
16 film anecdotes collected (12 align with the model, 2 band-semantics
disagreements, 1 artistic-intent special case). Headline findings:

  - "bpp is NOT a quality measure" is the loudest forum complaint (Doom9). The
    per-film CRF-20 denominator is literally the missing variable most people
    never have — but the absolute 100-anchor stays unpinned until Brennan rates
    ~10 films.
  - THE GRAINY-B&W REMUX PARADOX: 12 Angry Men's Criterion remux measures 67 and
    Taxi Driver's BD 65 — red band with NO better copy on the market. "Bad" can
    mislabel a sterling disc on deliberately expensive content. This is the
    strongest argument for an ANNOTATION ("grainy, expensive content") beside
    the band, and for never acting on a single band without the whole row.
  - 10-bit/HEVC crediting: the community treats 10-bit as a banding-cure quality
    tool; the model's x1.6 (efficiency) and the decode-`bad` (hardware ceiling)
    are TWO separate policies, and presenting them as one score is misleading.
  - Rules of thumb: StreamShark's bpp ~0.1 target is the flat constant everyone
    re-invented; the probe per-film version is the correction the community
    lacks. "Size should scale with content cost and provenance, never resolution
    alone" is the carry-away line.

===============================================================================
7. NETFLIX TECH BLOG 2015->2026 (report 07)
===============================================================================
VERDICT: no knee exists anywhere — Netflix's own per-title curves are
exponential with a quality-SATURATION threshold on the top rung ("increase in
bitrate not resulting in material improvement"). Matches the ladder pilot
(FINDING 1) and externally anchors the still-open "where does 100 sit": a
per-title saturation rung is how they define their 100.

Other transfers: VMAF #1192 stays open (their worst metric problem is grain);
Netflix even REJECTS low-quality mezzanines at ingest (VIS 2024) — every one of
their pipelines assumes a pristine master; production grain numbers exist (film
grain synthesis = -66% on They Cloned Tyrone, "we lack a dedicated quality
model for FGS").

Top-3 steal shortlist: (1) JND/visible-gain gating of replacements
(convex-hull wasted-points idea); (2) per-title saturation -> grab-size ceiling
(from probed cxEff); (3) R-guided audit ordering (their input-quality work, in
reverse). Everything else is master-encoder-only and structurally unavailable.

===============================================================================
8. WHAT TO ACT ON FIRST (ranking across all 7 reports)
===============================================================================
  P0  The one-line audio-R fix (biasFactor's x-axis): correctness for every
      score, one-line, already instrumented. Recompute §7-9 after.
  P1  Re-run the doc's numbers (§7-9) per its own §0 rule — the snapshot is
      stale and upstream consumers (AGENTS.md, reports) cite the stale profile.
  P2  Re-word BPP+ as "bitrate-adequacy per content" — cheap, kills the
      "quality" misreading the whole grain debate rests on.
  P3  The audio-R fix + 16.A.4 forced-choice A/B is the highest-value experiment:
      it re-tests everything at once (R, headroom, exponents) on the right x-axis.
  P4  Register CDVL today (the rate-limit). BVI-HD calibration = one night,
      ~35 min probing, three pre-registered read-outs.
  P5  Static libvmaf build (ladder-only) → unlocks CAMBI (banding gate) + static-
      VMAF on clean titles inside one dependency.
  P6  grainShare as annotation only; "grainy + under-provisioned" as a label/GATE
      (all 26 high-complexity films qualify); banding as a second axis, never a
      term.
  P7  Do NOT: add terms to the scalar, build the library-wide ladder cron, adopt
      learned NR metrics, use KonViD/YouTube-UGC MOS as weights, revive gShare.

===============================================================================
9. OPEN QUESTIONS TO CLOSE (deliberately left, in value order)
===============================================================================
  1. The true x265-vs-x264 floor (16.A.1) — CHEAPEST, unblocks the pinning
     coefficient which is now the only load-bearing unvalidated parameter.
  2. Audio-R fix, then a controlled-verdict pass (16.A.4) — the unblocker for
     every weight/band/constant.
  3. BVI-HD calibration: where does QP22 land vs 100? Does the exponent hold
     0.5 per content?
  4. Where does "100" sit in Brennan's eyes when the 1080p projector lands
     (~10 films, paired A/B, per 16.A.4 protocol).
  5. Whether the pinning floor (R<0.59, 49.5% of movies) should be extended
     downward with 1/8-1/16 starvation points (16.A.2).
  6. Whether CAMBI's full_ref "dark-by-design" reference is implementable
     without a master (it may reduce to "compare the file against a deband/
     gradfun pass of itself").
===============================================================================
10. ROUND 2 — RE-VERIFICATION + INNOVATION + DATA MINING (2026-08-20)
===============================================================================
Per-claim verdicts live in each report's "## ROUND 2" appendix. The results
that change the picture across reports:

  1. [MAJOR] THE P0 FIX IS NO LONGER A ONE-LINER (01 R2). probe-film.sh
     prefers the VIDEO-stream bitrate, so 526/885 files (59%) ALREADY have
     audio-free numerators — subtracting audioBps there double-counts and
     deflates BPP+ up to -7.7%. Needs a provenance flag on SRCBPS selection
     (subtract only on the container-total path). Tail revised: max inflation
     +8.02% (one film, The Witch); genuine R-drop up to 47.5%.

  2. [MAJOR] STORED R IS CODEC-NORMALISED (01 R2, 06 R2, 09). The dataset's R
     is src/(probe x eff_src) — h264 rows divided by 1.6 — so naive src/probe
     recomputation does NOT reproduce it (30/400 within 1%). In-controller
     scoring is internally exact; offline analyses must use eff_src.

  3. [SOLID] WHAT SURVIVED: stale-doc finding (now fixed in BPP-PLUS.txt),
     pure-bpp candidate race, 49.6% flat floor, sign-flip direction
     (+0.442/-0.330 raw, +0.252/-0.518 cxEff), all 16 film anecdotes (06),
     every headline Netflix quote verbatim with URLs (07), P.1204.3's
     grain-blindness clause (03).

  4. [FALSIFIED] CVQAD "unreachable" — live HuggingFace mirror + email form;
     NEW dataset LEHA-CVQAD (ACM MM 2025, 6240 clips) is now the primary
     ladder candidate. "P.1204.x all no-reference" — P.1204.4 is full/reduced-
     reference (strengthens the conclusion). Literature-gap 1 as stated —
     1stepVQA (IEEE TIP 2021) is a graded NR score for compressed video; the
     surviving gap is DECOMPOSITION (per-film content cost vs adequacy).

  5. [GOTCHA CONFIRMED] CAMBI via libvmaf requires a reference input anyway
     (point ref and distorted at the same file, upstream issue #1202); cannot
     splice into the probe's -vf chain (-filter_complex restructure needed);
     may UNDER-fire on grainy dark content (grain = dithering). AP<=1.6 cap is
     load-bearing: uncapped AP=2.0 drops a clean 100 to 70.7.

  6. [DATA] (09) Per-film denominator moves the median film 127/885 rank
     places, r(shift, complexity) = -0.746. Worst-PRECISION units are not the
     grainiest (cxRSE~cx = -0.13; spread-driven +0.46); only 15/163 units have
     sampleNEff >= 32. "WEBDL starves grainy titles" REJECTED (WEBDL-1080p med
     R 1.06 = least starved tier; the starved class is small Blu-ray rips of
     mid-complexity films). Replacements push complexity UP (median +30%,
     107 up / 35 down) and R 0.47->0.91. Complexity falls monotonically with
     year; the "grainy 1970s" is not a peak.

  7. [BREAKTHROUGH CANDIDATE] (08) Treat "where does 100 sit" as a missing
     UNIT, not a missing measurement: re-express BPP+ distances in JND terms
     (100->70 ~= 1.5-2.5 JND, matching Brennan's own "significant drop"
     quote); his ~10 judgments then collapse into choosing ONE offset on an
     already-interpretable scale. Top-3 ideas: codec-aware pinning refit from
     the 148 banked pairs (settles the x265-vs-x264 floor, zero encodes);
     decision-aware adaptive sampling (n=4 vs n=8 replay could ~double nightly
     throughput); the JND chain above.

REVISED ACTION RANKING (supersedes section 8):
  P0  Provenance-flagged audio-R fix (was "one-line"; see item 1).
  P1  Codec-aware pinning refit from banked priors (new; cheapest unblock).
  P2  16.A.4 forced-choice A/B on the corrected R axis (unchanged).
  P3  CDVL/BVI-HD calibration; CVQAD/LEHA-CVQAD now live alternates.
  P4  Static libvmaf build -> CAMBI via same-file reference + filter_complex
      restructure (gotcha above), still ladder-only.
  P5  JND-unit reframing (paper exercise before any probing).
  Do-NOT list unchanged (section 8 P7), plus: never recompute R naively from
  src/probe offline (item 2); never cite blockMean correlations from the
  withdrawn blind test (05 R2).

===============================================================================
END
===============================================================================