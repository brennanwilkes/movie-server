# Forced-choice A/B — the protocol

**Task** #47 (BPP-PLUS.txt 16.A.4) · **Written** 2026-08-20, before any judging, so it cannot be
adjusted to fit a result · **Status** ready to run; BLOCKED ON HARDWARE — there is no projector (died 2026-08-01), the replacement will be 1080p

Every research track this round independently named this the highest-value remaining experiment.
It is the only route to a **valid subjective label**, and without one nothing in this model can be
confirmed or refuted — the exponent, the headroom anchor, the band edges and the grain story all
rest on unvalidated or borrowed substrate.

## Why the last attempt was invalid, and what that dictates

The 2026-08-13 blind test was retracted (11.1). Eleven films, judged one at a time, scored
1 / 0.5 / 0 for "artifacts". It failed for a structural reason, not a sloppy one: **nobody can
separate grain from compression noise by eye on a single unpaired clip.** The judgements
correlated with how grainy a film was, not with how starved it was — so the test measured
grain-visibility and was then read as measuring compression. Report 03 found that ITU-T P.1204.3,
the industry's own no-reference standard, *specifies* the same blindness: "effects due to source
generations, such as signal noise… are not reflected."

That single fact forces almost every choice below.

| Requirement | Because |
|---|---|
| **Paired, same film, same scene, back to back** | Grain is then identical in both members, so it cancels. This is the whole reason the test can work at all. |
| **Forced choice, no absolute rating** | "Which looks better" is a judgement a person can make reliably. "Rate this 0–10" is not, and unpaired MOS is the same confound that disqualifies KonViD/LIVE-VQC as calibration sets (report 02). |
| **Blind to which is which** | The scores are known and would otherwise anchor the answer. |
| **On the projector, not a phone** | The 2026-08-13 test was judged on a phone at native resolution — a display that hides exactly the differences being asked about. **CORRECTED 2026-08-28:** this row originally said "the projector is native 720p today". It is not — the projector DIED 2026-08-01 and does not exist. The replacement will be 1080p, so the 44% downscale that masked these differences will be gone entirely. This protocol is BLOCKED ON THAT PURCHASE. |
| **Include "cannot tell"** | It is the single most informative answer available. A pair that is genuinely indistinguishable locates the just-noticeable threshold directly, and forcing a coin-flip there destroys that information. |

## What to compare

We cannot manufacture a better copy of a film, so the pairs must come from files that exist.
Three sources, in order of preference:

1. ~~**Banked replacement pairs.**~~ **CHECKED 2026-08-28 — THIS SOURCE DOES NOT EXIST.** 60 priors
   carry `measuredFrom`; 42 old files are gone, and of the 18 whose path still resolves, **16 are the
   SAME INODE as the current file** (the library hardlinks, so the old path is a second name for the
   same bytes) and the remaining 2 differ in runtime by 653s and 57s, i.e. different cuts. **Usable
   pairs: 0.** There are no duplicates elsewhere either — the 146 units with >1 video file are all
   seasons, and no movie directory holds two video files. Note the field is `path|size|timestamp`, not
   a bare path; testing it with a plain existence check returns a false zero.
2. **Deliberately starved clips.** `probe-starve.sh` already produces exactly this: same clips,
   same content, only the bitrate differs, written to `/tmp` and never touching `/data`. A pair at
   level 1.0 vs 0.5 is a known ~2 JND gap by §6.5's chain. **This is the controlled arm** and it is
   the one that can place the threshold.
3. **Cross-film pairs — do not use.** Different content means grain no longer cancels, which
   re-introduces the exact confound that invalidated the first attempt.

## The ladder, and the one number it produces

