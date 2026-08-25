# Grain investigation — continuation of archive/HANDOFF-2026-08-13.md §3

Written 2026-08-13 evening, while the experiment suite was still running. Live results land in
`docs/audit-2026-07-31/raw/grain-*.csv`; run `node scripts/analyze-grain.js` for the current state.

**Goal, stated in Brennan's terms:** make BPP+ as accurate as possible. Everything below is judged
against that, not against how interesting it is.

---

## THE HEADLINE (added late, and it supersedes the grain work below)

**`-tune grain` does not measure grain.** Up (2009) — rendered CGI, zero photochemical grain — scored
gShare **0.407**, against Casablanca (grainy B&W stock) **0.422** and Alien **0.421**. The metric is
dead as a grain detector, and §2 explains mechanically why.

**`blockMean` — already measured on all 881 movies since day one, and unused — separates the films
Brennan has actually judged.** Library p50 = 1.33, p90 = 2.20.

| film | blockMean | pct | blurMean | pct | R | src | Brennan's verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| Easy Rider | 3.80 | **96th** | 6.96 | 45th | 0.61 | 6.1 Mb | artifacts |
| Lawrence of Arabia | 2.36 | **90th** | 4.80 | **1st** | 1.80 | 16.6 Mb | artifacts |
| Raiders | 1.39 | 58th | 6.58 | 30th | 1.24 | 12.7 Mb | — |
| No Other Choice | 1.05 | **1st** | 5.82 | 9th | 0.33 | 2.0 Mb | looked good (weak) |
| Cinema Paradiso | 1.04 | **1st** | 7.66 | 72nd | 0.49 | 1.9 Mb | looked good (weak) |

**Bitrate gets all four backwards.** The two films that looked GOOD are the two most starved (R 0.33
and 0.49, ~2 Mb/s); the film that looked BAD is the least starved (R 1.80, 16.6 Mb/s). blockMean
orders all four correctly.

`blockMean` is independent of everything BPP+ already uses — r(block, R) = 0.16,
r(block, complexity) = −0.02, r(block, srcBitrate) = 0.20 — so it is new information, unlike gShare,
which turned out to be a confounded restatement of darkness (r = −0.885 vs mean luma).

**Lawrence's signature is the diagnostic one: SHARPEST 1% of the library and BLOCKIEST 10%.** Detail
retained, but block-quantised — which is precisely "compression noise on the grain". A smeared YIFY-
class rip would show the opposite (low block, high blur), so the two detectors together distinguish
"artifacted" from "smoothed to death". Neither alone would.

**Status: n=4, two of them weak (casual viewing, not analysis). Not yet a detector.** The missing
ingredient was never a metric — it is labelled data, which `TODO-quality` §B has been requesting for
weeks. A blind shortlist is the cheap way to get it.

## 0. What was closed out

