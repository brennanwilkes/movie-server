# What BPP+ needs from Brennan, and nothing else

**Written 2026-08-28.** Companion to `docs/BPP-PLUS.txt` (the algorithm),
`docs/BPP-PLUS-EVIDENCE.txt` (the experiments) and `docs/HANDOFF-2026-08-27.md` (state).

This file exists because the board is full of red that is *not* addressed to you. Almost everything
open either closed today or collapsed into one of the items below. The purpose here is to state, as
precisely as possible, **what only you can supply, why no amount of compute substitutes for it, and
exactly what to do.**

There are **two kinds** of human-dependent gap and they are commonly conflated:

- **MEASUREMENTS ONLY YOU CAN MAKE** — your eyes are the instrument. §1.
- **DECISIONS ONLY YOU CAN MAKE** — no measurement settles them because they are choices about what
  the score is *for*. §2.

§3 states what does **not** need you, so the boundary is unambiguous.

---

## 0. The one-paragraph version

Every instrument in this project is validated against other instruments. BPP+ is checked against the
artifact panel; the panel against controlled ladders; perPoint against the panel and against
starvation. **Nothing has ever been checked against whether a film actually looks bad.** The entire
external footing under a year of work is four published numbers (Netflix's CAMBI 2.817, x265
visually-lossless CRF 18–20, −13.6%/CRF, and a BD-rate range that turned out to be the wrong bound for
what it was used for). One evening of forced-choice judgements is worth more than another week of
compute, and — as of today — it is provably the *only* thing that can settle the largest remaining
gap.

**But it is blocked on hardware, not on your time.** There is no projector (§1.4), and a protocol for
this was already written on 2026-08-20 and is waiting on the same purchase. Buying the projector is the
action that unblocks the project.

---

## 1. MEASUREMENTS ONLY YOU CAN MAKE

### 1.1 Why this cannot be automated, stated precisely

This is not "it would be nice to have a human check." As of 2026-08-28 it is a proof.

The complexity denominator (`target ~ cxEff^a`, shipped at `a = 1`, **never fitted**) is the largest
re-ranking gap left. Today I tried to identify `a` from data alone and failed for a structural reason:

> **Every damage measure this project owns confounds content with damage.**
> Banding and blocking, because complexity *masks* them — so they all push `a` downward.
> perPoint, because complexity *supplies* the detail — at fixed bitrate a complex film has more
> destructible detail simply because it started with more, so its complexity coefficient is the sum of
> a negative content term and a positive adequacy term. Measured at −0.0024: that is what a
> *cancellation* looks like, not a small effect.

Combining two contaminated measures yields a third contaminated measure. So `a` is **not identified by
any instrument this project owns, and no cleverness fixes that.** (`docs/BPP-PLUS-EVIDENCE.txt` §E.10.2.)

What breaks the deadlock is a judgement that is **content-aware by nature**. A person asked *"does this
look bad **for what it is**"* supplies, for free, exactly the normalisation no detector has. That is
why §1.2 is not one item among several — it is the identification strategy.

The same argument arrived independently from two other directions this week: perPoint is a
well-validated instrument (reliability 0.945, non-redundant with BPP+ at 67%, damage-like, passes a
specificity test at 19% against a 70% kill line) whose **referent is unnamed** — three candidate units
were tested and all three rejected (starvation ~11×, generations ~10, resolution 1.2% of the spread).
A label naming what it corresponds to is the only remaining route.

### 1.2 The experiment: forced-choice pairs

**Format.** Two clips, same film, same scene, back to back, one question, no scale. *Which of these
looks worse?* Rating scales drift and anchor; a paired choice does not.

> **"Cannot tell" MUST be offered.** An earlier version of this file said to force a choice with no
> "about the same" option. That was wrong, and `docs/PROTOCOL-forced-choice-2026-08-20.md` had already
> settled it: a pair you genuinely cannot distinguish **locates the just-noticeable threshold
> directly**, and forcing a coin-flip there destroys the single most informative answer available.
> Forcing the choice is right for measuring *accuracy*; offering "cannot tell" is right for finding a
> *threshold*, and a threshold is what we actually want.

