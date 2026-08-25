# DESIGN — the nightly CRF probe

Status: **LIVE** — built 2026-08-05, ran one observe-only night, **cut over 2026-08-06**. Every BPP+
in the app is now divided by the film's own measured complexity. Supersedes the sketch in
`docs/TODO-quality.md` §B; operational reference is `AGENTS.md`. Measurements are from the NUC on
2026-08-01, 08-05 and 08-06 and are reproducible.

**Only one thing in this document is still unresolved: §12 Q1, where 100 sits.** Everything else
either shipped or was answered by measurement.

## Night one — the result that settled the design's central question (2026-08-06)

67 films, 01:00–05:25, **zero failures**, stopped exactly on budget (242 of 240 min).

| | complexity (H.264-equiv bpp) | vs the flat 0.13 it replaced |
|---|---|---|
| Schindler's List (1993) | 0.3511 | 2.7x more demanding |
| Casablanca (1943) | 0.2785 | 2.1x |
| **measured median** | **0.1237** | the flat value was a good *average* |
| Blade Runner 2049 (2017) | 0.0670 | 1.9x less |
| Dune (2021) | 0.0436 | 3.0x less |

**8.1x spread — and the flat constant's error was systematic, not noise.** It overrated grainy
film-stock transfers (whose bits buy grain reproduction, not detail) and underrated clean modern
digital capture. Casablanca 183→125, Schindler's List 94→57, Blade Runner 2049 137→191, Dune 69→118.
Mean absolute change 13 points, max ±58, while the library median moved only 68→69: a **pure
re-ranking**, which is the best available evidence that the anchor's level is roughly right.

The probe also reproduced production identity without being told about it: Ocean's Eleven/Twelve/
Thirteen landed within 4% of each other, and six Mission: Impossible films clustered 0.111–0.163 with
the cleanest (*Ghost Protocol*) lowest. That is the measurement picking up cinematography, not noise.

Throughput: **~198 s median per film ⇒ ~69 units/night, ~14 nights for 1014 units.**

Two operational corrections to this document's assumptions: the thermal gate needed to be **95C**
(window median was 88C and 60.7% of samples were ≥88 — the 88/80 originally proposed would have spent
the night cooling), and **trickplay cost 3m51s**, confirming the yield gate should stay off.

## Cutover (2026-08-06)

`installScoring()` injects a resolver into `arr-inspect.js`, so `bppIndex(bpp, key)` /
`bppBand(bpp, key)` use the film's measured complexity; called without a key they return the old flat
value unchanged. Injection rather than `require()` because probe.js already depends on arr-inspect —
this keeps one owner of the scoring math and no cycle. `VERDICT_VERSION` 17→18 (cached candidate
bands were computed against the wrong denominator). `PROBE_VERSION` deliberately **not** bumped: it
guards how a measurement is *taken*, and bumping it would have discarded 69 films of work.

**Why cutting over before calibration was correct.** At cutover only 69 of 1014 units were measured,
so most titles are scored against the shrinkage estimate. That estimate is derived from measured
films rather than invented, and the measured median (0.1237) sits within 5% of the constant it
replaced — verified live: **unmeasured films moved by a median of 2 points** (p90 3, max 18). So the
cutover was near-free for 93% of the library and a large correction for the 7% that had real data.
Every row carries `cxBasis`, and the UI carries confidence in **typography rather than colour** —
measured is bold, estimated is italic — because the badge's colour already means quality. A leading
`~` and a dashed underline were both tried first and both read as an error marker.

**Deliberate deviation from §6.** This document says nothing destructive may act on an estimated
value. That is not enforced as a hard block, because with 93% of the library estimated it would have
disabled the Audit tab's replace flow entirely — a regression nobody asked for — and because the
estimate is no worse than the flat constant that drove those same actions for months. It is enforced
as *marking* instead: `cxBasis` on every payload, `~` on every badge. Revisit if coverage stalls.

## Implementation status — what shipped, and what changed from this design

- `controller/scripts/probe-film.sh` — the measurement. Standalone and human-drivable:
  `docker exec controller /app/scripts/probe-film.sh "<file>"`. The controller shells out to this
  same script, so there is exactly one implementation of the number.
- `controller/lib/probe.js` — cache, nightly tick, gates, estimator ladder, API.
- API: `/api/probe` (status), `?detail=1` (every measurement), `/api/probe/score` (flat vs live BPP+
  — now the audit trail rather than a preview), `/api/probe/find?q=`, `POST /api/probe/run?key=` (one
  unit now), `POST /api/probe/session/start|stop` (run continuously until stopped).