- **#12 audio exclusion — DEPLOYED and verified.** `docker exec controller grep -c audioToSubtract
  /app/lib/arr-inspect.js` → 3 (was 0). Controller healthy after restart.
- **#9 per-sample probe values — WRITTEN, NOT DEPLOYED.** See §5.

---

## 1. The headline: gShare is NOT a constant scale factor — but that is not the same as it being right

Three separate degeneracy tests, all run against the existing 10-film data joined to the probe cache:

| test | result | reading |
|---|---|---|
| Is the factor constant across films? | `1/(1-gShare)` spans **1.276–2.469 = 1.94×** | Not constant. Carries **37 %** as much log dynamic range as complexity itself (5.82×). |
| Does it reorder? | **8/10 films change rank**, largest move 2 places, **Spearman 0.915** | A pure rescale cannot reorder. It genuinely moves films past each other. |
| Is it predictable from complexity? | **r = −0.234, r² = 5 %** | Not redundant. It is carrying information complexity does not have. |

Correlation of gShare against *every* metric already in the probe cache:

```
complexity  -0.234    blockMean  +0.238
R           -0.272    blurMean   -0.490
srcBitrate  -0.064    spreadRatio +0.049
probeBitrate -0.100
```

**So the correction is real in the arithmetic sense.** The open question is no longer "is it a
rescale" — it demonstrably is not — but **"is the information it adds signal or noise?"** Those look
identical in every test above, which is why §2 and §3 exist.

---

## 2. Why the camera hypothesis failed — a mechanical explanation, not a hand-wave

§3.4 concluded `-tune grain` measures "the cost of preserving high-frequency detail". The x265
documentation says something more damaging, and it explains the null result outright.

> "The purpose of this option is neither to retain nor eliminate grain, but to prevent noticeable
> artifacts caused by uneven distribution of grain."

**`-tune grain` is not a grain switch. It is eight simultaneous changes:**

```
--aq-mode 0        adaptive quantisation OFF    <- redistributes bits by local contrast
--cutree 0         CU-tree OFF                  <- lookahead QP modulation
--psy-rd 4.0       psycho-visual RD             <- the only grain-relevant knobs
--psy-rdoq 10.0    psycho-visual RDOQ           <- "
--sao 0            sample adaptive offset OFF
--recursion-skip 0 exhaustive CU search
--ipratio 1.1 --pbratio 1.0 --qpstep 1 + --rc-grain
```

Only `psy-rd`/`psy-rdoq` have anything to do with preserving grain. **`aq-mode 0` alone is a large,
strongly content-dependent bitrate change**: AQ moves bits toward flat and dark regions, so disabling
it costs most on films that are mostly flat and dark — which describes **2001 and Lawrence, the two
films that topped the table and drove the 65mm hypothesis**. That is a confound capable of
manufacturing exactly the result we got.

**Experiment C (ablation)** measures each knob separately on the same samples to find which one
actually drives gShare. `scripts/probe-grain-ablate.sh`.

---

## 3. Where the metric is *not* a constant — the three experiments now running

The old set could not discriminate because every film in it was a well-sourced live-action feature:
35mm and modern digital **both** carry high-frequency detail. The new sets attack the range instead.

- **B — extremes (`grain-sets/extremes.txt`).** Rendered CGI contains **no photochemical grain at
  all**. If Toy Story and Up score in the same 0.3–0.5 band as 35mm, the metric measures nothing.
  Against them: well-sourced B&W film stock (Citizen Kane, Casablanca, Maltese Falcon), which should
  top the table. Plus **starved-but-grainy** films (Saving Private Ryan R 0.23, Seven Samurai R 0.38)
  — the grain is genuinely in the film but the encoder already destroyed it, so a *faithfulness*
  measure must read LOW. That last group is the sharpest test, because BPP+ scores the **file**, not
  the film.
- **A2 — offset stability (§3.6).** Uses a new `GRAIN_PHASE` knob that holds the sample **count**
  fixed and moves only **which scenes** are hit. `GRAIN_SAMPLES=7` (the originally-proposed test)
  would have changed count and position together and could not separate them.
- **C — ablation.** §2 above.
- **D — flat-region detector.** §4.

### Offset stability, first film in

| film | phase 0 | phase 0.33 | shift | within-film SE | shift/SE |
|---|---:|---:|---:|---:|---:|
| Lawrence of Arabia | 0.528 | 0.473 | −0.055 | 0.061 | **0.90** |

**The shift is smaller than one within-film standard error**, against a between-film spread of 0.379
— scene selection accounts for ~15 % of the range. That is what a stable film property looks like.
One film is not a result; the remaining eight are queued.

---

## 4. A principled replacement for the cheap detector

§3.7 killed `jitter` and correctly diagnosed why: a **temporal** denoiser removes motion as well as
grain, and an **absolute** measurement over the whole frame cannot separate a two-source quantity.
It also suggested, untested, measuring only where the frame is flat.

**That suggestion is the industry-standard method.** AOMedia's AV1 film-grain estimator builds its
noise model from the source-minus-denoised residual measured *only in smooth regions*, using a Canny
edge detector plus dilation, explicitly so that "edges and texture do not affect the film grain
estimation".

`scripts/probe-flatgrain.sh` implements it, fixing both of `jitter`'s failure modes:

- denoiser is **spatial-only** (`removegrain`) — motion cannot enter a single-frame residual;
- residual is **masked to flat regions**, with the mask built from the **denoised** frame so grain
  cannot trigger the edge detector and carve away the regions we want to measure.

It is also **where Brennan actually sees the problem** — "randomly changing pixel noise in flat
skies". Cost is a decode, not an encode.

Smoke test, Toy Story (CGI): flat fraction 0.916, raw residual 0.0789, **flat residual 0.0598**.

**External sanity check on magnitude:** Netflix reports AV1 film-grain synthesis saving **~30 % of
bitrate on grainy titles, up to 50 % on heavy grain**. Our gShare range of 0.216–0.595 brackets that
figure — encouraging for the top of the range, and a warning about the bottom, since we measure 0.216
even on clean digital where the true grain cost should approach zero.

---

## 4b. The bigger, more certain BPP+ win: measure the audio

The grain correction may yet turn out to be noise. **This one is already proven.**

`probe-film.sh` now measures true total audio bitrate from packet sizes across **every** audio
stream — one ffprobe read, no decoding. Validated on Lawrence of Arabia:

```
ffprobe stream metadata:   ac3 448000 bps  +  dts "N/A"
actual audio packets:      2,590,746 bps total
```

Independent confirmation of the handoff's hand-measured 2.18 Mb/s DTS-HD figure (448k + 2.18M ≈
2.59M). **2.14 Mb/s of a 16.6 Mb/s container was being scored as picture** on the fallback path.
`audioToSubtract()` — deployed today — can only recover the 448k that *arr admits to.

Sampling four files at random already shows the scale of it: **12 Angry Men carries 4 audio tracks at
2.95 Mb/s total**, and it is the highest-complexity film in the library.

`scripts/measure-audio.sh` backfills the whole library without any encoding (~1 s/file, so minutes
rather than the ~14 nights a re-probe would take). **Not yet run** — it is I/O-bound on the USB drive
and would slow the encodes' reads.

### The wiring, deliberately NOT done unattended

Nothing consumes `audioBps` yet, and this is where the ~10 points actually get recovered. It was left
undone on purpose: `bppOf(mi, fallbackTotalBps)` has **no unit key**, so feeding it probe-measured
audio means changing its signature at **12 call sites**. That is a refactor to do with tests and a
person watching, not unattended on a live box.

The design that fits the existing architecture — mirror `setComplexityResolver` exactly:

```js
// arr-inspect.js, alongside _resolveTarget
let _resolveAudio = null;
function setAudioResolver(fn) { _resolveAudio = fn; }   // resolve(key) -> measured audio bps | null

