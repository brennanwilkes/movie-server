# 07 · Netflix TechBlog 2015–2026: the per-title encoding lineage, read for a no-master home library

Companion brief: mine the entire netflixtechblog (and adjacent Netflix research / engineering output)
for the per-title / rate-quality / grain lineage, and translate each technique to the reality the
movie-server actually lives in. Scope decisions up front, so this report stays additive to its
siblings:

- Inputs are **already-compressed consumer rips** — no master, no re-encodes, no libvmaf, 1080p
  ceiling, ~1031 probed units (885 movies + 146 seasons, `GET /api/probe/dataset`).
- The score already in production is **BPP+ = 100·sqrt(bpp / cxEff)**, with `cxEff` = probed CRF-20
  complexity × source-pinning bias (`BPP-PLUS.txt` §5). Everything here is read *against* that model
  — what Netflix does that BPP+ already does, and what it does that BPP+ should borrow.
- 02 (datasets), 03 (ITU NR metrics), 04 (banding/artifacts/ CAMBI), 05 (grain measurement) and 06
  (community) already exist and own those angles. This report owns the **lineage, the serve-side
  pipeline, and the rate-quality decision policy** that the blog posts document. Grain appears only
  as the acquisition/attention story, never re-measured.
- Never git-commit, never touch `/data`. Read-only research.

Tag legend used throughout: **[SOLID]** = primary source read/verified this session · **[DIRECTION]**
= secondary/partial snippet or adjacent work that points somewhere · **[UNTESTED]** = plausible
mapping to this library, not yet validated.

---

## 1. Executive summary

The Netflix tech-blog lineage (2015–2026) is a decade of work on **how to spend bits across content
and within a film**. The headline for our purposes:

1. **Netflix never models a "knee" in the rate-quality curve. It models the curve, then sets an ε
   threshold — its "quality saturation detection" — and stops spending bits there (§3).** Our own
   CRF ladder pilot (BPP-PLUS §6) found the same shape: exponential rate→CRF, no structural bend.
   The engineering answer to "where does extra bitrate stop buying picture?" is a *policy*, not a
   discovered fact — which is exactly the open `HEADROOM_TARGET` question (`DESIGN-CRF-PROBE.md` §12).
   Netflix went further than we can: **the top of its per-title ladder is chosen at the saturation
   point per title** (2020 4K post). That is a stealable decision rule for *grab-size ceilings* even
   though we can never build the ladder.

2. **The entire industry literature — including Netflix's own — assumes a pristine master, and the
   one paper whose problem is ours is Google's "input perceptual quality" QGT (2020), already in
   `BPP-PLUS.txt` §17.2.** This session found the literature continues to grow exactly in that
   direction (Google UVQ 2022; a 2026 UGC-transcoding paper that scores against the *pristine* source
   rather than the degraded reference). The philosophical through-line — *"the RDO process will force
   the codec to replicate the deficiencies of the input reference; score against the ideal, not the
   copy"* — is a direct validation that BPP+ divides by measured content complexity rather than
   comparing candidates to whatever degraded file came first (§4).

3. **Film grain is the one place Netflix changed how bits are spent: AV1 FGS strips the grain
   pre-encode and emits a model for the decoder (§5).** Two lessons that survive *without* re-encoding
   anything: (a) **grain masks compression artifacts** — a heavy-grain file at low bpp looks better
   than its number, and Netflix admits it has **no quality model for FGS at all**, so a red band on a
   grainy title overstates the visible damage; (b) scoring a grainy rip by *content-normalized bpp*
   (what we do) is the same answer as "disable FGS when computing metrics" (`Netflix/vmaf#1192`) — we
   are already on the defensible side of the grain-metric trap.

4. **The transferable unit from Netflix to us is DECISION POLICY, never encode machinery.** Netflix builds a ladder of encodes per title; we shop a prebuilt ladder (the release pool for a given film
   — a fixed 1080p endpoint, one file each). Per-title ladder construction, per-shot optimization,
   chunked-encoding penalty tricks, and NN quality scoring are all **does-not-transfer**. But the
   rules for *choosing a rung* — convex-hull dominance, "wasted point" detection, saturation-top,
   per-title complexity — map 1:1 onto *choosing a release* (§6, §7).

Steal shortlist (detailed in §7): visible-gain/JND gating of replacements & auto-swaps · per-title
saturation→size ceiling for grabs · R-guided (input-quality-aware) audit ordering · grain-masking
awareness in how red bands are presented · and a saturation-anchored candidate for the still-open
"where does 100 sit" pin.

---

## 2. The per-title lineage, 2015 → 2026