- **`bppIndex()` is live** — see the Cutover section above.
- UI: the **Quality panel** at the top of the Audit tab — coverage, throughput, ETA at the rate
  actually being achieved, and the session start/stop control. Polls only while that tab is visible.
  It absorbed the old standalone "Verifying · N left" text banner on Brennan's call (*"they should be
  unified"*): both report background work whose progress you want at a glance, and one box with two
  bars (QUALITY, SOURCES) reads as one system where a panel beside a bare text line did not. `/api/audit`
  gained `totals.verifyTotal` so the verify bar can show a real percentage rather than an invented one.
- **A race that would have caused exactly the conflict Brennan asked about** (found 2026-08-06 when he
  asked whether a manual session could collide with the scheduled one). `probeTick` checked `_busy` but
  set it only *after* `await blockedBy()` and `await getUnits()` — seconds of Jellyfin and *arr calls —
  so any nightly tick firing inside that window also passed the check. Two concurrent encodes would
  overwrite the single `_child` handle, leaving an **orphaned 3-thread x265 encode no safety gate could
  kill**, on a 4-core box, potentially while someone was watching a film. Fixed with `_tickLock`
  claimed synchronously before any await; `/api/probe/run` takes the same lock (it had the same bug).
  `_busy` now means only "an encode is in flight", which is what the UI should report.
- **Manual session** (2026-08-06, Brennan's ask: *"the ability to manually start and then stop the
  probe separately from the schedule, so I can blast through some of the library if I know I don't
  need the NUC for anything else"*). Waives the schedule, keeps every safety gate, reports why it is
  idling via `session.waiting`, runs units back-to-back with a 2 s gap (waiting for the 60 s tick
  would idle the box ~20% of the time), and **persists across a restart** — otherwise a routine
  `make deploy` would silently end it. Verified end-to-end 2026-08-06: Movie Mode ON killed an
  in-flight encode within 22 s and the session reported `waiting: Movie Mode`; Movie Mode OFF resumed
  it within 8 s without losing the session.
- **Zombie-session fix** (2026-08-06). `anyonePlaying()` had no idle timeout, so a client that died
  mid-film would have blocked the probe forever — silently, because that is also what a normal busy
  evening looks like. Sessions older than `PROBE_PLAY_STALE_MS` (15 min) are now ignored. A live
  client heartbeats every few seconds *including while paused*, so a real pause is never mistaken for
  a zombie; a missing timestamp is treated as LIVE.

**Decisions taken 2026-08-05 (Brennan), and the measurements behind them:**

| decision | value | why |
|---|---|---|
| Reference width | **1920** | Matches the native-1080p projector being bought. Costs 2.03x of 1280 (measured 19.0 vs 9.4 s/sample) and is somewhat less discriminating, but never needs re-probing. |
| Preset | **medium** | `fast`/`veryfast` save 22% but COMPRESS the spread between films 2.74x -> 2.52x. The spread is the product. |
| Night budget | **4h** of a 5h window | ~17 nights to a first pass instead of ~33. |
| TV unit | **season, 2 episodes** | ~312 probes instead of 1696; 2 (not 1) is what makes the homogeneity check possible. |
| Thermal gate | **95C / resume 88C** | The box runs hot (p50 68C, max 94C over 3 days). The gate protects responsiveness, not silicon — Tjmax is ~100C and the CPU throttles itself. |
| Yield to Jellyfin | **off** | Trickplay measured at **4m56s**, not 4h — the 03:00-07:00 window is a safety cap, not a runtime. A yield gate would turn one wedged Jellyfin task into weeks of lost probing. |

**Three things this design got wrong, corrected during the build:**

1. **The cache was keyed by FILE.** Brennan: *"film to film, not torrent source to torrent source,
   we use the same # for each file of a given film."* Correct — complexity is a property of the
   film. Now keyed by `mv:<id>`/`tv:<id>:<season>`, storing per-pixel bpp so it is
   resolution-independent. **This is also what lets a candidate release be scored without probing
   it**, which is what makes BPP+ usable for *choosing* a torrent rather than only judging the one
   on disk.
2. **The anchor was a made-up constant** (`R_TARGET = 2.65`, "hold the median fixed"). Anchoring to
   the library median asserts that what we already own is correct — the proposition the probe
   exists to test. The anchor is now **1.0 x the CRF-20 probe**: *100 means "as many bits as a
   visually-transparent encode of THIS film"*. CRF is a QUALITY target, so a CRF-20 Casablanca and a
   CRF-20 Blade Runner 2049 are the same quality at 3853 vs 1035 kb/s — which is exactly Brennan's
   *"a 100 for Casablanca should cost more disk than a 100 for Blade Runner, and both are good."*
   Moving the anchor later needs no re-probing (x265 is ~-15%/CRF point, applied at read time).
3. **Schedule gates and safety gates were conflated.** A manual run was refused with "outside the
   night window", making `/api/probe/run` useless between 06:00 and 01:00. Now: schedule gates
   (window, budget) are overridable by a human; safety gates (Movie Mode, someone watching,
   temperature) never are.

## The goal, in Brennan's words

> I just want that number to be as accurate to the final experience I'm going to get (other than
> GPU/CPU encoding / native device support, which is the separate indicator), so that I can make an
> informed decision on the tradeoff between quality and disk space for a given film.

