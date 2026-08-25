# CAMBI — banding is a real, independent axis. First new signal to survive its own degeneracy tests.

**Date** 2026-08-20 · **Task** #53 · **Tools** `scripts/setup-vmaf-tool.sh`,
`scripts/cambi-probe.js`, `scripts/cambi-analyse.js` · **Data** `data/cambi.json` (40 library-stratified) + `data/cambi-blindspot.json` (45 targeted) = `data/cambi-combined.json`, 85 films

## What this settles

Banding is the one artifact BPP+ is **structurally** blind to. The score answers "does this file have
enough bits for its own content"; banding is flat gradients quantised into visible steps, which a file
can suffer while being perfectly adequate on average. Every previous attempt at a second axis
(`gShare`, `blockMean`, `blurMean`, ladder slope) either collapsed into something already measured or
was never testable. **CAMBI is the first one to pass.**

## The constraint that turned out not to bind

Brennan's objection was the right one to raise: *"we will never have a raw and true source."* For
VMAF proper that is fatal — a same-file comparison scores ~100 by construction, so VMAF stays a
calibration-dataset tool here forever.

**CAMBI is different: it is genuinely no-reference.** It keys on flat regions within a single frame.
Only libvmaf's *plumbing* insists on two inputs, so both are pointed at the same file. That means
banding is measurable **in production, forever, with no master** — the constraint does not bind.

## Setup, and the trap it creates

Nothing on this box has libvmaf: controller 5.1 (no `--enable-libvmaf`), jellyfin 7.1.4 (`vmafmotion`
only, a different filter), host 4.2. So `scripts/setup-vmaf-tool.sh` fetches a **pinned static GPL
build** (ffmpeg n8.1) into `tools/`.

**It is deliberately not an upgrade to the controller's ffmpeg, and must never become one.** That
ffmpeg's x265 produced all 1044 complexity measurements and is the only ruler for them; different
x265 builds give different bitrates for identical input, so swapping it would silently make every
stored measurement incomparable with every future one. The static binary is safe precisely because
nothing in the probe path references it. Written into AGENTS.md as a standing warning.

## Method

40 films, stratified by complexity **and** R. That second axis matters: all 26 grain-heavy films in
this library are also starved, so sampling on complexity alone would make grain and supply
inseparable and neither correlation would mean anything.

4 clips × 2s per film at the same fractional offsets `probe-film.sh` uses, extracted **lossless
(ffv1)** so CAMBI sees the source's banding rather than the extraction's. Mean luma (`YAVG`) captured
per clip in the same pass, because darkness is the degeneracy that killed `gShare`.

## Degeneracy tests — pre-registered, all three pass

Thresholds fixed in the source before any number was read. `|r| > 0.6` = not an independent axis.

| test | against | Pearson | Spearman | verdict |
|---|---|---|---|---|
| D1 grain | complexity | −0.245 | −0.392 | **passes** |
| D2 darkness | mean luma | −0.254 | −0.295 | **passes** |
| D3 redundancy | BPP+ | −0.313 | −0.322 | **passes** |
| *(context)* | supply R | −0.310 | −0.318 | — |

Nothing exceeds 0.4 on the stricter of the two measures. For scale, `gShare` died at **−0.885**
against luma.

**A premature inference of mine, corrected.** On the 5-film smoke test I read Rocky (cambi 8.24, luma
37) against Shaun of the Dead (0.05, luma 88) as the darkness degeneracy already showing. At n=40 the
correlation is −0.25/−0.30. Two anecdotes are not a correlation, and Poor Things settles it: luma
**97.6** — bright — with cambi 2.92, while LOTR: Return of the King at luma **232** reads 0.078.

## Positive test — the physical mechanism is there

Passing three negatives only shows CAMBI measures *something* else. So: among the **smooth** half
(low complexity — gradients not broken up by detail), starved copies should band more.

- starved (median R 0.51): median cambi **2.682**
- supplied (median R 0.88): median cambi **1.151**
- **ratio 2.33×**, and it strengthened from 1.84× at the n=21 interim

Banding tracks starvation on exactly the content where banding is physically possible. That is a
mechanism, not a correlation.

## Where it disagrees with BPP+ — the actual value

Threshold: CAMBI ≥ p75 (2.817) = "bands visibly".

|  | BPP+ < 75 | BPP+ ≥ 75 |
|---|---|---|
| CAMBI low | 19 | 11 |
| **CAMBI high** | 8 | **2** |

**BPP+ says acceptable, CAMBI says it bands** — the blind spot, and the whole point:

| cambi | BPP+ | complexity | R | film |
|---|---|---|---|---|
| 4.129 | 75 (warn) | 0.114 | 0.71 | The Graduate (1967) |
| 3.361 | 81 (warn) | 0.057 | 0.80 | Army of Shadows (1969) |

**BPP+ says bad, CAMBI says clean** — starved, but bits are the *only* problem, so a replacement
would fix it and there is nothing structural in the way:

| cambi | BPP+ | complexity | film |
|---|---|---|---|
| 0.033 | 67 | 0.303 | The Bridge on the River Kwai (1957) |
| 0.078 | 74 | 0.192 | The Lord of the Rings: The Return of the King (2003) |
| 0.151 | 55 | 0.250 | The Man Who Knew Too Much (1956) |

## Two things worth flagging honestly

**1. The complexity relationship is NON-MONOTONIC, and I cannot explain it.**