| When | Title (URL) | What it did | Verdict for a no-master home server |
|------|-------------|-------------|--------------------------------------|
| 2015-12 | Per-Title Encode Optimization — `https://netflixtechblog.com/per-title-encode-optimization-7e99442b62a2` | First published per-title: probe each title's rate-quality curve with a small set of encodes, take a **convex hull**, pick ladders per title/device class instead of a fixed ladder. The direct ancestor of our per-film denominator (`BPP-PLUS.txt` §17.4). | **[SOLID]** Reinterpreted already: the probe IS this. The *convex-hull* part is the piece we have not yet borrowed (→ §3, steal #2). |
| 2015-12 | High Quality Video Encoding at Scale — `http://techblog.netflix.com/2015/12/high-quality-video-encoding-at-scale.html` | Chunked, cloud, scale-out ingest+encode pipeline. | **[DIRECTION]** Read once: infrastructure, not signal. |
| 2016 | Complexity-based consistent-quality encoding in the cloud (De Cock, Zhi Li, Manohara, Aaron — ICIP; cited as ref [1] in the Google QGT paper) | First move from *encoding* to *predicting* content complexity as input to target bitrate (consistent-quality, not consistent-bitrate). | **[SOLID]** The industry's "predict complexity instead of encode it" turn — the same instinct as our shrinkage estimator ladder (BPP-PLUS §4/§5). Nice precedent, no new action. |
| 2016 | More Efficient Mobile Encodes — `https://netflixtechblog.com/more-efficient-mobile-encodes-for-netflix-downloads-625d7b082909` | Device-limited ladder points for mobile/offline. | **[DIRECTION]** Single 1080p endpoint here; n/a. |
| 2016 | Toward a Practical Perceptual Video-Quality Metric (VMAF launch) — `https://netflixtechblog.com/toward-a-practical-perceptual-video-quality-metric-653f208b9652` | Introduced VMAF as the quality y-axis that per-title curves are drawn against. | **[SOLID]** Y-axis of the *whole* industry's rate-quality curves. Ours is BPP+ — same role, different source of truth (no reference). See §3. |
| 2018-03-05 | Dynamic optimizer — a perceptual video encoding optimization framework — `https://netflixtechblog.com/dynamic-optimizer-a-perceptual-video-encoding-optimization-framework-e19f1e3a277f` | Per-title **+ per-shot** bit allocation ("dynamic optimization"); look-ahead mitigates chunked-encode two-pass penalties. | **[SOLID]** The per-shot *encode* does not transfer; the **constrained bit-allocation objective** is the seed of every steal below. |
| 2018-03-09 | Optimized shot-based encodes: Now Streaming! — `https://netflixtechblog.com/optimized-shot-based-encodes-now-streaming-4b9464204830` | Production rollout; at VMAF 80, optimized encodes use **<half** the bits of per-title AVC; VP9-opt < one-third. First shown "convex-hull" ladders vs the "steps" of fixed ladders. | **[SOLID]** Our §17.6 anchor. The "steps/wasted-points" observation is what steal #1 exploits. |
| 2018-10-26 | VMAF: The Journey Continues — `https://netflixtechblog.com/vmaf-the-journey-continues-44b51ee9ed12` | VMAF feature evolution (VMAF in production, phone/TV variants, neural VMAF direction). | **[DIRECTION]** Confirms VMAF*is* in the per-title loop. Full-reference; cannot replace R (`BPP-PLUS.txt` §17.6 / §11.2). |
| 2021 | CAMBI, a banding artifact detector — `https://netflixtechblog.com/cambi-a-banding-artifact-detector-96777ae12fe2` | Distortion-SPECIFIC no-reference gate beside the headline score. | **[SOLID]** Owned by 04. Architecture precedent for our gates. |
| 2020-08-28 | Optimized shot-based encodes for 4K: Now streaming! — `https://netflixtechblog.com/optimized-shot-based-encodes-for-4k-now-streaming-47b516b10bbb` | Shot-based encodation *and* content-adaptive ladders to the top of the stack: the 4K ladder's highest average rung dropped 16→8 Mbps; individual titles 1.8 (animation) → 17.2 (rich-motion) Mbps; BD-rate −50%; per-title **quality-saturation detection** picks the top rung. | **[SOLID]** THE rate-quality decision-policy post. Saturation rule + waste detection = steals #1–#2 + the HEADROOM anchor idea (steal #5). |
| 2020-10 | Improving our Video Encodes for Legacy Devices — `https://netflixtechblog.com/improving-our-video-encodes-for-legacy-devices-2b6b56eec5c9` (research.netflix.com publication page) | Per-title encodes applied even to legacy-device SDR profiles (the long tail of the ladder). | **[DIRECTION]** Per-title reached even the "cheap" end — a parenting argument for our per-title probe when parts of the library look like the low end. |
| 2021-11 | Bringing AV1 Streaming to Netflix Members' TVs — `https://netflixtechblog.com/bringing-av1-streaming-to-netflix-members-tvs-b7fc88e42320` | AV1 launch; FGS enabled on a limited set of titles from day one. | **[SOLID]** Start of §5's timeline. |
| 2022-11 | For your eyes only: improving Netflix video quality with neural networks — `https://netflixtechblog.com/for-your-eyes-only-improving-netflix-video-quality-with-neural-networks-5b8d032da09c` | NN-based quality scoring/inspection in the loop. | **[DIRECTION]** Compute-heavy, reference-trained. n/a here. |
| 2023-11-29 | All of Netflix's HDR Video Streaming is now Dynamically Optimized — `https://netflixtechblog.com/all-of-netflixs-hdr-video-streaming-is-now-dynamically-optimized-e9e0cb15f2ba` | DO extended to all HDR (HDR-VMAF to run the curve; display-mapping deliberately excluded — score the *signal*, not the display). | **[SOLID]** Reinforces the "measure the signal" principle BPP+ already stands on (a display-relative score would drift with whoever's new projector arrives). |
| 2024-01 | Rebuilding Netflix Video Processing Pipeline with Microservices — `https://netflixtechblog.com/rebuilding-netflix-video-processing-pipeline-with-microservices-4e5e6310e359` | The pipeline's six services revealed: **VIS** (Video Inspection — *rejects non-conformant or low-quality mezzanines*), **CAS** (Complexity Analysis), **LGS** (Ladder Generation), **VES** (Encoding), **VVS** (Validation), **VQS** (Quality = VMAF on mezzanine-vs-encode). Input is studio **mezzanine**. | **[SOLID]** The pristine-input assumption made structural: Netflix **gates bad input at ingest**. We can't; we must *tolerate* it (§4). Also gives the *naming* for the transfer matrix (§6). |
| 2024-05 | The Making of VES: the Cosmos microservice for Netflix Video Encoding — `https://netflixtechblog.com/the-making-of-ves-the-cosmos-microservice-for-netflix-video-encoding-946b9b3cd300` | Deep-dive on the encode service (chunked by necessity, multi-codec, multi-device). | **[DIRECTION]** Chunking/latency infra. n/a. |
| 2025-07-02 | AV1 @ Scale: Film Grain Synthesis, The Awakening — `https://netflixtechblog.com/av1-scale-film-grain-synthesis-the-awakening-ee09cfdff40b` | FGS at scale (grain stripped pre-encode, AR-model + intensity-scaling transmitted, decoder re-adds). They Cloned Tyrone: 8274→2804 kbps (−66%) at *better* look. Confession: "we lack a dedicated quality model for film grain synthesis." | **[SOLID]** §5's centerpiece. The masking principle + the no-quality-model gap are both load-bearing for how we read red bands. |
| 2025-12 | AV1 — Now Powering 30% of Netflix Streaming — `https://netflixtechblog.com/av1-now-powering-30-of-netflix-streaming-02f592242d80` | Fleet status: 30% of streams AV1; reiterates the FGS trade (bitrate-restricted grain looks distorted; bitrate-for-grain buffers; FGS breaks the fork). | **[SOLID]** Close of §5's timeline. |