That sentence settles most of the design questions below, so it is the thing to re-read whenever
one of them is reopened. Two consequences worth stating up front:

- **Transcode cost stays out of BPP+.** It is a separate axis with its own indicator (the red
  format pill). Merging them was the exact bug fixed on 2026-08-01 — do not re-merge them.
- **Display resolution stays in**, because it genuinely changes the experience — but as a cheap
  read-time constant, never baked into the cached measurement. The projector died the evening this
  was written, which is precisely why that separation matters. See §8.

---

## 1. What BPP+ can and cannot see today

```
bpp  = videoBitrate / (width * height * fps)     x1.6 if HEVC
BPP+ = round(100 * sqrt(bpp / 0.13))
```

The numerator is a measured property of the file. **The denominator, `0.13`, is a guess** — one
constant standing in for "how many bits this content needs", applied identically to a 70mm desert
epic and a flat-lit sitcom. It is the whole weakness of the model.

Brennan's per-pixel intuition is already implemented correctly, for the record: `bppOf()` divides
by the file's *actual stored* dimensions (1920x816 for a scope film), so letterbox bars are not
charged for and a scope film is not penalised against a flat one.

## 2. What the probe measures

Re-encode short samples of the file at a fixed quality and see how many bits that takes. Content
that is genuinely hard (grain, motion, detail) costs more; content that is easy costs less. That
cost **is** the per-title answer to "how many bits does this need".

```
R = sourceBitrate / probeBitrate        (both normalised to the same codec)
```

`R` is dimensionless. Resolution, frame rate, letterboxing and codec all cancel or are normalised
out, because they affect both sides identically. So the model collapses to:

```
BPP+ = round(100 * sqrt(R / R_TARGET))
```

One global calibration constant, `R_TARGET`, replaces `BPP_TARGET`. **This is the answer to "just
dial it, or totally different?" — it is the same dial, but it now turns per title.** The square
root and its ratio semantics (200 = half the visible error of 100) are untouched; the probe fixes
the *anchor*, not the *shape*.

### Measured, 2026-08-01 — ten films, 8 x 4 s samples each

`R_TARGET = 2.65`, chosen so the *median* film keeps its current score. Sorted by probe cost.

| film | source | probe | **R** | BPP+ now | BPP+ probe | delta |
|---|---|---|---|---|---|---|
| Casablanca 1943 — Bluray | 16.71 Mbps | **4.63** | 2.26 | 183 | 92 | **−91** |
| Akira 1988 | 3.09 | 2.29 | 0.84 | 71 | 56 | −15 |
| Mad Max Fury Road — YIFY | 2.19 | 2.16 | 0.64 | 68 | 49 | −19 |
| Lawrence of Arabia 1962 | 16.61 | 2.02 | 5.15 | 160 | 140 | −20 |
| Spirited Away — x265 bdrip | 3.97 | 1.68 | 2.37 | 99 | 95 | −4 |
| Toy Story 1995 | 1.94 | 1.52 | 0.80 | 55 | 55 | 0 |
| Pulp Fiction | 12.58 | 1.35 | 5.81 | 161 | 148 | −13 |
| Project Hail Mary — WEB-DL | 2.72 | 1.31 | 2.08 | 82 | 89 | +7 |
| Identity Thief — YTS | 2.64 | 1.25 | 1.32 | 74 | 71 | −3 |
| Blade Runner 2049 | 10.54 | **0.80** | 8.20 | 148 | **176** | **+28** |

**Probe cost spans 5.8x across the library.** That is the size of the error in today's
one-constant-fits-all assumption, and it is not a rounding error.

**The two extremes are the whole argument for building this.** Today, Casablanca (16.7 Mbps) looks
like the most bloated file in the set and the Audit tab would rank it as prime disk-saving
material. The probe says the opposite: it is a grainy 1943 black-and-white transfer whose content
genuinely costs 4.63 Mbps, so its 16.7 Mbps is only 2.26x headroom — *average*. Shrinking it would
visibly hurt.

Blade Runner 2049 is the mirror image. Clean modern digital photography, dark, almost no grain —
it is the cheapest content in the set at 0.80 Mbps, so its 10.5 Mbps is 8.2x headroom, the most
over-provisioned file here. **It is the one to shrink, and today's model ranks it as more
deserving of its bits than Casablanca.** The probe reverses that, correctly.