**Five design constraints, each for a stated reason:**

| Constraint | Reason it is non-negotiable |
|---|---|
| **Blind to the score** | You must not see BPP+, P, perPoint, filename, or bitrate. Knowing the score makes the label a confirmation of the score rather than a test of it. |
| **Randomised order, and randomised sides** | Which clip is on the left must be random per trial, or a side bias becomes indistinguishable from a real preference. |
| **On the projector, not a monitor** | The delivery chain is the question. A phone was used in 2026-08-13 and that test was retracted. **See §1.4: there is no projector, so this constraint currently blocks the whole experiment.** |
| **Every pair shown twice** | This is the constraint people cut first and it is the one that makes the data readable. See §1.3. |
| **Degraded copies written to `/data/research/`, never over an original** | Standing rule: never modify media on disk. `/data` has 1.9T free; `/` has only 33G and is **not** to be used (a previous run filled it to zero). |

### 1.3 Why every pair must be shown twice — the thing that makes or breaks it

If a weak correlation comes back between your labels and the score, there are two completely different
explanations and **no way to tell them apart without this**:

1. the score is wrong, or
2. the score is fine and the labels are noisy.

Showing each pair twice (ideally with the sides swapped) measures **your own self-consistency**, which
is the ceiling on any correlation the labels can possibly show. If you agree with yourself 70% of the
time, then a score-vs-label agreement of 70% is *perfect* — the score is as good as the labels can
detect. Without that number, a 70% result is uninterpretable.

This doubles the trial count. It is still the cheapest thing in the design and the first thing that
should be protected if the session runs long.

### 1.4 *** THERE IS NO PROJECTOR. THIS IS BLOCKED ON HARDWARE, NOT ON YOUR TIME. ***

**Corrected 2026-08-28.** An earlier version of this file said "the projector is native 720p" and
attributed that to `docs/BPP-PLUS.txt`. Both halves were wrong: the doc said the opposite, and I took
the 720p figure from a stale note instead of from the source I cited.

The facts:

- **The projector died 2026-08-01.** There is no delivery display in the house right now.
- **The replacement will be 1080p**, not 720p.
- Every subjective figure gathered before 2026-08-01 was taken through a native-720p projector — i.e.
  through a **44% downscale that hid compression and grain alike.** Those figures *understate* what a
  1080p chain will show.
- The probe's reference width is already **1920**, chosen deliberately to match a future 1080p
  projector, so **nothing needs re-probing** when it arrives. That was foresight worth having.

**Consequences, and they are good news:**

1. **The trade-off I described does not exist.** There is nothing to weigh a monitor against. More
   importantly, the caveat I attached to it — *a null result would mean "not visible on this chain"* —
   **evaporates on a 1080p display.** The downscale that would have masked 1080p differences is gone.
   The experiment gets strictly easier to interpret.
2. **Do not run this on a monitor as a substitute.** The 2026-08-13 attempt was judged on a phone and
   was retracted partly for that reason. A display that is not the delivery chain answers a question
   we are not asking.
3. **This is a purchase, not an evening.** Until the projector exists, §1 cannot run at all. That
   reorders the whole board: the single highest-value remaining experiment is gated on hardware, and
   buying it is the action that unblocks the project.

### 1.5 How many pairs — and the number is bigger than "about 50"

I had been saying "~50 judgements." That was imprecise. Exact one-sided binomial, p < 0.05:

| pairs | correct needed | = accuracy | what it can detect |
|---|---|---|---|
| 15 | 12 | 80% | large effects only |
| 20 | 15 | 75% | moderate–large |
| 25 | 18 | 72% | moderate–large |
| 30 | 20 | 67% | moderate |
| 40 | 26 | 65% | moderate |
| 50 | 32 | 64% | moderate |
| 80 | 48 | 60% | moderate |