Also in the sweep, confirmed URLs incorrectly slotted from title-guessing (not cited as unique:
`the-making-of-ves-…-3e6177bfbeab` is wrong; correct slug is `…-946b9b3cd300`).

---

## 3. Rate-quality modeling: the "knee" is a policy, not a fact

**What Netflix's posts actually say, in their own words (all [SOLID], read in the 2020 shot-based body
this session):**

- The fixed-bitrate ladder "often appears like steps — it is not title adaptive, it switches 'late'…
  the quality **stays flat within that resolution even with increasing bitrate**. For example, two
  1080p points with identical VMAF score or four 4K points with identical VMAF score, resulting in
  **wasted bits and increased storage footprint**."
- The optimized ladder "appears closer to a monotonically increasing curve — increasing bitrate
  results in an increasing VMAF score," with resolution-limited extra points that "lie under (or to
  the right of) the **convex hull** main ladder curve."
- "We have logic to **detect quality saturation at the high end**, meaning an increase in bitrate not
  resulting in material improvement in quality. Once such a bitrate is reached it is a good candidate
  for the **topmost rung**."
- The rare content that out-runs the old cap (rock concert with fast-changing lighting, wildlife doc
  with fast action) gets a *higher* top rung — content-adaptive, not clamped.

**Reading our ladder pilot (§6 / `data/ladder-pilot.json`) against it:** the CRF ladder is
exponential in rate — i.e., **no structural knee**; every doubling of bits continues buying something,
just less. Netflix's saturation rule is the same observation turned into a *decision*: pick ε you are
willing to declare "material," and stop there. That is the entire answer to the knee question, and it
confirms the design doc's instinct that "where 100 sits" (`HEADROOM_TARGET`) is a preference, not a
measurement. Two further points the matrix picks up:

- **BPP+ is already the y-axis of the rate-quality curve, re-parameterised.** sqrt(bpp/cxEff) turns
  rate into a *visibility* scale (visible error ∝ bitrate^−0.5). Netflix draws (bitrate → VMAF);
  we draw (bpp → BPP+) with a universal top. The *convex-hull of candidate releases for one film* is
  therefore exactly their hull, plotted in our units — which is why hull reasoning transfers to
  release-picking unchanged.
- **Per-shot does not transfer.** Their optimization runs *on the encode side of the same master*.
  The home server's "per-shot" analogue would be per-scene chunking of a re-encoded file, which the
  constraints forbid. The *decision* layer (which whole-file point to acquire at which target) is the
  entire transferable surface, and it is a rich one.

---

## 4. The already-compressed / input-quality end

### The pristine-master assumption is structural, not incidental

"Existing R-D curves mainly focus on … the relative difference between the original and the
transcoded versions, whose **underlying assumption is that original videos are in pristine quality**"
— the Google QGT paper (§17.2) states our constraint as the industry's default. Netflix makes the
assumption physical: input to the pipeline is a studio **mezzanine**, and **VIS rejects
non-conformant or low-quality mezzanines at ingest** (2024 Rebuilding post). Netflix's answer to bad
input is a *gate*. A home server's answer must be *tolerance* — the input is the library.

### Google QGT (2020) — §17.2, now read in detail **[SOLID]**

Mechanism: a Siamese Inception‑front detector predicts low-quality probability per **5 s chunk**;
chunks above threshold `T_q=0.8` get CRF +10/+15/+20 while max/min bitrate are kept; VD results
≈ **5% average bitrate savings with statistically insignificant MOS loss** (bootstrap methodology).
Core observation: *viewers are more tolerant of added degradation when the input is already low
quality* — a 720p high-MOS clip loses 0.2 MOS at CRF+10; a low-MOS clip loses ~nothing.