Everything else moves modestly, which is the right behaviour: the probe refines the model rather
than upending it, and reserves its big corrections for the cases where the flat assumption is
genuinely wrong.

## 3. Findings that change the earlier design

**(a) Scene complexity varies 8.2x *within a single film*.** Pulp Fiction's eight samples ranged
375 to 3083 kb/s. The original "one 60 s clip" design would have produced a number with no
meaning. Eight samples is the floor, not a luxury; and the per-film **spread** should be stored,
because a high-variance film is one whose single number deserves less trust.

**(b) The downscale filter must preserve aspect ratio, and this is not cosmetic.** On Pulp
Fiction (1920x816):

| filter | probe bitrate |
|---|---|
| `scale=1280:720` (forces 16:9, distorts) | 898 kb/s |
| `scale='min(1280,iw)':-2` (correct) | 736 kb/s |

A 22% swing in the number the entire model rests on. Whatever reference width is chosen (§8), the
filter must be `scale='min(W,iw)':-2:flags=lanczos` — never a fixed `WxH`, which squashes every
scope film to 16:9 and invents detail that is not there.

**(c) `libvmaf` is not in the controller's ffmpeg, so CAMBI is unavailable.** The image is
`node:20-slim` + Debian's ffmpeg 5.1.9. `blockdetect`, `blurdetect` and `siti` *are* present.
Recommendation: ship without CAMBI. Adding libvmaf means building ffmpeg from source into the
image — a large change for one banding metric.

**(d) The analysis filters are not cheap, but they are nearly free *when chained*.** Measured per
4 s sample: encode alone 12.7 s; blockdetect alone 7.7 s; blurdetect alone 10.2 s; **all three plus
the encode in one pass, 26.5 s** — because they share one decode. Never run them as separate
passes. (This also kills the idea of a fast `siti`-only pre-pass over the whole library: at 13.5 s
it is no cheaper than the encode.)

**(e) `/data` is mounted `:ro` in the controller.** The probe therefore *cannot* modify source
files even if it had a bug — the never-modify-source-files invariant is enforced structurally by
the mount, not by discipline. Keep it that way; the probe writes only to `/config`.

## 4. Cost and schedule

Timings under Movie Mode (load ~2), 4 cores, **probing at 1280 wide** — see §8, the reference
width should be 1920, so **these are underestimates and must be re-measured before committing to a
schedule**:

- **9.9–14.4 s per 4 s sample** including detectors → **79–115 s per film** at 8 samples.
- **Casablanca was the outlier at 22.2 s/sample (178 s/film)** — complex content costs more to
  probe as well as to store, so the hardest films are the slowest. Budget for the tail, not the
  median.
- Under normal daytime load (load 5.8) the same work took ~45% longer. The probe must therefore
  budget by **elapsed time, not by file count**, and measure its own throughput.

Library: **857 movie files, 1696 TV episodes across 144 seasons / 96 series.**

| scope | units | at ~2 min | at ~3 min |
|---|---|---|---|
| movies only | 857 | 29 h | 43 h |
| movies + 2 episodes per season | 1145 | 38 h | 57 h |
| every episode | 2553 | 85 h | 128 h |

At 5%/night of 1145 units (57 units, ~2 h of encoding) the first full pass takes **20 nights**,
then it only ever catches up with new arrivals. That is the right shape.

### Scheduler: in the controller, not a systemd timer

The host uses systemd timers for host-level jobs (`ps4fix.timer`). The probe should **not** be one.
It belongs in the controller because the controller already owns every input it needs: Movie Mode
(`isMasterPaused()`), the "is Jellyfin playing right now" check (`nowPlayingTitles()` in audit.js),
CPU temperature (`readTempC()` in system-stats.js), the persisted state file, the `/data` mount and
the ffmpeg binary. A host timer would have to ask the controller all of that anyway.

Follow the `startAuditVerifier()` pattern — a tick on an interval with all gating inside the tick:

```
probeTick() every 60s, runs one probe unit only if ALL of:
  - local hour within [PROBE_WINDOW_START, PROBE_WINDOW_END)   default 01:00–06:00
  - !isMasterPaused()                                          Movie Mode
  - nowPlayingTitles() is empty                                nobody is watching
  - readTempC() < PROBE_TEMP_MAX                               default 80C
  - tonight's elapsed encode time < PROBE_NIGHT_BUDGET_MS      default 2h
  - not already busy (a _probeBusy latch, as audit.js uses)
```