And for **80% power** to detect a given true accuracy:

| true accuracy | pairs needed |
|---|---|
| 90% (obvious differences) | 8 |
| 80% | 18 |
| 75% | 26 |
| 70% | 40 |
| 65% (subtle) | 74 |

**The consequence:** 50 pairs answers **one** question properly. It does not answer three. Split
across three questions, 50 pairs gives ~17 each, which can only detect 80%+ accuracy — i.e. only
differences so obvious we would not need an experiment to find them.

> ***** BUT THIS TABLE IS FOR THE WRONG DESIGN, AND THE RIGHT ONE IS FAR CHEAPER. ***
> The numbers above price a *hypothesis test on accuracy* — "can he beat chance?" —
> which needs many independent trials. `docs/PROTOCOL-forced-choice-2026-08-20.md` specifies a
> **threshold search** instead: fix a film and a scene, ladder the starvation level, and find the ratio
> at which you stop being able to tell. A staircase converges on a threshold in **~10 pairs per
> sitting** — which that protocol caps deliberately, because fatigue makes a tired judgement a noisy
> label and noisy labels are what we already have too many of.
> **Use the 2026-08-20 protocol's trial counts, not this table.** The table is retained only to size
> any *accuracy*-style question (§1.6 B and C), and to make the point that such questions are
> expensive — which is one more reason to prefer the threshold design.

### 1.6 The questions — and two of the three I proposed are FORBIDDEN

> ***** PROCESS FAILURE, RECORDED. *** I drafted three experiments here without first checking whether
> a protocol already existed. One does: `docs/PROTOCOL-forced-choice-2026-08-20.md`, written 2026-08-20
> *before any judging so it could not be adjusted to fit a result*. It had already settled two of the
> choices I was re-deriving, and it **explicitly forbids** the design I proposed for two of my three
> questions. **That document is the protocol. This section defers to it.**

#### The rule I violated, and why it exists

The 2026-08-20 protocol ranks pair sources and rules the third out flatly:

> **Cross-film pairs — do not use.** Different content means grain no longer cancels, which
> re-introduces the exact confound that invalidated the first attempt.

That confound is documented and expensive. The **2026-08-13 blind test was retracted** because nobody
can separate grain from compression noise by eye on a single unpaired clip: the judgements correlated
with how *grainy* a film was, not how *starved* it was. ITU-T P.1204.3, the industry's own
no-reference standard, specifies the same blindness — "effects due to source generations, such as
signal noise… are not reflected."

**Pairing the same film with itself is the whole reason the test can work**, because grain is then
identical in both members and cancels exactly.

#### Question A — CALIBRATION. **The one to run. Already specified.**

Fix a film, fix a scene, ladder the starvation level, find the ratio at which you stop being able to
tell. Output is **one number: your just-noticeable threshold in the model's own units.** Run on at
least 3 films spanning complexity — if the threshold tracks graininess rather than the scale, the
per-film denominator has a problem, and that is itself a finding.

The full design, the predicted table, the control pairs, the fatigue cap and the exact `probe-starve.sh`
invocation are in `docs/PROTOCOL-forced-choice-2026-08-20.md`. **Do not re-derive them here.**

#### Questions B and C — perPoint's referent, and P's validity. **BLOCKED BY DESIGN, not just by hardware.**

I proposed matching two *different* films on BPP+ and complexity and asking which looks more
detail-poor (B) or more compressed (C). **Both are cross-film, and therefore both are forbidden by the
rule above.** Matching on BPP+ and complexity does not rescue them — grain and shooting style are not
matched by those two variables, and grain is precisely the confound that sank 2026-08-13.

This matters because it removes the route I claimed yesterday for naming perPoint's referent. A
same-film pair cannot name it either: starving a film changes perPoint *and* everything else at once.