Why QGT matters to us is that it runs the *opposite* of intuition: it spends **less** on bad content.
For this library, "reducing bitrate" means "choosing a different release / leaving the file alone",
and the transfer is: **effort (disk, torrents, attention) should be spent where the input merits
it** — which is what `R` = srcBitrate/probeBitrate already measures per title. Low-R grainy/starved
files read "more visible gain available," but QGT's tolerance finding argues the *absolute* gain from
an upgrade is capped by how much the viewer cares about the current file — the two together mean **R
should drive ordering, not the raw band colour** (steal #3).

### The pristine-vs-degraded scoring controversy — a 2026 confirmation **[SOLID]**

`arXiv:2603.25566` (Mar 2026), "A Mamba-based Perceptual Loss Function for Learning-based UGC
Transcoding" — the clearest current statement of the idea:

> "the reference video *R* often contains visible compression artifacts… The RDO process will force
> the codec to **replicate these distortions**… quality labels are computed `VMAF(S, D)` — against
> the **pristine source**, not the non-pristine reference."

Translation for us: **score against the ideal, never against the degraded copy.** BPP+'s structure —
divide by *probed CRF-20 transparency*, a content measurement independent of the file that happened to
be in the folder — is exactly the "score vs pristine source" answer, applied to a world with no
pristine source. This is the single strongest piece of external validation for the probe design this
report found, and it partially fills `BPP-PLUS.txt` §17 "STILL MISSING" (the headroom-without-a-master
treatment).

### Google UVQ (2022) and the survey **[DIRECTION]**

`https://research.google/blog/uvq-measuring-youtubes-perceptual-video-quality` — ContentNet/
DistortionNet/CompressionNet/AggregationNet, trained self-supervised, patch-based so resolution is
captured natively, anchored on YouTube-UGC MOS. The scale-up of "measure quality without a master on
arbitrary input"; confirms the field's answer to our level is learning-based NR-VQA with its own
grain-blindness (03 report owns the landscape). `arXiv:2112.12284` (Survey on Perceptually Optimized
Video Coding, Dec 2021) is the ordering frame for all of it.

**Bottom line for §4:** the input-quality frontier (QGT 2020 → UVQ 2022 → PT-loss 2026) keeps
deepening the claim that *the current quality of the input is a first-class transcoding input*.
A no-master server already carries that input metric (`R`); what it lacks is a decision layer that
uses it. That is steal #3.

---

## 5. Grain & the film-look pipeline (what they do *before* delivery)

Scope guard: the *measurement* side of grain is fully owned by 05 and 04. This section is the
**serve-side pipeline** and the two consequences that survive a world with no re-encoding.

### The mechanics, from Netflix's own posts **[SOLID]**

- Model = **Pattern** (autoregressive spatial model: a 64×64 noise template built from AR
  coefficients fit on the residual of *denoised* video; decoder draws random 32×32 patches and adds
  them) + **Intensity** (piecewise-linear scaling of grain strength vs pixel value).
- Pipeline: **denoise first** ("the standard does not mandate a specific method — choose your
  preferred denoiser"), encode the clean picture, transmit model parameters in-band, decoder
  synthesises. Denoising the source is *why* it compresses better — the grain isn't in the bitstream.
- Numbers: The Awakening — `They Cloned Tyrone` 8274→2804 kbps (−66%) with *less* DCT‑pattern
  distortion; the DCC 2018 paper (Norkin/Birkbeck, `https://norkin.org/pdf/DCC_2018_AV1_film_grain.pdf`)
  bounded heavy-grain savings "up to 50%". Third-party measurement (Sonnati, 2026-06-30,
  `https://sonnati.wordpress.com/2026/06/30/film-grain-synthesis-the-most-disruptive-yet-underrated-encoding-technique`):
  FGS ≈ +5–6 pts on a visibility scale, ~20% avg bitrate cut vs non-FGS AV1, with honest caveats
  ("sometimes excess compression behind the grain, sometimes the grain disappears"). Rollout: limited
  2021 (AV1 launch) → at scale March–July 2025 → 30% of streams (Dec 2025).
- The AV1 twist that makes it production-safe: unlike the H.264/HEVC *Film Grain Characteristics SEI*
  (2006/2013, optional), AV1 makes grain **regeneration normative** — a conformant decoder must
  synthesise. Grain becomes a *guaranteed* part of the decode.

### Consequence 1 — grain masks: a red band is not a red band **[SOLID → UNTESTED mapping]**

Netflix's own language: "synthesized grain… a form of mask, effectively conceals some compression
artifacts." The masked look is the *point* of the technique. For a grainy 1976 BluRay rip sitting at
BPP+ ~57 (Schindler's List, measured 0.35 complexity), the honest reading is **not** "57 out of 100:
half the transparency of a clean title" — it is "the picture is grain-masked, so visible damage at
this R is below what the number suggests." The Audit tab's attention model keys on colour×profile
mismatch, and for grainy titles that **over-signals** next to an equal-BPP+ clean title. That is a
presentation/policy call, does not touch the score, and costs nothing to implement.

### Consequence 2 — even Netflix has no quality model for FGS **[SOLID]**

The Awakening, verbatim: "**Currently, we lack a dedicated quality model for film grain
synthesis**." Plus `Netflix/vmaf#1192` (closed July 2023): the standing recommendation is to
**disable decode-time FGS when computing objective metrics**, because the statistically-equivalent
but position-mismatched re-synthesised grain reads as error to pointwise/FR metrics. Two firm
inferences for us: (a) no FR metric in common production is trustworthy on grain (05's conclusion,
now sourced); (b) our choice of **content-cost-normalised bpp** — the probe absorbs exactly what
transparency *costs* for that grain and then scores the file against it — is the only one of the
industry's templates that is *grain-safe by construction*, because it never compares the file to a
master. Whenever someone floats an FR/objective cross-check (02's BVI-HD/Netflix ladder idea) the
#1192 rule must be applied: those ladders are only valid on grain-free content.

### What does not transfer

FGS itself is a *re-encode + in-band synthesis* feature — this library stores finished H.264/HEVC
files and its players (Fire Stick/PS4) do no synthesis (the AC3 compat track via `ps4ify` is the only
re-encode the stack tolerates, and it is audio-only). An AV1-FGS *source rip* arrives with its grain
already **baked in as DCT noise** — the decode-side synthesis only exists on the streaming device,
never in a file. So the lineup of "AV1 measure = same quality at lower bitrate" does **not** transfer
to file-based storage; the quality-tier codec hierarchy in `_arr_common.sh` (H.264 +80 > HEVC-8bit
+20, AV1/VP9 −1000) is not challenged by this lineage. What transfers is the *masking* judgement
(Consequence 1) and the *metric-hygiene* rule (Consequence 2), both policy-layer.

---

## 6. Obstacle × invention — transfer matrix

| Netflix invention | Transfers | Reinterpret | Doesn't transfer | Already done in BPP+ |
|---|---|---|---|---|
| Per-title complexity from sampled encodes (2015) | — | The probe IS this; the *convex-hull* step is unborrowed (steals #1/#2) | — | ✔ per-film CRF-20 probe (`lib/probe.js`) |
| Content-complexity *prediction* instead of encodes (De Cock 2016 / Durbha & Bovik 2023) | — | Shrinkage/estimator ladder already the fallback for unprobed units | — | ✔ estimator ladder + priors |
| Dynamic optimizer / per-shot bit allocation (2018) | Decision layer: "spend bits where they buy picture" → release-choice policy | — | ✘ we never allocate bits; a file is a file | — |
| Convex-hull ladder + "wasted points" (2018/2020) | **DOMINANCE test for candidate releases** (a 12 MB/s HEVC-8bit equal to a 6 MB/s x264 ⇒ the big one is a wasted point on our hull) | — | — | — (gap) |
| Quality-saturation detector → per-title top rung (2020) | **Per-title sensible ceiling** → grab-size cap + "past this, bits buy nothing visible" | Anchors the open HEADROOM/where-100-sits question | — | — (gap) |
| Chunked-encode penalty workarounds, look-ahead (2018) | — | — | ✘ no multi-segment encodes | — |
| VIS ingest gate *rejects* bad mezzanines (2024) | — | Our gates are output-side (runtimeVerdict, ffprobe preflight, `unprobed` rows) — same *philosophy*, opposite *side* | — | ✔ Chinatown / Holiday Special class of checks |
| QGT input-quality-aware bitrate (Google 2020) | **R-guidance**: spend replacement effort where input merits it | Tolerance finding ⇒ absolute gain from an upgrade is *capped* for content the viewer already tolerates | — | ✔ `R` measured (dataset); ✘ unused in ordering |
| Camera/sensor + film grain as noise; denoise→encode→model (2018/2025) | — | Masking ⇒ red bands on grainy titles overstate visible damage | ✘ FGS requires re-encode + normative decoder; stored files never synth | — |
| CAMBI / block / blur as *gates beside the score* (2019) | — | — | — | ✔ gate architecture (04 owns) |
| HDR-VMAF: score the *signal*, not the display (2023) | Principle reinforces a display-independent scale | — | ✘ no HDR/VMAF here | ✔ BPP+ is display-independent by construction |
| NN quality models (2022 / VQS) | — | — | ✘ compute & training set | — |
| Device-limited ladder rungs (2016 mobile, 2020 legacy) | — | Per-title reached the "cheap" end ⇒ our low-tier titles still deserve the probed denominator | — | ✔ |

---

## 7. The steal shortlist, ranked

1. **Visible-gain / JND gating of replacements and auto-swaps** — foreground the merger of the
   "wasted points" observation (identical-VMAF points = wasted bits/storage) and our per-title hull.
   For every candidate release and every Disk/Upgrade row, compute ΔBPP+ and paint *expected visible
   gain* (sub-JND / JND / clearly-better bands) rather than raw score deltas; refuse in-gain anything
   under the just-noticeable delta for that film. This makes `gpuVerifySweep`'s paranoid swap guard
   principled instead of ad-hoc, and it is the correct label for the "×3 bitrate, +looks-the-same"
   class of offers. **[SOLID sources: 2018/2020 shot-based + our ladder pilot]**

2. **Per-title saturation → grab-size ceiling.** Use each film's probed `cxEff` to compute the point
   where further bitrate stops buying visible picture (their saturation rule in BPP+ units — where
   BPP+ flattens per film) and *tell the grab layer the ceiling*: a candidate above the ceiling is
   ranked last, not by size-phobia but because beyond it bits are literally invisible at 1080p. This
   is the home-library form of "the topmost rung." **[SOLID: 2020 saturation; UNTESTED: mapping the ε
   to a concrete ΔBPP+]**.

3. **R-guide the audit queue (QGT inverse).** Order audit/attention work by the *pair* (R, band):
   prioritize the starved titles where the upgrade genuinely wins (low R AND high complexity ⇒
   under-bitted, replace-targets), and de-prioritize content whose input already caps the visible
   gain (QGT's tolerance region). `R` exists in every `/api/probe/dataset` row today; nothing needs
   probing. **[SOLID mechanism; UNTESTED ordering rule]**

4. **Grain-masking in attention & confidence presentation.** Where a red-band file is also
   grain-heavy, the Audit copy should say "the number overstates the visible damage; masked by grain" and never
   present those files' scores with the same confidence as clean titles (extend the existing
   measured-vs-estimated typographic rule to a masked-vs-clean one). No score change. **[SOLID: FGS
   masking + no-quality-model confession]**

5. **Saturation as the anchor for "where does 100 sit" (`HEADROOM_TARGET`).** Netflix's saturation
   point is, in BPP+ units, "the bitrate at which Δvisible < ε" — provenance for an externally-
   grounded level without grading ten films (the standing §12 Q1 gap). If HEADROOM_TARGET is meant
   to be "not visibly better to spend more," the saturation-ε of a reference set of clean films *is*
   the number. **[UNTESTED: requires the ε definition, which Netflix never publishes; best treated
   as a cross-check on any label you do get]**

---

## 8. Open questions

- **The ε is unpublished.** Netflix never states the ΔVMAF they call "saturation." Any concrete home
  rule (steal #2/#5) must define its own ε; can `data/ladder-pilot.json` + blind-test data pin one
  per band? (feeds directly into steal #1's JND bands).
- **VIS's "low-quality mezzanine" criteria** are unpublished. Our ingest-side analogue is the
  runtime/`unprobed` gate — is there a *quality* gate worth adding at import (e.g. probe-cache-driven
  "this release is far enough below the film's ceiling that even the transparent version wouldn't
  help")?
- **Do FGS streams change the codec hierarchy?** No for file storage (grain bakes in). But if a title
  arrives only as "AV1 (FGS)" WEB-DL at ⅓ the size with the same look, the tie-break logic
  (`_arr_common.sh`) currently lists it −1000. Open: is AV1-FGS *source rips* a real category yet, and
  should it differ from plain AV1 in ranking? (No evidence found; likely a no.)
- **The pristine-vs-degraded principle wants a confirming experiment.** The clearest win would wrap
  02's BVI-HD/Netflix-ladder idea with the #1192 rule: run a ladder of *clean* content and confirm
  BPP+ ordering against the labels, grain excluded. This is the one externally-visible validation the
  2026 PT-loss paper suggests is legitimate to claim.
- **Would any serve-side per-shot remain?** No — the 2020 post's own "wasted points" logic applied to
  a single-file endpoint says the only server-side per-shot play left is candidate *selection* at the
  film level. Confirmed closed.

---

## Sources

Primary (all URL-verified, most read in body this session): the 2015 per-title post; 2015
high-quality-encoding; De Cock et al. 2016 (via QGT ref [1]); 2016 mobile encodes; 2016 VMAF launch;
2018 Dynamic optimizer; 2018 shot-based (VMAF-80 figures); 2018 VMAF Journey Continues; CAMBI post;
2020 shot-based 4K (saturation/convex-hull/waste quotes); 2020 legacy-device per-title; 2021 AV1
launch; 2022 For Your Eyes Only; 2023 HDR DO (HDR-VMAF, display-mapping exclusion, open-source
status); 2024 Rebuilding pipeline (VIS/CAS/LGS/VES/VVS/VQS + mezzanine + VIS rejection); 2024 VES
making-of; 2025 FGS Awakening (AR model, intensity function, denoise-then-encode, They Cloned Tyrone
numbers, masking, no-FGS-quality-model); 2025 AV1-30% (stripped-grain rationale). OSS/standards:
DCC 2018 AV1 grain paper; `Netflix/vmaf#1192` (issue body + APSIPA quote, closed 2023-07-27).

Sibling/adjacent (verified this session): Google QGT full PDF (Siamese detector, 5s chunks, Tq=0.8,
CRF+10/15/20, 5%, bootstrap); Google UVQ; the 2026 Mamba/PT-loss UGC transcoding paper
(`arXiv:2603.25566`); perceptually-optimized-video-coding survey (`arXiv:2112.12284`); IEEE
10222417 deep-CNN pre-encoding quality control; Sonnati FGS measurement post (2026-06-30); ETCentric/
TV Tech/engineering.fyi mirrors used where Medium 403'd — each cited at its verified URL.

Cross-report: 02 owns dataset calibration (incl. Netflix public ladder), 03 the NR-metric landscape,
04 CAMBI/gates, 05 grain measurement + the §5 "industry consensus" framing to extend, 06 community
rules of thumb.

---

## ROUND 2 — ADVERSARIAL VERIFICATION (2026-08-19)

Adversarial re-check of every load-bearing claim above against primary sources: Medium canonical
timestamps + post bodies, `github.com/Netflix/vmaf`, arXiv/SPIE, and independent third-party coverage.
`netflixtechblog.com` 403s automated fetches (Medium bot-block); verification used the Blogger-era
mirrors (`techblog.netflix.com`) and the official syndication mirror (`noise.getoto.net`) — content
identical to the Medium posts. Original text above is untouched; verdicts only. Dataset figures
re-computed live from `GET /api/probe/dataset` (n=1031 = 885 movies + 146 seasons — header figure ✓).

### Lineage table (§2) — per-row verdicts

| Row | Verdict |
|---|---|
| 2015-12 Per-Title Encode Optimization | **[VERIFIED]** — published 2015-12-14; slug `…-7e99442b62a2` correct (read at `http://techblog.netflix.com/2015/12/per-title-encode-optimization.html`). Per-title probe encodes → per-title/device ladders confirmed. |
| 2015-12 High Quality at Scale | **[UNCHECKED — session limit]**; era-consistent Blogger-era post, no contradiction found. |
| 2016 De Cock et al., complexity prediction | Paper real ("Complexity-based consistent quality encoding in the cloud", ICIP 2016); "cited as QGT ref [1]" not independently re-opened — **[UNCHECKED — session limit]**, no contradiction. |
| 2016 More Efficient Mobile Encodes | **[VERIFIED indirectly]** — the 2018 Dynamic Optimizer post confirms "'per-chunk encode optimization', introduced in Dec. 2016 as part of our 'Mobile encodes for downloads' initiative". |
| 2016 VMAF launch | **[VERIFIED]** — Journey post: "In June 2016, we open-sourced VMAF on Github, and also published the first VMAF techblog." |
| 2018-03-05 Dynamic Optimizer | **[VERIFIED]** — Mar 5, 2018, Ioannis Katsavounidis; per-shot allocation, look-ahead, convex hull, VMAF objective all in body (`…-e19f1e3a277f`). |
| 2018-03-09 Shot-based encodes | **[VERIFIED]** — Mar 9, 2018; verbatim: optimized encodes "require less than half of the bits" of per-title AVCMain; VP9-Opt "less than one third"; Stranger Things 20×3-min chunks → 900 shots @ ~4 s avg shot length (`…-4b9464204830`). |
| 2018-10-26 VMAF Journey Continues | **[VERIFIED]** — Medium canonical timestamp 2018-10-26T00:00Z (byline renders "Oct 25"; timezone artifact — the table's date matches the canonical field) (`…-44b51ee9ed12`). |
| 2021 CAMBI | **[UNCHECKED — session limit]** (owned by 04); post real, no contradiction. |
| 2020-08-28 Shot-based 4K | **[VERIFIED]** — 2020-08-28, Mavlankar/Guo/Moorthy/Aaron (`…-47b516b10bbb`). Saturation rule **verbatim**: "we have logic to detect quality saturation at the high end, meaning an increase in bitrate not resulting in material improvement in quality. Once such a bitrate is reached it is a good candidate for the topmost rung of the ladder." Fixed 4K ladder 8/10/12/16 Mbps (restated verbatim in the 2023 HDR post); top average rung 16→8 Mbps and BD-rate ≈ −50% confirmed by independents (Hackaday 2020-09-16; digitalproduction.com 2020-10-26); animation title at 1.8 Mbps seen in Fig. 4. The single-title **17.2 Mbps** figure is consistent with the post's "optimized ladder exceeds the fixed-bitrate ladder" passage but was not byte-re-captured through mirror truncation — **[VERIFIED contextually]**. |
| 2020-10 Legacy devices | **[REVISED]** — published **2020-08-10**, not 2020-10 (`…-2b6b56eec5c9`). Content claim unaffected. |
| 2021-11 AV1 on TVs | **[VERIFIED]** — 2021-11-09 (`…-b7fc88e42320`). "FGS on a limited set of titles from day one" is confirmed by the 2025 FGS post itself ("we only enabled it for a limited number of titles during our initial launch of the AV1 codec in 2021"). |
| 2022-11 For Your Eyes Only | **[REVISED — mischaracterized]** — post exists (2022-11-14, `…-5b8d032da09c`) but is about the **neural-network video downscaler** ("deep downscaler" enabling more low-res ladder points), *not* "NN-based quality scoring/inspection in the loop". The §6 matrix row "NN quality models (2022/VQS)" inherits the error: VQS (2024 post) computes VMAF; nothing in this post puts an NN in quality scoring. The verdict (doesn't transfer) survives; the stated reason does not. |
| 2023-11-29 HDR DO | **[VERIFIED]** — 2023-11-29 (`…-e9e0cb15f2ba`); HDR-VMAF first internal version 2021, Dolby collaboration, signal-not-display framing, entire HDR catalog optimized by June 2023, fixed 4K ladder 8/10/12/16 Mbps. |
| 2024-01 Rebuilding pipeline | **[VERIFIED]** — 2024-01-10 (`…-4e5e6310e359`). Six services exact: VIS/CAS/LGS/VES/VVS/VQS. Load-bearing VIS claim is **verbatim**: "It leverages VIS to detect and reject non-conformant or low-quality mezzanines." Nuance: VIS's own service blurb covers metadata inspection/flagging; the reject-low-quality language sits in the Streaming Workflow Orchestrator paragraph — report cites it in substance correctly. |
| 2024-05 Making of VES | **[REVISED]** — published **2024-04-09**, not 2024-05 (`…-946b9b3cd300`). |
| 2025-07-02 FGS Awakening | **[VERIFIED]** — 2025-07-02 (`…-ee09cfdff40b`). They Cloned Tyrone **8274→2804 kbps ≈ −66%** verbatim; masking **verbatim**: "The added film grain, a form of mask, effectively conceals some compression artifacts."; confession **verbatim**: "Currently, we lack a dedicated quality model for film grain synthesis."; AR model, 64×64 noise template, random 32×32 patches, piecewise-linear intensity scaling, "The standard does not mandate a specific method" denoiser sentence — all verbatim. Bonus figures the report didn't use: ~300-title study, −36% avg bitrate ≥1080p, only ~10% below 1080p. |
| 2025-12 AV1 30% | **[VERIFIED]** — 2025-12-01 (`…-02f592242d80`); ~30% of viewing, +4.3 VMAF vs AVC / +0.9 vs HEVC, one-third less bandwidth. |
| §2 slug footnote | **[VERIFIED]** — correct VES slug is `…-946b9b3cd300`. |

### §3 rate-quality reading — **[VERIFIED]**

All three block quotes trace to the 2020 4K post (saturation/topmost-rung verbatim above; the
"steps"/flat-quality/wasted-bits passage appears there and nearly verbatim again in the 2023 HDR post:
"quality stays almost flat among two successive 1080p points or two successive 4K points"). Convex-hull
language confirmed across the DO, Journey, and codec-comparison posts. The central interpretation —
Netflix detects saturation but never publishes the ε defining "material improvement" — survives every
read: no ε value appears in any post. §8's "the ε is unpublished" stands. The "no structural knee /
saturation is policy not fact" reading is an accurate characterization of what Netflix publishes:
they describe a *detector plus threshold*, never a discovered curve feature.

### §4 input-quality end — **[VERIFIED, internals carried]**

QGT real: SPIE OE+Apps, 2020-08-21, DOI 10.1117/12.2569332 (Wang/Talebi/Yim/Birkbeck/Adsumilli);
~5% average bitrate savings confirmed. Internal constants (T_q=0.8, CRF +10/+15/+20, Siamese
Inception-front, 5 s chunks) **[UNCHECKED — session limit]** — carried from the PDF read; no
contradicting source found. arXiv:2603.25566 (Mamba perceptual loss for UGC transcoding) verified
real: 2026-03-26, Bristol + Tencent Media Lab; its block quote is paraphrase-grade, not byte-checked.
UVQ blog and arXiv:2112.12284 survey **[UNCHECKED — session limit]**; known real, no contradiction.

### §5 grain pipeline — **[VERIFIED, two small flags]**

Mechanics, Tyrone numbers, masking language, and the no-quality-model confession: all verbatim (above).
AV1 grain regeneration normative: confirmed by AV1/AFGS1 specs and norkin.org ("specifies mandatory
support"). `Netflix/vmaf#1192`: created 2023-07-01 by veikk0, **closed 2023-07-27**; maintainer reply:
"synthesized grain interferes with VMAF scores, and we recommend to disable it when computing VMAF."
The report correctly says "closed July 2023".

Flags:
1. **DCC-2018 attribution slightly loose.** The "up to 50%" heavy-grain figure surfaces in #1192 via
   the APSIPA *coding-tools overview* quote; DCC 2018 (Norkin/Birkbeck, `norkin.org/pdf/DCC_2018_AV1_film_grain.pdf`,
   real) documents the heavy-grain result via informal subjective test in its §6. Both papers exist;
   the 50% line belongs primarily to the APSIPA overview. **[REVISED nuance]**
2. **Sonnati figures partially confirmed.** Post exists at the cited URL, dated 2026-06-30 ✓; "+5–6 pts
   XVS (~1 JND)" confirmed via the author's own posts. The "~20% avg bitrate cut vs non-FGS AV1"
   attribution was **not re-captured** — the author's posts say ">30%" additional savings and Netflix's
   own A/B says −31.6% average bitrate. Treat the 20% as **[UNCHECKED — session limit]**.

### Consequence 1's worked example — **[REVISED — stale number + wrong year]**

"a grainy 1976 BluRay rip sitting at BPP+ ~57 (Schindler's List…)": Schindler's List is **1993**, not
1976; and against today's dataset the film reads **BPP+ 45** (complexity 0.35108 ✓ matches, biasFactor
1.607, cxEff 0.56401, R 0.3537, bpp 0.11512). The complexity figure is right; the score predates the
2026-08-18 bias recalibration. The masking argument itself is untouched by either correction.

### §6 transfer matrix / §7 steal shortlist — **[VERIFIED dependencies]**

Steal #1/#2/#5 rest on the saturation rule (**verified verbatim**) and the unpublished ε (**verified
absent from every post**). Steal #3 rests on QGT (**verified real, 5% figure**). Steal #4 rests on the
masking sentence and the no-FGS-quality-model confession (**both verbatim**). The §6 rows citing the
2022 NN post inherit the mischaracterization noted above; every other row's source checks out.

### Errors & misattributions found (summary)

1. **For Your Eyes Only mischaracterized** — NN downscaler, not NN quality scoring (the one substantive
   content error).
2. **Legacy devices date**: 2020-08-10, not 2020-10.
3. **VES making-of date**: 2024-04-09, not 2024-05.
4. Minor: DCC-2018 "up to 50%" attribution (figure is from the APSIPA overview quoted in #1192).
5. Minor: Sonnati "~20% avg bitrate cut" unconfirmed (author says >30%; Netflix A/B −31.6%).
6. Minor: Schindler example — wrong year (1993, not 1976) and stale BPP+ (45 live, not ~57).
7. **Nothing fabricated**: every cited post/paper exists at its cited URL/slug; both self-confessed
   §2 URL fixes check out; the VIS rejection sentence, saturation rule, Tyrone numbers, and FGS
   no-quality-model confession are all verbatim accurate.
8. Sibling-doc erratum (out of scope here): `BPP-PLUS.txt` §11.2 still calls vmaf#1192 "an open bug" —
   it closed 2023-07-27.