**The temperature gate and the night budget are not optional.** On 2026-07-09 an uncapped 03:00
Jellyfin trickplay task ran straight through the following day and cooked the NUC; the fix was a
hard 4 h `MaxRuntime`. This is the same class of job. Both a hard wall-clock stop at
`PROBE_WINDOW_END` and a per-night time budget should exist, and the currently-running ffmpeg must
be killed — not merely not-restarted — when the window closes or Movie Mode comes on.

Run ffmpeg with `-threads 3` (of 4) so a probe never leaves the box unresponsive, and consider
`nice`. Worth measuring whether 3 threads costs much throughput before committing.

## 5. What is a "unit": movies per file, TV per season

- **Movies: one unit per file.** 857 units.
- **TV: one unit per season, sampling 2 episodes.** Within a season the source, release group,
  encoder settings and content are near-identical; between seasons they frequently differ (a
  different group, a later remaster). The season's `R` then applies to all its episodes. This is
  what takes TV from 1696 units to 288.
- **Escape hatch:** if the two sampled episodes disagree by more than ~25%, the season is not
  homogeneous — queue the rest of its episodes individually rather than trusting the average.

This is the answer to "episode? Not clear to me": probe per season, *apply* per episode.

## 6. Estimating unscanned files — the explicit ask

> films that have not been scanned can use a sample of the ones that have to better inform their
> default value until they themselves are scanned

Yes, and there is a standard way to do it: **shrinkage toward a global mean** (empirical Bayes).
A group's average is trusted in proportion to how many measurements it has.

```
R_est(group) = (n * mean(R over scanned members) + k * R_global) / (n + k)      k ~ 5
```

Ladder, most specific first — take the first group with `n >= 1`:

1. **Measured.** This file has been probed. No estimate.
2. **Same series** (TV) or **same TMDB collection** (movies).
3. **Same (source type x codec x release group)** — e.g. `Bluray x264 OFT`. The 2026-08-01 release
   group analysis showed within-group BPP+ variance is tight (OFT n=36 spans 91–108), so this is a
   strong grouping.
4. **Same (source type x decade)**.
5. **Global median.**

Two rules that matter more than the ladder:

- **An estimated BPP+ must be visibly distinguishable from a measured one.** A number derived from
  five other films is not the same claim as a number derived from this film, and presenting them
  identically is fake precision. Minimum: expose it in the tooltip and in the API; better: a
  subtle marker on the badge.
- **Never let an estimate drive a destructive action.** Nothing on the Audit tab should propose
  deleting or replacing a file whose BPP+ is estimated rather than measured. Probe it first.

## 7. Source type — Bluray vs WEB-DL vs WEBRip vs HDTV

Brennan's question, paraphrased: is a high-BPP+ WEB-DL actually better than a low-BPP+ Bluray, and
should BPP+ be weighted by source type with weights derived from specs?

**BPP+ and source type measure genuinely different things.** BPP+ measures compression loss *in
the copy you hold*. Source type measures **generation loss** — how many lossy encodes happened
before yours, and how good the master was. BPP+ is structurally blind to generation loss: bits
spent faithfully reproducing someone else's compression artifacts still read as high bitrate.

So Brennan's instinct is right, and here is why, per label:

| label | what it physically is | generations | ceiling |
|---|---|---|---|
| Remux | bit-identical copy of the disc stream | 0 | 1.00 by definition |
| Bluray | re-encode of the disc | 1, from a near-lossless master | ~1.00 |
| WEB-DL | **direct stream copy** of the service's file, no re-encode | 1, from an already-compressed master (~5–8 Mbps) | ~0.90–0.95 |
| WEBRip | **re-encode** of a WEB source | 2 | ~0.70–0.80, high variance |
| HDTV | broadcast capture, deinterlaced, possible overlays | 2, worse master | ~0.60–0.70 |

That table explains the intuition exactly: WEB-DL is only slightly worse because *it is not a
re-encode* — it is a first-generation copy of a good-but-compressed master. WEBRip and HDTV are
meaningfully worse because a lossy generation happened before your bits were spent.

### But do NOT implement it as a multiplier

`BPP+ x weight` breaks at both ends: a WEBRip at 400 becomes 140 and still reads green, which is
wrong; and a Bluray at 40 stays red even when it is still the better watch. **A ceiling is the
correct shape**, because source type caps what any bitrate can buy:

```
effectiveQuality = min(BPP+, ceiling(sourceType) * 100)
```

"No amount of bitrate makes a WEBRip better than its ceiling; a Bluray is only as good as the bits
actually spent on it."

### And the ceilings should be measured, not invented

Asked whether the weights can be derived from facts: **partly.** Derivable from definitions are
the generation count and whether a re-encode occurred. *Not* derivable from any spec sheet is the
mapping from generation count to perceived quality. The numbers in the table above are informed
estimates and should be labelled as such until measured.