**So the honest status of B and C is: no valid design currently exists.** They are not "waiting on an
evening." Finding a within-film contrast that isolates perPoint is an open research problem, and it
should be recorded as one rather than scheduled as a session.

**The one partial exception has now been checked, and it is closed.** I said I would answer this
without you; the answer is zero. The protocol's *banked replacement pairs* — units holding a prior
measurement with the old file's path — do not exist as pairs:

| | |
|---|---|
| priors carrying `measuredFrom` | 60 |
| old file deleted | 42 |
| path still resolves | 18 |
| …of which **same inode** as the current file (hardlink — one file, two names) | **16** |
| …of which different cuts (runtime differs by 653s and 57s) | 2 |
| **usable pairs** | **0** |

Nor are there duplicates anywhere else: the 146 units with more than one video file are all *seasons*
(episodes, not copies), and **no movie directory holds two video files.**

*(My first pass reported 0 of 60 surviving, which was also wrong — `measuredFrom` is
`path|size|timestamp`, not a bare path, so a plain existence check can never succeed. The real number
is 18 surviving paths and 0 usable pairs, for the hardlink reason above.)*

**So every pair must be MANUFACTURED from one source file.** That is a real constraint. I first wrote
that it limited the labels to the JND question "and nothing else" — **that was too pessimistic, and
here is the corrected version.** Three things are reachable from same-file pairs:

1. **The JND, hence where 100 sits.** Ladder the starvation level; find where you stop being able to
   tell.