| tercile | median complexity | median cambi |
|---|---|---|
| low (smooth) | 0.072 | 1.467 |
| **mid** | 0.110 | **2.087** |
| high (grainy) | 0.179 | 0.936 |

The grain-dithering story explains the high tercile — grain breaks up gradients and suppresses
banding, which is why The Bridge on the River Kwai (complexity 0.303) reads 0.033. It does **not**
explain why the smoothest tercile bands *less* than the middle. Plausibly the very-low-complexity
films are modern digital sources generously supplied relative to what they need, so there is no
quantisation to see — but that is a guess, and it is stated as one. It also means CAMBI cannot be
predicted from complexity, which is a point in favour of it being independent.

**2. ~~The disagreement cell is only 2 films at n=40.~~ ANSWERED — see the prevalence section below.**

Also directionally interesting, on tiny n: WEBRip-1080p (n=2) and WEBDL-720p (n=1) median cambi
4.47/4.69 against Bluray-1080p (n=32) at 1.32. Consistent with generation loss before the file ever
arrived, but n=1 and n=2 are anecdotes.

## Prevalence — how big is the blind spot? (second run, 45 more films)

The first run could not answer this: sampling the library at random mostly draws films BPP+ already
condemns, and a film at BPP+ 47 gets replaced regardless of banding. So a second, **targeted** run
took 45 films restricted to **BPP+ >= 75** (279 eligible, excluding the 40 already measured) — many
times cheaper per CPU-second than widening a random sample until enough acceptable films appear.

The threshold is deliberately **not** recomputed on the targeted set, which is biased by
construction. It stays at p75 of the original library-stratified sample (2.817).

**Of 58 films BPP+ calls acceptable, 8 band visibly — 14% (95% CI roughly 5–23%).**

| cambi | BPP+ | complexity | R | luma | film |
|---|---|---|---|---|---|
| 5.414 | 76 (warn) | 0.071 | 0.73 | 86.9 | Backrooms (2026) |
| 4.129 | 75 (warn) | 0.114 | 0.71 | 64.9 | The Graduate (1967) |
| 3.361 | 81 (warn) | 0.057 | 0.80 | 36.4 | Army of Shadows (1969) |
| **3.060** | **109 (ok)** | 0.137 | 1.22 | 39.1 | **Fargo (1996)** |
| 3.033 | 97 (warn) | 0.059 | 1.03 | 57.5 | Heat (1995) |
| 3.012 | 88 (warn) | 0.052 | 0.90 | 38.2 | In the Mood for Love (2000) |
| 3.003 | 78 (warn) | 0.055 | 0.76 | 77.5 | Her (2013) |
| **2.836** | **103 (ok)** | 0.048 | 1.12 | 37.1 | **Obsession (2026)** |

Two of them — Fargo at 109 and Obsession at 103 — are films the score calls **good**, in the green
band, with supply *above* transparency (R 1.22 and 1.12). No amount of bitrate reasoning reaches
those: they have the bits and they still band.

Rate falls monotonically with the score, which is the sanity check this needed:

| BPP+ band | n | median cambi | banding |
|---|---|---|---|
| warn 75–99 | 34 | 0.958 | 6/34 (18%) |
| ok 100–124 | 17 | 0.391 | 2/17 (12%) |
| wow ≥125 | 7 | 0.175 | 0/7 |

**The blind spot is SMOOTH content**, exactly as the mechanism predicts: banding films have median
complexity **0.058** against 0.102 for the clean ones, and 6 of 8 sit below 0.10. Grain dithers
gradients away; smooth modern digital photography has nothing to hide the steps.

### The degeneracy tests replicate on the independent sample

The 45 targeted films were never used to set any threshold, so they are a clean replication:

| test | first run (n=40) | replication (n=45) |
|---|---|---|
| vs complexity | −0.245 | −0.444 |
| vs luma | −0.254 | **−0.022** |
| vs BPP+ | −0.313 | −0.273 |

Luma comes back at **−0.02** — the darkness degeneracy is dead, not merely under threshold, and my
5-film smoke-test inference was simply wrong. Complexity rises to −0.444: partial dependence,
consistent with grain suppressing banding, still well inside the 0.6 line. Nothing here is a
restatement of something already measured.

## Where it must go in the model — a GATE, and the denominator if ever

Unchanged from report 04's reasoning, and now with a measured signal behind it:

- **Not a term in the scalar.** No valid subjective label exists, so any weight would be invented.
- **A gate/annotation beside the score** — "bands" is a different sentence from "starved", and the
  two disagree in both directions, which is precisely why they should be reported separately.
- **If it ever enters the score it multiplies the DENOMINATOR**, capped ~1.6, never additively: the
  sqrt then halves any misread, so a wrong CAMBI costs ≤ ~2 points instead of an unshielded error.

## Not shipped

No score, gate or UI changed. This establishes that CAMBI carries information BPP+ lacks. It does
**not** establish that the information matters to Brennan — nothing here has been checked against
anything he has looked at, and it should be one of the axes tested by the forced-choice protocol
(`docs/PROTOCOL-forced-choice-2026-08-20.md`).

## Reproduce

```sh
./scripts/setup-vmaf-tool.sh                       # idempotent; verifies libvmaf is present
node scripts/cambi-probe.js --films 40 --clips 4 --seclen 2
node scripts/cambi-analyse.js
```