**The probe is the instrument that can measure them.** A second-generation source has already had
detail destroyed, and destroyed detail is *cheap to re-encode* — so `R` is systematically
different for WEBRip than for Bluray, and `blockdetect`/`blurdetect` measure the artifacts
generation loss leaves behind directly. Once a few hundred files are probed, group `R`,
`block mean` and `blur mean` by source label and read the ceilings off our own library.

This also revives the generation-loss experiment that has been blocked since SSIM was ruled out —
the probe is a valid instrument for it where SSIM was not.

**Recommendation: ship the probe with no source-type term at all, then look at the data.** Only
add an explicit ceiling for the labels the probe demonstrably cannot see. There is a real chance
it sees most of it, in which case a hand-tuned weight would be double-counting. One caveat to
carry: Radarr's own quality labels are not trustworthy (all three `Remux-1080p` files are
mislabelled by ~10x), so group by the label parsed from the *release name*, cross-checked against
the file, not by the *arr quality field.

### "Re-encode"-tagged releases

Same logic — a re-encode is by definition a generation added, so it belongs in the ceiling table
rather than in the bitrate term. The probe should see it as a low `R` with elevated `block mean`.
Confirm that empirically before hard-coding anything.

## 8. Hardware weighting

Brennan: *"I feel like its better to mostly be agnostic ish."* Agreed, with one exception, and the
split is exactly the one he drew himself.

- **Codec / transcode support (NUC iGPU, Fire Stick): stays out.** Different axis, separate
  indicator, already correct.
- **Display resolution: belongs in the score, but must NOT be baked into the cached probe.**

### The projector died on 2026-08-01, and it exposed a design flaw

An earlier draft of this document probed at `min(1280, iw)` — the WiMiUS K5's native panel width —
so that the target was computed over the pixels the projector actually lights up. That is correct
for scoring and **wrong for caching**: buying a projector would have invalidated all 1145 cached
measurements and cost ~20 nights of re-scanning. The K5 failing the same evening the design was
written is a lucky catch.

**Separate the expensive measurement from the cheap adjustment:**

```
probe (expensive, cached, display-agnostic)   →  R, measured once per file, at a FIXED reference
score (cheap, recomputed on every read)       →  BPP+ = f(R, DISPLAY_WIDTH)
```

The probe runs at a fixed reference width that never changes — **1920 is the right choice**, since
it is native for essentially the whole library and matches any true-1080p projector. Display
resolution then applies at read time, where changing it is free.

```js
const PROBE_REFERENCE_WIDTH = 1920;  // NEVER change this. It defines the cache. Not a display setting.
const DISPLAY_WIDTH = 1280;          // What the panel actually shows. Change freely when the
                                     // projector changes — costs one recompute, NO re-probing.
```

That is the documented knob, and it now genuinely is one line. Everything else stays
hardware-agnostic.

**Two things this changes, neither blocking:**

- **Probing at 1920 costs more than at 1280** — roughly 2.25x the pixels for flat content. The
  cost table in §4 was measured at 1280 and needs re-measuring at 1920 before the schedule is
  fixed. This is the main open cost question.
- **The "2.25x projector credit" question stays open** rather than being dissolved by the probe as
  the earlier draft claimed. It is now a *scoring* question, and a much easier one, because it can
  be answered against a fixed measured `R` without re-probing anything. **Do not try to settle it
  before the new projector is chosen.**

Brennan is buying a replacement and will consult separately; per his instruction, do not
over-invest in 720p-specific reasoning in the meantime. Designing for `DISPLAY_WIDTH` as a free
variable is exactly the hedge that makes that decision cheap.

## 9. Storage and cache invalidation

A separate file, **`/config/probe-cache.json`**, not `state.json`. `state.json` is rewritten in
full on a 500 ms debounce from a dozen call sites; adding ~1145 entries of per-sample data to that
write path is a bad trade. The probe cache is append-mostly and only written once per unit.

```
key   = `${path}|${size}|${mtime}`     // a re-download invalidates automatically
value = { v: PROBE_VERSION, ts, R, probeBitrate, samples: [...], spreadRatio,
          blockMean, blurMean, wallMs, unit: 'movie'|'season' }
```

Write atomically (temp + rename on the same filesystem), exactly as `persistState()` does — a
truncated cache should never be parseable as empty.

`PROBE_VERSION` invalidates everything on any change to CRF, preset, sample count/length, the
scale filter, or `DISPLAY_WIDTH`. Note this is a *second* version counter alongside audit.js's
`VERDICT_VERSION`; a probe re-run changes BPP+, which changes audit band membership, so bumping
one will often require bumping the other.