2. **The complexity exponent (#99) — the largest re-ranking gap on the board.** I had said this needed
   a cross-film judgement. It does not. Measure the JND *within* each of ≥3 films spanning complexity —
   grain cancels inside each film — then compare the **thresholds** across films. You are comparing a
   *derived quantity*, not two films' appearance, so it is legal. If the exponent is right, the JND in
   BPP+ points is constant across complexity; if it drifts, the drift says which way to move it.
   **Caveat, and it is mine to own:** the 2026-08-20 protocol specifies ≥3 films, but three thresholds
   each carrying their own error cannot fit a slope — that is a smoke test, not an estimator.
   Estimating the exponent realistically needs **6–8 films** spanning the library's 5.5× complexity
   range. So this does not come free with Question A; it makes Question A somewhat longer.
3. **The directions of P and perPoint.** Starvation is not the only contrast we can manufacture: a
   **generation at matched bitrate** is same-film and moves P *specifically* — that is the signature P
   is built on, and `anchor-e2e.js` already produces it. A detail-reducing manipulation is Leg C's
   design with you in place of the instrument.

**And a fourth, which I had written off an hour earlier and should not have.** You said not to treat
the 2026-08-20 protocol as gospel. Its weakest rule is the blanket ban on cross-film pairs, justified
by "grain no longer cancels." That reason is real, but **grain is one of the four things we measure**,
so it can be *matched* rather than cancelled. Tested against the library:

> Requiring simultaneously — raw grain within 10%, |Δz_grain| ≤ 0.25, |Δlog cx| ≤ 0.15, |ΔBPP+| ≤ 10%,
> same codec, height within 5%, same kind, **year within 8**, and |ΔP| ≥ 1.0 —
> **236 qualifying pairs, 94 disjoint.** More than double the ~40 needed for 80% power.

And they are genuinely comparable, not nominal: **Full Metal Jacket (1987) vs Platoon (1986)**, ΔP 3.04.
Radio Days vs Aliens. McCabe & Mrs. Miller vs The Graduate.

So **P's validity is testable after all** — as a second arm behind the same-film calibration, with one
control built in from the start: **include null pairs matched on P too.** If a difference is "seen"
there, the matching isn't working and the arm is void.

**What is still genuinely out of reach: perPoint's cross-film referent.** No matched contrast isolates
it — perPoint moves with content, and matching on complexity does not hold destructible detail fixed.
That one stays an open research problem.

### 1.7 Practical protocol

Superseded — see `docs/PROTOCOL-forced-choice-2026-08-20.md`, which specifies ~10 pairs per sitting,
randomised left/right, **2 identical pairs as controls** (if the controls are not answered "cannot
tell", the session is discarded), answers recorded before scores are revealed, same scene and same room
light, and predictions written down before each pair is shown.

What I can add to it, and will once the hardware exists: the clip pairs pre-rendered and randomised, an
answer sheet with no scores on it, and the analysis run blind.

## 2. DECISIONS ONLY YOU CAN MAKE

These are **not** measurements. No experiment settles them, because each is a choice about what the
score is *for*. They are listed with the number in hand wherever a number exists, because the project's
rule is that a choice should be made with its cost visible.

### 2.1 Where should 100 sit? — and your 5% criterion needs revising

**The decision.** BPP+ 100 currently means "adequately provisioned". The library median is ~67 and you
have long suspected that is too low.

**What is measured and settled:**
- P **cannot** answer this — it is standardised to mean zero across the library, so it is zero-sum by
  construction and *cannot move the median*, ever.
- The absolute artifact thresholds **can**, because they owe nothing to this library.
- **The external bound, which holds regardless of any artifact data:** median 67 is CRF-equivalent
  ~25.5. Moving the median to 100 asserts that CRF 25.5 is transparent, against published x265
  visually-lossless practice of CRF 18–20. **Median-at-100 fails before any of our data is consulted.**
  A median of **75–85** (CRF 21.5–23.3) sits inside the published range.
- Cost of the move, exactly: it is a **pure rescale and preserves every ranking.** Median 75 = ×1.119,
  median 80 = ×1.194, median 85 = ×1.269.

**What is yours:** the acceptable rate. You said *"5% or less of visible artifacts is good enough."*
That was measured against and **0 of 60 films met it.** So either the criterion moves, or almost the
whole library is inadequate — and the second reading is not credible given you watch it happily. This
needs your number, informed by the finished 40-film run.

**Also yours, and newly so:** as of today the scene fraction is known to be a *cut-off*, which the
design rule forbids and which was discarding most of the measurement (counted fraction reproduces at
0.44 for banding and **0.04** for blocking; a smooth mean of the same data reproduces at 0.70 and 0.81).
The recommendation is to state the criterion on the smooth statistic instead. **That changes what "5%"
means**, so the criterion has to be restated in the new units, and only you can say what level of it
you would accept.

### 2.2 What is perPoint *for*? — compression damage, or delivered detail?

**The decision, quoted from `scripts/perpoint-resolution-split.mjs` where it was recorded rather than
silently taken:**

> **(a)** perPoint should measure **compression damage only**, because BPP+'s tier gates already handle
> resolution, and double-counting it would penalise 720p twice.
> **(b)** perPoint should measure **delivered detail**, in which case resolution belongs in it and the
> impossible exchange rate simply means it must not be converted into a bitrate-equivalent.

**Why it is a decision and not a measurement.** A 720p copy of a 1080p film genuinely *is* compromised
— just not by compression. Residualising resolution out of perPoint removes a real quality difference
from the reading. That is a choice about scope, not a confound cleanup.

**The number in hand:** resolution accounts for only **1.2%** of the perPoint residual's spread, so
whichever you choose, the practical effect is small. This decision is cheap. It matters for *what we
say perPoint means*, not for what it does.

### 2.3 The grain axis conflates two artifacts — which one do you care about?

**The decision.** One measurement, two artifacts. On grainy films the grain residual tracks **grain
loss**; on grainless ones it tracks **fine digital detail loss**. Both are real. Both currently go
through one axis labelled "grain kept". No threshold value fixes it: 7% loss of 35mm grain and 7% loss
of digital detail are not equally visible **to you**, and only you can say by how much.

**Status:** the proposed discriminator (gridRatio) was validated at n=2 and **falsified at n=101**.
There is currently **no candidate mechanism**, which is why this has not moved.

**Size, measured today:** deleting grain from P *entirely* — the most extreme possible outcome — moves
a typical film by −5.4% to +6.2%, and leaves the ordering at rank correlation **0.915**. So this is a
small gap wearing a scary label, and I would not spend an evening on it before §1.

**Origin, for context:** this task exists because you said *"I'm concerned that our slider currently is
moving films that I don't consider to really have much grain at all."* Your judgement is the target
here; there is no external standard for it.

### 2.4 The `strength` dial

Ships at 1.0, exposed in the lab as a 0–1 slider. At 1.0 the provenance term moves a typical film
−12.9% to +14.5%, worst film ±28%. Turning it down is a pure taste decision about how much you want the
artifact panel to override the bitrate reading. Nothing measures the right answer.

### 2.5 Prod wiring priorities — deferred by you, listed so it is not forgotten

You deferred this to its own session: nightly probes, Jobs tab, Audit tab, and every BPP+ number on the
site. One finding must be carried into that work as a **decision, not a nicety**:

- The backfill samples **4 clips**. At 4 clips, a quarter to a third of films land on the *wrong side*
  of a decision threshold (banding flips the 5% criterion 29.3% of the time; blur flips the 25%
  criterion 35.1%).
- With the **counted** statistic, 24 clips is the operating point (banding's flip rate 23.2% → 4.9% at
  40% of the cost of 60).
- With the **smooth** statistic, 4 clips already matches the counted statistic at 12–30 clips — a 3–6×
  saving. **Switching statistic is cheaper than switching clip count**, and does not need a re-measure
  of the library.

---

## 3. WHAT DOES *NOT* NEED YOU

Stated so the boundary is unambiguous. All of this is either done or does not require your time:

- **Closed today:** P's factor structure (it is an index, λ₁ = 1.399, structure is 3+1 with blur
  orthogonal); the probe block/blur swap (implemented, **rejected** by its pre-registered arbiter at
  355/20000 against a bar of 100, baseline restored and verified at max |ΔP| = 0); the scene-fraction
  cut-off finding; the exponent identification proof in §1.1.
- **Closed earlier this week:** the λ identity (λ = 1/A, the generation step cancels); the anchor (49%
  of the measured generation step was rate-control contamination, λ vindicated with **no change**);
  provShare shipped at 0.1089, measured from the bitstream encoder fingerprint; P's reliability
  corrected to 0.674 (the "0.106" was a different statistic); the last failing pre-registered structural
  check now passes.
- **Finishing on its own:** the 40-film × 60-clip visibility run (26/40, ~1.5h). Rank-preserving in its
  consequences, so expect few dominoes.
- **A 20-minute chore:** grain backfill for 5 pre-grain ladder films (#71).
- **Not worth your time:** #73, per the sizing in §2.3.

**The shape of it:** of everything still open, exactly one item is large *and* re-ranking (the
exponent, ±23% worst film), and it collapses entirely into §1. One is large but safe (where 100 sits,
+19% but rank-preserving). One is small (grain, ±5%). Once §1.6 Question A is done, the project is
within reach of shipping.

---

## 4. If you only do one thing

**Buy the 1080p projector.**

That is not a deflection — it is the literal answer. The single highest-value remaining experiment
(§1.6 Question A) has had a complete, pre-registered protocol sitting ready since 2026-08-20. It is not
waiting on analysis, on design, or on your evening. It is waiting on a display, and it has been since
2026-08-01.

Once it exists: `docs/PROTOCOL-forced-choice-2026-08-20.md`, ~10 pairs per sitting, three films
spanning complexity. It gives the scale a physical unit for the first time and it unblocks both the
exponent and the 100-line.

Everything else in this file either waits on that, is a decision in §2 you can make from your armchair,
or does not need you at all.