// audioToSubtract() prefers a MEASUREMENT over *arr's single-track claim, keeping the 40% cap:
//   measured (all tracks, from packets)  >  mi.audioBitrate (one track)  >  0
```

`bppSource()` then gains a `total-minus-audio-measured` state, which is the only one of the four that
is not a ceiling. Same injection pattern, same cycle-avoidance reason, and every call site that does
not pass a key degrades to exactly today's behaviour.

## 5. #9 — per-sample probe values (written, not deployed)

`probe-film.sh` has **always** emitted `sampleKbps`; `probeUnit()` averaged it away and stored only
the mean. Added `sampleStats()` to `controller/lib/probe.js`, storing `sampleCx`, `cxSE` and `cxRSE`.

**Why it matters for BPP+ accuracy:** complexity is the *denominator* of every BPP+ in the app, so a
film with an uncertain complexity has a proportionally uncertain BPP+ — and today a 94 and a 207 are
printed with identical confidence. `spreadRatio` is not a substitute: it is max/min, set by a single
freak scene, and says nothing about the precision of the mean.

Verified on synthetic input: a tight film reports `cxRSE` 0.3 %, a scattered one 20 %.

`complexity` itself is **deliberately unchanged** — 1026 measurements and 108 calibration pairs are
expressed in its current units.

**Not deployed** (the image rebuild would have stolen CPU from the running encodes), and it only
populates on **re-probe**, so existing entries stay bare until #10 re-measures them.

---

## 6. Corrections to the handoff

1. **2001: A Space Odyssey is intrinsically pathological in x265, not a memory-pressure artefact.**
   §2.1 attributed the 1050 s encode to the 8 GB stale Claude session. Re-measured today on a healthy
   box (9.5 GiB available, load 7): **a single 4 s veryfast/1280 encode ran past 287 s** versus ~35 s
   for the same operation on Lawrence. The memory crisis was real and worth finding, but it is not
   the explanation here. 2001 is now excluded from every interactive set and needs its own overnight
   slot with a long timeout.
2. **Group-ordered film sets waste a stopped run.** The extremes set originally listed all three CGI
   films before all three B&W ones, so the first hour of encoding contained no CGI-vs-B&W comparison
   at all. Reordered to alternate groups, so a run stopped at any point still carries the contrast.
   Toy Story was also demoted from first: at ~3 min/sample it is the slowest film in the set.
3. **This box has 4 cores, and the experiments are CPU-bound.** Running two suites concurrently drove
   load to 13 and the package to 89 °C while halving each run's throughput. Everything is now strictly
   sequential (`scripts/grain-run-all.sh`) with a 120 s per-encode cap.

---

## 7. Tools added

| script | what it does |
|---|---|
| `scripts/grain-run-all.sh` | the whole suite, sequential, ordered by what each stage can decide |
| `scripts/probe-grain-ablate.sh` | decomposes `-tune grain` into its eight individual knobs |
| `scripts/probe-flatgrain.sh` | AV1-style flat-region grain residual (decode-only) |
| `scripts/analyze-grain.js` | turns the CSVs into the three answers they were run to produce |
| `scripts/grain-sets/*.txt` | film sets, each with its hypothesis written down |

`probe-grain.sh` gained `GRAIN_PHASE` (offset shift at fixed n), `GRAIN_SET_FILE` (swap the film set
without touching the recorded camera-format set), and a `per_sample` CSV column.