## 10. Failure modes and guards

1. **The destroyed-source trap — MEASURED 2026-08-01, and it is mild.**

   The worry: every file in the library is already a compressed torrent. If prior compression has
   stripped the detail out, the file is cheap to re-encode, so `probeBitrate` drops, so the target
   drops, so the *worst* files score *best*. If that effect were strong, the metric would be
   worthless.

   It was measured directly. Take one clean segment, deliberately degrade it down a bitrate
   ladder, and probe every rung. If the probe is honest it stays flat while the source is wrecked;
   if it is blind it falls in step. Define the elasticity `e = dlog(probe) / dlog(source)`:
   `e = 0` means immune, `e = 1` means completely fooled. `R` then scales as `source^(1-e)`, so
   `1 - e` is the fraction of the real signal that survives.

   | source rung | Casablanca probe | Blade Runner 2049 probe |
   |---|---|---|
   | original (16.7 / 10.5 Mbps) | 2836 kb/s | 544 kb/s |
   | 12000 kbps | 2590 | 548 |
   | 6000 kbps | 2270 | 550 |
   | 3000 kbps | 1931 | 547 |
   | 1500 kbps | 1753 | 524 |
   | 750 kbps | 1771 | 538 |

   **Blade Runner 2049: `e = 0.004`.** The source was destroyed by 14x and the probe did not move
   at all. 100% of the signal survives.

   **Casablanca: `e = 0.22` over the useful range, flooring out below 3 Mbps.** 78% of the signal
   survives — the worst case in the test, and it is grain-heavy content, which is exactly where
   the effect should be strongest since compression destroys grain first.

   **Why it is mild, structurally:** the probe encodes at *CRF 20*, a **quality** target, not a
   bitrate target. A destroyed source still has to be reproduced faithfully at CRF 20 — including
   its blocking artifacts, which are themselves expensive to encode. The artifacts cost roughly
   what the detail they replaced cost. That is why Casablanca *floors* at ~1750 kb/s instead of
   continuing to fall, and why BR2049 never fell at all. **This is a property of the CRF design,
   not luck — do not switch the probe to a fixed-bitrate target, which would destroy it.**

   Residual bias: with the `sqrt`, a real 4x bitrate difference reads as 2.00x on clean content
   and 1.71x on the grainiest — a 14% understatement in the worst case. **Recommendation: do not
   correct it.** A correction would have to be content-dependent, and 14% is far smaller than the
   5.8x content error the probe removes.

2. **The detectors are a weak signal, not the safety net.** Across the same ladder,
   `block mean` moved +2% on Casablanca and +17% on BR2049; `blur mean` moved +11% and +8%. Both
   point the right way, neither is decisive. This downgrades them from "must-have guard" to
   "record it, use it as a tiebreak, revisit with real data" — which is affordable precisely
   because finding 1 showed the guard is much less needed than feared. They cost ~6 s per sample
   when chained into the existing pass, so keep collecting them.
3. **High-variance films.** Store the sample spread; where it is extreme, either sample more or
   mark the number low-confidence.
4. **Thermal runaway.** See §4. Hard window, night budget, temperature gate, and kill the running
   ffmpeg rather than merely declining to start the next one.
5. **Absolute values are meaningless until calibrated.** `R_TARGET` must be pinned against ~10
   files Brennan has already judged. **This needs Brennan to name the files** — ideally a few he
   considers clearly excellent, a few clearly poor, and a few borderline. Skip this and the numbers
   are arbitrary.
6. **Probe timings are load-dependent** (~45% slower at load 5.8 than at load 2.1). `R` is a ratio
   of *bitrates*, not of times, so throughput varies but the measurement does not. Still worth
   recording `wallMs` and concurrent load to confirm that assumption holds in practice.

## 11. Suggested build order

Each phase is independently useful and independently abandonable.

1. **`scripts/probe-film.sh`** — one file in, `R` + detector means out. Standalone, no controller
   changes. A working prototype already exists at the scratchpad path used for §2's measurements
   and should be promoted here.
2. **Calibration run** — the ~10 files Brennan names, plus ~20 spanning the source labels. Pin
   `R_TARGET`; set the blockdetect/blurdetect thresholds; check the source-type ceilings against
   the data before writing any of them down.
3. **`controller/lib/probe.js`** — the cache, the tick, all the gates, the estimator ladder. Ships
   *observing only*: it records `R` and exposes it in the API but BPP+ still uses `BPP_TARGET`.
   Let it run a full pass and compare the two rankings offline.
4. **Cut over** — DONE 2026-08-06, and out of the order this list proposed: cutover happened
   *before* step 2's calibration, deliberately (see the Cutover section for why that was safe).
   One correction to this step as written: **do NOT bump `PROBE_VERSION`.** It guards how a
   measurement is taken, so bumping it for a scoring change discards every night of work. Only
   `VERDICT_VERSION` moved (17→18).