Option 2 is now the ONLY option (see above), not merely the preferred one. Use it for the calibration. Fix a film, take one scene, and build a ladder of starvation
levels around the region of interest. From §6.5, BPP+ 100→90 is ~0.5 JND ("visible side by side,
invisible alone") and 100→70 is ~2 JND ("a significant drop"). So bracket it:

| pair | bitrate ratio | BPP+ equivalent | predicted |
|---|---|---|---|
| 1.0 vs 0.90 | 0.90 | 100 vs 95 | should be very hard or impossible |
| 1.0 vs 0.81 | 0.81 | 100 vs 90 | ~0.5 JND — the threshold candidate |
| 1.0 vs 0.64 | 0.64 | 100 vs 80 | ~1.2 JND — should be reliably visible |
| 1.0 vs 0.49 | 0.49 | 100 vs 70 | ~2 JND — should be obvious |

**The output is one number: the ratio at which Brennan stops being able to tell.** That is his
just-noticeable threshold in the model's own units, and §6.5's whole argument is that this is the
single offset the scale is missing — not a recalibration.

Run it on **at least 3 films spanning complexity** (one clean modern, one mid, one grain-heavy).
If the threshold differs materially between them, the per-film denominator is doing its job and the
threshold is a property of the scale; if it tracks graininess instead, section 9 has a problem.

## Rules that make the result usable

- **~10 pairs per sitting, maximum.** Fatigue is a real effect and a tired judgement is a noisy
  label, which is what we already have too much of.
- **Randomise left/right per pair**, and include **2 identical pairs as controls**. If the controls
  are not answered "cannot tell", the session is discarded — that is the internal validity check,
  and it is cheap.
- **Record the answer before revealing the scores.** Every time.
- **Same scene, same time of day, same room light.** The projector's contrast in daylight is not
  its contrast at night.
- **Write down the prediction before each pair is shown** (the table above is that prediction). A
  protocol that can only be evaluated after the fact is not a test.

## What it validates, and what it cannot

**Can:** the JND-per-BPP+-point conversion (§6.5), where "100" sits relative to Brennan's eye
(open question 2), whether the band edges land near anything perceptual, and — by comparing the
grain-heavy film against the clean one — whether the per-film denominator genuinely neutralises
grain or merely appears to.

**Cannot:** anything about the **absolute** quality of a real library file, because the reference in
this design is a starved copy of that same file rather than a master. It measures *differences*
reliably and *levels* not at all. That limit is structural (1.2c: no master exists anywhere) and no
protocol removes it.

**Will not be used to fit a score term.** One person's thresholds on three films are a valid label
for choosing an offset on an existing monotone scale. They are not a training set, and treating them
as one is how 11.1 happened.

## Practical setup

```sh
# a controlled pair, written to /tmp, source read-only, /data untouched
docker exec controller /app/scripts/probe-starve.sh "<path>" --levels "1.0 0.81" --samples 1 --seclen 10
```

Keep the clips; play them back to back on the projector from the same player. `--seclen 10` rather
than the probe's 4s: four seconds is enough to measure and not enough to judge.

---

## ASSESSMENT, 2026-08-28 — appended, not edited in

*This protocol was pre-registered, so its body is deliberately left untouched. What follows is a
later critical read, added because it was being treated as settled when parts of it are assertion.*

### What holds up

- **Same-film pairing.** The core insight is sound and it is the reason the test can work: grain is
  identical in both members, so it cancels. The 2026-08-13 retraction is real evidence for it.
- **"Cannot tell" as an answer.** Correct for a threshold design — an indistinguishable pair locates
  the JND directly, and forcing a coin flip there destroys the most informative response.
- **Blind, randomised sides, predictions written first, "not a training set."** All good discipline.

### What is weaker than it sounds

1. **THE CROSS-FILM PROHIBITION IS BROADER THAN ITS OWN ARGUMENT SUPPORTS.** The stated reason is
   that grain stops cancelling. True — but the 2026-08-13 failure was an *unpaired, single-clip,
   absolute rating*, which is a different design from a *matched cross-film pair*. And we **measure
   grain**: it is one of the four detectors. Pairs could be matched on measured grain, complexity and
   BPP+, differing only in P. That defuses much of the objection. The blanket ban should be a
   *caution with a matching requirement*, not a prohibition. Worth testing rather than assuming.
2. **TWO CONTROL PAIRS WITH A DISCARD-THE-SESSION RULE IS BRITTLE.** One lapse of attention throws
   away the whole sitting. More controls, and a graded rule, would be better than an all-or-nothing.
3. **~10 PAIRS PER SITTING ACROSS 3 FILMS IS A SMOKE TEST, NOT AN ESTIMATOR.** The protocol frames
   the multi-film run as a diagnostic ("is the per-film denominator doing its job"). It cannot
   *estimate* the complexity exponent: that needs the per-film JND regressed on log complexity, and
   three points with their own errors will not fit a slope. **Anything claiming the exponent closes
   with this design needs more films — realistically 6-8 spanning the library's 5.5x complexity
   range — and per-film thresholds precise enough to regress.** Recorded because a claim was made on
   2026-08-28 that #99 closes with these labels; it closes with an EXTENDED version of them.
4. **THE PREDICTED JND TABLE IS MODEL-INTERNAL.** The "~0.5 JND / ~2 JND" column is derived from the
   model's own chain, not measured. It is fine as a pre-registered prediction, but it must not then
   be read as independent confirmation when the answer lands near it. That would be circular.
5. **ACROSS-SITTING VARIATION IS UNADDRESSED** beyond "same time of day, same room light." If a
   threshold takes several sittings, sitting becomes a nuisance variable and should be balanced
   across conditions rather than confounded with them.

### Standing status

Useful as a starting point and much better than nothing — particularly the same-film insight and the
"cannot tell" rule. **Not gospel.** Items 1 and 3 above should be resolved before any session runs,
and item 1 in particular may re-open designs this protocol currently forbids.