5. **Only then** consider source-type ceilings, and only for what the data shows the probe misses.

## 12. Open questions for Brennan

**Q1 IS THE ONLY ONE STILL OPEN.** Q2–Q5 were answered on 2026-08-05/06 — see the status section.

1. **STILL OPEN — which ~10 films do you consider clearly excellent / clearly poor / borderline?**
   This is the last unpinned thing in the whole design. `HEADROOM_TARGET = 1.0` asserts your "perfect
   tradeoff" is exactly CRF-20 transparency, which is the standard 1080p figure and not a measurement
   of your eyes. Naming a handful you have judged confirms or moves it.

   Relevant data: **90% of measured files sit below CRF-20 transparency** (median R 0.49), so the
   library median BPP+ is ~69 rather than 100. Either that is correct for a native-720p projector, or
   the anchor should come down. Nothing in the data can decide it.

   **Not blocking anything.** The anchor is one read-time multiplier: it moves the scale without
   reordering it and needs no re-probing. Brennan's call 2026-08-06: **recalibrate once more of the
   library is scanned, not now.**
2. ~~Night window and budget~~ — **answered: 01:00–06:00, 240 min.** Measured at ~69 units/night ⇒
   ~14 nights. A manual session can now be started on demand to go faster.
3. ~~TV per-season sampling~~ — **answered: yes, 2 interior episodes per season**, which is also what
   makes the homogeneity check (`disagree`) possible.
4. ~~CRF 20 / medium / 8x4s~~ — **answered by measurement 2026-08-05.** `fast`/`veryfast` save ~22%
   but compress the between-film spread 2.74x → 2.52x/2.56x. The spread is the product, so: medium.
5. ~~Cost at 1920 vs 1280~~ — **measured: 2.03x** (19.0 vs 9.4 s/sample), not the 2.25x pixel ratio.
   Confirmed acceptable at ~198 s/film; per-season TV sampling stayed optional and was chosen anyway.

## 13. What is already proven, and what is not

**Superseded by night one.** The 2026-08-06 run of 67 films is a far larger sample than anything
below; where they disagree, trust it. In particular the spread is **8.1x**, not 5.8x, and it grew
with sample size — so treat 8.1x as a floor too.

**Proven by measurement on 2026-08-01** (ten films, plus a five-rung degradation ladder on two):

- Content complexity varies **5.8x** across the library (**revised to 8.1x on 2026-08-06 over 69
  films**) — the flat `0.13` constant is wrong by that much, and the probe measures it.
- The probe **reverses the Casablanca / Blade Runner 2049 ranking**, which is a real decision
  Brennan would otherwise get backwards.
- The destroyed-source failure mode is **mild** (`e = 0.00` clean, `e = 0.22` grainy) and mild for
  a structural reason, not by luck.
- Scene complexity varies **8.2x within one film**, so multi-sampling is mandatory.
- Aspect-preserving downscale matters by **22%**.

**Since resolved:**

- ~~`R` stability across re-runs~~ — **PROVEN 2026-08-05.** Two identical runs on the same file both
  returned R 4.27. Corroborated at scale by night one, where three Ocean's films landed within 4% and
  six Mission: Impossible films clustered coherently by how clean each was shot.
- ~~The cost at 1920~~ — **measured: 2.03x of 1280**, ~198 s/film in practice.
- ~~`R_TARGET`/anchor as a made-up constant~~ — replaced by `HEADROOM_TARGET = 1.0`, anchored to
  CRF-20 transparency, which is an external standard rather than our own library's median. Its
  *level* still awaits §12 Q1; its *principle* no longer does.
- ~~Elasticity / the destroyed-source failure mode~~ — re-measured at the shipping 1920 width (the
  harder test, no downscale filter): Casablanca `e ≈ 0.30` over 4x and it **floors** (the bottom
  rungs halve the source while the probe drops only 16% then 10%); Blade Runner 2049 `e ≈ 0.04`,
  essentially immune. ~70–75% of signal survives the worst case against the 5.8–8.1x spread the probe
  removes. Conclusion holds at the shipping settings.

**Still not proven:**

- That the source-type ceilings in §7 are real; they are informed estimates awaiting data.
- **That complexity behaves on TV.** Night one probed movies only — the queue puts all 857 films
  before the 157 seasons — so every TV number in the app is currently an *estimate*, and the
  `disagree` homogeneity check has never fired on real data. First TV measurements land around
  night 13, or sooner via a manual session.
- Where 100 belongs (§12 Q1). Unchanged and now the only open design question.
